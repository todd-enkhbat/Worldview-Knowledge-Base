import { CrmProfileCapture } from '../../server/crmProfileCapture.ts'
import { createHash } from 'node:crypto'
import { applyStudy, decodeStudy, STUDY_KEY } from '../../src/study/model.ts'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReaderCalendar } from '../../server/readerEvents.ts'
import { ArticleCapture, handleArticleCaptureRequest } from '../../server/articleCapture.ts'
import { createHost, type Host } from '../../server/host.ts'
import { unzipSync, strFromU8 } from 'fflate'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'
import { SCHEMA_VERSION } from '../../src/domain/types.ts'
import { PORTABLE_WORLD_KEYS } from '../../src/data/worldSnapshot.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'
import type { ReadingSnapshot } from '../../src/reading/types.ts'

const origin = `chrome-extension://${'a'.repeat(32)}`
const article = { url: 'https://example.com/article?utm_source=test#section', title: 'Synthetic orchard article', text: 'The copper orchard uses local storage. The original evidence stays readable.' }
const live: { db: WorldDb; server: Server; directory: string; host?: Host }[] = []
afterEach(async () => { for (const item of live.splice(0)) { item.server.closeAllConnections(); await new Promise<void>((resolve) => item.server.close(() => resolve())); item.host?.close(); item.db.close(); rmSync(item.directory, { recursive: true, force: true }) } vi.restoreAllMocks() })
async function fixture(mode: 'service' | 'host' | 'accounts' = 'service', calendar?: ReaderCalendar) {
  const directory = mkdtempSync(join(tmpdir(), 'worldview-article-')), db = openWorldDb(join(directory, 'world.sqlite'))
  db.putSettings({ T0: Date.UTC(1990, 0, 1), yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: Date.now(), schemaVersion: SCHEMA_VERSION })
  const service = new ArticleCapture({ db, calendar, blobDir: join(directory, 'blobs') }), host = mode === 'service' ? undefined : createHost({ dataDir: directory, accounts: mode === 'accounts' })
  const server = createServer((req, res) => { if (host) host.handler(req, res); else void handleArticleCaptureRequest(service, req, res) })
  live.push({ db, server, directory, host })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/reading-capture`
  const management = { 'content-type': 'application/json', 'x-wv-client': 'article-test' }
  const pair = async () => { const response = await fetch(base, { method: 'POST', headers: management, body: JSON.stringify({ origin, name: 'Synthetic browser' }) }); expect(response.status).toBe(201); return await response.json() as { token: string; clientId: string } }
  const capture = (token: string, input: unknown, extra: Record<string, string> = {}) => fetch(`${base}/capture`, { method: 'POST', headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra }, body: JSON.stringify(input) })
  const corpus = () => db.getKv<KnowledgeSnapshot>('knowledge.v1')!
  const reading = () => db.getKv<ReadingSnapshot>('reading.v1')!
  return { directory, db, service, base, management, pair, capture, corpus, reading }
}

describe('paired browser article capture over HTTP', () => {
  it('relays Enki requests only between the intended desktop workspace and an authenticated Reader', async () => {
    const f = await fixture(), paired = await f.pair()
    const requestHeaders = { ...f.management, 'x-wv-client': 'desktop-profile-capture', 'x-wv-workspace-fingerprint': createHash('sha256').update(f.directory).digest('hex') }
    const browserHeaders = { origin, authorization: 'Bearer ' + paired.token, 'content-type': 'application/json' }
    const post = (path: string, input: unknown, headers: Record<string, string> = requestHeaders) => fetch(f.base + '/enki/' + path, { method: 'POST', headers, body: JSON.stringify(input) })
    expect((await post('request', { operation: 'page', args: {} }, f.management)).status).toBe(403)
    expect((await post('request', { operation: 'page', args: {} }, { ...requestHeaders, origin: 'https://untrusted.example' })).status).toBe(403)
    expect((await post('poll', {}, { ...browserHeaders, authorization: 'Bearer invalid' })).status).toBe(401)
    const observed = vi.spyOn(f.service.readerBridge, 'poll')
    const polling = post('poll', {}, browserHeaders)
    await vi.waitFor(() => expect(observed).toHaveBeenCalledOnce())
    const desktop = post('request', { operation: 'page', args: {} })
    const { command } = await (await polling).json()
    expect(command.operation).toBe('page')
    const reply = { id: command.id, value: { title: 'Field notes', url: article.url } }
    expect((await post('reply', reply, browserHeaders)).status).toBe(200)
    const result = await (await desktop).json()
    expect(result).toEqual({ client: paired.clientId, value: reply.value })
    expect(JSON.stringify(result)).not.toContain(paired.token)
    expect((await post('summons', {}, f.management)).status).toBe(403)
    const summons = vi.spyOn(f.service.readerBridge, 'waitForSummon'), waiting = post('summons', {})
    await vi.waitFor(() => expect(summons).toHaveBeenCalledOnce())
    const ref = { id: '17', url: article.url, documentId: 'test-document' }
    expect((await post('summon', { ref }, browserHeaders)).status).toBe(200)
    expect(await (await waiting).json()).toMatchObject({ summon: { client: paired.clientId, ref } })
    expect((await post('reply', reply, browserHeaders)).status).toBe(400)
    expect((await post('request', { operation: 'evaluate', args: { code: 'alert(1)' } })).status).toBe(400)
    await post('disconnect', {}, browserHeaders)
    expect((await post('request', { operation: 'page', args: {} })).status).toBe(400)
  })
  it('retains profile references in originals and versions even when the visible text is unchanged', async () => {
    const f = await fixture(), paired = await f.pair()
    expect((await f.capture(paired.token, { ...article, sequence: 1 })).status).toBe(200)
    const profileImages = [{ url: 'https://images.example/person.jpg', isProfile: true, label: 'Profile photo' }], profileLinks = [{ url: 'https://github.com/example' }]
    expect((await f.capture(paired.token, { ...article, profileImages, profileLinks, sequence: 2 })).status).toBe(200)
    const versions = f.corpus().versions
    expect(versions).toHaveLength(2)
    expect(versions[1].text).toBe(versions[0].text)
    expect(versions[1].metadata?.profileImages).toMatchObject([{ url: profileImages[0].url, sourceUrl: article.url, isProfile: true }])
    const original = JSON.parse(readFileSync(join(f.directory, 'blobs', versions[1].originalBlobId), 'utf8'))
    expect(original.profileLinks).toEqual([{ url: 'https://github.com/example', rel: 'me' }])
    expect((await f.capture(paired.token, { url: article.url, sequence: 3, profileLinks: [{ url: 'https://x.com/example' }] })).status).toBe(200)
    expect(f.corpus().versions.at(-1)?.metadata?.profileImages).toEqual(versions[1].metadata?.profileImages)
    expect((await f.capture(paired.token, { url: article.url, sequence: 4, progress: { fraction: .5, position: 120, activeMs: 5000, following: true } })).status).toBe(200)
    expect(f.corpus().versions).toHaveLength(3)
  })
  it('mounts through the actual host and downloads only the static companion files behind local management checks', async () => {
    const f = await fixture('host'), paired = await f.pair()
    expect((await f.capture(paired.token, { ...article, sequence: 1 })).status).toBe(200)
    expect((await fetch(`${f.base}/download`)).status).toBe(403)
    const response = await fetch(`${f.base}/download`, { headers: f.management })
    expect(response.status).toBe(200); expect(response.headers.get('content-disposition')).toContain('WorldviewReader.zip')
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
    expect(Object.keys(files).sort()).toEqual(['README.md', 'background.js', 'enki-bridge.js', 'enki-shortcut.js', 'content.js', 'folk-content.js', 'extract.js', 'group-icon.js', 'worldview-128.png', 'manifest.json', 'popup.css', 'popup.html', 'popup.js', 'application-form.js', 'contact-ui.js', 'contact-ui.css', 'organization-ui.js', 'reader-events-ui.js', 'todo-ui.js', 'todo-ui.css'].map((name) => `WorldviewReader/${name}`).sort())
    expect(strFromU8(files['WorldviewReader/folk-content.js'])).toContain('MutationObserver')
    expect(JSON.parse(strFromU8(files['WorldviewReader/manifest.json'])).permissions).toEqual(['activeTab', 'scripting', 'storage', 'alarms'])
    expect(Object.keys(files).some((path) => /token|\.env|sqlite|blobs/.test(path))).toBe(false)
    const hosted = await fixture('accounts')
    expect((await fetch(hosted.base, { headers: hosted.management })).status).toBe(403)
  })
  it('shows an extension save in an already connected desktop workspace and links the same record and group', async () => {
    const f = await fixture('host'), paired = await f.pair(), api = f.base.replace('/reading-capture', '')
    const group = { id: 'local-group', name: 'Reading group', entityType: 'person' }
    const command = await fetch(api + '/crm/command', { method: 'POST', headers: f.management, body: JSON.stringify({ operation: 'create', collection: 'groups', requestId: 'add-group', record: group }) })
    expect(command.ok).toBe(true)
    const controller = new AbortController(), desktop = await fetch(api + '/world/changes?client=open-mac-window', { signal: controller.signal })
    const reader = desktop.body!.getReader()
    try {
      const send = await f.capture(paired.token, { saveProfileData: true, quickAdd: true, sequence: 1, groupId: group.id, url: 'https://example.org/profile', title: 'Reader Profile', text: 'Reader Profile', profile: { entityType: 'person', name: 'Reader Profile' } })
      expect(send.ok).toBe(true)
      const receipt = await send.json()
      expect(receipt.quickAdd.status).toBe('saved')
      expect(new URL(receipt.reviewUrl).origin).toBe(new URL(f.base).origin)
      let frames = ''
      const timeout = setTimeout(() => controller.abort(), 5000)
      try {
        while (!frames.includes('"from":"reader-profile"')) {
          const { value, done } = await reader.read()
          if (done) break
          frames += new TextDecoder().decode(value)
        }
      } finally { clearTimeout(timeout) }
      expect(frames).toContain('"keys":["crm.v1"]')
      const status = await (await fetch(api + '/crm/status', { headers: f.management })).json()
      expect(status.workspaceFingerprint).toBe(receipt.workspaceFingerprint)
      expect(status.lastBrowserSave).toEqual({ id: receipt.quickAdd.recordId, kind: 'person', name: 'Reader Profile' })
      const visible = await (await fetch(api + '/crm/people?groupId=' + group.id, { headers: f.management })).json()
      expect(visible.rows.map((row: { id: string }) => row.id)).toEqual([receipt.quickAdd.recordId])
    } finally { controller.abort(); reader.releaseLock() }
  })
  it('requires local management authorization and never returns token hashes or old tokens', async () => {
    const f = await fixture()
    expect((await fetch(f.base)).status).toBe(403)
    expect((await fetch(f.base, { headers: { ...f.management, origin: 'https://untrusted.example' } })).status).toBe(403)
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => { const request = httpRequest(f.base, { headers: { ...f.management, host: 'attacker.example' } }, (response) => { response.resume(); resolve(response.statusCode) }); request.on('error', reject); request.end() })
    expect(hostStatus).toBe(403)
    const paired = await f.pair(), status = await (await fetch(f.base, { headers: f.management })).text()
    expect(status).not.toContain(paired.token); expect(status).not.toContain('tokenHash')
    expect(PORTABLE_WORLD_KEYS).not.toContain('reading.capture.clients.v1'); expect(PORTABLE_WORLD_KEYS).not.toContain('reading.capture.receipts.v1')
  })
  it('allows preflight only for a paired extension and requires its exact origin and bearer token', async () => {
    const f = await fixture(), paired = await f.pair()
    const preflight = await fetch(`${f.base}/capture`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } })
    expect(preflight.status).toBe(204); expect(preflight.headers.get('access-control-allow-origin')).toBe(origin)
    expect((await f.capture('', { ...article, sequence: 1 })).status).toBe(401)
    expect((await f.capture(paired.token, { ...article, sequence: 1 }, { origin: `chrome-extension://${'b'.repeat(32)}` })).status).toBe(403)
    expect((await f.capture(paired.token, { ...article, sequence: 1 }, { origin: 'https://example.com' })).status).toBe(403)
    expect(f.db.getKv('knowledge.v1')).toBeUndefined()
  })
  it('retains original text and exact highlight offsets atomically, with separate human commentary and no 3D projection', async () => {
    const f = await fixture(), paired = await f.pair(), quote = 'local storage', start = article.text.indexOf(quote)
    const input = { ...article, sequence: 1, selection: { quote, start, end: start + quote.length, note: 'This is my own reaction.' }, remark: 'Keep the source, not just a summary.', progress: { fraction: .25, position: 200, activeMs: 15000, following: true } }
    const first = await f.capture(paired.token, input); expect(first.status).toBe(200)
    const result = await first.json(), corpus = f.corpus(), reading = f.reading()
    expect(corpus.sources).toHaveLength(1); expect(corpus.sources[0].nodeId).toBeUndefined(); expect(f.db.listNodes()).toEqual([])
    expect(corpus.passages.every((passage) => passage.role === 'third-party' && passage.authoredAt === null)).toBe(true)
    expect(corpus.versions[0].metadata).toMatchObject({ url: article.url, canonicalUrl: 'https://example.com/article', format: 'article' })
    expect(JSON.parse(readFileSync(join(f.directory, 'blobs', corpus.versions[0].originalBlobId), 'utf8'))).toMatchObject({ text: article.text, url: article.url })
    expect(reading.highlights).toMatchObject([{ sourceId: result.sourceId, versionId: result.versionId, quote, start, end: start + quote.length, note: 'This is my own reaction.' }])
    expect(reading.notes[0].text).toBe('Keep the source, not just a summary.')
    expect(reading.items[0]).toMatchObject({ progress: .25, activeReadMs: 15000, following: true })
    const revision = corpus.revision
    expect((await f.capture(paired.token, input)).status).toBe(200)
    expect(f.corpus().revision).toBe(revision); expect(f.reading().highlights).toHaveLength(1); expect(f.reading().items[0].activeReadMs).toBe(15000)
    expect((await f.capture(paired.token, { ...input, remark: 'Different payload, same sequence' })).status).toBe(409)
    expect((await f.capture(paired.token, { ...article, sequence: 2, selection: { ...input.selection, note: 'An additional reaction.' } })).status).toBe(200)
    expect(f.reading().highlights).toHaveLength(1)
    expect(f.reading().highlights[0].note).toBe('This is my own reaction.\n\nAn additional reaction.')
  })
  it('deduplicates stable URLs while retaining earlier source versions and their highlights', async () => {
    const f = await fixture(), paired = await f.pair()
    const first = await (await f.capture(paired.token, { ...article, sequence: 1, selection: { quote: 'copper orchard' } })).json()
    const second = await (await f.capture(paired.token, { ...article, url: 'https://example.com/article?utm_medium=other#end', sequence: 2, text: `${article.text}\nA new retained revision.` })).json()
    expect(second.sourceId).toBe(first.sourceId); expect(second.versionId).not.toBe(first.versionId)
    expect(f.corpus().sources).toHaveLength(1); expect(f.corpus().versions).toHaveLength(2)
    expect(f.reading().highlights[0].versionId).toBe(first.versionId)
    const retryAfterRestart = new ArticleCapture({ db: f.db, blobDir: join(f.directory, 'blobs') })
    expect(await retryAfterRestart.capture({ ...article, url: 'https://example.com/article?utm_medium=other#end', sequence: 2, text: `${article.text}\nA new retained revision.` }, origin, paired.token)).toEqual(second)
    expect(f.corpus().versions).toHaveLength(2)
  })
  it('refuses ambiguous anchors, oversized input, revoked tokens and excluded sources without partial data writes', async () => {
    const f = await fixture(), paired = await f.pair()
    expect((await f.capture(paired.token, { ...article, text: 'Repeated quote. Repeated quote.', sequence: 1, selection: { quote: 'Repeated quote.' } })).status).toBe(409)
    expect(f.db.getKv('knowledge.v1')).toBeUndefined(); expect(f.db.getKv('reading.v1')).toBeUndefined()
    expect((await f.capture(paired.token, { ...article, sequence: 1, text: 'x'.repeat(1024 * 1024) })).status).toBe(413)
    expect((await f.capture(paired.token, { ...article, sequence: 1, url: 'file:///private/data' })).status).toBe(400)
    expect((await f.capture(paired.token, { ...article, sequence: 1 })).status).toBe(200)
    const snapshot = f.corpus(); snapshot.sources[0].excluded = true; snapshot.revision++; f.db.putKv('knowledge.v1', snapshot)
    expect((await f.capture(paired.token, { ...article, sequence: 2 })).status).toBe(409)
    await fetch(`${f.base}/${paired.clientId}`, { method: 'DELETE', headers: f.management })
    expect((await f.capture(paired.token, { ...article, sequence: 2 })).status).toBe(403)
    expect(f.corpus().sources).toHaveLength(1)
  })
  it('does not split a source and its reading metadata when their atomic commit conflicts', async () => {
    const f = await fixture(), paired = await f.pair()
    vi.spyOn(f.db, 'commitKnowledge').mockReturnValueOnce(false)
    expect((await f.capture(paired.token, { ...article, sequence: 1, selection: { quote: 'local storage' } })).status).toBe(409)
    expect(f.db.getKv('knowledge.v1')).toBeUndefined(); expect(f.db.getKv('reading.v1')).toBeUndefined(); expect(f.db.getKv('reading.capture.receipts.v1')).toBeUndefined()
    expect((await f.capture(paired.token, { ...article, sequence: 1, selection: { quote: 'local storage' } })).status).toBe(200)
    expect(f.reading().highlights).toHaveLength(1)
  })
  it('never marks a short article read from an immediate stop or zero-dwell progress report', async () => {
    const f = await fixture(), paired = await f.pair()
    const progress = { fraction: 1, position: 0, activeMs: 0, following: true }
    expect((await f.capture(paired.token, { ...article, sequence: 1, progress })).status).toBe(200)
    expect(f.reading().items[0]).toMatchObject({ status: 'reading', progress: 0, activeReadMs: 0 })
    expect((await f.capture(paired.token, { url: article.url, sequence: 2, progress: { ...progress, following: false } })).status).toBe(200)
    expect(f.reading().items[0].status).not.toBe('read')
    expect((await f.capture(paired.token, { url: article.url, sequence: 3, progress: { ...progress, activeMs: 14999 } })).status).toBe(200)
    expect(f.reading().items[0].status).not.toBe('read')
    expect((await f.capture(paired.token, { url: article.url, sequence: 4, progress: { ...progress, activeMs: 1 } })).status).toBe(200)
    expect(f.reading().items[0]).toMatchObject({ status: 'read', progress: 1, activeReadMs: 15000 })
  })
})

