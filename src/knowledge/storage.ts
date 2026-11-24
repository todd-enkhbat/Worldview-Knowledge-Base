import type { KnowledgeSnapshot } from './types.ts'
import type { AssetMeta, NodeRecord } from '../domain/types.ts'
import { assertRevisionMutation } from '../data/worldState.ts'
import { sha256Text } from '../data/sha256.ts'

export const KNOWLEDGE_KEY = 'knowledge.v1'
export const KNOWLEDGE_RECEIPTS_KEY = 'knowledge.receipts.v1'
export const KNOWLEDGE_MIGRATION_KEY = 'knowledge.migration.v1'
export const KNOWLEDGE_COLLECTIONS = ['sources', 'versions', 'passages', 'imports', 'proposals', 'jobs'] as const
export type KnowledgeCollection = typeof KNOWLEDGE_COLLECTIONS[number]
export type KnowledgeRow = KnowledgeSnapshot[KnowledgeCollection][number]
export type KnowledgeUpserts = Partial<{ [K in KnowledgeCollection]: KnowledgeSnapshot[K] }>
export interface KnowledgeDelta {
  schemaVersion: 1
  revision: number
  upserts: KnowledgeUpserts
  deletes: Partial<Record<KnowledgeCollection, string[]>>
  /** Replace root extension fields only when changed; row extensions live in their row. */
  metadata?: Record<string, unknown>
  /** Explicit ordering is rare; normal upserts append only new identities. */
  order?: Partial<Record<KnowledgeCollection, string[]>>
}
export interface KnowledgeCommitOptions {
  expectedRevision: number
  idempotencyKey: string
  /** Optional atomic projections, after original blob bytes have been retained. */
  nodes?: NodeRecord[]
  expectedNodes?: Record<string, number | null>
  assets?: AssetMeta[]
  /** Sidecars whose changes must share the corpus transaction (for example, purging a voice original). */
  state?: { key: 'voiceInbox.v1' | 'artifacts.v1' | 'collections.v1' | 'reading.v1' | 'reading.capture.receipts.v1'; value: unknown; expectedRevision: number }[]
}
export interface KnowledgeReceipt { id: string; fingerprint: string; revision: number }
export interface KnowledgeHead { revision: number; metadata: Record<string, unknown>; nextOrder?: Partial<Record<KnowledgeCollection, number>> }
export interface StoredKnowledgeRow { key: string; collection: KnowledgeCollection; id: string; order: number; value: KnowledgeRow }
export class KnowledgeMigrationError extends Error { override name = 'KnowledgeMigrationError' }

const own = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const reserved = new Set<string>(['schemaVersion', 'revision', ...KNOWLEDGE_COLLECTIONS])
export const knowledgeRowKey = (collection: KnowledgeCollection, id: string): string => JSON.stringify([collection, id])

export function isKnowledgeSnapshot(value: unknown): value is KnowledgeSnapshot {
  if (!own(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return false
  return KNOWLEDGE_COLLECTIONS.every((collection) => {
    const rows = value[collection]
    return Array.isArray(rows) && rows.every((row) => own(row) && typeof row.id === 'string' && row.id.length > 0) && new Set(rows.map((row) => row.id)).size === rows.length
  })
}

export function snapshotMetadata(snapshot: KnowledgeSnapshot): Record<string, unknown> {
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) => !reserved.has(key)))
}

export function diffKnowledgeSnapshots(previous: KnowledgeSnapshot | undefined, next: KnowledgeSnapshot): KnowledgeDelta {
  if (!isKnowledgeSnapshot(next) || previous && !isKnowledgeSnapshot(previous)) throw new Error('Invalid knowledge snapshot; no corpus rows were changed.')
  const delta: KnowledgeDelta = { schemaVersion: 1, revision: next.revision, upserts: {}, deletes: {} }
  for (const collection of KNOWLEDGE_COLLECTIONS) {
    const old = new Map((previous?.[collection] ?? []).map((row) => [row.id, row]))
    const current = new Map(next[collection].map((row) => [row.id, row]))
    const changed = next[collection].filter((row) => { const before = old.get(row.id); return before !== row && (before === undefined || JSON.stringify(before) !== JSON.stringify(row)) })
    if (changed.length) (delta.upserts as Record<string, KnowledgeRow[]>)[collection] = changed
    const removed = [...old.keys()].filter((id) => !current.has(id))
    if (removed.length) delta.deletes[collection] = removed
    const natural = [...old.keys()].filter((id) => current.has(id)).concat([...current.keys()].filter((id) => !old.has(id)))
    const wanted = [...current.keys()]
    if (natural.some((id, index) => wanted[index] !== id)) { delta.order ??= {}; delta.order[collection] = wanted }
  }
  const metadata = snapshotMetadata(next)
  if (!previous || JSON.stringify(snapshotMetadata(previous)) !== JSON.stringify(metadata)) delta.metadata = metadata
  return delta
}

