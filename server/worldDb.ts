import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { load as loadVec } from 'sqlite-vec'
import type { AssetMeta, Attachment, InteractionEvent, Link, NodeRecord, WorldSettings } from '../src/domain/types.ts'
import { assertRevisionMutation, stateRevision, WorldStateConflictError } from '../src/data/worldState.ts'
import { KnowledgeIndex } from './knowledgeIndex.ts'
import type { KnowledgeSnapshot, SearchFilters, SearchHit } from '../src/knowledge/types.ts'
import type { WorldSnapshot } from '../src/data/WorldStore.ts'
import { PORTABLE_WORLD_KEYS } from '../src/data/worldSnapshot.ts'
import { assertKnowledgeReceipt, diffKnowledgeSnapshots, isKnowledgeSnapshot, KNOWLEDGE_KEY, KNOWLEDGE_MIGRATION_KEY, KNOWLEDGE_RECEIPTS_KEY, validateKnowledgeCommit, type KnowledgeCommitOptions, type KnowledgeDelta } from '../src/knowledge/storage.ts'
import { SqliteKnowledgeStore } from './knowledgeStore.ts'
import { createKnowledgeMigrationBackup } from './knowledgeMigrationBackup.ts'
import { SqliteCrmStore } from './crmStore.ts'
import { CRM_KV } from '../src/crm/types.ts'
import { crmAssetReferences } from '../src/crm/model.ts'

// The SQLite engine (Phase 4): node:sqlite + sqlite-vec, synchronous, one connection per
// server process. It stores exactly what the browser stores, normalised per
// src/domain/schema.sql, and hands back records that are canonical-JSON-identical to the
// ones it was given (unknown keys ride in nodes.extra), so an export from either engine
// hashes the same. Blob bytes live on disk (server/blobs.ts); this file keeps their meta.

export const EMBEDDING_DIM = 512
const SCHEMA_URL = new URL('../src/domain/schema.sql', import.meta.url)

/** NodeRecord keys that have their own columns (or tables); everything else goes to extra. */
const MAPPED_KEYS = new Set([
  'id', 'slug', 'archetype', 'title', 'contentMd', 'tags', 'temporalOrigin', 'temporalPrecision', 'referenceDate',
  'thermo', 'anchorXZ', 'links', 'attachments', 'visibility', 'splat', 'entity', 'demon', 'provenance', 'createdAt',
  'updatedAt', 'deletedAt', 'schemaVersion',
])

type Row = Record<string, SQLInputValue>

const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v))
const num = (v: SQLInputValue): number => Number(v)
const str = (v: SQLInputValue): string => String(v)

export class StoreInputError extends Error {
  override name = 'StoreInputError'
}

export function openWorldDb(path: string): WorldDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path, { allowExtension: true })
  loadVec(db)
  db.exec('PRAGMA foreign_keys = ON')
  const version = num((db.prepare('PRAGMA user_version').get() as Row).user_version)
  if (version > 3) { db.close(); throw new Error('This world was written by a newer storage version. Update the app before opening it.') }
  if (version === 0) {
    db.exec(readFileSync(SCHEMA_URL, 'utf8'))
    db.exec('PRAGMA user_version = 2')
  } else if (version === 1) migrateFileKinds(db)
  try { return new WorldDb(db, version < 3 ? createKnowledgeMigrationBackup(db, path) : undefined) }
  catch (error) { db.close(); throw error }
}

