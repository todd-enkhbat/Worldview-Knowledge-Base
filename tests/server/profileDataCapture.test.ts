import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createHost, type Host } from '../../server/host.ts'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'
import { crmAssetReferences, decodeCrm } from '../../src/crm/model.ts'

let host: Host | undefined, server: Server | undefined, db: WorldDb | undefined, directory = ''
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) } host?.close(); db?.close(); if (directory) await rm(directory, { recursive: true, force: true }); host = undefined; server = undefined; db = undefined })
async function fixture() {
  directory = await mkdtemp(join(tmpdir(), 'wv-profile-e2e-')); db = openWorldDb(join(directory, 'world.sqlite'))
  db.putSettings({ T0: 0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: 1, schemaVersion: 1 })
  host = createHost({ dataDir: directory }); server = createServer((req, res) => host!.handler(req, res)); await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers = { 'x-wv-client': 'profile-e2e', 'content-type': 'application/json' }, origin = `chrome-extension://${'a'.repeat(32)}`
  const post = async (path: string, value: unknown) => { const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(value) }); return { response, body: await response.json() } }
  const paired = await post('/api/reading-capture', { origin, name: 'Test Reader' })
  const capture = async (value: unknown) => { const response = await fetch(base + '/api/reading-capture/capture', { method: 'POST', headers: { origin, authorization: `Bearer ${paired.body.token}`, 'content-type': 'application/json' }, body: JSON.stringify(value) }); return { response, body: await response.json() } }
  return { base, headers, post, capture }
}
it('captures a profile through the real paired host, retains its original, and applies only selected sourced fields', async () => {
  const f = await fixture(), url = 'https://example.org/ada'
  db!.crm.command({ requestId: 'person', operation: 'create', collection: 'people', record: { id: 'ada', fullName: 'Ada Example', urls: [url], description: 'My own context', raw: { originalUnknown: ['keep'] } } })
  const before = db!.crm.get('people', 'ada')
  const request = { sequence: 1, saveProfileData: true, url, title: 'Ada Example', text: 'Ada Example\nResearcher\nEducation\nExample University\nBSc Computer Science', html: '<main><h1>Ada Example</h1><h2>Education</h2><p>Example University — BSc Computer Science</p></main>', profile: { entityType: 'person', name: 'Ada Example', description: 'Public bio', affiliations: [{ kind: 'education', organization: 'Example University', degree: 'BSc', field: 'Computer Science', excerpt: 'Example University\nBSc Computer Science' }] } }
  const captured = await f.capture(request); expect(captured.response.status).toBe(200)
  const draft = captured.body.profileDraft; expect(draft.matches).toContainEqual(expect.objectContaining({ id: 'ada', reason: 'profile-url' })); expect(db!.crm.get('people', 'ada')).toEqual(before)
  const original = await readFile(join(directory, 'blobs', draft.source.originalAssetId)), raw = JSON.parse(original.toString())
  expect(createHash('sha256').update(original).digest('hex')).toBe(draft.source.originalAssetId.slice('crm-file-'.length)); expect(raw.text).toBe(request.text)
  expect((await f.post('/api/crm/command', { requestId: 'wrong-review', operation: 'review_candidate', id: draft.id, expectedRecordRevision: draft.revision, accept: true })).response.status).toBe(403)
  const applied = await f.post(`/api/crm/profile-capture/${draft.id}/apply`, { requestId: 'apply', targetId: 'ada', expectedRecordRevision: before!.revision, fields: ['affiliations'] })
  expect(applied.response.status).toBe(200)
  const person = db!.crm.get('people', 'ada')!; expect(person.description).toBe('My own context'); expect(person.raw).toEqual(before!.raw)
  expect(person.affiliations).toMatchObject([{ kind: 'education', organization: 'Example University', degree: 'BSc', evidence: [expect.objectContaining({ url })] }])
  expect(db!.crm.list('people', { q: 'Computer Science' }).rows.map(value => value.id)).toEqual(['ada'])
  expect(db!.getKv('knowledge.v1')).toBeUndefined(); expect(db!.getKv('reading.v1')).toBeUndefined(); expect(db!.listNodes()).toEqual([])
  const portable = db!.crm.portableSnapshot()!; expect(decodeCrm(portable).people[0].affiliations).toEqual(person.affiliations); expect(crmAssetReferences(portable).has(draft.source.originalAssetId)).toBe(true)
  expect((await f.capture(request)).body.profileDraft.id).toBe(draft.id)
})
it('saves a company from a retained page only after explicit creation review', async () => {
  const f = await fixture(), url = 'https://example.org/company'
  const captured = await f.capture({ sequence: 1, saveProfileData: true, url, title: 'Example Ventures', text: 'Example Ventures\nInvestment firm\nSan Francisco\nAbout\nBacking new companies.', profile: { entityType: 'company', name: 'Example Ventures', description: 'Backing new companies.', industry: 'Investment firm', location: 'San Francisco', urls: [url] } })
  expect(captured.response.status).toBe(200); expect(db!.crm.rows('companies')).toEqual([])
  const draft = captured.body.profileDraft
  expect((await f.post(`/api/crm/profile-capture/${draft.id}/apply`, { requestId: 'ambiguous-create', fields: ['name'] })).response.status).toBe(400)
  const result = await f.post(`/api/crm/profile-capture/${draft.id}/apply`, { requestId: 'create-company', createNew: true, fields: ['name', 'description', 'industry', 'urls', 'location'] })
  expect(result.response.status).toBe(200); expect(db!.crm.rows('companies')).toMatchObject([{ name: 'Example Ventures', industry: 'Investment firm', urls: [url] }]); expect(db!.crm.rows('people')).toEqual([])
  expect(db!.getKv('knowledge.v1')).toBeUndefined(); expect(db!.getKv('writing.v1')).toBeUndefined()
})