it('connects a requesting extension only after local approval, binds the secret to its exact origin, and expires handoffs', async () => {
  const f = await fixture()
  const connect = async (sender = origin) => { const response = await fetch(`${f.base}/connect`, { method: 'POST', headers: { origin: sender, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic Reader' }) }); return { response, value: await response.json() as { requestId: string; secret: string } } }
  expect((await connect('https://untrusted.example')).response.status).toBe(403)
  const requested = await connect(); expect(requested.response.status).toBe(201)
  const path = `${f.base}/connect/${requested.value.requestId}`, headers = { origin, authorization: `Bearer ${requested.value.secret}` }
  expect(await (await fetch(path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'check' }) })).json()).toMatchObject({ connected: false })
  expect((await fetch(path, { method: 'POST', headers: { authorization: headers.authorization, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'check' }) })).status).toBe(403)
  const status = await (await fetch(f.base, { headers: f.management })).text()
  expect(status).toContain(requested.value.requestId); expect(status).not.toContain(requested.value.secret)
  expect((await fetch(`${path}/approve`, { method: 'POST' })).status).toBe(403)
  expect((await fetch(`${path}/approve`, { method: 'POST', headers: f.management })).status).toBe(200)
  expect((await fetch(path, { headers: { ...headers, origin: `chrome-extension://${'b'.repeat(32)}` } })).status).toBe(401)
  const ready = await (await fetch(path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'check' }) })).json() as { connected: boolean; token: string }
  expect(ready.connected).toBe(true); expect(ready.token).toMatch(/^wvread_/)
  expect((await f.capture(ready.token, { ...article, sequence: 1 })).status).toBe(200)
  expect((await fetch(path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'acknowledge' }) })).status).toBe(200)
  expect((await fetch(path, { headers })).status).toBe(401)
  expect(JSON.stringify(f.service.status())).not.toContain(ready.token)
  let now = Date.now()
  const timed = new ArticleCapture({ db: f.db, blobDir: join(f.directory, 'blobs'), now: () => now }), pending = timed.requestConnection(origin, {})
  now += 5 * 60_000 + 1
  expect(() => timed.approveConnection(pending.requestId)).toThrow(/expired/)
  expect(timed.status().requests).toEqual([])
})

