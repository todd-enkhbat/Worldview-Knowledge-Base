import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { load as loadVec } from 'sqlite-vec'

type Row = Record<string, SQLInputValue>
function fileHash(path: string): string {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(256 * 1024), file = openSync(path, 'r')
  try { let bytes: number; while ((bytes = readSync(file, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes)) }
  finally { closeSync(file) }
  return hash.digest('hex')
}

/** Synchronous server startup migration keeps an independently readable pre-cutover world. */
export function createKnowledgeMigrationBackup(db: DatabaseSync, databasePath: string): Record<string, unknown> | undefined {
  if (databasePath === ':memory:') return undefined
  const occupied = Number((db.prepare('SELECT (SELECT COUNT(*) FROM nodes) + (SELECT COUNT(*) FROM assets) + (SELECT COUNT(*) FROM settings) + (SELECT COUNT(*) FROM kv) AS n').get() as Row).n)
  if (!occupied) return undefined
  const dataVersion = Number((db.prepare('PRAGMA data_version').get() as Row).data_version)
  const root = join(dirname(databasePath), 'backups', `before-knowledge-v3-${Date.now()}-${randomUUID()}`)
  const savedDatabase = join(root, 'world.sqlite'), savedBlobs = join(root, 'blobs')
  mkdirSync(savedBlobs, { recursive: true })
  db.exec(`VACUUM INTO '${savedDatabase.replaceAll("'", "''")}'`)
  const saved = new DatabaseSync(savedDatabase, { readOnly: true, allowExtension: true })
  const originals: { id: string; bytes: number; sha256: string; backend: string }[] = []
  try {
    loadVec(saved)
    if ((saved.prepare('PRAGMA integrity_check').get() as Row).integrity_check !== 'ok') throw new Error('The pre-migration SQLite backup failed its integrity check.')
    for (const asset of saved.prepare('SELECT id,bytes,data FROM assets ORDER BY id').all() as Row[]) {
      const id = String(asset.id), source = join(dirname(databasePath), 'blobs', encodeURIComponent(id))
      if (existsSync(source)) {
        if (statSync(source).size !== Number(asset.bytes)) throw new Error(`Original ${id} differs from its recorded size; no knowledge cutover was performed.`)
        const target = join(savedBlobs, encodeURIComponent(id))
        copyFileSync(source, target)
        const before = fileHash(source), after = fileHash(target)
        if (before !== after) throw new Error(`An original changed while creating the pre-migration backup (${id}).`)
        originals.push({ id, bytes: Number(asset.bytes), sha256: after, backend: 'file' })
      } else if (asset.data instanceof Uint8Array && asset.data.byteLength === Number(asset.bytes)) originals.push({ id, bytes: Number(asset.bytes), sha256: createHash('sha256').update(asset.data).digest('hex'), backend: 'sqlite' })
      else throw new Error(`Original ${id} is missing; repair or explicitly recover the world before migration. No knowledge cutover was performed.`)
    }
    const legacy = saved.prepare("SELECT value FROM kv WHERE key = 'knowledge.v1'").get() as Row | undefined
    const current = db.prepare("SELECT value FROM kv WHERE key = 'knowledge.v1'").get() as Row | undefined
    if (legacy?.value !== current?.value || Number((db.prepare('PRAGMA data_version').get() as Row).data_version) !== dataVersion) throw new Error('The world changed during its pre-migration backup. Restart to retry; no knowledge cutover was performed.')
  } finally { saved.close() }
  const result = { location: root, databaseSha256: fileHash(savedDatabase), originals, dataVersion, verified: true, createdAt: Date.now() }
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(result, null, 2))
  return result
}
