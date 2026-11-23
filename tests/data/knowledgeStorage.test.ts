import 'fake-indexeddb/auto'
import { openDB } from 'idb'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'sqlite-vec'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldStore } from '../../src/data/WorldStore.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { DB_VERSION, openIdbStore, openWorldStore } from '../../src/data/idbStore.ts'
import { createHttpStore } from '../../src/data/httpStore.ts'
import { bytesSink, exportArchive, importArchive } from '../../src/data/archive.ts'
import { buildDemoWorld } from '../../src/data/seed/demo.ts'
import { diffKnowledgeSnapshots, KNOWLEDGE_KEY, KNOWLEDGE_MIGRATION_KEY, KNOWLEDGE_RECEIPTS_KEY, KnowledgeMigrationError, stableJson } from '../../src/knowledge/storage.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'
import { openWorldDb } from '../../server/worldDb.ts'
import { startTestEngine } from '../helpers/engine.ts'

const opened: WorldStore[] = []
afterEach(() => { for (const store of opened.splice(0)) store.close() })
const adapters = [
  { name: 'memory', make: async () => createMemoryStore() },
  { name: 'IndexedDB', make: () => openIdbStore({ name: `delta-${crypto.randomUUID()}`, opfsRoot: null }) },
  { name: 'SQLite HTTP', make: async () => createHttpStore({ base: (await startTestEngine()).base }) },
]
function corpus(): KnowledgeSnapshot {
  const text = 'Amber lighthouse reserve is eighteen hours.'
  return {
    schemaVersion: 1, revision: 1, imports: [], proposals: [], jobs: [],
    sources: [{ id: 'source', externalId: 'notes/source.md', title: 'Reserve', kind: 'document', currentVersionId: 'v1', createdAt: 1, updatedAt: 1, excluded: false, aiAllowed: true, tags: [] }],
    versions: [{ id: 'v1', sourceId: 'source', contentHash: 'retained-hash', originalBlobId: 'original', originalName: 'source.md', text, createdAt: 1, authoredAt: null, origin: 'import', metadata: { extra: 'preserved' } }],
    passages: [{ id: 'passage', sourceId: 'source', versionId: 'v1', title: 'Reserve', text, start: 0, end: text.length, role: 'human', authoredAt: null }],
  }
}

