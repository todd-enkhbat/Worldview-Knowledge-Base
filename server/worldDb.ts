import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { load as loadVec } from 'sqlite-vec'
import type { AssetMeta, Attachment, InteractionEvent, Link, NodeRecord, WorldSettings } from '../src/domain/types.ts'

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
  if (version === 0) {
    db.exec(readFileSync(SCHEMA_URL, 'utf8'))
    db.exec('PRAGMA user_version = 1')
  }
  return new WorldDb(db)
}

export class WorldDb {
  readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
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
    this.db.prepare('DELETE FROM assets WHERE id = ?').run(id)
  }

  // ── kv ──

  getKv(key: string): unknown {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined
    return r ? JSON.parse(str(r.value)) : undefined
  }

  putKv(key: string, value: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, JSON.stringify(value))
  }

  deleteKv(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key)
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
  wipe(): void {
    this.tx(() => {
      for (const t of ['links', 'attachments', 'nodes', 'events', 'assets', 'kv', 'settings']) this.db.exec(`DELETE FROM ${t}`)
    })
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
