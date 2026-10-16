import type { AssetMeta, InteractionEvent, NodeRecord, WorldSettings } from '../domain/types.ts'
import type { BlobInput, StoreInfo, WorldStore } from './WorldStore.ts'

// In-memory WorldStore: the test double and the fallback when IndexedDB is unusable
// (some private windows). Records are structured-cloned on the way in and on the way out
// so callers can never mutate stored state by reference, matching IndexedDB semantics.
// Ordering matches idbStore: records and assets by id, events by (t, id).

interface StoredBytes {
  bytes: Uint8Array<ArrayBuffer>
  meta: AssetMeta
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const byTimeThenId = (a: InteractionEvent, b: InteractionEvent) => a.t - b.t || byId(a, b)

/** IndexedDB rejects records whose keyPath is missing; mirror that so both adapters fail alike. */
function assertKey(id: unknown, what: string): asserts id is string {
  if (typeof id !== 'string') throw new DOMException(`${what}: id must be a string key`, 'DataError')
}

/** Copy blob input into an owned buffer (a Uint8Array may view a larger shared buffer). */
export async function toOwnedBytes(data: Blob | Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (data instanceof Uint8Array) return data.slice()
  return new Uint8Array(await data.arrayBuffer())
}

export function createMemoryStore(): WorldStore {
  let settings: WorldSettings | null = null
  const nodes = new Map<string, NodeRecord>()
  const events = new Map<string, InteractionEvent>()
  const blobs = new Map<string, StoredBytes>()
  const kv = new Map<string, unknown>()
  const info: StoreInfo = { kind: 'memory', blobBackend: 'memory' }

  return {
    info,

    async getSettings() {
      return settings === null ? null : structuredClone(settings)
    },
    async putSettings(s) {
      settings = structuredClone(s)
    },

    async listNodes() {
      return [...nodes.values()].sort(byId).map((n) => structuredClone(n))
    },
    async getNode(id) {
      const n = nodes.get(id)
      return n === undefined ? undefined : structuredClone(n)
    },
    async putNode(n) {
      assertKey(n.id, 'putNode')
      nodes.set(n.id, structuredClone(n))
    },
    async putNodes(ns) {
      // Clone and validate the whole batch before touching the map: all or nothing.
      const staged = ns.map((n) => {
        assertKey(n.id, 'putNodes')
        return structuredClone(n)
      })
      for (const n of staged) nodes.set(n.id, n)
    },
    async deleteNode(id) {
      nodes.delete(id)
    },

    async appendEvent(e) {
      assertKey(e.id, 'appendEvent')
      events.set(e.id, structuredClone(e))
    },
    async listEvents(sinceT) {
      const out: InteractionEvent[] = []
      for (const e of events.values()) if (sinceT === undefined || e.t >= sinceT) out.push(structuredClone(e))
      return out.sort(byTimeThenId)
    },
    async clearEvents(beforeT) {
      let n = 0
      for (const [id, e] of events) {
        if (beforeT === undefined || e.t < beforeT) {
          events.delete(id)
          n++
        }
      }
      return n
    },

    async putBlob({ meta, data }: BlobInput) {
      assertKey(meta.id, 'putBlob')
      const bytes = await toOwnedBytes(data)
      blobs.set(meta.id, { bytes, meta: { ...structuredClone(meta), bytes: bytes.byteLength } })
    },
    async getBlob(id) {
      const b = blobs.get(id)
      // Blob construction copies, so the stored bytes stay private.
      return b === undefined ? undefined : new Blob([b.bytes], { type: b.meta.mime })
    },
    async getAssetMeta(id) {
      const b = blobs.get(id)
      return b === undefined ? undefined : structuredClone(b.meta)
    },
    async listAssets() {
      return [...blobs.values()].map((b) => structuredClone(b.meta)).sort(byId)
    },
    async deleteBlob(id) {
      blobs.delete(id)
    },

    async getKv<T = unknown>(key: string) {
      return (kv.has(key) ? structuredClone(kv.get(key)) : undefined) as T | undefined
    },
    async putKv(key, value) {
      kv.set(key, structuredClone(value))
    },
    async deleteKv(key) {
      kv.delete(key)
    },

    async wipe() {
      settings = null
      nodes.clear()
      events.clear()
      blobs.clear()
      kv.clear()
    },
    close() {
      // Nothing to release; the data lives as long as this object.
    },
  }
}
