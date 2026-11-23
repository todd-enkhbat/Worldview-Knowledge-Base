import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb'
import type { AssetMeta, InteractionEvent, NodeRecord, WorldSettings } from '../domain/types.ts'
import { createMemoryStore, toOwnedBytes } from './memoryStore.ts'
import { openOpfsBlobDir, type OpfsBlobDir } from './opfs.ts'
import type { BlobInput, StoreInfo, WorldStore } from './WorldStore.ts'
import { assertRevisionMutation, stateRevision, WorldStateConflictError } from './worldState.ts'
import { assertKnowledgeReceipt, diffKnowledgeSnapshots, isKnowledgeSnapshot, KNOWLEDGE_COLLECTIONS, KNOWLEDGE_KEY, KNOWLEDGE_MIGRATION_KEY, KNOWLEDGE_RECEIPTS_KEY, KnowledgeMigrationError, knowledgeRowKey, materializeKnowledge, normalizeKnowledgeFingerprint, normalizeKnowledgeReceipts, snapshotMetadata, stableJson, validateKnowledgeCommit, type KnowledgeCommitOptions, type KnowledgeDelta, type KnowledgeHead, type KnowledgeReceipt, type StoredKnowledgeRow } from '../knowledge/storage.ts'
import type { KnowledgeSnapshot } from '../knowledge/types.ts'

// IndexedDB WorldStore. Records, events, settings, asset metadata and kv live in IDB;
// blob bytes live in OPFS when it is writable, else in the IDB 'blobs' store. Reads fall
// back to the IDB store even in OPFS mode, so bytes written before the browser gained
// createWritable (or before a backend switch) stay readable.

export const DB_NAME = 'hyperspace'
export const DB_VERSION = 2
const SETTINGS_KEY = 'world'

interface HyperspaceDB extends DBSchema {
  nodes: { key: string; value: NodeRecord; indexes: { updatedAt: number; deletedAt: number } }
  events: { key: string; value: InteractionEvent; indexes: { t: number } }
  settings: { key: string; value: WorldSettings }
  assets: { key: string; value: AssetMeta }
  /** Raw bytes keyed by asset id; the mime type lives on AssetMeta. */
  blobs: { key: string; value: ArrayBuffer }
  kv: { key: string; value: unknown }
  knowledgeRows: { key: string; value: StoredKnowledgeRow; indexes: { collection: string } }
  knowledgeState: { key: string; value: unknown }
  knowledgeReceipts: { key: string; value: KnowledgeReceipt }
}

const KNOWLEDGE_STORES: StoreNames<HyperspaceDB>[] = ['knowledgeRows', 'knowledgeState', 'knowledgeReceipts', 'kv']
const ALL_STORES: StoreNames<HyperspaceDB>[] = ['nodes', 'events', 'settings', 'assets', 'blobs', 'kv', 'knowledgeRows', 'knowledgeState', 'knowledgeReceipts']
type KnowledgeTransaction = IDBPTransaction<HyperspaceDB, StoreNames<HyperspaceDB>[], 'readwrite' | 'versionchange'>
type KnowledgeReadTransaction = IDBPTransaction<HyperspaceDB, StoreNames<HyperspaceDB>[], 'readonly'>

async function readKnowledge(tx: KnowledgeTransaction | KnowledgeReadTransaction): Promise<KnowledgeSnapshot | undefined> {
  const head = await tx.objectStore('knowledgeState').get('head') as KnowledgeHead | undefined
  if (!head) return undefined
  return materializeKnowledge(head, await tx.objectStore('knowledgeRows').getAll())
}

async function readValue(tx: KnowledgeTransaction | KnowledgeReadTransaction, key: string): Promise<unknown> {
  if (key === KNOWLEDGE_KEY) return await readKnowledge(tx) ?? await tx.objectStore('kv').get(key)
  if (key === KNOWLEDGE_RECEIPTS_KEY) { const receipts = await tx.objectStore('knowledgeReceipts').getAll(); return receipts.length ? receipts : undefined }
  if (key === KNOWLEDGE_MIGRATION_KEY) return tx.objectStore('knowledgeState').get('migration')
  return tx.objectStore('kv').get(key)
}

