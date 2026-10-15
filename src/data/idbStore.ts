import { openDB, type DBSchema, type IDBPDatabase, type StoreNames } from 'idb'
import type { AssetMeta, InteractionEvent, NodeRecord, WorldSettings } from '../domain/types.ts'
import { createMemoryStore, toOwnedBytes } from './memoryStore.ts'
import { openOpfsBlobDir, type OpfsBlobDir } from './opfs.ts'
import type { BlobInput, StoreInfo, WorldStore } from './WorldStore.ts'

// IndexedDB WorldStore. Records, events, settings, asset metadata and kv live in IDB;
// blob bytes live in OPFS when it is writable, else in the IDB 'blobs' store. Reads fall
// back to the IDB store even in OPFS mode, so bytes written before the browser gained
// createWritable (or before a backend switch) stay readable.

export const DB_NAME = 'hyperspace'
export const DB_VERSION = 1
const SETTINGS_KEY = 'world'

interface HyperspaceDB extends DBSchema {
  nodes: { key: string; value: NodeRecord; indexes: { updatedAt: number; deletedAt: number } }
  events: { key: string; value: InteractionEvent; indexes: { t: number } }
  settings: { key: string; value: WorldSettings }
  assets: { key: string; value: AssetMeta }
  /** Raw bytes keyed by asset id; the mime type lives on AssetMeta. */
  blobs: { key: string; value: ArrayBuffer }
  kv: { key: string; value: unknown }
}

const ALL_STORES: StoreNames<HyperspaceDB>[] = ['nodes', 'events', 'settings', 'assets', 'blobs', 'kv']

/** Thrown by every call after close() or after another tab forced a schema upgrade. */
export class StoreClosedError extends Error {
  constructor(message = 'The world store was closed (updated in another tab — reload)') {
    super(message)
    this.name = 'StoreClosedError'
  }
}

export interface IdbStoreOptions {
  /** Database name. Default 'hyperspace'; tests use unique names. */
  name?: string
  /** OPFS root for blob bytes. undefined = navigator.storage.getDirectory(); null = keep bytes in IDB. */
  opfsRoot?: FileSystemDirectoryHandle | null
  /**
   * Another tab wants a newer schema (or is deleting the database). This connection has
   * already been closed so that tab can proceed; tell the user to reload.
   */
  onVersionChange?: () => void
  /** Our open is waiting for an older connection in another tab to close. */
  onBlocked?: () => void
  /** The browser closed the connection abnormally (storage cleared, disk error). */
  onTerminated?: () => void
}

export interface IdbWorldStore extends WorldStore {
  readonly closed: boolean
}

function assertKey(id: unknown, what: string): asserts id is string {
  if (typeof id !== 'string') throw new DOMException(`${what}: id must be a string key`, 'DataError')
}

