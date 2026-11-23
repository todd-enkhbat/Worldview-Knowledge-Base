import type { AssetMeta, InteractionEvent, NodeRecord, WorldSettings } from '../domain/types.ts'
import type { BlobInput, StoreInfo, WorldStore } from './WorldStore.ts'
import { assertRevisionMutation, stateRevision, WorldStateConflictError } from './worldState.ts'
import { assertKnowledgeReceipt, diffKnowledgeSnapshots, isKnowledgeSnapshot, KNOWLEDGE_KEY, KNOWLEDGE_MIGRATION_KEY, KNOWLEDGE_RECEIPTS_KEY, KnowledgeMemory, normalizeKnowledgeReceipts, validateKnowledgeCommit } from '../knowledge/storage.ts'

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
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
  return new Uint8Array(await data.arrayBuffer())
}

export function createMemoryStore(): WorldStore {
  let settings: WorldSettings | null = null
  const nodes = new Map<string, NodeRecord>()
  const events = new Map<string, InteractionEvent>()
  const blobs = new Map<string, StoredBytes>()
  const kv = new Map<string, unknown>()
  const knowledge = new KnowledgeMemory()
  const getValue = (key: string): unknown => key === KNOWLEDGE_KEY ? knowledge.read() ?? kv.get(key) : key === KNOWLEDGE_RECEIPTS_KEY ? knowledge.receipts.size ? [...knowledge.receipts.values()] : undefined : key === KNOWLEDGE_MIGRATION_KEY ? knowledge.migration : kv.get(key)
  const putValue = (key: string, value: unknown) => {
    if (key === KNOWLEDGE_KEY && isKnowledgeSnapshot(value)) { knowledge.replace(value); kv.delete(key); return }
    if (key === KNOWLEDGE_KEY && knowledge.head) throw new Error('Unsupported knowledge format; the current corpus was preserved.')
    if (key === KNOWLEDGE_RECEIPTS_KEY) {
      knowledge.receipts = new Map(normalizeKnowledgeReceipts(structuredClone(value)).map((row) => [row.id, row])); return
    }
    kv.set(key, structuredClone(value))
  }
  const info: StoreInfo = { kind: 'memory', blobBackend: 'memory' }

  return {
    info,

    async readWorldSnapshot(keys) {
      return structuredClone({ settings, nodes: [...nodes.values()].sort(byId), events: [...events.values()].sort(byTimeThenId), assets: [...blobs.values()].map((blob) => blob.meta).sort(byId), kv: Object.fromEntries(keys.flatMap((key) => { const value = getValue(key); return value === undefined ? [] : [[key, value]] })) })
    },
    async getKnowledgeRevision() { return knowledge.head?.revision ?? stateRevision(kv.get(KNOWLEDGE_KEY)) },
    async commitKnowledge(delta, opts) {
      const fingerprint = validateKnowledgeCommit(delta, opts)
      const staged = structuredClone({ delta, opts })
      if (assertKnowledgeReceipt(knowledge.receipts.get(opts.idempotencyKey), fingerprint)) return true
      if (kv.get('importInProgress') !== undefined || (knowledge.head?.revision ?? stateRevision(kv.get(KNOWLEDGE_KEY))) !== opts.expectedRevision) return false
      for (const entry of staged.opts.state ?? []) if (stateRevision(kv.get(entry.key)) !== entry.expectedRevision) return false
      for (const [id, expected] of Object.entries(opts.expectedNodes ?? {})) if ((nodes.get(id)?.updatedAt ?? null) !== expected) return false
      for (const node of staged.opts.nodes ?? []) assertKey(node.id, 'commitKnowledge')
      for (const meta of staged.opts.assets ?? []) if (!blobs.has(meta.id)) throw new Error('Original bytes must be retained before their asset metadata is committed.')
      if (!knowledge.commit(staged.delta, staged.opts)) return false
      for (const node of staged.opts.nodes ?? []) nodes.set(node.id, node)
      for (const meta of staged.opts.assets ?? []) blobs.get(meta.id)!.meta = meta
      for (const entry of staged.opts.state ?? []) kv.set(entry.key, entry.value)
      return true
    },

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
      return structuredClone(getValue(key)) as T | undefined
    },
    async putKv(key, value) {
      putValue(key, value)
    },
    async compareAndSwapKv(key, value, expectedRevision) {
      assertRevisionMutation(value, expectedRevision)
      const staged = structuredClone(value)
      if (stateRevision(getValue(key)) !== expectedRevision) return false
      if (key === KNOWLEDGE_KEY && isKnowledgeSnapshot(staged)) return knowledge.commit(diffKnowledgeSnapshots(knowledge.read(), staged), { expectedRevision, idempotencyKey: `compat:${crypto.randomUUID()}` })
      putValue(key, staged)
      return true
    },
    async deleteKv(key) {
      kv.delete(key)
      if (key === KNOWLEDGE_KEY) knowledge.clear()
      if (key === KNOWLEDGE_RECEIPTS_KEY) knowledge.receipts.clear()
    },

    async wipe() {
      settings = null
      nodes.clear()
      events.clear()
      blobs.clear()
      kv.clear()
      knowledge.clear()
    },
    async resetWithKv(key, value, preserveKeys = [], expectedKnowledgeRevision) {
      const marker = structuredClone(value)
      if (expectedKnowledgeRevision !== undefined && (!Number.isSafeInteger(expectedKnowledgeRevision) || expectedKnowledgeRevision < 0 || stateRevision(getValue(KNOWLEDGE_KEY)) !== expectedKnowledgeRevision)) throw new WorldStateConflictError()
      const kept = new Map(preserveKeys.filter((name) => name !== key).map((name) => [name, getValue(name)]))
      settings = null; nodes.clear(); events.clear(); blobs.clear(); kv.clear(); knowledge.clear()
      for (const [name, item] of kept) if (item !== undefined) putValue(name, item)
      putValue(key, marker)
    },
    close() {
      // Nothing to release; the data lives as long as this object.
    },
  }
}