it('persists an observed application submission through the paired Reader HTTP route',async()=>{
 const f=await fixture('host'),paired=await f.pair(),now=Date.now(),state=decodeStudy(undefined)
 const id=applyStudy(state,'application',{organization:'Alive Prize',opportunity:'Alive Prize',source:'https://aliveprize.com/apply',step:'Application',submitted:false,answers:[],deadline:'11/25'},now-1000)
 f.db.putKv(STUDY_KEY,state)
 const payload={applicationId:id,submissionId:crypto.randomUUID(),sequence:1,workspaceToken:f.db.crm.workspaceFingerprint(),source:'https://aliveprize.com/apply',form:{submitted:true,appliedAt:now,submissionEvidence:'Thank you for your application',answers:[{question:'Why apply?',answer:'My final answer.'}]}}
 const post=(value:unknown)=>fetch(f.base+'/application-submitted',{method:'POST',headers:{origin,authorization:'Bearer '+paired.token,'content-type':'application/json'},body:JSON.stringify(value)})
 expect((await post({...payload,workspaceToken:'earlier-workspace'})).status).toBe(409)
 const saved=await post(payload), receipt=await saved.json();expect(saved.status,JSON.stringify(receipt)).toBe(200)
 expect(receipt).toMatchObject({ok:true,id,appliedAt:now,submissionId:payload.submissionId,sequence:1})
 const persisted=f.db.getKv(STUDY_KEY)
 const retried=await post({...payload,sequence:2})
 expect(await retried.json()).toEqual({...receipt,sequence:2})
 expect(f.db.getKv(STUDY_KEY)).toEqual(persisted)
 expect((await post({...payload,form:{...payload.form,answers:[]}})).status).toBe(409)
 expect(decodeStudy(f.db.getKv(STUDY_KEY)).applications[0]).toMatchObject({appliedAt:now,deadline:'11/25',revisions:[expect.anything(),expect.objectContaining({submitted:true,answers:[{question:'Why apply?',answer:'My final answer.'}]})]})
})

