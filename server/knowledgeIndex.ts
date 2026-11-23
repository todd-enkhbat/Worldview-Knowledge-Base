import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { KnowledgePassage, KnowledgeSnapshot, SearchFilters, SearchHit } from '../src/knowledge/types.ts'
import type { KnowledgeDelta } from '../src/knowledge/storage.ts'

type Row = Record<string, SQLInputValue>
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'

/** Disposable FTS projection. Originals and source versions remain in the portable corpus. */
export class KnowledgeIndex {
  readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_sources (
        id TEXT PRIMARY KEY, current_version TEXT NOT NULL, excluded INTEGER NOT NULL,
        ai_allowed INTEGER NOT NULL, deleted INTEGER NOT NULL, node_id TEXT
      );
      CREATE TABLE IF NOT EXISTS knowledge_passage_rows (id TEXT PRIMARY KEY, body TEXT NOT NULL, source_id TEXT, version_id TEXT, fts_rowid INTEGER);
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_passage_fts USING fts5(
        passage_id UNINDEXED, source_id UNINDEXED, version_id UNINDEXED, title, text,
        tokenize = 'unicode61'
      );
      CREATE TABLE IF NOT EXISTS knowledge_index_state (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
    `)
    if (!(db.prepare('PRAGMA table_info(knowledge_sources)').all() as Row[]).some((row) => row.name === 'kind')) db.exec("ALTER TABLE knowledge_sources ADD COLUMN kind TEXT NOT NULL DEFAULT 'legacy'")
    const fields = new Set((db.prepare('PRAGMA table_info(knowledge_passage_rows)').all() as Row[]).map((row) => row.name))
    for (const name of ['source_id', 'version_id', 'fts_rowid']) if (!fields.has(name)) db.exec(`ALTER TABLE knowledge_passage_rows ADD COLUMN ${name} ${name === 'fts_rowid' ? 'INTEGER' : 'TEXT'}`)
    if (!fields.has('fts_rowid')) this.clear()
    db.exec('CREATE INDEX IF NOT EXISTS knowledge_passage_source ON knowledge_passage_rows(source_id); CREATE INDEX IF NOT EXISTS knowledge_passage_version ON knowledge_passage_rows(version_id);')
  }

  clear(): void {
    this.db.exec('DELETE FROM knowledge_sources; DELETE FROM knowledge_passage_rows; DELETE FROM knowledge_passage_fts; DELETE FROM knowledge_index_state;')
  }

  /** Incremental publication: never scan unchanged versions/passages for a small capture. */
  updateDelta(delta: KnowledgeDelta, versionById: (id: string) => unknown, sourceById: (id: string) => unknown): void {
    const erase = (id: string) => {
      const row = this.db.prepare('SELECT fts_rowid FROM knowledge_passage_rows WHERE id = ?').get(id) as Row | undefined
      if (row) this.db.prepare('DELETE FROM knowledge_passage_fts WHERE rowid = ?').run(row.fts_rowid)
      this.db.prepare('DELETE FROM knowledge_passage_rows WHERE id = ?').run(id)
    }
    const eraseMatching = (field: 'source_id' | 'version_id', id: string) => {
      for (const row of this.db.prepare(`SELECT id FROM knowledge_passage_rows WHERE ${field} = ?`).all(id) as Row[]) erase(String(row.id))
    }
    for (const id of delta.deletes.sources ?? []) { eraseMatching('source_id', id); this.db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(id) }
    for (const id of delta.deletes.versions ?? []) eraseMatching('version_id', id)
    for (const id of delta.deletes.passages ?? []) erase(id)
    const sourcePut = this.db.prepare('INSERT OR REPLACE INTO knowledge_sources (id,current_version,excluded,ai_allowed,deleted,node_id,kind) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const source of delta.upserts.sources ?? []) sourcePut.run(source.id, source.currentVersionId, source.excluded ? 1 : 0, source.aiAllowed ? 1 : 0, source.deleted ? 1 : 0, source.nodeId ?? null, source.kind)
    const changed = new Map((delta.upserts.passages ?? []).map((passage) => [passage.id, passage]))
    for (const version of delta.upserts.versions ?? []) {
      for (const row of this.db.prepare('SELECT body FROM knowledge_passage_rows WHERE version_id = ?').all(version.id) as Row[]) {
        const passage = JSON.parse(String(row.body)) as KnowledgePassage
        if (!changed.has(passage.id)) changed.set(passage.id, passage)
      }
    }
    for (const passage of changed.values()) {
      erase(passage.id)
      const version = versionById(passage.versionId), source = sourceById(passage.sourceId)
      if (!object(version) || !object(source) || typeof version.text !== 'string' || version.sourceId !== passage.sourceId || !Number.isSafeInteger(passage.start) || !Number.isSafeInteger(passage.end) || passage.start < 0 || passage.end < passage.start || passage.end > version.text.length || version.text.slice(passage.start, passage.end) !== passage.text) continue
      const inserted = this.db.prepare('INSERT INTO knowledge_passage_fts (passage_id,source_id,version_id,title,text) VALUES (?, ?, ?, ?, ?)').run(passage.id, passage.sourceId, passage.versionId, passage.title, passage.text)
      this.db.prepare('INSERT INTO knowledge_passage_rows (id,body,source_id,version_id,fts_rowid) VALUES (?, ?, ?, ?, ?)').run(passage.id, JSON.stringify(passage), passage.sourceId, passage.versionId, inserted.lastInsertRowid)
    }
    this.db.prepare('INSERT OR REPLACE INTO knowledge_index_state VALUES (1, ?)').run(delta.revision)
  }

  /** Called inside the same transaction as the authoritative snapshot write. */
  update(value: unknown): void {
    if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.sources) || !Array.isArray(value.versions) || !Array.isArray(value.passages) || !Number.isSafeInteger(value.revision)) {
      this.clear()
      return
    }
    const snapshot = value as unknown as KnowledgeSnapshot
    const versions = new Map(snapshot.versions.filter((v) => object(v) && typeof v.id === 'string' && typeof v.text === 'string').map((v) => [v.id, v]))
    const sources = new Set<string>()
    const sourcePut = this.db.prepare('INSERT OR REPLACE INTO knowledge_sources (id, current_version, excluded, ai_allowed, deleted, node_id, kind) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const source of snapshot.sources) {
      if (!object(source) || typeof source.id !== 'string' || typeof source.currentVersionId !== 'string') continue
      sources.add(source.id)
      sourcePut.run(source.id, source.currentVersionId, source.excluded ? 1 : 0, source.aiAllowed ? 1 : 0, source.deleted ? 1 : 0, source.nodeId ?? null, source.kind)
    }
    for (const row of this.db.prepare('SELECT id FROM knowledge_sources').all() as Row[]) {
      if (!sources.has(String(row.id))) this.db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(row.id)
    }
    const existing = new Map((this.db.prepare('SELECT id,body,fts_rowid FROM knowledge_passage_rows').all() as Row[]).map((r) => [String(r.id), { body: String(r.body), rowid: r.fts_rowid }]))
    const retained = new Set<string>()
    const eraseRow = this.db.prepare('DELETE FROM knowledge_passage_rows WHERE id = ?')
    const eraseFts = this.db.prepare('DELETE FROM knowledge_passage_fts WHERE rowid = ?')
    const putRow = this.db.prepare('INSERT OR REPLACE INTO knowledge_passage_rows (id,body,source_id,version_id,fts_rowid) VALUES (?, ?, ?, ?, ?)')
    const putFts = this.db.prepare('INSERT INTO knowledge_passage_fts (passage_id, source_id, version_id, title, text) VALUES (?, ?, ?, ?, ?)')
    for (const passage of snapshot.passages) {
      if (!object(passage) || typeof passage.id !== 'string' || typeof passage.sourceId !== 'string' || typeof passage.versionId !== 'string' || typeof passage.text !== 'string' || typeof passage.title !== 'string') continue
      const version = versions.get(passage.versionId)
      if (!sources.has(passage.sourceId) || !version || version.sourceId !== passage.sourceId || !Number.isSafeInteger(passage.start) || !Number.isSafeInteger(passage.end) || passage.start < 0 || passage.end < passage.start || passage.end > version.text.length || version.text.slice(passage.start, passage.end) !== passage.text) continue
      retained.add(passage.id)
      const body = JSON.stringify(passage)
      if (existing.get(passage.id)?.body === body) continue
      if (existing.has(passage.id)) eraseFts.run(existing.get(passage.id)!.rowid)
      const inserted = putFts.run(passage.id, passage.sourceId, passage.versionId, passage.title, passage.text)
      putRow.run(passage.id, body, passage.sourceId, passage.versionId, inserted.lastInsertRowid)
    }
    for (const id of existing.keys()) {
      if (!retained.has(id)) { eraseFts.run(existing.get(id)!.rowid); eraseRow.run(id) }
    }
    this.db.prepare('INSERT OR REPLACE INTO knowledge_index_state VALUES (1, ?)').run(snapshot.revision)
  }

  search(query: string, filters: SearchFilters = {}): { revision: number; hits: SearchHit[] } {
    const revision = Number((this.db.prepare('SELECT revision FROM knowledge_index_state WHERE id = 1').get() as Row | undefined)?.revision ?? 0)
    const terms = [...new Set(query.normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [])].slice(0, 80)
    const quoted = [...query.matchAll(/"([^"]+)"/g)].map((m) => m[1]).slice(0, 10)
    const match = quoted.length ? quoted.map((q) => `"${q.replaceAll('"', '""')}"`).join(' AND ') : terms.map((q) => `"${q.replaceAll('"', '""')}"`).join(' OR ')
    if (!match) return { revision, hits: [] }
    const parameters: SQLInputValue[] = [match]
    const predicates = ['knowledge_passage_fts MATCH ?', 's.excluded = 0', 's.deleted = 0', '(s.node_id IS NULL OR n.deleted_at IS NULL AND n.id IS NOT NULL)']
    if (!filters.includeHistory) predicates.push('f.version_id = s.current_version')
    if (filters.aiOnly) predicates.push('s.ai_allowed = 1')
    if (filters.sourceIds) {
      if (!filters.sourceIds.length) return { revision, hits: [] }
      const ids = filters.sourceIds.slice(0, 1000)
      predicates.push(`s.id IN (${ids.map(() => '?').join(',')})`)
      parameters.push(...ids)
    }
    if (filters.role) { predicates.push("json_extract(r.body, '$.role') = ?"); parameters.push(filters.role) }
    if (filters.kinds) {
      if (!filters.kinds.length) return { revision, hits: [] }
      predicates.push(`s.kind IN (${filters.kinds.map(() => '?').join(',')})`)
      parameters.push(...filters.kinds)
    }
    if (filters.authoredAfter !== undefined) { predicates.push("json_extract(r.body, '$.authoredAt') >= ?"); parameters.push(filters.authoredAfter) }
    if (filters.authoredBefore !== undefined) { predicates.push("json_extract(r.body, '$.authoredAt') <= ?"); parameters.push(filters.authoredBefore) }
    const limit = Math.max(1, Math.min(200, Math.floor(filters.limit ?? 30)))
    parameters.push(limit)
    const rows = this.db.prepare(`
      SELECT r.body, bm25(knowledge_passage_fts) AS rank FROM knowledge_passage_fts f
      JOIN knowledge_passage_rows r ON r.id = f.passage_id
      JOIN knowledge_sources s ON s.id = f.source_id
      LEFT JOIN nodes n ON n.id = s.node_id
      WHERE ${predicates.join(' AND ')} ORDER BY rank, f.passage_id LIMIT ?
    `).all(...parameters) as Row[]
    return { revision, hits: rows.map((row) => ({ ...JSON.parse(String(row.body)) as KnowledgePassage, score: -Number(row.rank) })) }
  }
}
