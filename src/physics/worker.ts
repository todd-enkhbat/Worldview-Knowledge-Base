// Module-worker entry for the physics host (src/world/time/physicsClient.ts spawns it with
// new Worker(new URL('../../physics/worker.ts', import.meta.url), { type: 'module' })).
// All behaviour lives in workerHost.ts; this file only wires it to the worker scope and
// gives it a persistent checkpoint cache.
//
// The cache is its own IndexedDB database, 'hyperspace-cache', apart from the world store:
// checkpoints are derived data (a pure function of records, settings and step), so the
// database can be dropped at any time and is never exported, backed up or locked.

import { openDB } from 'idb'
import type { KvStore } from './checkpointCache.ts'
import { PhysicsHost } from './workerHost.ts'
import type { FromWorker, ToWorker } from './workerProtocol.ts'

export const CACHE_DB_NAME = 'hyperspace-cache'
const CACHE_STORE = 'kv'

/** A KvStore over its own IndexedDB database; null where IndexedDB is unavailable. */
export function openCheckpointKv(name = CACHE_DB_NAME): KvStore | null {
  if (typeof indexedDB === 'undefined') return null
  const db = openDB(name, 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(CACHE_STORE)) d.createObjectStore(CACHE_STORE)
    },
  })
  // Callers see the rejection through their own awaits; this keeps it from going unhandled.
  db.catch(() => undefined)
  return {
    async getKv<T>(key: string): Promise<T | undefined> {
      return (await (await db).get(CACHE_STORE, key)) as T | undefined
    },
    async putKv(key: string, value: unknown): Promise<void> {
      await (await db).put(CACHE_STORE, value, key)
    },
    async deleteKv(key: string): Promise<void> {
      await (await db).delete(CACHE_STORE, key)
    },
  }
}

/**
 * Background ticks through a MessageChannel: unlike nested setTimeout(0) it is not clamped
 * to 4 ms, and incoming messages (new targets, edits) still interleave between ticks.
 */
function channelScheduler(): (fn: () => void) => void {
  if (typeof MessageChannel === 'undefined') return (fn) => void setTimeout(fn, 0)
  const ch = new MessageChannel()
  const queue: (() => void)[] = []
  ch.port1.onmessage = () => queue.shift()?.()
  return (fn) => {
    queue.push(fn)
    ch.port2.postMessage(null)
  }
}

interface WorkerScope {
  postMessage(msg: unknown, transfer: Transferable[]): void
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null
}

// Wire up only inside a worker, so tests can import this module for openCheckpointKv.
if ('WorkerGlobalScope' in globalThis) {
  const scope = globalThis as unknown as WorkerScope
  const host = new PhysicsHost({
    post: (msg: FromWorker, transfer) => scope.postMessage(msg, transfer),
    kv: openCheckpointKv(),
    schedule: channelScheduler(),
  })
  scope.onmessage = (e) => host.handle(e.data)
}