async function replaceKnowledge(tx: KnowledgeTransaction, snapshot: KnowledgeSnapshot): Promise<void> {
  await Promise.all([tx.objectStore('knowledgeRows').clear(), tx.objectStore('knowledgeReceipts').clear()])
  for (const collection of KNOWLEDGE_COLLECTIONS) for (const [order, value] of snapshot[collection].entries()) await tx.objectStore('knowledgeRows').put({ key: knowledgeRowKey(collection, value.id), collection, id: value.id, order, value })
  await tx.objectStore('knowledgeState').put({ revision: snapshot.revision, metadata: snapshotMetadata(snapshot), nextOrder: Object.fromEntries(KNOWLEDGE_COLLECTIONS.map((collection) => [collection, snapshot[collection].length])) } satisfies KnowledgeHead, 'head')
  await tx.objectStore('kv').delete(KNOWLEDGE_KEY)
}

async function writeValue(tx: KnowledgeTransaction, key: string, value: unknown): Promise<void> {
  if (key === KNOWLEDGE_KEY && isKnowledgeSnapshot(value)) return replaceKnowledge(tx, value)
  if (key === KNOWLEDGE_KEY && await tx.objectStore('knowledgeState').get('head')) throw new Error('Unsupported knowledge format; the current corpus was preserved.')
  if (key === KNOWLEDGE_RECEIPTS_KEY) {
    const receipts = normalizeKnowledgeReceipts(value)
    await tx.objectStore('knowledgeReceipts').clear()
    for (const row of receipts) await tx.objectStore('knowledgeReceipts').put(row)
    return
  }
  await tx.objectStore('kv').put(value, key)
}

