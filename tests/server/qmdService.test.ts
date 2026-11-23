import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'
import { QmdNativeRuntime } from '../../server/qmdRuntime.ts'
import { QmdService, qmdMetadataFilter } from '../../server/qmdService.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'

class ControlledRuntime extends QmdNativeRuntime {
  calls: { operation: string; input: Record<string, unknown> }[] = []
  beforeResults: (() => void | Promise<void>) | null = null
  stops = 0
  private indexed: { directory: string; collection: string; dbPath: string } | null = null
  override async request<T>(operation: string, raw: unknown): Promise<T> {
    const input = raw as Record<string, unknown>; this.calls.push({ operation, input })
    if (operation === 'open') { this.indexed = input as unknown as typeof this.indexed; await writeFile(String(input.dbPath), 'disposable QMD native data'); return {} as T }
    const files = await readdir(this.indexed!.directory)
    await this.beforeResults?.()
    return files.filter((name) => name.endsWith('.md')).map((file) => ({ file: `qmd://${this.indexed!.collection}/${file}`, score: .8 })) as T
  }
  override stop() { this.stops++; super.stop() }
}
const opened: { db: WorldDb; service: QmdService; directory: string }[] = []
afterEach(async () => { for (const item of opened.splice(0)) { item.service.close(); await new Promise((resolve) => setTimeout(resolve, 0)); item.db.close(); await rm(item.directory, { recursive: true, force: true }) } })
function corpus(): KnowledgeSnapshot {
  const text = 'Synthetic violet decision approved for December 12.'
  return { schemaVersion: 1, revision: 1, sources: [{ id: 'a', externalId: 'a', title: 'Decision', kind: 'thought', currentVersionId: 'v1', createdAt: 1, updatedAt: 1, excluded: false, aiAllowed: true, tags: [] }], versions: [{ id: 'v1', sourceId: 'a', text, contentHash: 'hash', originalBlobId: 'raw', originalName: 'a.md', createdAt: 1, authoredAt: 100, origin: 'capture' }], passages: [{ id: 'p1', sourceId: 'a', versionId: 'v1', title: 'Decision', text, start: 0, end: text.length, role: 'human', authoredAt: 100 }], imports: [], jobs: [], proposals: [] }
}
async function start() {
  const directory = await mkdtemp(join(tmpdir(), 'wv-qmd-service-')), db = openWorldDb(':memory:'), runtime = new ControlledRuntime()
  db.putKv('knowledge.v1', corpus())
  const service = new QmdService(db, join(directory, 'qmd'), runtime); opened.push({ directory, db, service })
  return { directory, db, service, runtime }
}

it('runs native retrieval only after an explicit scope and returns current original evidence', async () => {
  const { service, runtime } = await start()
  await expect(service.search('violet')).rejects.toThrow(/Select sources/)
  await service.configure(['a'], 'hybrid')
  const result = await service.search('violet', { sourceIds: ['a'], role: 'human', authoredAfter: 99, limit: 5 }, { candidates: 10 })
  expect(result).toMatchObject({ engine: 'qmd', mode: 'hybrid', candidates: 10, hits: [{ id: 'p1', sourceId: 'a', versionId: 'v1', text: corpus().versions[0].text }] })
  expect(runtime.calls.at(-1)?.input).toMatchObject({ candidates: 10, filter: { operator: 'and', operands: [{ field: 'sourceId', operator: 'in', value: ['a'] }, { field: 'role', operator: 'eq', value: 'human' }, { field: 'authoredAt', operator: 'gte', value: 99 }] } })
  expect((await service.search('violet', { sourceIds: ['other'] })).hits).toEqual([])
})

it('rechecks consent after inference and removes the old mirror/index on policy change', async () => {
  const { db, service, runtime, directory } = await start(); await service.configure(['a'], 'hybrid')
  runtime.beforeResults = () => { const changed = corpus(); changed.revision = 2; changed.sources[0].aiAllowed = false; db.putKv('knowledge.v1', changed) }
  expect((await service.search('violet')).hits).toEqual([])
  runtime.beforeResults = null
  await service.reconcile()
  expect((await readdir(join(directory, 'qmd/mirror'))).filter((name) => name.endsWith('.md'))).toEqual([])
  expect((await service.status()).indexedPassages).toBe(0)
})

it('disables and physically erases a private index after restore/wipe removes its settings', async () => {
  const { db, service, directory } = await start(); await service.configure(['a'], 'lexical')
  expect(existsSync(join(directory, 'qmd/index.sqlite'))).toBe(true)
  db.wipe(); db.putKv('knowledge.v1', corpus()) // same corpus revision is deliberately reused
  await service.reconcile()
  expect(await service.status()).toMatchObject({ enabled: false, phase: 'disabled', indexedPassages: 0 })
  expect(existsSync(join(directory, 'qmd'))).toBe(false)
  await expect(service.search('violet')).rejects.toThrow(/Select sources/)
})

it('rejects stale native completion after a scope change and honors explicit empty scope', async () => {
  const { service, runtime } = await start(); await service.configure(['a'], 'lexical')
  runtime.beforeResults = async () => { await service.disable() }
  await expect(service.search('violet')).rejects.toThrow(/scope changed/)
  expect(qmdMetadataFilter({ sourceIds: [] })).toMatchObject({ field: 'sourceId', operator: 'eq' })
  const filter = qmdMetadataFilter({ sourceIds: Array.from({ length: 130 }, (_, i) => String(i)) }) as { operator: string; operands: { value: string[] }[] }
  expect(filter.operator).toBe('or'); expect(filter.operands.map((item) => item.value.length)).toEqual([64, 64, 2])
})

it('refuses any disposable-index deletion that would remove the runtime or shared model cache', async () => {
  const runtime = new QmdNativeRuntime('/safe/tools/qmd', '/safe/tools/qmd-cache')
  await expect(runtime.destroy('/safe/tools')).rejects.toThrow(/outside/)
  await expect(runtime.destroy('/safe/tools/qmd-cache')).rejects.toThrow(/outside/)
  await expect(runtime.destroy('/safe/tools/qmd')).rejects.toThrow(/outside/)
})

it('keeps selected scopes fixed and follows new permitted captures only after explicit opt-in', async () => {
  const selected = await start(), following = await start()
  await selected.service.configure(['a'], 'lexical')
  await following.service.configure([], 'lexical', true)
  for (const { db } of [selected, following]) {
    const changed = corpus(); changed.revision = 2
    changed.sources.push({ ...changed.sources[0], id: 'b', externalId: 'b', currentVersionId: 'v2' })
    changed.versions.push({ ...changed.versions[0], id: 'v2', sourceId: 'b' })
    changed.passages.push({ ...changed.passages[0], id: 'p2', sourceId: 'b', versionId: 'v2' })
    db.putKv('knowledge.v1', changed)
  }
  await selected.service.reconcile(); await following.service.reconcile()
  expect(await selected.service.status()).toMatchObject({ followNewSources: false, indexedPassages: 1 })
  expect(await following.service.status()).toMatchObject({ followNewSources: true, indexedPassages: 2 })
  expect((await selected.service.search('violet')).hits.map((hit) => hit.id)).toEqual(['p1'])
  expect((await following.service.search('violet')).hits.map((hit) => hit.id).sort()).toEqual(['p1', 'p2'])
})