describe.each(adapters)('Incremental knowledge authority: $name', ({ make }) => {
  it('commits once, replays safely after newer work, and refuses stale or reused commands', async () => {
    const store = await make(); opened.push(store)
    const first = corpus(), delta = diffKnowledgeSnapshots(undefined, first)
    expect(await store.commitKnowledge!(delta, { expectedRevision: 0, idempotencyKey: 'capture-1' })).toBe(true)
    const next = { ...first, revision: 2, sources: first.sources.map((source) => ({ ...source, aiAllowed: false })) }
    expect(await store.commitKnowledge!(diffKnowledgeSnapshots(first, next), { expectedRevision: 1, idempotencyKey: 'policy-2' })).toBe(true)
    expect(await store.commitKnowledge!(delta, { expectedRevision: 0, idempotencyKey: 'capture-1' })).toBe(true)
    expect(await store.getKnowledgeRevision!()).toBe(2)
    expect(await store.getKv(KNOWLEDGE_KEY)).toEqual(next)
    const receipts = await store.getKv<{ fingerprint: string }[]>(KNOWLEDGE_RECEIPTS_KEY)
    expect(receipts?.every((receipt) => /^sha256:[a-f0-9]{64}$/.test(receipt.fingerprint))).toBe(true)
    expect(JSON.stringify(receipts)).not.toContain(first.versions[0].text)
    expect(await store.commitKnowledge!(delta, { expectedRevision: 0, idempotencyKey: 'unrelated-stale' })).toBe(false)
    await expect(store.commitKnowledge!({ ...delta, metadata: { altered: true } }, { expectedRevision: 0, idempotencyKey: 'capture-1' })).rejects.toThrow(/idempotency/)
    expect(await store.getKv(KNOWLEDGE_KEY)).toEqual(next)
  })

  it('normalizes imported pre-digest receipts without retaining wording or losing replay safety', async () => {
    const store = await make(); opened.push(store)
    const first = corpus(), delta = diffKnowledgeSnapshots(undefined, first), opts = { expectedRevision: 0, idempotencyKey: 'legacy-receipt' }
    await store.commitKnowledge!(delta, opts)
    const legacy = [{ id: opts.idempotencyKey, fingerprint: stableJson({ delta, expectedRevision: 0 }), revision: 1 }]
    await store.putKv(KNOWLEDGE_RECEIPTS_KEY, legacy)
    expect(await store.commitKnowledge!(delta, opts)).toBe(true)
    expect(JSON.stringify(await store.getKv(KNOWLEDGE_RECEIPTS_KEY))).not.toContain(first.versions[0].text)
    await expect(store.putKv(KNOWLEDGE_RECEIPTS_KEY, [legacy[0], legacy[0]])).rejects.toThrow(/receipts/)
    expect(await store.commitKnowledge!(delta, opts)).toBe(true)
  })

  it('publishes source and projection together and rolls back every row on projection failure', async () => {
    const store = await make(); opened.push(store)
    const snapshot = corpus()
    const node = buildDemoWorld(Date.UTC(1990, 0, 1), Date.UTC(2026, 10, 23))[0]
    snapshot.sources[0].nodeId = node.id
    const delta = diffKnowledgeSnapshots(undefined, snapshot)
    await expect(store.commitKnowledge!(delta, { expectedRevision: 0, idempotencyKey: 'invalid-projection', nodes: [{ ...node, id: undefined as unknown as string }] })).rejects.toThrow()
    expect(await store.getKnowledgeRevision!()).toBe(0)
    expect(await store.getKv(KNOWLEDGE_KEY)).toBeUndefined()
    expect(await store.listNodes()).toEqual([])
    expect(await store.commitKnowledge!(delta, { expectedRevision: 0, idempotencyKey: 'valid-projection', nodes: [node], expectedNodes: { [node.id]: null } })).toBe(true)
    const next = { ...snapshot, revision: 2 }
    expect(await store.commitKnowledge!(diffKnowledgeSnapshots(snapshot, next), { expectedRevision: 1, idempotencyKey: 'conflicted-projection', expectedNodes: { [node.id]: -1 } })).toBe(false)
    expect(await store.getKnowledgeRevision!()).toBe(1)
    expect(await store.getNode(node.id)).toEqual(node)
  })

  it('exports logical history, extensions and command receipts and replays after restore', async () => {
    const store = await make(); opened.push(store)
    const snapshot = { ...corpus(), extension: { future: true } }
    const bytes = new TextEncoder().encode(snapshot.versions[0].text)
    await store.putBlob({ meta: { id: 'original', kind: 'file', bytes: bytes.length, mime: 'text/markdown', createdAt: 1, nodeId: null }, data: bytes })
    const delta = diffKnowledgeSnapshots(undefined, snapshot), opts = { expectedRevision: 0, idempotencyKey: 'portable-capture' }
    await store.commitKnowledge!(delta, opts)
    const sink = bytesSink()
    await exportArchive(store, sink)
    const restored = createMemoryStore(); opened.push(restored)
    await importArchive(restored, new Blob([sink.bytes().slice()]), { allowWithoutBackup: true })
    expect(await restored.getKv(KNOWLEDGE_KEY)).toEqual(snapshot)
    expect(await restored.getKv(KNOWLEDGE_RECEIPTS_KEY)).toEqual(await store.getKv(KNOWLEDGE_RECEIPTS_KEY))
    expect(await restored.commitKnowledge!(delta, opts)).toBe(true)
    expect(await restored.getKnowledgeRevision!()).toBe(1)
    expect(await (await restored.getBlob('original'))!.text()).toBe(snapshot.versions[0].text)
  })

  it('purges corpus rows and voice sidecars atomically, including conflicts and delayed replay', async () => {
    const store = await make(); opened.push(store)
    const first = corpus()
    await store.commitKnowledge!(diffKnowledgeSnapshots(undefined, first), { expectedRevision: 0, idempotencyKey: 'source-before-purge' })
    const before = { schemaVersion: 1, revision: 1, entries: [{ id: 'voice', sourceId: 'source', blobId: 'original' }] }
    await store.putKv('voiceInbox.v1', before)
    const removed = { ...first, revision: 2, sources: [], versions: [], passages: [] }, delta = diffKnowledgeSnapshots(first, removed)
    const after = { schemaVersion: 1, revision: 2, entries: [] }
    expect(await store.commitKnowledge!(delta, { expectedRevision: 1, idempotencyKey: 'stale-voice-purge', state: [{ key: 'voiceInbox.v1', expectedRevision: 0, value: { ...after, revision: 1 } }] })).toBe(false)
    expect(await store.getKv(KNOWLEDGE_KEY)).toEqual(first)
    expect(await store.getKv('voiceInbox.v1')).toEqual(before)
    const opts = { expectedRevision: 1, idempotencyKey: 'atomic-voice-purge', state: [{ key: 'voiceInbox.v1' as const, expectedRevision: 1, value: after }] }
    expect(await store.commitKnowledge!(delta, opts)).toBe(true)
    expect(await store.getKv(KNOWLEDGE_KEY)).toEqual(removed)
    expect(await store.getKv('voiceInbox.v1')).toEqual(after)
    const later = { schemaVersion: 1, revision: 3, entries: [{ id: 'later-voice' }] }
    await store.putKv('voiceInbox.v1', later)
    expect(await store.commitKnowledge!(delta, opts)).toBe(true)
    expect(await store.getKv('voiceInbox.v1')).toEqual(later)
    await expect(store.commitKnowledge!(delta, { ...opts, state: [{ ...opts.state[0], value: { ...after, entries: [{ id: 'changed' }] } }] })).rejects.toThrow(/idempotency/)
  })
})