async function applyKnowledgeCommit(tx: KnowledgeTransaction, delta: KnowledgeDelta, opts: KnowledgeCommitOptions, fingerprint: string): Promise<boolean> {
  if (assertKnowledgeReceipt(await tx.objectStore('knowledgeReceipts').get(opts.idempotencyKey), fingerprint)) return true
  const head = await tx.objectStore('knowledgeState').get('head') as KnowledgeHead | undefined
  const revision = head?.revision ?? stateRevision(await tx.objectStore('kv').get(KNOWLEDGE_KEY))
  if (revision !== opts.expectedRevision || await tx.objectStore('kv').get('importInProgress') !== undefined) return false
  for (const entry of opts.state ?? []) if (stateRevision(await tx.objectStore('kv').get(entry.key)) !== entry.expectedRevision) return false
  for (const [id, expected] of Object.entries(opts.expectedNodes ?? {})) if (((await tx.objectStore('nodes').get(id))?.updatedAt ?? null) !== expected) return false
  const nextOrder = { ...head?.nextOrder }
  for (const collection of KNOWLEDGE_COLLECTIONS) {
    for (const id of delta.deletes[collection] ?? []) await tx.objectStore('knowledgeRows').delete(knowledgeRowKey(collection, id))
    let order = nextOrder[collection] ?? 0
    for (const value of delta.upserts[collection] ?? []) {
      const key = knowledgeRowKey(collection, value.id), previous = await tx.objectStore('knowledgeRows').get(key)
      await tx.objectStore('knowledgeRows').put({ key, collection, id: value.id, order: previous?.order ?? order++, value })
    }
    for (const [position, id] of (delta.order?.[collection] ?? []).entries()) { const row = await tx.objectStore('knowledgeRows').get(knowledgeRowKey(collection, id)); if (row) await tx.objectStore('knowledgeRows').put({ ...row, order: position }) }
    nextOrder[collection] = delta.order?.[collection]?.length ?? order
  }
  for (const node of opts.nodes ?? []) await tx.objectStore('nodes').put(node)
  for (const asset of opts.assets ?? []) await tx.objectStore('assets').put(asset)
  for (const entry of opts.state ?? []) await tx.objectStore('kv').put(entry.value, entry.key)
  await tx.objectStore('knowledgeState').put({ revision: delta.revision, metadata: delta.metadata ?? head?.metadata ?? {}, nextOrder } satisfies KnowledgeHead, 'head')
  await tx.objectStore('knowledgeReceipts').put({ id: opts.idempotencyKey, fingerprint, revision: delta.revision })
  return true
}

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
  let migrationError: unknown

  const conn = await openDB<HyperspaceDB>(opts.name ?? DB_NAME, DB_VERSION, {
    upgrade(d, oldVersion, _newVersion, transaction) {
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
      if (oldVersion < 2) {
        void transaction.done.catch(() => {})
        d.createObjectStore('knowledgeRows', { keyPath: 'key' }).createIndex('collection', 'collection')
        d.createObjectStore('knowledgeState')
        d.createObjectStore('knowledgeReceipts', { keyPath: 'id' })
        // Only IDB requests are awaited: the upgrade stays one atomic transaction.
        void (async () => {
          const tx = transaction as KnowledgeTransaction
          const original = await tx.objectStore('kv').get(KNOWLEDGE_KEY)
          if (original && typeof original === 'object' && 'schemaVersion' in original && original.schemaVersion === 1 && !isKnowledgeSnapshot(original)) throw new Error('The existing corpus contains invalid or duplicate identities.')
          if (!isKnowledgeSnapshot(original)) return
          await tx.objectStore('knowledgeState').put(original, 'legacyBackup')
          await replaceKnowledge(tx, original)
          if (stableJson(await readKnowledge(tx)) !== stableJson(original)) throw new Error('The normalized corpus did not match its retained legacy backup.')
          await tx.objectStore('knowledgeState').put({ format: 2, verified: true, at: Date.now(), backup: 'knowledgeState.legacyBackup', counts: Object.fromEntries(KNOWLEDGE_COLLECTIONS.map((collection) => [collection, original[collection].length])) }, 'migration')
        })().catch((error: unknown) => { migrationError = error; transaction.abort() })
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
  }).catch((error: unknown) => { if (migrationError) throw new KnowledgeMigrationError('The knowledge migration was rolled back; the original browser world is intact.', { cause: migrationError }); throw error })
  db = conn
  // Repair receipts written by a development build that retained canonical payloads.
  // Cursor updates share one transaction, so no command can observe a partial repair.
  try {
    const repair = conn.transaction('knowledgeReceipts', 'readwrite')
    let cursor = await repair.store.openCursor()
    while (cursor) {
      const fingerprint = normalizeKnowledgeFingerprint(cursor.value.fingerprint)
      if (fingerprint !== cursor.value.fingerprint) await cursor.update({ ...cursor.value, fingerprint })
      cursor = await cursor.continue()
    }
    await repair.done
  } catch (error) { conn.close(); throw error }

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

    async readWorldSnapshot(keys) {
      const tx = live().transaction(['settings', 'nodes', 'events', 'assets', ...KNOWLEDGE_STORES], 'readonly')
      const [settings, nodes, events, assets, values] = await Promise.all([tx.objectStore('settings').get(SETTINGS_KEY), tx.objectStore('nodes').getAll(), tx.objectStore('events').getAll(), tx.objectStore('assets').getAll(), Promise.all(keys.map((key) => readValue(tx, key)))])
      await tx.done
      events.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id))
      return { settings: settings ?? null, nodes, events, assets, kv: Object.fromEntries(keys.flatMap((key, index) => values[index] === undefined ? [] : [[key, values[index]]])) }
    },
    async getKnowledgeRevision() {
      const tx = live().transaction(['knowledgeState', 'kv'], 'readonly')
      const head = await tx.objectStore('knowledgeState').get('head') as KnowledgeHead | undefined
      const revision = head?.revision ?? stateRevision(await tx.objectStore('kv').get(KNOWLEDGE_KEY))
      await tx.done
      return revision
    },
    async commitKnowledge(delta, options) {
      const fingerprint = validateKnowledgeCommit(delta, options)
      const staged = structuredClone({ delta, options })
      const tx = live().transaction([...KNOWLEDGE_STORES, 'nodes', 'assets'], 'readwrite')
      try { const applied = await applyKnowledgeCommit(tx, staged.delta, staged.options, fingerprint); await tx.done; return applied }
      catch (error) { try { tx.abort() } catch { /* transaction already failed */ }; await tx.done.catch(() => {}); throw error }
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
      if ([KNOWLEDGE_KEY, KNOWLEDGE_RECEIPTS_KEY, KNOWLEDGE_MIGRATION_KEY].includes(key)) {
        const tx = live().transaction(KNOWLEDGE_STORES, 'readonly')
        const value = await readValue(tx, key)
        await tx.done
        return value as T | undefined
      }
      return (await live().get('kv', key)) as T | undefined
    },
    async putKv(key, value) {
      if (key === KNOWLEDGE_KEY || key === KNOWLEDGE_RECEIPTS_KEY) {
        const staged = structuredClone(value), tx = live().transaction(KNOWLEDGE_STORES, 'readwrite')
        try { await writeValue(tx, key, staged); await tx.done; return }
        catch (error) { try { tx.abort() } catch { /* transaction already failed */ }; await tx.done.catch(() => {}); throw error }
      }
      await live().put('kv', value, key)
    },
    async compareAndSwapKv(key, value, expectedRevision) {
      assertRevisionMutation(value, expectedRevision)
      const staged = structuredClone(value)
      const tx = live().transaction(key === KNOWLEDGE_KEY ? KNOWLEDGE_STORES : ['kv'], 'readwrite')
      const current = key === KNOWLEDGE_KEY ? await readValue(tx, key) : await tx.objectStore('kv').get(key)
      if (stateRevision(current) !== expectedRevision) {
        await tx.done
        return false
      }
      if (key === KNOWLEDGE_KEY && isKnowledgeSnapshot(staged)) {
        const delta = diffKnowledgeSnapshots(isKnowledgeSnapshot(current) ? current : undefined, staged)
        const options = { expectedRevision, idempotencyKey: `compat:${crypto.randomUUID()}` }
        const applied = await applyKnowledgeCommit(tx, delta, options, validateKnowledgeCommit(delta, options))
        await tx.done
        return applied
      } else if (key === KNOWLEDGE_KEY) await writeValue(tx, key, staged)
      else await tx.objectStore('kv').put(staged, key)
      await tx.done
      return true
    },
    async deleteKv(key) {
      if (key === KNOWLEDGE_KEY || key === KNOWLEDGE_RECEIPTS_KEY) {
        const tx = live().transaction(KNOWLEDGE_STORES, 'readwrite')
        if (key === KNOWLEDGE_KEY) await Promise.all([tx.objectStore('knowledgeRows').clear(), tx.objectStore('knowledgeState').clear(), tx.objectStore('knowledgeReceipts').clear()])
        else await tx.objectStore('knowledgeReceipts').clear()
        await tx.objectStore('kv').delete(key); await tx.done; return
      }
      await live().delete('kv', key)
    },

    async wipe() {
      const tx = live().transaction(ALL_STORES, 'readwrite')
      await Promise.all([...ALL_STORES.map((s) => tx.objectStore(s).clear()), tx.done])
      await opfs?.clear()
    },
    async resetWithKv(key, value, preserveKeys = [], expectedKnowledgeRevision) {
      const marker = structuredClone(value)
      const tx = live().transaction(ALL_STORES, 'readwrite')
      const head = await tx.objectStore('knowledgeState').get('head') as KnowledgeHead | undefined
      if (expectedKnowledgeRevision !== undefined && (!Number.isSafeInteger(expectedKnowledgeRevision) || expectedKnowledgeRevision < 0 || (head?.revision ?? stateRevision(await tx.objectStore('kv').get(KNOWLEDGE_KEY))) !== expectedKnowledgeRevision)) {
        tx.abort()
        await tx.done.catch(() => {})
        throw new WorldStateConflictError()
      }
      const kept = await Promise.all(preserveKeys.filter((name) => name !== key).map(async (name) => [name, await readValue(tx, name)] as const))
      await Promise.all(ALL_STORES.map((name) => tx.objectStore(name).clear()))
      for (const [name, item] of kept) if (item !== undefined) await writeValue(tx, name, item)
      await writeValue(tx, key, marker)
      await tx.done
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
    if (error instanceof KnowledgeMigrationError || (error as { name?: unknown } | null)?.name === 'VersionError') throw error
    return { store: createMemoryStore(), fallback: true, error }
  }
}