/** The existing file attachment contract needs the same allowed kinds on old SQLite worlds. */
function migrateFileKinds(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      ALTER TABLE assets RENAME TO assets_v1;
      CREATE TABLE assets (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('splat-proxy','splat-interior','splat-thumb','image','image-thumb','text','file')),
        mime TEXT NOT NULL, bytes INTEGER NOT NULL CHECK (bytes >= 0),
        created_at INTEGER NOT NULL, node_id TEXT, data BLOB
      );
      INSERT INTO assets SELECT * FROM assets_v1;
      DROP TABLE assets_v1;
      CREATE INDEX assets_node ON assets (node_id);
      ALTER TABLE attachments RENAME TO attachments_v1;
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('image','text','file')),
        name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL CHECK (bytes >= 0),
        blob_id TEXT NOT NULL, thumb_blob_id TEXT, created_at INTEGER NOT NULL, ord INTEGER NOT NULL
      );
      INSERT INTO attachments SELECT * FROM attachments_v1;
      DROP TABLE attachments_v1;
      CREATE INDEX attachments_node ON attachments (node_id, ord);
      PRAGMA user_version = 2;
      COMMIT;
    `)
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

export class WorldDb {
  private replacementGeneration = 0
  /** Device-service guard: restored backups can reuse the same portable revision. */
  getReplacementGeneration(): number { return this.replacementGeneration }
  readonly db: DatabaseSync
  readonly knowledge: KnowledgeIndex
  readonly corpus: SqliteKnowledgeStore
  readonly crm: SqliteCrmStore

  constructor(db: DatabaseSync, migrationBackup?: Record<string, unknown>) {
    this.db = db
    this.knowledge = new KnowledgeIndex(db)
    this.corpus = new SqliteKnowledgeStore(db)
    this.crm = new SqliteCrmStore(this)
    // Rebuildable after migration/restore; no source content is changed by the index.
    this.tx(() => {
      if (migrationBackup && Number((db.prepare('PRAGMA data_version').get() as Row).data_version) !== migrationBackup.dataVersion) throw new Error('The world changed after its pre-migration backup; retry startup before switching knowledge storage.')
      const migrated = this.corpus.migrateLegacy(migrationBackup)
      this.crm.migrateLegacy()
      const indexed = db.prepare('SELECT revision FROM knowledge_index_state WHERE id = 1').get() as Row | undefined
      if (migrated || !indexed || Number(indexed.revision) !== this.corpus.revision()) this.knowledge.update(this.getKv(KNOWLEDGE_KEY))
      db.exec('PRAGMA user_version = 3')
    })
    db.exec(`CREATE TRIGGER IF NOT EXISTS knowledge_refuse_legacy_insert BEFORE INSERT ON kv
      WHEN NEW.key = 'knowledge.v1' AND EXISTS(SELECT 1 FROM knowledge_store_state WHERE key = 'head')
      BEGIN SELECT RAISE(ABORT, 'This world uses incremental knowledge storage; reload the app before writing.'); END;
      CREATE TRIGGER IF NOT EXISTS knowledge_refuse_legacy_update BEFORE UPDATE ON kv
      WHEN NEW.key = 'knowledge.v1' AND EXISTS(SELECT 1 FROM knowledge_store_state WHERE key = 'head')
      BEGIN SELECT RAISE(ABORT, 'This world uses incremental knowledge storage; reload the app before writing.'); END;`)
  }

  /** Run fn in one transaction: all of it commits or none of it does. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  // ── settings ──

  readWorldSnapshot(keys: readonly string[]): WorldSnapshot {
    if (keys.some((key) => !PORTABLE_WORLD_KEYS.includes(key))) throw new StoreInputError('Only portable world keys are allowed in a backup snapshot')
    return this.tx(() => ({ settings: this.getSettings(), nodes: this.listNodes(), events: this.listEvents(), assets: this.listAssets(), kv: Object.fromEntries(keys.flatMap((key) => { const value = this.getKv(key); return value === undefined ? [] : [[key, value]] })) }))
  }

  getSettings(): WorldSettings | null {
    const r = this.db.prepare('SELECT * FROM settings WHERE id = 1').get() as Row | undefined
    if (!r) return null
    return {
      T0: num(r.t0),
      yPerYear: num(r.y_per_year),
      stepsPerYear: num(r.steps_per_year),
      physicsSeed: num(r.physics_seed),
      qualityTier: str(r.quality_tier) as WorldSettings['qualityTier'],
      firstRunComplete: num(r.first_run_complete) === 1,
      lastBackupAt: r.last_backup_at === null ? null : num(r.last_backup_at),
      autoBackupEnabled: num(r.auto_backup_enabled) === 1,
      createdAt: num(r.created_at),
      schemaVersion: num(r.schema_version),
    }
  }

  putSettings(s: WorldSettings): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO settings (id, t0, y_per_year, steps_per_year, physics_seed, quality_tier,
           first_run_complete, last_backup_at, auto_backup_enabled, created_at, schema_version)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.T0, s.yPerYear, s.stepsPerYear, s.physicsSeed, s.qualityTier, s.firstRunComplete ? 1 : 0, s.lastBackupAt,
        s.autoBackupEnabled ? 1 : 0, s.createdAt, s.schemaVersion)
  }

  // ── nodes ──

  listNodes(): NodeRecord[] {
    const rows = this.db.prepare('SELECT * FROM nodes ORDER BY id').all() as Row[]
    const links = this.groupBy('SELECT * FROM links ORDER BY source_id, ord', 'source_id')
    const atts = this.groupBy('SELECT * FROM attachments ORDER BY node_id, ord', 'node_id')
    return rows.map((r) => this.toRecord(r, links.get(str(r.id)) ?? [], atts.get(str(r.id)) ?? []))
  }

  getNode(id: string): NodeRecord | undefined {
    const r = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Row | undefined
    if (!r) return undefined
    const links = this.db.prepare('SELECT * FROM links WHERE source_id = ? ORDER BY ord').all(id) as Row[]
    const atts = this.db.prepare('SELECT * FROM attachments WHERE node_id = ? ORDER BY ord').all(id) as Row[]
    return this.toRecord(r, links, atts)
  }

  putNodes(ns: readonly NodeRecord[]): void {
    for (const n of ns) assertNode(n)
    this.tx(() => {
      for (const n of ns) this.writeNode(n)
    })
  }

  deleteNode(id: string): void {
    // links and attachments cascade
    this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id)
  }

  private writeNode(n: NodeRecord): void {
    const extra: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(n)) if (!MAPPED_KEYS.has(k) && v !== undefined) extra[k] = v
    this.db.prepare('DELETE FROM nodes WHERE id = ?').run(n.id)
    this.db
      .prepare(
        `INSERT INTO nodes (id, slug, archetype, title, content_md, tags, temporal_origin, temporal_precision,
           reference_date, mass, temperature, anchor_x, anchor_z, visibility, splat, entity_kind, demon,
           created_at, updated_at, deleted_at, schema_version, provenance, extra)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(n.id, n.slug, n.archetype, n.title, n.contentMd, JSON.stringify(n.tags), n.temporalOrigin, n.temporalPrecision,
        json(n.referenceDate), n.thermo.mass, n.thermo.temperature, n.anchorXZ[0], n.anchorXZ[1], n.visibility,
        json(n.splat), n.entity?.kind ?? null, json(n.demon), n.createdAt, n.updatedAt, n.deletedAt, n.schemaVersion,
        json(n.provenance), Object.keys(extra).length ? JSON.stringify(extra) : null)
    const link = this.db.prepare('INSERT INTO links (source_id, target_id, kind, label, created_at, ord) VALUES (?, ?, ?, ?, ?, ?)')
    n.links.forEach((l, i) => link.run(n.id, l.targetId, l.kind, l.label ?? null, l.createdAt, i))
    const att = this.db.prepare(
      `INSERT INTO attachments (id, node_id, kind, name, mime, bytes, blob_id, thumb_blob_id, created_at, ord)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    n.attachments.forEach((a, i) => att.run(a.id, n.id, a.kind, a.name, a.mime, a.bytes, a.blobId, a.thumbBlobId ?? null, a.createdAt, i))
  }

  private groupBy(sql: string, key: string): Map<string, Row[]> {
    const out = new Map<string, Row[]>()
    for (const r of this.db.prepare(sql).all() as Row[]) {
      const k = str(r[key])
      const list = out.get(k)
      if (list) list.push(r)
      else out.set(k, [r])
    }
    return out
  }

  private toRecord(r: Row, links: Row[], atts: Row[]): NodeRecord {
    const rec: NodeRecord = {
      ...(r.extra === null ? {} : (JSON.parse(str(r.extra)) as object)),
      id: str(r.id),
      slug: str(r.slug),
      archetype: str(r.archetype) as NodeRecord['archetype'],
      title: str(r.title),
      contentMd: str(r.content_md),
      tags: JSON.parse(str(r.tags)) as string[],
      temporalOrigin: num(r.temporal_origin),
      temporalPrecision: str(r.temporal_precision) as NodeRecord['temporalPrecision'],
      referenceDate: r.reference_date === null ? null : (JSON.parse(str(r.reference_date)) as NodeRecord['referenceDate']),
      thermo: { mass: num(r.mass), temperature: num(r.temperature) },
      anchorXZ: [num(r.anchor_x), num(r.anchor_z)],
      links: links.map((l): Link => {
        const out: Link = { targetId: str(l.target_id), kind: str(l.kind) as Link['kind'], createdAt: num(l.created_at) }
        if (l.label !== null) out.label = str(l.label)
        return out
      }),
      attachments: atts.map((a): Attachment => {
        const out: Attachment = {
          id: str(a.id),
          kind: str(a.kind) as Attachment['kind'],
          name: str(a.name),
          mime: str(a.mime),
          bytes: num(a.bytes),
          blobId: str(a.blob_id),
          createdAt: num(a.created_at),
        }
        if (a.thumb_blob_id !== null) out.thumbBlobId = str(a.thumb_blob_id)
        return out
      }),
      visibility: str(r.visibility) as NodeRecord['visibility'],
      createdAt: num(r.created_at),
      updatedAt: num(r.updated_at),
      deletedAt: r.deleted_at === null ? null : num(r.deleted_at),
      schemaVersion: num(r.schema_version),
    }
    if (r.splat !== null) rec.splat = JSON.parse(str(r.splat)) as NodeRecord['splat']
    if (r.entity_kind !== null) rec.entity = { kind: str(r.entity_kind) as NonNullable<NodeRecord['entity']>['kind'] }
    if (r.demon !== null) rec.demon = JSON.parse(str(r.demon)) as NodeRecord['demon']
    if (r.provenance !== null) rec.provenance = JSON.parse(str(r.provenance)) as NodeRecord['provenance']
    return rec
  }

  // ── events ──

  appendEvent(e: InteractionEvent): void {
    if (typeof e?.id !== 'string') throw new StoreInputError('appendEvent: id must be a string key')
    this.db
      .prepare('INSERT OR REPLACE INTO events (id, t, kind, node_id, amplitude, demon_id, bits) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(e.id, e.t, e.kind, e.nodeId, e.amplitude ?? null, e.demonId ?? null, e.bits ?? null)
  }

  listEvents(sinceT?: number): InteractionEvent[] {
    const rows = (
      sinceT === undefined
        ? this.db.prepare('SELECT * FROM events ORDER BY t, id').all()
        : this.db.prepare('SELECT * FROM events WHERE t >= ? ORDER BY t, id').all(sinceT)
    ) as Row[]
    return rows.map((r) => {
      const e: InteractionEvent = { id: str(r.id), t: num(r.t), kind: str(r.kind) as InteractionEvent['kind'], nodeId: str(r.node_id) }
      if (r.amplitude !== null) e.amplitude = num(r.amplitude)
      if (r.demon_id !== null) e.demonId = str(r.demon_id)
      if (r.bits !== null) e.bits = num(r.bits)
      return e
    })
  }

  clearEvents(beforeT?: number): number {
    const res = beforeT === undefined ? this.db.prepare('DELETE FROM events').run() : this.db.prepare('DELETE FROM events WHERE t < ?').run(beforeT)
    return num(res.changes)
  }

  // ── asset meta (bytes on disk) ──

  putAssetMeta(m: AssetMeta): void {
    this.db
      .prepare('INSERT OR REPLACE INTO assets (id, kind, mime, bytes, created_at, node_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(m.id, m.kind, m.mime, m.bytes, m.createdAt, m.nodeId)
  }

  getAssetMeta(id: string): AssetMeta | undefined {
    const r = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Row | undefined
    return r ? toMeta(r) : undefined
  }

  listAssets(): AssetMeta[] {
    return (this.db.prepare('SELECT * FROM assets ORDER BY id').all() as Row[]).map(toMeta)
  }

  deleteAssetMeta(id: string): void {
    if (this.crm.hasData() && crmAssetReferences(this.crm.getSnapshot()).has(id)) throw new StoreInputError('This original is retained by People, a comment, or CRM history. Preserve it when removing other files.')
    this.db.prepare('DELETE FROM assets WHERE id = ?').run(id)
  }

  // ── kv ──

  getKv<T = unknown>(key: string): T | undefined
  getKv(key: string): unknown {
    if (key === CRM_KV && this.crm.hasData()) return this.crm.getSnapshot()
    if (key === KNOWLEDGE_KEY && this.corpus.head()) return this.corpus.read()
    if (key === KNOWLEDGE_RECEIPTS_KEY) { const rows = this.corpus.receipts(); return rows.length ? rows : undefined }
    if (key === KNOWLEDGE_MIGRATION_KEY) return this.corpus.state('migration')
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined
    return r ? JSON.parse(str(r.value)) : undefined
  }

  putKv(key: string, value: unknown): void {
    if (key === KNOWLEDGE_KEY || key === KNOWLEDGE_RECEIPTS_KEY || key === CRM_KV) {
      this.tx(() => this.writeKv(key, value))
    } else this.writeKv(key, value)
  }

  private writeKv(key: string, value: unknown): void {
    if (key === CRM_KV) { this.crm.restoreSnapshot(value); this.db.prepare('DELETE FROM kv WHERE key = ?').run(key); return }
    if (key === KNOWLEDGE_RECEIPTS_KEY) { this.corpus.setReceipts(value); return }
    if (key === KNOWLEDGE_KEY && isKnowledgeSnapshot(value)) {
      this.corpus.replace(value)
      this.db.prepare('DELETE FROM kv WHERE key = ?').run(key)
      this.knowledge.update(value)
      return
    }
    if (key === KNOWLEDGE_KEY && this.corpus.head()) throw new StoreInputError('Unsupported knowledge format; the current corpus was preserved.')
    this.db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, JSON.stringify(value))
    if (key === 'knowledge.v1') this.knowledge.update(value)
  }

  compareAndSwapKv(key: string, value: unknown, expectedRevision: number): boolean {
    try { assertRevisionMutation(value, expectedRevision) } catch (e) {
      throw new StoreInputError(e instanceof Error ? e.message : 'Invalid state revision')
    }
    return this.tx(() => {
      if ((key === KNOWLEDGE_KEY ? this.getKnowledgeRevision() : stateRevision(this.getKv(key))) !== expectedRevision) return false
      if (key === KNOWLEDGE_KEY && isKnowledgeSnapshot(value)) return this.writeKnowledgeDelta(diffKnowledgeSnapshots(this.corpus.read(), value), { expectedRevision, idempotencyKey: `compat:${crypto.randomUUID()}` })
      this.writeKv(key, value)
      return true
    })
  }

  /** Local capture commits a ledger and its projections together after asynchronous I/O. */
  compareAndSwapKnowledge(value: KnowledgeSnapshot, expectedRevision: number, nodes: readonly NodeRecord[], expectedNodes: Readonly<Record<string, number | null>> = {}, assets: readonly AssetMeta[] = []): boolean {
    try { assertRevisionMutation(value, expectedRevision) } catch (error) { throw new StoreInputError(error instanceof Error ? error.message : 'Invalid knowledge revision') }
    for (const node of nodes) assertNode(node)
    return this.tx(() => {
      if (this.getKv('importInProgress') !== undefined) return false
      if (this.getKnowledgeRevision() !== expectedRevision) return false
      for (const node of nodes) {
        const current = this.getNode(node.id)
        if (!(node.id in expectedNodes) || (current?.updatedAt ?? null) !== expectedNodes[node.id]) return false
        // A background source refresh never changes a user's spatial placement inputs.
        if (current && (JSON.stringify(node.anchorXZ) !== JSON.stringify(current.anchorXZ) || JSON.stringify(node.fieldAnchorXZ) !== JSON.stringify(current.fieldAnchorXZ))) return false
      }
      return this.writeKnowledgeDelta(diffKnowledgeSnapshots(this.corpus.read(), value), { expectedRevision, idempotencyKey: `capture:${crypto.randomUUID()}`, nodes: [...nodes], assets: [...assets] })
    })
  }

  deleteKv(key: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM kv WHERE key = ?').run(key)
      if (key === CRM_KV) this.crm.clear()
      if (key === KNOWLEDGE_KEY) { this.corpus.clear(); this.knowledge.clear() }
      if (key === KNOWLEDGE_RECEIPTS_KEY) this.corpus.setReceipts([])
    })
  }

  searchKnowledge(query: string, filters: SearchFilters = {}): { revision: number; hits: SearchHit[] } {
    return this.knowledge.search(query, filters)
  }

  getKnowledgeRevision(): number {
    const head = this.corpus.head()
    if (head) return head.revision
    const legacy = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(KNOWLEDGE_KEY) as Row | undefined
    return legacy ? stateRevision(JSON.parse(String(legacy.value))) : 0
  }

  commitKnowledge(delta: KnowledgeDelta, opts: KnowledgeCommitOptions): boolean {
    try { validateKnowledgeCommit(delta, opts) } catch (error) { throw new StoreInputError(error instanceof Error ? error.message : 'Invalid knowledge command') }
    for (const node of opts.nodes ?? []) assertNode(node)
    return this.tx(() => this.writeKnowledgeDelta(delta, opts))
  }

  private writeKnowledgeDelta(delta: KnowledgeDelta, opts: KnowledgeCommitOptions): boolean {
    const fingerprint = validateKnowledgeCommit(delta, opts)
    if (assertKnowledgeReceipt(this.corpus.receipt(opts.idempotencyKey), fingerprint)) return true
    if (this.getKv('importInProgress') !== undefined || this.getKnowledgeRevision() !== opts.expectedRevision) return false
    for (const entry of opts.state ?? []) if (stateRevision(this.getKv(entry.key)) !== entry.expectedRevision) return false
    for (const [id, expected] of Object.entries(opts.expectedNodes ?? {})) if ((this.getNode(id)?.updatedAt ?? null) !== expected) return false
    if (!this.corpus.commit(delta, opts)) return false
    for (const meta of opts.assets ?? []) this.putAssetMeta(meta)
    for (const node of opts.nodes ?? []) this.writeNode(node)
    for (const entry of opts.state ?? []) this.writeKv(entry.key, entry.value)
    this.knowledge.updateDelta(delta, (id) => this.corpus.row('versions', id), (id) => this.corpus.row('sources', id))
    return true
  }

  // ── embeddings (derived; never exported) ──

  putEmbedding(nodeId: string, vector: Float32Array, textHash: string, model: string, now: number): void {
    if (vector.length !== EMBEDDING_DIM) throw new StoreInputError(`embedding must have ${EMBEDDING_DIM} dimensions`)
    this.tx(() => {
      // vec0 has no upsert
      this.db.prepare('DELETE FROM embeddings WHERE node_id = ?').run(nodeId)
      this.db.prepare('INSERT INTO embeddings (node_id, embedding) VALUES (?, ?)').run(nodeId, f32Bytes(vector))
      this.db
        .prepare('INSERT OR REPLACE INTO embedding_meta (node_id, text_hash, model, updated_at) VALUES (?, ?, ?, ?)')
        .run(nodeId, textHash, model, now)
    })
  }

  deleteEmbedding(nodeId: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM embeddings WHERE node_id = ?').run(nodeId)
      this.db.prepare('DELETE FROM embedding_meta WHERE node_id = ?').run(nodeId)
    })
  }

  embeddingMeta(): { id: string; hash: string; model: string }[] {
    return (this.db.prepare('SELECT * FROM embedding_meta ORDER BY node_id').all() as Row[]).map((r) => ({
      id: str(r.node_id),
      hash: str(r.text_hash),
      model: str(r.model),
    }))
  }

  allEmbeddings(): { id: string; vector: Float32Array }[] {
    return (this.db.prepare('SELECT node_id, embedding FROM embeddings ORDER BY node_id').all() as Row[]).map((r) => ({
      id: str(r.node_id),
      vector: bytesF32(r.embedding as Uint8Array),
    }))
  }

  /** k nearest by cosine distance (sqlite-vec KNN). */
  knn(vector: Float32Array, k: number): { id: string; distance: number }[] {
    if (vector.length !== EMBEDDING_DIM) throw new StoreInputError(`query must have ${EMBEDDING_DIM} dimensions`)
    const n = Math.max(1, Math.min(200, Math.floor(k)))
    return (
      this.db.prepare('SELECT node_id, distance FROM embeddings WHERE embedding MATCH ? AND k = ? ORDER BY distance').all(f32Bytes(vector), n) as Row[]
    ).map((r) => ({ id: str(r.node_id), distance: num(r.distance) }))
  }

  /** Everything except embeddings (those are derived from the records, not part of the world). */
  resetWithKv(key: string, value: unknown, preserveKeys: readonly string[] = [], expectedKnowledgeRevision?: number): void {
    const marker = JSON.parse(JSON.stringify(value)) as unknown
    this.tx(() => {
      if (expectedKnowledgeRevision !== undefined && (!Number.isSafeInteger(expectedKnowledgeRevision) || expectedKnowledgeRevision < 0 || stateRevision(this.getKv('knowledge.v1')) !== expectedKnowledgeRevision)) throw new WorldStateConflictError()
      const kept = preserveKeys.filter((name) => name !== key).map((name) => [name, this.getKv(name)] as const)
      for (const table of ['links', 'attachments', 'nodes', 'events', 'assets', 'kv', 'settings']) this.db.exec(`DELETE FROM ${table}`)
      this.corpus.clear()
      this.crm.clear()
      this.knowledge.clear()
      for (const [name, item] of kept) if (item !== undefined) this.writeKv(name, item)
      this.writeKv(key, marker)
    })
    this.replacementGeneration++
  }

  /** Everything except embeddings (those are derived from the records, not part of the world). */
  wipe(): void {
    this.tx(() => {
      for (const t of ['links', 'attachments', 'nodes', 'events', 'assets', 'kv', 'settings']) this.db.exec(`DELETE FROM ${t}`)
      this.corpus.clear()
      this.crm.clear()
      this.knowledge.clear()
    })
    this.replacementGeneration++
  }

  wipeEmbeddings(): void {
    this.tx(() => {
      this.db.exec('DELETE FROM embeddings')
      this.db.exec('DELETE FROM embedding_meta')
    })
  }

  close(): void {
    this.db.close()
  }
}

function toMeta(r: Row): AssetMeta {
  return {
    id: str(r.id),
    kind: str(r.kind) as AssetMeta['kind'],
    mime: str(r.mime),
    bytes: num(r.bytes),
    createdAt: num(r.created_at),
    nodeId: r.node_id === null ? null : str(r.node_id),
  }
}

export function f32Bytes(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
}

export function bytesF32(b: Uint8Array): Float32Array {
  // Copy: the row buffer may not be 4-byte aligned.
  return new Float32Array(b.slice().buffer)
}

/** Shape checks the browser's IndexedDB would also enforce (a key) plus what the columns need. */
function assertNode(n: NodeRecord): void {
  if (typeof n?.id !== 'string') throw new StoreInputError('putNode: id must be a string key')
  if (typeof n.contentMd !== 'string' || typeof n.title !== 'string' || !Array.isArray(n.tags) || !n.thermo || !Array.isArray(n.anchorXZ)) {
    throw new StoreInputError(`putNode: record ${n.id} is malformed`)
  }
  if (!Array.isArray(n.links) || !Array.isArray(n.attachments)) throw new StoreInputError(`putNode: record ${n.id} is malformed`)
}