it('edits the matched saved organization and keeps related activity scoped to that company', async () => {
  const f = await fixture(), { token } = await f.pair()
  const url = 'https://www.linkedin.com/company/acme-example/'
  const company = f.db.crm.command({ requestId: 'seed-company', operation: 'create', collection: 'companies', record: { name: 'Acme', urls: [url], addresses: [{ label: 'Retained address' }] } }).record!
  const other = f.db.crm.command({ requestId: 'seed-other', operation: 'create', collection: 'companies', record: { name: 'Other', urls: ['https://www.linkedin.com/company/another/'] } }).record!
  const companyContext = { id: company.id, url, workspace: f.db.crm.workspaceFingerprint() }
  const send = (data: Record<string, unknown> = {}, auth = token) => fetch(f.base + '/organization', {
    method: 'POST', headers: { origin, authorization: 'Bearer ' + auth, 'content-type': 'application/json' },
    body: JSON.stringify({ ...companyContext, ...data }),
  })
  const edit = { action: 'edit', requestId: '00000001-0000-4000-8000-000000000000', revision: company.revision, patch: { foundationYear: 2022, employeeRange: '11–50', fundingRaised: 12500, lastFundingDate: '2026-03-12', status: 'Researching' } }
  expect((await send({}, 'invalid')).status).toBe(401)
  expect((await send({ ...edit, id: other.id })).status).toBe(404)
  expect((await send({ ...edit, workspace: 'somewhere-else' })).status).toBe(409)
  const saved = await send(edit)
  expect(saved.status).toBe(200)
  expect((await saved.json()).record).toMatchObject({ ...edit.patch, addresses: [{ label: 'Retained address' }] })
  expect((await send({ ...edit, requestId: '00000002-0000-4000-8000-000000000000' })).status).toBe(409)
  expect((await send({ ...edit, requestId: '00000003-0000-4000-8000-000000000000', patch: { archivedAt: 1 } })).status).toBe(400)
  const note = { action: 'note', body: 'Prepare questions for next meeting', requestId: '00000004-0000-4000-8000-000000000000' }
  expect((await send(note)).status).toBe(200)
  expect((await send(note)).status).toBe(200)
  expect((await (await send()).json()).notes).toHaveLength(1)
  expect(f.db.crm.detail('companies', other.id).related.notes).toHaveLength(0)
})