async function legacyIdb(name: string, snapshot: unknown) {
  const db = await openDB(name, 1, { upgrade(database) {
    const nodes = database.createObjectStore('nodes', { keyPath: 'id' }); nodes.createIndex('updatedAt', 'updatedAt'); nodes.createIndex('deletedAt', 'deletedAt')
    database.createObjectStore('events', { keyPath: 'id' }).createIndex('t', 't')
    database.createObjectStore('settings'); database.createObjectStore('assets', { keyPath: 'id' }); database.createObjectStore('blobs'); database.createObjectStore('kv')
  } })
  await db.put('kv', snapshot, KNOWLEDGE_KEY)
  db.close()
}

it('atomically upgrades the browser corpus with a verified rollback copy and refuses old writers', async () => {
  const name = `legacy-knowledge-${crypto.randomUUID()}`, original = { ...corpus(), extra: 'not dropped' }
  await legacyIdb(name, original)
  const store = await openIdbStore({ name, opfsRoot: null }); opened.push(store)
  expect(await store.getKv(KNOWLEDGE_KEY)).toEqual(original)
  expect(await store.getKv(KNOWLEDGE_MIGRATION_KEY)).toMatchObject({ verified: true, format: 2, counts: { sources: 1, versions: 1, passages: 1 } })
  const raw = await openDB(name, DB_VERSION)
  expect(await raw.get('kv', KNOWLEDGE_KEY)).toBeUndefined()
  expect(await raw.get('knowledgeState', 'legacyBackup')).toEqual(original)
  expect(await raw.count('knowledgeRows')).toBe(3)
  raw.close()
  await expect(openDB(name, 1)).rejects.toMatchObject({ name: 'VersionError' })
})

it('rolls back an invalid browser migration instead of opening an empty memory fallback', async () => {
  const name = `bad-legacy-knowledge-${crypto.randomUUID()}`, original = corpus()
  original.sources.push(original.sources[0])
  await legacyIdb(name, original)
  await expect(openWorldStore({ name, opfsRoot: null })).rejects.toBeInstanceOf(KnowledgeMigrationError)
  const unchanged = await openDB(name, 1)
  expect(await unchanged.get('kv', KNOWLEDGE_KEY)).toEqual(original)
  expect(unchanged.version).toBe(1)
  unchanged.close()
})

