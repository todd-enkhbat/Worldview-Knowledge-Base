import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'
import { CrmProfileCapture } from '../../server/crmProfileCapture.ts'
import { CrmProfileCollection } from '../../server/crmProfileCollection.ts'
import { ArticleCapture } from '../../server/articleCapture.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'

let db: WorldDb, directory: string, capture: CrmProfileCapture
const url = 'https://profiles.example.org/ada', html = '<title>Ada Example</title><script type="application/ld+json">{"@type":"Person","name":"Ada Example","alumniOf":{"@type":"CollegeOrUniversity","name":"Example University"}}</script><main><h1>Ada Example</h1><p>Education: Example University</p></main>'
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'wv-profile-collection-')); db = openWorldDb(':memory:'); db.putSettings({ T0: 0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: 1, schemaVersion: 1 }); capture = new CrmProfileCapture({ db, store: db.crm, blobDir: directory }) })
afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
const publicLookup = async () => ['93.184.216.34']
async function savedSource() {
  const reader = new ArticleCapture({ db, blobDir: directory }), origin = `chrome-extension://${'a'.repeat(32)}`, paired = reader.pair({ origin })
  return reader.capture({ sequence: 1, url, title: 'Ada Example', text: 'Ada Example\nAbout\nResearcher\nEducation\nExample University\nBSc, Computer Science\n2018 – 2022\nExperience\nResearcher\nExample Labs\n2023 – Present', profileImages: [{ url: 'https://images.example.org/ada.jpg', subjectName: 'Ada Example', isProfile: true }] }, origin, paired.token)
}
it('captures a declared public profile into review and replays a lost URL response without fetching changed content', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })), collect = new CrmProfileCollection({ db, capture, blobDir: directory, fetch: fetcher, lookup: publicLookup })
  const first = await collect.fromUrl({ requestId: 'url', url }); expect(first.profile.affiliations).toMatchObject([{ kind: 'education', organization: 'Example University' }]); expect(first.source.captureMethod).toBe('public-url'); expect(db.crm.rows('people')).toEqual([])
  expect(await collect.fromUrl({ requestId: 'url', url })).toEqual(first); expect(fetcher).toHaveBeenCalledOnce()
  await expect(collect.fromUrl({ requestId: 'url', url: 'https://profiles.example.org/other' })).rejects.toMatchObject({ status: 409 })
  expect(JSON.parse(await readFile(join(directory, first.source.originalAssetId), 'utf8')).text).toContain('Example University')
  expect(db.getKv('knowledge.v1')).toBeUndefined()
})
it('refuses private networks and directs authenticated LinkedIn pages to Reader', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(html)), collect = new CrmProfileCollection({ db, capture, blobDir: directory, fetch: fetcher, lookup: publicLookup })
  await expect(collect.fromUrl({ requestId: 'private', url: 'http://127.0.0.1/private' })).rejects.toThrow(/private|public/)
  await expect(collect.fromUrl({ requestId: 'linkedin', url: 'https://www.linkedin.com/in/ada' })).rejects.toMatchObject({ status: 422 })
  expect(fetcher).not.toHaveBeenCalled(); expect(db.crm.rows('candidates')).toEqual([])
})
it('scans a named retained Reader original into sourced education and employment without editing it', async () => {
  const source = await savedSource(), before = db.getKv<KnowledgeSnapshot>('knowledge.v1'), collect = new CrmProfileCollection({ db, capture, blobDir: directory })
  const result = await collect.scanSaved({ requestId: 'scan', limit: 10, offset: 0 })
  expect(result).toMatchObject({ processed: 1, total: 1, nextOffset: null, skipped: [] }); expect(result.drafts).toHaveLength(1)
  expect(result.drafts[0].profile.affiliations).toMatchObject([{ kind: 'education', organization: 'Example University' }, { kind: 'employment', organization: 'Example Labs', role: 'Researcher' }])
  expect(result.drafts[0].source).toMatchObject({ captureMethod: 'saved-source', sourceId: source.sourceId, sourceVersionId: source.versionId })
  expect(db.getKv('knowledge.v1')).toEqual(before); expect(db.crm.rows('people')).toEqual([])
})
it('withholds excluded and damaged retained sources instead of claiming a successful extraction', async () => {
  await savedSource(); const collect = new CrmProfileCollection({ db, capture, blobDir: directory }), corpus = db.getKv<KnowledgeSnapshot>('knowledge.v1')!
  await writeFile(join(directory, corpus.versions[0].originalBlobId), 'changed source')
  const damaged = await collect.scanSaved({ requestId: 'damaged' }); expect(damaged.drafts).toEqual([]); expect(damaged.skipped[0].reason).toContain('damaged')
  corpus.sources[0].excluded = true; corpus.revision++; db.putKv('knowledge.v1', corpus)
  expect(await collect.scanSaved({ requestId: 'excluded' })).toMatchObject({ total: 0, processed: 0, drafts: [] }); expect(db.crm.rows('candidates')).toEqual([])
})
it('recovers the committed URL import after both wrapper receipts are interrupted, without refetching a changed website', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(html, { headers: { 'content-type': 'text/html' } })), collect = new CrmProfileCollection({ db, capture, blobDir: directory, fetch: fetcher, lookup: publicLookup })
  const first = await collect.fromUrl({ requestId: 'crash', url })
  db.db.prepare("DELETE FROM crm_state WHERE key LIKE 'profile-capture-stage:%'").run()
  const receipt = db.db.prepare("SELECT key,body FROM crm_state WHERE key LIKE 'profile-url:%'").get() as { key: string; body: string }, value = JSON.parse(receipt.body); delete value.id
  db.db.prepare('UPDATE crm_state SET body=? WHERE key=?').run(JSON.stringify(value), receipt.key)
  fetcher.mockImplementation(async () => new Response(html.replace('Example University', 'Changed University'), { headers: { 'content-type': 'text/html' } }))
  const restarted = new CrmProfileCollection({ db, capture, blobDir: directory, fetch: fetcher, lookup: publicLookup })
  expect((await restarted.fromUrl({ requestId: 'crash', url })).id).toBe(first.id); expect(fetcher).toHaveBeenCalledOnce(); expect(db.crm.rows('candidates')).toHaveLength(1)
})
it('coalesces simultaneous retries of the same public URL into one fetch and draft', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
  const fetcher = vi.fn<typeof fetch>(async () => { await gate; return new Response(html, { headers: { 'content-type': 'text/html' } }) }), collect = new CrmProfileCollection({ db, capture, blobDir: directory, fetch: fetcher, lookup: publicLookup })
  const first = collect.fromUrl({ requestId: 'concurrent', url }), second = collect.fromUrl({ requestId: 'concurrent', url }); release()
  const [a, b] = await Promise.all([first, second]); expect(a.id).toBe(b.id); expect(fetcher).toHaveBeenCalledOnce()
})
it('matches a LinkedIn school People page to its existing institution without creating a duplicate', async () => {
  db.crm.command({ requestId: 'school', operation: 'create', collection: 'companies', record: { id: 'school', name: 'Example University', organizationType: 'university', urls: ['https://www.linkedin.com/school/example-university/'] } })
  const draft = await capture.stage({ requestId: 'school-capture', url: 'https://www.linkedin.com/school/example-university/people/', title: 'Example University', text: 'Example University\nWhere they studied\nOther University 20', profile: { entityType: 'company', name: 'Example University', affiliations: [] } })
  expect(draft.matches).toMatchObject([{ id: 'school', collection: 'companies' }]); expect(draft.targetId).toBe('school'); expect(draft.profile.affiliations).toEqual([]); expect(db.crm.rows('companies')).toHaveLength(1)
})