it('enriches missing saved-person fields with source evidence and keeps manually supplied values', async () => {
  const f = await fixture(), { token } = await f.pair()
  const url = 'https://www.linkedin.com/in/river-example/'
  const capture = new CrmProfileCapture({ db: f.db, store: f.db.crm, blobDir: join(f.directory, 'blobs') })
  const draft = await capture.stage({ requestId: 'reader-enrichment-seed', url, title: 'River Example', text: 'Public profile evidence for River Example.',
    profile: { name: 'River Example', entityType: 'person', headline: 'Engineer', emails: ['river@example.org'], phones: ['+14155550123'], urls: [url] } })
  const { record } = await capture.apply(draft.id, { requestId: 'reader-enrichment-accept', createNew: true, fields: ['name', 'urls'] })
  f.db.crm.command({ requestId: 'reader-enrichment-manual-role', operation: 'update', collection: 'people', id: record.id,
    expectedRecordRevision: record.revision, patch: { jobTitle: 'Manual role' } })
  const send = async (extra: Record<string, unknown> = {}) => {
    const response = await fetch(f.base + '/organization', {
      method: 'POST', headers: { origin, authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ id: record.id, url, workspace: f.db.crm.workspaceFingerprint(), entityType: 'person', ...extra }),
    })
    return { status: response.status, body: await response.json() }
  }
  const result = await send({ action: 'enrich', requestId: '00000005-0000-4000-8000-000000000000' })
  expect(result).toMatchObject({ status: 200, body: {
    record: { jobTitle: 'Manual role', emails: ['river@example.org'], phones: ['+14155550123'] },
    evidence: { emails: { provider: 'Saved profile', url }, phones: { provider: 'Saved profile', url } },
    enrichment: { fields: ['emails', 'phones'] },
  } })
  expect((await send()).body.evidence).not.toHaveProperty('jobTitle')
  const updated = await send({ action: 'edit', requestId: '00000006-0000-4000-8000-000000000000', revision: result.body.record.revision, patch: { emails: ['manual@example.org'] } })
  expect(updated).toMatchObject({ status: 200, body: { record: { emails: ['manual@example.org'] } } })
  expect(updated.body.evidence).not.toHaveProperty('emails')
  const note = await send({ action: 'note', requestId: '00000007-0000-4000-8000-000000000000', body: 'Met at the conference.' })
  expect(note).toMatchObject({ status: 200, body: { notes: [{ body: 'Met at the conference.' }] } })
})


