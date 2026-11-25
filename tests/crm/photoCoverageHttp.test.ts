import { createServer, type Server } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createCrmHttp } from '../../server/crmHttp.ts'
import { ArticleCapture, handleArticleCaptureRequest } from '../../server/articleCapture.ts'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'

let db: WorldDb, server: Server, base: string, directory: string, articles: ArticleCapture
const origin = `chrome-extension://${'a'.repeat(32)}`, clientHeaders = { 'x-wv-client': 'portrait-http-test' }
beforeEach(async () => {
  db = openWorldDb(':memory:'); directory = await mkdtemp(join(tmpdir(), 'wv-photo-http-'))
  db.putSettings({ T0: 0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: 1, schemaVersion: 1 })
  const crm = createCrmHttp(db, { store: db.crm, blobDir: directory })
  articles = new ArticleCapture({ db, blobDir: directory, saveFolkPhotos: input => crm.photos!.saveFolkPhotos(input), saveContactPhoto: input => crm.photos!.saveCapturedProfile(input) })
  server = createServer((req, res) => { if (req.url?.startsWith('/api/reading-capture')) void handleArticleCaptureRequest(articles, req, res); else void crm.handle(req, res) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); await rm(directory, { recursive: true, force: true }) })

it('protects coverage with CRM management boundaries and reports every active person without writes', async () => {
  db.crm.command({ requestId: 'fixture-person', operation: 'create', collection: 'people', record: { id: 'p', fullName: 'Portrait missing' } })
  const before = db.crm.portableSnapshot()
  expect((await fetch(base + '/api/crm/photo-coverage')).status).toBe(403)
  expect((await fetch(base + '/api/crm/photo-coverage', { headers: { ...clientHeaders, origin: 'https://untrusted.example' } })).status).toBe(403)
  const response = await fetch(base + '/api/crm/photo-coverage?status=needs-attention&limit=1', { headers: clientHeaders }); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toMatchObject({ total: 1, available: 0, missing: 1, nextOffset: null, rows: [{ personId: 'p', status: 'missing' }] })
  expect((await fetch(base + '/api/crm/photo-coverage?offset=-1', { headers: clientHeaders })).status).toBe(400); expect(db.crm.portableSnapshot()).toEqual(before)
})

it('returns a separate paired Folk diagnostic receipt over HTTP while leaving Knowledge and Reading empty', async () => {
  const uuid = '11111111-1111-4111-8111-111111111111', groupId = `grp_${uuid}`
  db.crm.command({ requestId: 'fixture-group', operation: 'create', collection: 'groups', record: { id: groupId, name: 'Private group', sourceRefs: [{ provider: 'folk', accountId: 'test-account', externalId: groupId }] } })
  const paired = articles.pair({ origin, name: 'HTTP test Reader' }), payload = { saveFolkPhotos: true, sequence: 1, url: `https://app.folk.app/apps/contacts/network/22222222-2222-4222-8222-222222222222/groups/${uuid}/view/33333333-3333-4333-8333-333333333333`, title: 'Private group', folkPhotos: [], folkPhotoRows: [{ name: 'Visible photo', photoUrl: 'https://documents.folk.app/asset', attributes: { 'data-row-id': 'row' } }] }
  const headers = { origin, authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' }, send = () => fetch(base + '/api/reading-capture/capture', { method: 'POST', headers, body: JSON.stringify(payload) })
  const response = await send(); expect(response.status).toBe(200); expect(response.headers.get('access-control-allow-origin')).toBe(origin)
  const result = await response.json(); expect(result).toMatchObject({ sequence: 1, originalAssetId: expect.stringMatching(/^crm-file-/), folkPhotos: { total: 0, saved: 0, diagnostic: true } }); expect(result).not.toHaveProperty('sourceId'); expect(result).not.toHaveProperty('versionId')
  expect(await (await send()).json()).toEqual(result); expect(db.crm.rows('imports', false)).toHaveLength(1); expect(db.getKv('knowledge.v1')).toBeUndefined(); expect(db.getKv('reading.v1')).toBeUndefined()
  articles.revoke(paired.clientId); expect((await send()).status).toBe(403)
})

it('rejects old paired Follow, progress, highlight and ordinary contact-photo captures on Folk before retaining private CRM text', async () => {
  const paired = articles.pair({ origin, name: 'Previously paired Reader' }), headers = { origin, authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' }
  const url = 'https://app.folk.app/apps/contacts/network/22222222-2222-4222-8222-222222222222/groups/11111111-1111-4111-8111-111111111111'
  const variants = [{}, { progress: { fraction: 0.5, activeMs: 1000, following: true } }, { selection: 'Private CRM text' }, { saveContactPhoto: true }, { url: url.replace('app.folk.app', 'APP.FOLK.APP.') }]
  for (const [index, variant] of variants.entries()) {
    const response = await fetch(base + '/api/reading-capture/capture', { method: 'POST', headers, body: JSON.stringify({ sequence: index + 1, url, title: 'Private contact group', text: 'Private CRM text', ...variant }) })
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ error: expect.stringContaining('private CRM data') })
  }
  expect(db.getKv('knowledge.v1')).toBeUndefined(); expect(db.getKv('reading.v1')).toBeUndefined(); expect(db.crm.rows('imports', false)).toEqual([]); expect(await readdir(directory)).toEqual([])
})

it('accepts only paired diagnostic-only Search captures and cannot write a contact photo from that route', async () => {
  db.crm.command({ requestId: 'search-person', operation: 'create', collection: 'people', record: { id: 'per_11111111-1111-4111-8111-111111111111', fullName: 'Untouched contact' } })
  const people = db.crm.rows('people', false), paired = articles.pair({ origin, name: 'Search diagnostic Reader' }), headers = { origin, authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' }, payload = { saveFolkPhotos: true, sequence: 1, url: 'https://app.folk.app/apps/contacts/network/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/search', folkPhotos: [], folkPhotoRows: [{ name: 'Visible Search row', photoUrl: 'https://documents.folk.app/example', imageState: { complete: true, naturalWidth: 40, naturalHeight: 40, verifiedReason: 'diagnostic-only' } }] }
  const post = (body: unknown, credentials = headers) => fetch(base + '/api/reading-capture/capture', { method: 'POST', headers: credentials, body: JSON.stringify(body) })
  expect((await post(payload, { ...headers, authorization: 'Bearer wrong' })).status).toBe(401)
  const response = await post(payload); expect(response.status).toBe(200); const result = await response.json(); expect(result).toMatchObject({ sequence: 1, originalAssetId: expect.stringMatching(/^crm-file-/), folkPhotos: { diagnostic: true, total: 0, saved: 0, results: [] } }); expect(result).not.toHaveProperty('sourceId')
  expect((await post({ ...payload, sequence: 2, folkPhotos: [{ personId: people[0].id, name: 'Untouched contact', photoUrl: 'https://documents.folk.app/example' }] })).status).toBe(400)
  expect(db.crm.rows('people', false)).toEqual(people); expect(db.crm.rows('imports', false)).toHaveLength(1); expect(db.getKv('knowledge.v1')).toBeUndefined(); expect(db.getKv('reading.v1')).toBeUndefined()
})
