import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { KnowledgeSnapshot } from '../src/knowledge/types.ts'
import { assertKnowledgeReceipt, isKnowledgeSnapshot, KNOWLEDGE_COLLECTIONS, materializeKnowledge, normalizeKnowledgeFingerprint, normalizeKnowledgeReceipts, snapshotMetadata, stableJson, validateKnowledgeCommit, type KnowledgeCollection, type KnowledgeCommitOptions, type KnowledgeDelta, type KnowledgeHead, type KnowledgeReceipt, type KnowledgeRow, type StoredKnowledgeRow } from '../src/knowledge/storage.ts'

type Row = Record<string, SQLInputValue>
const table = (collection: KnowledgeCollection) => `knowledge_store_${collection}`

/** Corpus rows are authoritative; the legacy JSON shape is materialized only for reads/exports. */
export class SqliteKnowledgeStore {
  readonly db: DatabaseSync
  constructor(db: DatabaseSync) {
    this.db = db
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_store_state (key TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_store_receipts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL);
    `)
    for (const collection of KNOWLEDGE_COLLECTIONS) db.exec(`CREATE TABLE IF NOT EXISTS ${table(collection)} (id TEXT PRIMARY KEY, ord INTEGER NOT NULL, body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ${table(collection)}_order ON ${table(collection)}(ord,id);`)
    // Old development receipts held payload JSON. Keep replay compatibility while
    // erasing that duplicate text from the live authority before serving requests.
    for (const row of db.prepare('SELECT id,fingerprint FROM knowledge_store_receipts').all() as Row[]) {
      const fingerprint = normalizeKnowledgeFingerprint(String(row.fingerprint))
      if (fingerprint !== row.fingerprint) db.prepare('UPDATE knowledge_store_receipts SET fingerprint = ? WHERE id = ?').run(fingerprint, row.id)
    }
  }
  head(): KnowledgeHead | undefined {
    const row = this.db.prepare("SELECT body FROM knowledge_store_state WHERE key = 'head'").get() as Row | undefined
    return row ? JSON.parse(String(row.body)) as KnowledgeHead : undefined
  }
  state(key: string): unknown {
    const row = this.db.prepare('SELECT body FROM knowledge_store_state WHERE key = ?').get(key) as Row | undefined
    return row ? JSON.parse(String(row.body)) : undefined
  }
  writeState(key: string, value: unknown): void { this.db.prepare('INSERT OR REPLACE INTO knowledge_store_state VALUES (?, ?)').run(key, JSON.stringify(value)) }
  revision(): number { return this.head()?.revision ?? 0 }
  read(): KnowledgeSnapshot | undefined {
    const head = this.head()
    if (!head) return undefined
    const rows: StoredKnowledgeRow[] = []
    for (const collection of KNOWLEDGE_COLLECTIONS) for (const row of this.db.prepare(`SELECT id,ord,body FROM ${table(collection)} ORDER BY ord,id`).all() as Row[]) rows.push({ key: '', collection, id: String(row.id), order: Number(row.ord), value: JSON.parse(String(row.body)) as KnowledgeRow })
    return materializeKnowledge(head, rows)
  }
  row(collection: KnowledgeCollection, id: string): KnowledgeRow | undefined {
    const row = this.db.prepare(`SELECT body FROM ${table(collection)} WHERE id = ?`).get(id) as Row | undefined
    return row ? JSON.parse(String(row.body)) as KnowledgeRow : undefined
  }
  receipts(): KnowledgeReceipt[] { return this.db.prepare('SELECT id,fingerprint,revision FROM knowledge_store_receipts ORDER BY revision,id').all() as unknown as KnowledgeReceipt[] }
  receipt(id: string): KnowledgeReceipt | undefined { return this.db.prepare('SELECT id,fingerprint,revision FROM knowledge_store_receipts WHERE id = ?').get(id) as unknown as KnowledgeReceipt | undefined }
  setReceipts(value: unknown): void {
    const receipts = normalizeKnowledgeReceipts(value)
    this.db.exec('DELETE FROM knowledge_store_receipts')
    for (const row of receipts) this.db.prepare('INSERT INTO knowledge_store_receipts VALUES (?, ?, ?)').run(row.id, row.fingerprint, row.revision)
  }
  clear(): void {
    for (const collection of KNOWLEDGE_COLLECTIONS) this.db.exec(`DELETE FROM ${table(collection)}`)
    this.db.exec('DELETE FROM knowledge_store_state; DELETE FROM knowledge_store_receipts;')
  }
  replace(snapshot: KnowledgeSnapshot): void {
    if (!isKnowledgeSnapshot(snapshot)) throw new Error('Invalid knowledge snapshot')
    for (const collection of KNOWLEDGE_COLLECTIONS) {
      this.db.exec(`DELETE FROM ${table(collection)}`)
      const put = this.db.prepare(`INSERT INTO ${table(collection)} VALUES (?, ?, ?)`)
      snapshot[collection].forEach((row, ord) => put.run(row.id, ord, JSON.stringify(row)))
    }
    this.db.exec('DELETE FROM knowledge_store_receipts')
    this.writeState('head', { revision: snapshot.revision, metadata: snapshotMetadata(snapshot) } satisfies KnowledgeHead)
  }
  /** Caller owns the encompassing transaction, including index/projection publication. */
  commit(delta: KnowledgeDelta, opts: KnowledgeCommitOptions): boolean {
    const fingerprint = validateKnowledgeCommit(delta, opts)
    const prior = this.db.prepare('SELECT id,fingerprint,revision FROM knowledge_store_receipts WHERE id = ?').get(opts.idempotencyKey) as unknown as KnowledgeReceipt | undefined
    if (assertKnowledgeReceipt(prior, fingerprint)) return true
    if (this.revision() !== opts.expectedRevision) return false
    for (const collection of KNOWLEDGE_COLLECTIONS) {
      for (const id of delta.deletes[collection] ?? []) this.db.prepare(`DELETE FROM ${table(collection)} WHERE id = ?`).run(id)
      let order = Number((this.db.prepare(`SELECT COALESCE(MAX(ord), -1) + 1 AS next FROM ${table(collection)}`).get() as Row).next)
      const put = this.db.prepare(`INSERT INTO ${table(collection)} (id,ord,body) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`)
      for (const row of delta.upserts[collection] ?? []) put.run(row.id, order++, JSON.stringify(row))
      for (const [position, id] of (delta.order?.[collection] ?? []).entries()) this.db.prepare(`UPDATE ${table(collection)} SET ord = ? WHERE id = ?`).run(position, id)
    }
    this.writeState('head', { revision: delta.revision, metadata: delta.metadata ?? this.head()?.metadata ?? {} } satisfies KnowledgeHead)
    this.db.prepare('INSERT INTO knowledge_store_receipts VALUES (?, ?, ?)').run(opts.idempotencyKey, fingerprint, delta.revision)
    return true
  }
  migrateLegacy(backup?: Record<string, unknown>): boolean {
    if (this.head()) return false
    const legacy = this.db.prepare("SELECT value FROM kv WHERE key = 'knowledge.v1'").get() as Row | undefined
    if (!legacy) return false
    const original = JSON.parse(String(legacy.value)) as unknown
    if (!isKnowledgeSnapshot(original)) {
      if (original && typeof original === 'object' && 'schemaVersion' in original && original.schemaVersion === 1) throw new Error('The existing corpus contains invalid or duplicate identities. Recover the verified backup before migration.')
      return false
    }
    this.writeState('legacyBackup', original)
    this.replace(original)
    const restored = this.read()
    if (stableJson(restored) !== stableJson(original)) throw new Error('Knowledge migration verification failed; the existing corpus was not changed.')
    this.writeState('migration', { format: 2, verified: true, at: Date.now(), sha256: createHash('sha256').update(stableJson(original)).digest('hex'), counts: Object.fromEntries(KNOWLEDGE_COLLECTIONS.map((collection) => [collection, original[collection].length])), backup: backup ?? { location: 'knowledge_store_state.legacyBackup', scope: 'legacy corpus metadata; original assets remain in the unchanged world' } })
    this.db.prepare("DELETE FROM kv WHERE key = 'knowledge.v1'").run()
    return true
  }
}