it('suggests events across accounts and reuses a single event across people and companies', async () => {
  const now = Date.now()
  const accounts = ['personal', 'work'].map(id => ({
    id, email: id + '@example.test', label: id, configured: true, connected: true, autoSync: false,
    capabilities: ['calendar' as const], scopes: [], connectedAt: null, lastSyncAt: null, includeSubjects: false,
  }))
  const calendar: ReaderCalendar = {
    status: async () => ({ available: true, accounts, driveClientAvailable: false, aiRequired: false,
      happenstance: { configured: false, automaticResearch: false, mcpUrl: '' } }),
    calendars: async accountId => ({ complete: true, calendars: [
      { id: accountId, summary: 'Calendar', primary: true, selected: true, timeZone: 'UTC', accessRole: 'owner' },
    ] }),
    events: async ({ accountId }) => ({ nextPageToken: null, timeZone: 'UTC', attendanceConfirmed: false, events: [{
      id: String(accountId), accountId: String(accountId), calendarId: String(accountId), iCalUID: 'same-invitation',
      title: 'Community dinner', body: 'https://partiful.com/e/example and private agenda', status: 'confirmed', startAt: now,
      endAt: now + 3600000, timezone: 'UTC', allDay: false, htmlLink: '', updated: '', originalStartTime: '',
      raw: { location: 'private location' }, organizer: { email: 'host@example.test', name: 'Host' },
      attendees: accountId === 'work' ? [{ email: 'river@example.test', name: 'River', responseStatus: 'accepted', self: false, organizer: false }] : [],
    }] }),
  }
  const f = await fixture('service', calendar), { token } = await f.pair()
  const personUrl = 'https://www.linkedin.com/in/river-example/'
  const companyUrl = 'https://www.linkedin.com/company/company-example/'
  const person = f.db.crm.command({ requestId: 'event-person', operation: 'create', collection: 'people',
    record: { fullName: 'River Example', emails: ['river@example.test'], urls: [personUrl] } }).record!
  const company = f.db.crm.command({ requestId: 'event-company', operation: 'create', collection: 'companies',
    record: { name: 'Example', urls: [companyUrl] } }).record!
  const send = (entityType: 'person' | 'company', data: Record<string, unknown>, auth = token) => fetch(f.base + '/organization', {
    method: 'POST', headers: { origin, authorization: 'Bearer ' + auth, 'content-type': 'application/json' },
    body: JSON.stringify({ ...data, entityType, id: entityType === 'person' ? person.id : company.id,
      url: entityType === 'person' ? personUrl : companyUrl, workspace: f.db.crm.workspaceFingerprint() }),
  })
  const suggestions = await (await send('person', { action: 'event-suggestions', online: true })).json()
  expect(suggestions.calendarStatus).toBe('complete')
  expect(suggestions.events).toHaveLength(1)
  expect(suggestions.events[0]).toMatchObject({ title: 'Community dinner', source: 'Partiful', matched: true })
  expect(JSON.stringify(suggestions)).not.toContain('private')
  const attach = { action: 'link-event', eventId: suggestions.events[0].id, requestId: '11111111-0000-4000-8000-000000000000' }
  expect((await send('company', attach)).status).toBe(400)
  expect((await send('person', attach, (await f.pair()).token)).status).toBe(400)
  expect((await send('person', attach)).status).toBe(200)
  expect((await send('person', attach)).status).toBe(200)
  const saved = await (await send('company', { action: 'event-suggestions', online: true })).json()
  expect(saved.events).toHaveLength(1)
  expect(saved.events[0]).toMatchObject({ title: 'Community dinner', source: 'Partiful' })
  expect((await send('company', { ...attach, eventId: saved.events[0].id,
    requestId: '22222222-0000-4000-8000-000000000000' })).status).toBe(200)
  expect(f.db.crm.rows('interactions', false)).toMatchObject([
    { personIds: [person.id], companyIds: [company.id], attendanceConfirmed: false },
  ])

  const create = { action: 'interaction', kind: 'event', title: 'Demo evening', body: '', date: null,
    requestId: '33333333-0000-4000-8000-000000000000' }
  expect((await send('company', create)).status).toBe(200)
  expect((await send('company', create)).status).toBe(200)
  const local = await (await send('person', { action: 'event-suggestions' })).json()
  expect(local.events).toEqual([expect.objectContaining({ title: 'Demo evening', source: 'Saved' })])
  expect(f.db.crm.rows('interactions', false)).toHaveLength(2)
})

