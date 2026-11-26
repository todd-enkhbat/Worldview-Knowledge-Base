import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createCrmHttp } from '../../server/crmHttp.ts'
import { previewNameDigest, previewUrlDigest } from '../../server/crmProfilePreviewIdentity.ts'
import { ArticleCapture, handleArticleCaptureRequest } from '../../server/articleCapture.ts'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'

let db: WorldDb, server: Server, base: string, directory: string, articles: ArticleCapture
const origin = `chrome-extension://${'a'.repeat(32)}`, clientHeaders = { 'x-wv-client': 'portrait-http-test' }
beforeEach(async () => {
  db = openWorldDb(':memory:'); directory = await mkdtemp(join(tmpdir(), 'wv-photo-http-'))
  db.putSettings({ T0: 0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: 1, schemaVersion: 1 })
  const crm = createCrmHttp(db, { store: db.crm, blobDir: directory, workspaceDirectory: directory,
    profileMediaLookup: async () => ['203.0.113.17'],
    profileMediaFetch: async url => String(url) === 'https://portrait.example.org/editor.png'
      ? new Response(new Uint8Array(await readFile('extensions/worldview-reader/worldview-128.png')), {headers:{'content-type':'image/png'}})
      : new Response(null,{status:404}),
  })
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

it('saves native capture through the normal group and retained-source flow and replays without a duplicate person', async () => {
  db.crm.command({ operation: 'create', requestId: 'native-group', collection: 'groups', record: { id: 'g', name: 'Founders', entityType: 'person' } })
  const headers = { 'x-wv-client':'desktop-profile-capture', 'x-wv-workspace-fingerprint':createHash('sha256').update(await realpath(directory)).digest('hex'), 'content-type': 'application/json' }
  const groupsUrl = base + '/api/crm/profile-capture/groups?entityType=person'
  expect((await fetch(groupsUrl, {headers:{...headers, 'x-wv-workspace-fingerprint':'previous workspace'}})).status).toBe(409)
  const dest = await (await fetch(groupsUrl, { headers })).json()
  expect(dest).toMatchObject({ groups: [{ id: 'g', name: 'Founders' }], workspaceToken:expect.any(String) })
  const snapshot = { workspaceToken:dest.workspaceToken, requestId: 'native-try', groupId: 'g', url: 'https://example.org/ada', title: 'Ada Example', text: 'Ada Example is a founder.', profile: { entityType: 'person', name: 'Ada Example' } }
  const post = () => fetch(base + '/api/crm/profile-capture/quick-add', { method: 'POST', headers, body: JSON.stringify(snapshot) })
  const stale = await fetch(base + '/api/crm/profile-capture/quick-add', { method:'POST', headers, body:JSON.stringify({...snapshot, workspaceToken:'earlier database'}) })
  expect(stale.status).toBe(409)
  expect(db.crm.rows('candidates')).toHaveLength(0)
  const first = await (await post()).json()
  expect(first).toMatchObject({ status: 'saved', recordId: expect.any(String) })
  expect(await (await post()).json()).toMatchObject({ recordId: first.recordId, draftId: first.draftId })
  expect(db.crm.list('people', {groupId: 'g'}).total).toBe(1)
  const digest = previewUrlDigest(snapshot.url)
  const matched = await fetch(base + '/api/crm/profile-capture/visible-matches', { method:'POST', headers, body:JSON.stringify({ digests:[digest,previewUrlDigest('https://other.example/ada')] }) })
  expect(await matched.json()).toMatchObject({ matches:{[digest]: { recordId:first.recordId, groupIds:['g'] }}, workspaceToken:dest.workspaceToken })
  const existing = await fetch(groupsUrl + '&sourceDigest=' + digest + '&nameDigest=' + previewNameDigest(snapshot.title), { headers })
  expect(await existing.json()).toMatchObject({ existing:{recordId:first.recordId,groupIds:['g']} })
  const unrelated = { ...snapshot, requestId:'same-name-new-site', url:'https://different.example.org/about' }
  const review = await fetch(base + '/api/crm/profile-capture/quick-add', { method:'POST', headers, body:JSON.stringify(unrelated) })
  expect(await review.json()).toMatchObject({status:'review', draftId:expect.any(String)})
  expect(db.crm.list('people').total).toBe(1)
  expect(await (await fetch(base + '/api/crm/profile-capture/' + first.draftId, { headers })).json()).toMatchObject({ source: { captureMethod: 'desktop-capture' }, status: 'accepted' })
})

it('reads only a uniquely linked, exactly named active person’s saved affiliation facts for a native preview', async () => {
  const source = 'https://uni.example/faculty/ada/'
  const work = { kind:'employment', organization:'Example Lab', current:true, role:'Professor', evidence:[] }
  const study = { kind:'education', organization:'Example University', evidence:[] }
  db.crm.command({operation:'create', collection:'people', requestId:'preview-person', record:{id:'p-preview',fullName:'Ada J. Example', urls:[source], affiliations:[{...work,id:'a'}, {...work,id:'b',organization:'Former Org',current:false,endDate:'2020'}, {...study,id:'c'}]}})
  const headers = { 'x-wv-client':'desktop-profile-capture', 'x-wv-workspace-fingerprint':createHash('sha256').update(await realpath(directory)).digest('hex') }
  const get = async (name: string, url: string) => (await fetch(base + '/api/crm/profile-capture/groups?' + new URLSearchParams({ entityType:'person',sourceDigest:previewUrlDigest(url),nameDigest:previewNameDigest(name) }), {headers})).json()
  const revision = db.crm.revision()
  expect(await get('Ada J. Example', source + '?utm_source=preview#profile')).toMatchObject({savedAffiliations: { companies:['Example Lab'], schools:[{organization:'Example University',status:'attended'}] }})
  expect(await get('Ada Example', source)).not.toHaveProperty('savedAffiliations')
  expect(await get('Ada J. Example', source + '?differentPerson=2')).not.toHaveProperty('savedAffiliations')
  expect(await get('Ada J. Example', 'https://other.example/ada')).not.toHaveProperty('savedAffiliations')
  expect(db.crm.revision()).toBe(revision)
  db.crm.command({operation:'create',collection:'people',requestId:'preview-duplicate-url',record:{id:'p-other',fullName:'Other Person',urls:[source]}})
  expect(await get('Ada J. Example', source)).not.toHaveProperty('savedAffiliations')
})

it('stages native field review without applying it and saves only the named existing contact’s portrait', async () => {
  const url = 'https://example.org/team/ben', name = 'Ben Southwood', photoUrl = 'https://portrait.example.org/editor.png'
  const headers = {'content-type':'application/json','x-wv-client':'desktop-profile-capture','x-wv-workspace-fingerprint':createHash('sha256').update(await realpath(directory)).digest('hex')}
  const workspaceToken = db.crm.workspaceFingerprint()
  const post = (action:string, data:Record<string,unknown>)=>fetch(base+'/api/crm/profile-capture/'+action,{method:'POST',headers,body:JSON.stringify({workspaceToken,requestId:'same-'+action,url,...data})})
  const receipt = await (await post('review-fields',{title:name,text:name+' appears on the team page.',profile:{entityType:'person',name,headline:'Editor'}})).json()
  expect(receipt).toMatchObject({draftId:expect.stringMatching(/^crm-profile-capture-/)})
  expect(db.crm.rows('people',false)).toHaveLength(0)
  expect(await (await post('photo-only',{name,photoUrl})).json()).toMatchObject({status:'unmatched'})
  db.crm.command({operation:'create',collection:'people',requestId:'existing-person',record:{id:'local-ben',fullName:name,urls:[url]}})
  expect(await (await post('photo-only',{name:'Someone Else',photoUrl})).json()).toMatchObject({status:'unmatched'})
  expect(await (await post('photo-only',{name,photoUrl})).json()).toMatchObject({status:'saved'})
  expect(await (await post('photo-only',{name,photoUrl})).json()).toMatchObject({status:'kept'})
  expect(db.crm.get('people','local-ben')).toMatchObject({avatarAssetId:expect.stringMatching(/^crm-avatar-/)})
  expect(db.crm.get('people','local-ben')?.jobTitle).not.toBe('Editor')
  expect((await post('photo-only',{workspaceToken:'stale',name,photoUrl})).status).toBe(409)
})