export function validateKnowledgeCommit(delta: KnowledgeDelta, opts: KnowledgeCommitOptions): string {
  if (!own(delta) || delta.schemaVersion !== 1 || !Number.isSafeInteger(opts.expectedRevision) || opts.expectedRevision < 0 || !Number.isSafeInteger(delta.revision) || delta.revision !== opts.expectedRevision + 1) throw new Error('A knowledge command must advance its expected revision exactly once.')
  if (typeof opts.idempotencyKey !== 'string' || opts.idempotencyKey.length < 1 || opts.idempotencyKey.length > 200) throw new Error('A knowledge command requires a bounded idempotency key.')
  if (!own(delta.upserts) || !own(delta.deletes)) throw new Error('Knowledge delta rows must be objects.')
  for (const field of ['upserts', 'deletes', 'order'] as const) {
    const values = delta[field]
    if (values === undefined && field === 'order') continue
    if (!own(values) || Object.keys(values).some((key) => !KNOWLEDGE_COLLECTIONS.includes(key as KnowledgeCollection))) throw new Error(`Unknown knowledge collection in ${field}.`)
    for (const collection of KNOWLEDGE_COLLECTIONS) {
      const rows = values[collection]
      if (rows === undefined) continue
      if (!Array.isArray(rows)) throw new Error('Knowledge rows must be arrays.')
      const ids: unknown[] = field === 'upserts' ? rows.map((row) => own(row) && typeof row.id === 'string' ? row.id : null) : rows
      if (ids.some((id) => typeof id !== 'string' || !id.length) || new Set(ids).size !== ids.length) throw new Error('Knowledge row identities must be unique nonempty strings.')
    }
  }
  if (delta.metadata !== undefined && (!own(delta.metadata) || Object.keys(delta.metadata).some((key) => reserved.has(key)))) throw new Error('Knowledge extension fields cannot replace canonical collections.')
  if (opts.state !== undefined) {
    if (!Array.isArray(opts.state) || new Set(opts.state.map((entry) => entry.key)).size !== opts.state.length) throw new Error('Atomic knowledge sidecars must have unique keys.')
    for (const entry of opts.state) {
      if (!entry || !['voiceInbox.v1', 'artifacts.v1', 'collections.v1', 'reading.v1', 'reading.capture.receipts.v1'].includes(entry.key)) throw new Error('Unsupported atomic knowledge sidecar.')
      assertRevisionMutation(entry.value, entry.expectedRevision)
    }
  }
  // Receipts retain a digest only, so permanently purged wording cannot survive here.
  return `sha256:${sha256Text(stableJson({ delta, expectedRevision: opts.expectedRevision, nodes: opts.nodes, expectedNodes: opts.expectedNodes, assets: opts.assets, state: opts.state }))}`
}

export function normalizeKnowledgeFingerprint(value: string): string { return /^sha256:[a-f0-9]{64}$/.test(value) ? value : `sha256:${sha256Text(value)}` }

export function normalizeKnowledgeReceipts(value: unknown): KnowledgeReceipt[] {
  if (!Array.isArray(value) || value.some((row) => !own(row) || typeof row.id !== 'string' || !row.id || typeof row.fingerprint !== 'string' || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 0) || new Set(value.map((row) => row.id)).size !== value.length) throw new Error('Invalid knowledge command receipts')
  return value.map((row: KnowledgeReceipt) => ({ ...row, fingerprint: normalizeKnowledgeFingerprint(row.fingerprint) }))
}

