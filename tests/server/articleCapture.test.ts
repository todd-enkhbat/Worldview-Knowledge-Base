import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
async function fixture(mode: 'service' | 'host' | 'accounts' = 'service') {
  const directory = mkdtempSync(join(tmpdir(), 'worldview-article-')), db = openWorldDb(join(directory, 'world.sqlite'))
  db.putSettings({ T0: Date.UTC(1990, 0, 1), yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: Date.now(), schemaVersion: SCHEMA_VERSION })
  const service = new ArticleCapture({ db, blobDir: join(directory, 'blobs') }), host = mode === 'service' ? undefined : createHost({ dataDir: directory, accounts: mode === 'accounts' })
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
    expect(Object.keys(files).sort()).toEqual(['README.md', 'background.js', 'content.js', 'folk-content.js', 'extract.js', 'manifest.json', 'popup.css', 'popup.html', 'popup.js'].map((name) => `WorldviewReader/${name}`).sort())
    expect(strFromU8(files['WorldviewReader/folk-content.js'])).toContain('MutationObserver')
    expect(JSON.parse(strFromU8(files['WorldviewReader/manifest.json'])).permissions).toEqual(['activeTab', 'scripting', 'storage'])
    expect(Object.keys(files).some((path) => /token|\.env|sqlite|blobs/.test(path))).toBe(false)
    const hosted = await fixture('accounts')
    expect((await fetch(hosted.base, { headers: hosted.management })).status).toBe(403)
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