it('verifies a physical SQLite/original backup before legacy corpus cutover', () => {
  const folder = mkdtempSync(join(tmpdir(), 'knowledge-upgrade-')), path = join(folder, 'world.sqlite'), original = { ...corpus(), extension: { nested: ['retained'] } }
  let db: ReturnType<typeof openWorldDb> | undefined
  try {
    const old = new DatabaseSync(path, { allowExtension: true }); load(old)
    old.exec(readFileSync(new URL('../../src/domain/schema.sql', import.meta.url), 'utf8'))
    old.exec('PRAGMA user_version = 2')
    old.prepare('INSERT INTO kv VALUES (?, ?)').run(KNOWLEDGE_KEY, JSON.stringify(original))
    const raw = Buffer.from(original.versions[0].text)
    old.prepare('INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?)').run('original', 'file', 'text/markdown', raw.length, 1, null, raw)
    old.close()
    db = openWorldDb(path)
    expect(db.getKv(KNOWLEDGE_KEY)).toEqual(original)
    const migration = db.getKv(KNOWLEDGE_MIGRATION_KEY) as { verified: boolean; backup: { location: string } }
    expect(migration.verified).toBe(true)
    expect(db.db.prepare('SELECT value FROM kv WHERE key = ?').get(KNOWLEDGE_KEY)).toBeUndefined()
    const backup = new DatabaseSync(join(migration.backup.location, 'world.sqlite'), { readOnly: true })
    expect(JSON.parse(String(backup.prepare('SELECT value FROM kv WHERE key = ?').get(KNOWLEDGE_KEY)!.value))).toEqual(original)
    expect(Buffer.from(backup.prepare('SELECT data FROM assets WHERE id = ?').get('original')!.data as Uint8Array).toString()).toBe(original.versions[0].text)
    backup.close()
    expect(JSON.parse(readFileSync(join(migration.backup.location, 'manifest.json'), 'utf8'))).toMatchObject({ verified: true, originals: [{ id: 'original', backend: 'sqlite' }] })
    expect(() => db!.db.prepare('INSERT OR REPLACE INTO kv VALUES (?, ?)').run(KNOWLEDGE_KEY, JSON.stringify(original))).toThrow(/incremental/)
    db.close(); db = openWorldDb(path)
    expect(readdirSync(join(folder, 'backups'))).toHaveLength(1)
    expect(db.getKv(KNOWLEDGE_KEY)).toEqual(original)
  } finally { db?.close(); rmSync(folder, { recursive: true, force: true }) }
})

it('updates only changed SQLite rows/FTS entries and sends a bounded delta for a large corpus', () => {
  const db = openWorldDb(':memory:')
  try {
    const large = corpus()
    for (let i = 1; i <= 10_000; i++) {
      large.sources.push({ ...large.sources[0], id: `source-${i}`, externalId: `notes/${i}.md`, currentVersionId: `v-${i}` })
      large.versions.push({ ...large.versions[0], id: `v-${i}`, sourceId: `source-${i}` })
      large.passages.push({ ...large.passages[0], id: `p-${i}`, sourceId: `source-${i}`, versionId: `v-${i}` })
    }
    db.putKv(KNOWLEDGE_KEY, large)
    db.db.exec("CREATE TEMP TRIGGER protect_unchanged BEFORE DELETE ON knowledge_store_versions WHEN OLD.id = 'v-5000' BEGIN SELECT RAISE(ABORT,'unchanged version was rewritten'); END;")
    const rowid = db.db.prepare("SELECT fts_rowid FROM knowledge_passage_rows WHERE id = 'p-5000'").get()!.fts_rowid
    const next = { ...large, revision: 2, sources: large.sources.map((source) => source.id === 'source' ? { ...source, aiAllowed: false } : source) }
    const delta = diffKnowledgeSnapshots(large, next)
    expect(JSON.stringify(delta).length).toBeLessThan(2000)
    expect(db.commitKnowledge(delta, { expectedRevision: 1, idempotencyKey: 'small-policy-change' })).toBe(true)
    expect(db.db.prepare("SELECT fts_rowid FROM knowledge_passage_rows WHERE id = 'p-5000'").get()!.fts_rowid).toBe(rowid)
    expect(db.db.prepare("SELECT value FROM kv WHERE key = 'knowledge.v1'").get()).toBeUndefined()
    expect(db.searchKnowledge('lighthouse', { sourceIds: ['source'], aiOnly: true }).hits).toEqual([])
    expect(db.searchKnowledge('lighthouse', { sourceIds: ['source-5000'], aiOnly: true }).hits).toHaveLength(1)
  } finally { db.close() }
})

it('rejects older HTTP writers after cutover while retaining bounded revision reads', async () => {
  const engine = await startTestEngine()
  engine.db.putKv(KNOWLEDGE_KEY, corpus())
  const refused = await fetch(`${engine.base}/world/kv/knowledge.v1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: corpus() }) })
  expect(refused.status).toBe(409)
  const revision = await fetch(`${engine.base}/world/knowledge-revision`)
  expect(await revision.json()).toEqual({ revision: 1, format: 2 })
  expect(engine.db.getKv(KNOWLEDGE_KEY)).toEqual(corpus())
})