export function assertKnowledgeReceipt(receipt: KnowledgeReceipt | undefined, fingerprint: string): boolean {
  if (!receipt) return false
  if (normalizeKnowledgeFingerprint(receipt.fingerprint) !== fingerprint) throw new Error('The idempotency key was already used for a different knowledge command.')
  return true
}

export function materializeKnowledge(head: KnowledgeHead | undefined, rows: readonly StoredKnowledgeRow[]): KnowledgeSnapshot | undefined {
  if (!head) return undefined
  const snapshot = { ...head.metadata, schemaVersion: 1, revision: head.revision } as unknown as KnowledgeSnapshot
  for (const collection of KNOWLEDGE_COLLECTIONS) (snapshot as unknown as Record<string, unknown>)[collection] = rows.filter((row) => row.collection === collection).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map((row) => row.value)
  return snapshot
}

/** Normalized in-memory authority also serves as the reference semantics for adapters. */
export class KnowledgeMemory {
  head: KnowledgeHead | undefined
  rows = new Map<string, StoredKnowledgeRow>()
  receipts = new Map<string, KnowledgeReceipt>()
  nextOrder = new Map<KnowledgeCollection, number>()
  migration: Record<string, unknown> | undefined
  legacyBackup: unknown
  read(): KnowledgeSnapshot | undefined { return materializeKnowledge(this.head, [...this.rows.values()]) }
  clear(): void { this.head = undefined; this.rows.clear(); this.receipts.clear(); this.nextOrder.clear(); this.migration = undefined; this.legacyBackup = undefined }
  replace(snapshot: KnowledgeSnapshot): void {
    const next = new Map<string, StoredKnowledgeRow>()
    for (const collection of KNOWLEDGE_COLLECTIONS) snapshot[collection].forEach((value, order) => { const key = knowledgeRowKey(collection, value.id); next.set(key, { key, collection, id: value.id, order, value: structuredClone(value) }) })
    const head = { revision: snapshot.revision, metadata: structuredClone(snapshotMetadata(snapshot)) }
    if (JSON.stringify(materializeKnowledge(head, [...next.values()])) !== JSON.stringify(snapshot)) {
      // Root JSON key order is not semantic; compare values with a canonical key traversal.
      if (stableJson(materializeKnowledge(head, [...next.values()])) !== stableJson(snapshot)) throw new Error('Knowledge migration verification failed; original snapshot retained.')
    }
    this.head = head; this.rows = next; this.receipts.clear()
    for (const collection of KNOWLEDGE_COLLECTIONS) this.nextOrder.set(collection, snapshot[collection].length)
  }
  commit(delta: KnowledgeDelta, opts: KnowledgeCommitOptions): boolean {
    const fingerprint = validateKnowledgeCommit(delta, opts)
    delta = structuredClone(delta)
    if (assertKnowledgeReceipt(this.receipts.get(opts.idempotencyKey), fingerprint)) return true
    if ((this.head?.revision ?? 0) !== opts.expectedRevision) return false
    for (const collection of KNOWLEDGE_COLLECTIONS) {
      for (const id of delta.deletes[collection] ?? []) this.rows.delete(knowledgeRowKey(collection, id))
      let order = this.nextOrder.get(collection) ?? 0
      for (const value of delta.upserts[collection] ?? []) {
        const key = knowledgeRowKey(collection, value.id), previous = this.rows.get(key)
        this.rows.set(key, { key, collection, id: value.id, order: previous?.order ?? order++, value: structuredClone(value) })
      }
      for (const [position, id] of (delta.order?.[collection] ?? []).entries()) { const row = this.rows.get(knowledgeRowKey(collection, id)); if (row) row.order = position }
      this.nextOrder.set(collection, delta.order?.[collection]?.length ?? order)
    }
    this.head = { revision: delta.revision, metadata: structuredClone(delta.metadata ?? this.head?.metadata ?? {}) }
    this.receipts.set(opts.idempotencyKey, { id: opts.idempotencyKey, fingerprint, revision: delta.revision })
    return true
  }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (own(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