export async function openIdbStore(opts: IdbStoreOptions = {}): Promise<IdbWorldStore> {
  let closed = false
  let db: IDBPDatabase<HyperspaceDB> | null = null

  const conn = await openDB<HyperspaceDB>(opts.name ?? DB_NAME, DB_VERSION, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        const nodes = d.createObjectStore('nodes', { keyPath: 'id' })
        nodes.createIndex('updatedAt', 'updatedAt')
        // null is not a valid key, so this index holds exactly the trash.
        nodes.createIndex('deletedAt', 'deletedAt')
        d.createObjectStore('events', { keyPath: 'id' }).createIndex('t', 't')
        d.createObjectStore('settings')
        d.createObjectStore('assets', { keyPath: 'id' })
        d.createObjectStore('blobs')
        d.createObjectStore('kv')
      }
    },
    blocked() {
      opts.onBlocked?.()
    },
    blocking() {
      // Holding the connection open would stall the other tab's upgrade forever.
      closed = true
      db?.close()
      opts.onVersionChange?.()
    },
    terminated() {
      closed = true
      opts.onTerminated?.()
    },
  })
  db = conn

  let opfs: OpfsBlobDir | null
  try {
    opfs = await openOpfsBlobDir(opts.opfsRoot)
  } catch {
    opfs = null
  }
  const info: StoreInfo = { kind: 'idb', blobBackend: opfs ? 'opfs' : 'idb' }

  const live = (): IDBPDatabase<HyperspaceDB> => {
    if (closed) throw new StoreClosedError()
    return conn
  }

  return {
    info,
    get closed() {
      return closed
    },

    async getSettings() {
      return (await live().get('settings', SETTINGS_KEY)) ?? null
    },
    async putSettings(s) {
      await live().put('settings', s, SETTINGS_KEY)
    },

    async listNodes() {
      return live().getAll('nodes')
    },
    async getNode(id) {
      return live().get('nodes', id)
    },
    async putNode(n) {
      await live().put('nodes', n)
    },
    async putNodes(ns) {
      if (ns.length === 0) return
      const tx = live().transaction('nodes', 'readwrite')
      const pending: Promise<unknown>[] = []
      try {
        for (const n of ns) pending.push(tx.store.put(n))
      } catch (e) {
        // A synchronous failure (DataError, DataCloneError) mid-batch: roll back the puts
        // already queued in this transaction so the batch is all-or-nothing.
        tx.abort()
        await Promise.allSettled([...pending, tx.done])
        throw e
      }
      await Promise.all([...pending, tx.done])
    },
    async deleteNode(id) {
      await live().delete('nodes', id)
    },

    async appendEvent(e) {
      await live().put('events', e)
    },
    async listEvents(sinceT) {
      const range = sinceT === undefined ? undefined : IDBKeyRange.lowerBound(sinceT)
      return live().getAllFromIndex('events', 't', range)
    },
    async clearEvents(beforeT) {
      const tx = live().transaction('events', 'readwrite')
      const work = (async () => {
        if (beforeT === undefined) {
          const n = await tx.store.count()
          await tx.store.clear()
          return n
        }
        let n = 0
        let cursor = await tx.store.index('t').openCursor(IDBKeyRange.upperBound(beforeT, true))
        while (cursor) {
          await cursor.delete()
          n++
          cursor = await cursor.continue()
        }
        return n
      })()
      // Await both together so a failure in either is observed (no unhandled tx.done).
      const [n] = await Promise.all([work, tx.done])
      return n
    },

    async putBlob({ meta, data }: BlobInput) {
      assertKey(meta.id, 'putBlob')
      live()
      if (opfs) {
        const existed = (await live().get('assets', meta.id)) !== undefined
        await opfs.put(meta.id, data)
        const stored: AssetMeta = { ...meta, bytes: data instanceof Blob ? data.size : data.byteLength }
        try {
          const tx = live().transaction(['assets', 'blobs'], 'readwrite')
          // Drop any stale IDB copy so the fallback read can never resurrect old bytes.
          await Promise.all([tx.objectStore('assets').put(stored), tx.objectStore('blobs').delete(meta.id), tx.done])
        } catch (e) {
          if (!existed) await opfs.delete(meta.id).catch(() => {})
          throw e
        }
        return
      }
      // Read the bytes before opening the transaction: awaiting non-IDB work inside it
      // would let it auto-commit.
      const bytes = await toOwnedBytes(data)
      const stored: AssetMeta = { ...meta, bytes: bytes.byteLength }
      const tx = live().transaction(['assets', 'blobs'], 'readwrite')
      await Promise.all([tx.objectStore('blobs').put(bytes.buffer, meta.id), tx.objectStore('assets').put(stored), tx.done])
    },
    async getBlob(id) {
      const meta = await live().get('assets', id)
      if (meta === undefined) return undefined
      if (opfs) {
        const f = await opfs.get(id)
        // slice() re-types without copying the file contents.
        if (f) return f.slice(0, f.size, meta.mime)
      }
      const buf = await live().get('blobs', id)
      return buf === undefined ? undefined : new Blob([buf], { type: meta.mime })
    },
    async getAssetMeta(id) {
      return live().get('assets', id)
    },
    async listAssets() {
      return live().getAll('assets')
    },
    async deleteBlob(id) {
      // Metadata first: an interrupted delete leaves an orphan file, never a dangling meta.
      const tx = live().transaction(['assets', 'blobs'], 'readwrite')
      await Promise.all([tx.objectStore('assets').delete(id), tx.objectStore('blobs').delete(id), tx.done])
      await opfs?.delete(id)
    },

    async getKv<T = unknown>(key: string) {
      return (await live().get('kv', key)) as T | undefined
    },
    async putKv(key, value) {
      await live().put('kv', value, key)
    },
    async deleteKv(key) {
      await live().delete('kv', key)
    },

    async wipe() {
      const tx = live().transaction(ALL_STORES, 'readwrite')
      await Promise.all([...ALL_STORES.map((s) => tx.objectStore(s).clear()), tx.done])
      await opfs?.clear()
    },
    close() {
      closed = true
      conn.close()
    },
  }
}

export interface OpenedWorldStore {
  store: WorldStore
  /** True when IndexedDB could not be opened and the world lives only in memory. */
  fallback: boolean
  error?: unknown
}

/**
 * Open the IndexedDB store, falling back to memory when IndexedDB is unusable (some private
 * windows). A VersionError is rethrown: it means this tab runs older code than the data, and
 * hiding the user's world behind an empty memory store would be worse than asking to reload.
 */
export async function openWorldStore(opts: IdbStoreOptions = {}): Promise<OpenedWorldStore> {
  try {
    return { store: await openIdbStore(opts), fallback: false }
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === 'VersionError') throw error
    return { store: createMemoryStore(), fallback: true, error }
  }
}