it('edits the same saved CRM record through the workspace-bound Enki endpoint', async () => {
  const f = await fixture('host')
  const person = f.db.crm.command({requestId:'enki-record-seed',operation:'create',collection:'people',
    record:{fullName:'Enki Example',urls:['https://www.linkedin.com/in/enki-example/']}}).record!
  const headers = {...f.management,'x-wv-client':'desktop-profile-capture',
    'x-wv-workspace-fingerprint':createHash('sha256').update(realpathSync(f.directory)).digest('hex')}
  const post = (fields:Record<string,unknown>) => fetch(f.base.replace('/reading-capture','/crm/profile-capture/organization'),
    {method:'POST',headers,body:JSON.stringify({id:person.id,entityType:'person',workspaceToken:f.db.crm.workspaceFingerprint(),...fields})})
  expect((await post({workspaceToken:'wrong-workspace'})).status).toBe(409)
  const read = await post({})
  const value = await read.json()
  expect(read.status, JSON.stringify(value)).toBe(200)
  expect(value.record.fullName).toBe('Enki Example')
  const note={action:'note',body:'A note from Enki',requestId:'aaaaaaaa-0000-4000-8000-000000000000'}
  expect((await post(note)).status).toBe(200)
  expect((await post(note)).status).toBe(200)
  expect(f.db.crm.detail('people',person.id).related.notes).toHaveLength(1)
})
