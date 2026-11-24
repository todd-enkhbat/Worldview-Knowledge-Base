import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { zipSync, strToU8 } from 'fflate'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GoogleDriveConnection, GOOGLE_DRIVE_SCOPE, handleGoogleDriveRequest, DRIVE_EXPORT_LIMIT } from '../../server/connections/googleDrive.ts'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'
import { PORTABLE_WORLD_KEYS } from '../../src/data/worldSnapshot.ts'
import { defaultWritingAppearance, writingFromPlainText } from '../../src/writing/model.ts'
let directory: string, db: WorldDb, service: GoogleDriveConnection, time: number
const DOC = 'application/vnd.google-apps.document'
const metadata = (version = '7', mimeType = 'text/plain') => ({ id: 'selected-file', name: 'Chosen original.txt', mimeType, version, webViewLink: 'https://drive.google.com/file/d/selected-file/view', capabilities: { canDownload: true, canEdit: true } })
const provider = vi.fn<typeof fetch>()
const json = (value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
const nativeExport = (year = 2025, text = 'Exact document words.') => zipSync({ 'word/document.xml': strToU8(`<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`) }, { mtime: new Date(year, 0, 1) })
async function configured() { await service.configure({ oauthClient: { installed: { client_id: 'synthetic-client.apps.googleusercontent.com', client_secret: 'SYNTHETIC_NOT_REAL' } }, pickerKey: 'synthetic-picker-key', appId: '123456789' }) }
async function connect() { await configured(); const start = await service.start('http://127.0.0.1:5173'), url = new URL(start.authorizationUrl); provider.mockResolvedValueOnce(json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, scope: GOOGLE_DRIVE_SCOPE })); await service.callback(new URL('http://127.0.0.1:5173/api/connections/drive/callback?code=synthetic-code&state=' + url.searchParams.get('state')), 'http://127.0.0.1:5173'); return url }
function draft() { const document = { id: 'saved-writing', title: 'My saved essay', subtitle: '', byline: 'A writer', format: 'essay', content: writingFromPlainText('A precise saved draft.'), appearance: defaultWritingAppearance(), createdAt: 1, updatedAt: 2, archivedAt: null }; db.putKv('writing.v1', { schemaVersion: 1, revision: 1, docs: [document] }); return { documentId: document.id, expectedUpdatedAt: 2, htmlBase64: Buffer.from('<html><body><h1>My saved essay</h1><p>A precise saved draft.</p></body></html>').toString('base64'), nativeDocument: true } }
beforeEach(() => { time = 1000; provider.mockReset(); vi.stubEnv('GOOGLE_DRIVE_CLIENT_ID', ''); vi.stubEnv('GOOGLE_DRIVE_CLIENT_SECRET', ''); vi.stubEnv('GOOGLE_PICKER_API_KEY', ''); vi.stubEnv('GOOGLE_DRIVE_APP_ID', ''); directory = mkdtempSync(join(tmpdir(), 'worldview-drive-')); db = openWorldDb(join(directory, 'world.sqlite')); db.putSettings({ T0: 0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: 1, schemaVersion: 1 }); service = new GoogleDriveConnection({ db, blobDir: join(directory, 'blobs'), now: () => time, fetch: provider }) })
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('starts honestly disconnected and stores no credentials in portable or API-readable world state', async () => {
  expect(await service.status()).toMatchObject({ available: true, configured: false, connected: false, aiRequired: false })
  expect(provider).not.toHaveBeenCalled()
  await connect()
  expect(await service.status()).toMatchObject({ configured: true, connected: true, pickerConfigured: true })
  const privateFile = join(directory, 'connections', 'google-drive.private.json')
  expect(statSync(privateFile).mode & 0o777).toBe(0o600)
  expect(readFileSync(privateFile, 'utf8')).toContain('synthetic-refresh')
  expect(JSON.stringify(db.readWorldSnapshot(PORTABLE_WORLD_KEYS))).not.toMatch(/synthetic-access|synthetic-refresh|SYNTHETIC_NOT_REAL/)
  expect(JSON.stringify(await service.status())).not.toMatch(/synthetic-access|synthetic-refresh|SYNTHETIC_NOT_REAL/)
})
it('uses a single selected-file scope, PKCE S256, a loopback callback and single-use state', async () => {
  const url = await connect(), params = url.searchParams
  expect(params.get('scope')).toBe(GOOGLE_DRIVE_SCOPE); expect(params.get('code_challenge_method')).toBe('S256')
  expect(params.get('redirect_uri')).toBe('http://127.0.0.1:5173/api/connections/drive/callback')
  const exchange = provider.mock.calls[0]
  expect(exchange[0]).toBe('https://oauth2.googleapis.com/token')
  const body = exchange[1]?.body as URLSearchParams
  expect(body.get('code_verifier')?.length).toBeGreaterThanOrEqual(43)
  await expect(service.callback(new URL('http://127.0.0.1:5173/api/connections/drive/callback?code=replay&state=' + params.get('state')), 'http://127.0.0.1:5173')).rejects.toThrow(/expired/)
  expect(provider).toHaveBeenCalledTimes(1)
})
it('uses the Desktop system-browser Picker without an API key and exposes only its validated selected file', async () => {
  await service.configure({ oauthClient: { installed: { client_id: 'synthetic-client.apps.googleusercontent.com' } } })
  const start = await service.start('http://localhost:5173', true), url = new URL(start.authorizationUrl)
  expect(url.searchParams.get('trigger_onepick')).toBe('true')
  expect(url.searchParams.get('allow_multiple')).toBe('false')
  expect(url.searchParams.get('prompt')).toBe('consent')
  expect(url.searchParams.get('scope')).toBe(GOOGLE_DRIVE_SCOPE)
  expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  expect(await service.status()).toMatchObject({ pickerMode: 'desktop', pickerConfigured: true, connected: false })
  provider.mockResolvedValueOnce(json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', scope: GOOGLE_DRIVE_SCOPE }))
  const callback = new URL('http://127.0.0.1:5173/api/connections/drive/callback?code=synthetic&picked_file_ids=selected-file&state=' + url.searchParams.get('state'))
  expect(await service.callback(callback, 'http://127.0.0.1:5173')).toBe('http://localhost:5173/#/sources?connection=drive&drive=connected')
  const status = await service.status()
  expect(status).toMatchObject({ connected: true, selection: { fileIds: ['selected-file'] } })
  expect(status.connectionRevision).toBeGreaterThan(start.connectionRevision)
  expect(JSON.stringify(status)).not.toMatch(/synthetic-access|synthetic-refresh/)
  provider.mockResolvedValueOnce(json(metadata('7', DOC), { etag: '"r7"' }))
  const selected = await service.inspect(status.selection!.fileIds[0])
  expect(selected.file.version).toBe('7'); expect(selected.updateAvailable).toBe(true)
  await expect(service.callback(callback, 'http://127.0.0.1:5173')).rejects.toThrow(/expired/)
  time += 600001
  expect((await service.status()).selection).toBeUndefined()
})
it('rejects missing, duplicate, multiple or malformed Desktop Picker IDs before exchanging the code', async () => {
  await configured()
  for (const suffix of ['', '&picked_file_ids=', '&picked_file_ids=one,two', '&picked_file_ids=../invalid', '&picked_file_ids=one&picked_file_ids=two']) {
    const url = new URL((await service.start('http://127.0.0.1:5173', true)).authorizationUrl)
    const callback = new URL('http://127.0.0.1:5173/api/connections/drive/callback?code=x&state=' + url.searchParams.get('state') + suffix)
    await expect(service.callback(callback, 'http://127.0.0.1:5173')).rejects.toThrow(/one valid selected file/)
  }
  expect(provider).not.toHaveBeenCalled()
})
it('binds a Desktop Picker grant to its original workspace and does not treat cancellation as selection', async () => {
  await configured()
  let url = new URL((await service.start('http://127.0.0.1:5173', true)).authorizationUrl)
  expect(await service.callback(new URL('http://127.0.0.1:5173/api/connections/drive/callback?error=access_denied&state=' + url.searchParams.get('state')), 'http://127.0.0.1:5173')).toContain('drive=cancelled')
  expect((await service.status()).selection).toBeUndefined()
  url = new URL((await service.start('http://127.0.0.1:5173', true)).authorizationUrl)
  db.wipe()
  await expect(service.callback(new URL('http://127.0.0.1:5173/api/connections/drive/callback?code=x&picked_file_ids=selected-file&state=' + url.searchParams.get('state')), 'http://127.0.0.1:5173')).rejects.toThrow(/expired/)
  expect(provider).not.toHaveBeenCalled()
})
it('keeps the embedded web Picker as an explicitly configured fallback', async () => {
  await service.configure({ oauthClient: { web: { client_id: 'synthetic-web.apps.googleusercontent.com', redirect_uris: ['http://127.0.0.1:5173/api/connections/drive/callback'] } } })
  expect(await service.status()).toMatchObject({ pickerMode: 'web', pickerConfigured: false })
  const url = new URL((await service.start('http://127.0.0.1:5173', true)).authorizationUrl)
  expect(url.searchParams.has('trigger_onepick')).toBe(false)
  await expect(service.picker()).rejects.toThrow(/Picker API key/)
})
it('rejects an expired or wrong-origin OAuth response before exchanging any code', async () => {
  await configured(); const start = await service.start('http://localhost:5173'), url = new URL(start.authorizationUrl), callback = new URL('http://127.0.0.1:5173/api/connections/drive/callback?code=synthetic&state=' + url.searchParams.get('state'))
  await expect(service.callback(callback, 'http://127.0.0.1:9999')).rejects.toThrow(/expired/)
  time += 600001
  await expect(service.callback(callback, 'http://127.0.0.1:5173')).rejects.toThrow(/expired/)
  expect(provider).not.toHaveBeenCalled()
})
it('rejects unexpectedly broader token scopes rather than persisting them', async () => {
  await configured(); const start = await service.start('http://127.0.0.1:5173'), url = new URL(start.authorizationUrl)
  provider.mockResolvedValueOnce(json({ access_token: 'too-broad', scope: 'https://www.googleapis.com/auth/drive' }))
  await expect(service.callback(new URL('http://127.0.0.1:5173/api/connections/drive/callback?code=x&state=' + url.searchParams.get('state')), 'http://127.0.0.1:5173')).rejects.toThrow(/selected-file/)
  expect((await service.status()).connected).toBe(false)
})
it('retains byte-exact originals, immutable Drive versions and searchable source passages without spatial projections', async () => {
  await connect(); provider.mockReset()
  const bytes = Buffer.from('The exact selected original stays local.')
  provider.mockResolvedValueOnce(json(metadata(), { etag: '"r7"' })).mockResolvedValueOnce(new Response(bytes)).mockResolvedValueOnce(json(metadata(), { etag: '"r7"' }))
  const first = await service.importFile('selected-file')
  let corpus = db.getKv<KnowledgeSnapshot>('knowledge.v1')!
  expect(corpus.sources[0].externalId).toBe('google-drive:selected-file'); expect(corpus.sources[0].nodeId).toBeUndefined()
  expect(corpus.versions[0]).toMatchObject({ id: first.versionId, text: bytes.toString(), metadata: { googleDriveVersion: '7' } })
  expect(readFileSync(join(directory, 'blobs', corpus.versions[0].originalBlobId))).toEqual(bytes)
  expect(corpus.passages[0].text).toBe(bytes.toString()); expect(db.listNodes()).toEqual([])
  provider.mockResolvedValueOnce(json(metadata('8'), { etag: '"r8"' })).mockResolvedValueOnce(new Response('The second retained original.')).mockResolvedValueOnce(json(metadata('8'), { etag: '"r8"' }))
  const second = await service.importFile('selected-file')
  corpus = db.getKv<KnowledgeSnapshot>('knowledge.v1')!
  expect(second.sourceId).toBe(first.sourceId); expect(second.versionId).not.toBe(first.versionId)
  expect(corpus.versions).toHaveLength(2); expect(corpus.versions[0].text).toBe(bytes.toString())
})
it('exports a native Google Doc as a retained DOCX original and extracts its text locally', async () => {
  await connect(); provider.mockReset()
  const bytes = zipSync({ 'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>Exact document words &amp; context.</w:t></w:r></w:p></w:body></w:document>') })
  provider.mockResolvedValueOnce(json(metadata('7', DOC))).mockResolvedValueOnce(new Response(bytes)).mockResolvedValueOnce(json(metadata('7', DOC)))
  const result = await service.importFile('selected-file')
  expect(result.extraction).toBe('complete')
  expect(db.getKv<KnowledgeSnapshot>('knowledge.v1')!.versions[0].text).toBe('Exact document words & context.\n')
  expect(String(provider.mock.calls[1][0])).toContain('/export?mimeType=')
})
it('reuses verified native originals for the same Google revision despite volatile export timestamps', async () => {
  await connect(); provider.mockReset()
  const bytes = nativeExport(), volatileBytes = nativeExport(2026)
  expect(bytes).not.toEqual(volatileBytes)
  let exports = 0
  provider.mockImplementation(async (url) => String(url).includes('/export?') ? new Response(++exports === 1 ? bytes : volatileBytes) : json(metadata('7', DOC)))
  const first = await service.importFile('selected-file'), before = db.getKv('knowledge.v1')
  const second = await service.importFile('selected-file')
  expect(second).toMatchObject({ sourceId: first.sourceId, versionId: first.versionId, unchanged: true, extraction: 'complete' })
  expect(exports).toBe(1); expect(db.getKv('knowledge.v1')).toEqual(before)
  expect(db.listAssets()).toHaveLength(1)
  provider.mockReset()
  provider.mockResolvedValueOnce(json(metadata('8', DOC))).mockResolvedValueOnce(new Response(nativeExport(2026, 'An actual Google edit.'))).mockResolvedValueOnce(json(metadata('8', DOC)))
  const edited = await service.importFile('selected-file')
  expect(edited.unchanged).toBe(false); expect(edited.versionId).not.toBe(first.versionId)
  expect(db.getKv<KnowledgeSnapshot>('knowledge.v1')!.versions).toHaveLength(2)
})
it.each(['missing', 'corrupt', 'truncated', 'missing-asset', 'wrong-mime', 'symlink'] as const)('downloads and repairs a %s retained original rather than falsely reusing a native revision', async (damage) => {
  await connect(); provider.mockReset()
  const bytes = nativeExport()
  provider.mockResolvedValueOnce(json(metadata('7', DOC))).mockResolvedValueOnce(new Response(bytes)).mockResolvedValueOnce(json(metadata('7', DOC)))
  const first = await service.importFile('selected-file'), version = db.getKv<KnowledgeSnapshot>('knowledge.v1')!.versions[0], path = join(directory, 'blobs', version.originalBlobId)
  if (damage === 'missing') rmSync(path)
  if (damage === 'corrupt') { const corrupt = Buffer.from(bytes); corrupt[0] ^= 0xff; writeFileSync(path, corrupt) }
  if (damage === 'truncated') writeFileSync(path, bytes.subarray(0, bytes.length - 1))
  if (damage === 'missing-asset') db.deleteAssetMeta(version.originalBlobId)
  if (damage === 'wrong-mime') db.putAssetMeta({ ...db.getAssetMeta(version.originalBlobId)!, mime: 'text/plain' })
  if (damage === 'symlink') { const target = join(directory, 'unrelated-original'); writeFileSync(target, bytes); rmSync(path); symlinkSync(target, path) }
  provider.mockReset()
  provider.mockResolvedValueOnce(json(metadata('7', DOC))).mockResolvedValueOnce(new Response(bytes)).mockResolvedValueOnce(json(metadata('7', DOC)))
  const repaired = await service.importFile('selected-file')
  expect(String(provider.mock.calls[1][0])).toContain('/export?')
  expect(repaired).toMatchObject({ sourceId: first.sourceId, versionId: first.versionId, unchanged: true })
  expect(readFileSync(path)).toEqual(Buffer.from(bytes))
  expect(statSync(path).isFile()).toBe(true)
  expect(db.getAssetMeta(version.originalBlobId)).toMatchObject({ kind: 'file', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: bytes.byteLength })
})
it.each(['invalid-original-id', 'failed-extraction', 'purged-original'] as const)('retries a retained native revision with %s instead of claiming it is complete', async (damage) => {
  await connect(); provider.mockReset()
  const bytes = nativeExport()
  provider.mockResolvedValueOnce(json(metadata('7', DOC))).mockResolvedValueOnce(new Response(bytes)).mockResolvedValueOnce(json(metadata('7', DOC)))
  const first = await service.importFile('selected-file'), prior = db.getKv<KnowledgeSnapshot>('knowledge.v1')!
  if (damage === 'invalid-original-id') prior.versions[0].originalBlobId = '../untrusted-local-path'
  else if (damage === 'purged-original') prior.versions[0].originalPurged = true
  else { prior.versions[0].text = ''; prior.versions[0].contentHash = createHash('sha256').update('').digest('hex'); prior.versions[0].metadata!.extraction = 'unavailable'; prior.passages = [] }
  prior.revision++; db.putKv('knowledge.v1', prior)
  provider.mockReset()
  provider.mockResolvedValueOnce(json(metadata('7', DOC))).mockResolvedValueOnce(new Response(bytes)).mockResolvedValueOnce(json(metadata('7', DOC)))
  const recovered = await service.importFile('selected-file')
  expect(String(provider.mock.calls[1][0])).toContain('/export?')
  expect(recovered).toMatchObject({ sourceId: first.sourceId, unchanged: false, extraction: 'complete' })
  const corpus = db.getKv<KnowledgeSnapshot>('knowledge.v1')!
  expect(corpus.versions).toHaveLength(2)
  expect(corpus.versions[1].text).toBe('Exact document words.\n')
  expect(corpus.versions[0]).toEqual(prior.versions[0])
  expect(corpus.passages.some((passage) => passage.versionId === recovered.versionId)).toBe(true)
})
it('does not reuse a native original after a workspace or library change during local verification', async () => {
  await connect(); provider.mockReset()
  const bytes = nativeExport()
  provider.mockResolvedValueOnce(json(metadata('7', DOC))).mockResolvedValueOnce(new Response(bytes)).mockResolvedValueOnce(json(metadata('7', DOC)))
  await service.importFile('selected-file')
  const before = db.getKv<KnowledgeSnapshot>('knowledge.v1')!, getAsset = db.getAssetMeta.bind(db)
  provider.mockReset(); provider.mockResolvedValueOnce(json(metadata('7', DOC)))
  const changing = vi.spyOn(db, 'getAssetMeta').mockImplementationOnce((id) => { const asset = getAsset(id); db.putKv('knowledge.v1', { ...before, revision: before.revision + 1 }); return asset })
  await expect(service.importFile('selected-file')).rejects.toThrow(/local library changed/)
  expect(provider).toHaveBeenCalledTimes(1); changing.mockRestore()
  provider.mockReset(); provider.mockResolvedValueOnce(json(metadata('7', DOC)))
  vi.spyOn(db, 'getAssetMeta').mockImplementationOnce((id) => { const asset = getAsset(id); db.wipe(); return asset })
  await expect(service.importFile('selected-file')).rejects.toThrow(/connection or workspace changed/)
  expect(provider).toHaveBeenCalledTimes(1)
})
it('rechecks the native Google revision after verifying retained bytes before reporting unchanged', async () => {
  await connect(); provider.mockReset()
  provider.mockResolvedValueOnce(json(metadata('7', DOC))).mockResolvedValueOnce(new Response(nativeExport())).mockResolvedValueOnce(json(metadata('7', DOC)))
  await service.importFile('selected-file')
  const before = db.getKv('knowledge.v1')
  provider.mockReset(); provider.mockResolvedValueOnce(json(metadata('7', DOC))).mockResolvedValueOnce(json(metadata('8', DOC)))
  await expect(service.importFile('selected-file')).rejects.toThrow(/changed during import/)
  expect(db.getKv('knowledge.v1')).toEqual(before)
  expect(provider.mock.calls.some(([url]) => String(url).includes('/export?'))).toBe(false)
})
it('rejects a changed remote file during download without committing mismatched local evidence', async () => {
  await connect(); provider.mockReset()
  provider.mockResolvedValueOnce(json(metadata('7'))).mockResolvedValueOnce(new Response('A read in flight.')).mockResolvedValueOnce(json(metadata('8')))
  await expect(service.importFile('selected-file')).rejects.toThrow(/changed during download/)
  expect(db.getKv('knowledge.v1')).toBeUndefined(); expect(db.listAssets()).toEqual([])
})
it('requires explicit selected revision guards before replacement and sends If-Match for an unchanged target', async () => {
  await connect(); provider.mockReset(); const input = draft()
  provider.mockResolvedValueOnce(json(metadata('7', DOC), { etag: '"strong-r7"' }))
  const target = await service.inspect('selected-file')
  expect(target.updateAvailable).toBe(true)
  provider.mockResolvedValueOnce(json(metadata('7', DOC), { etag: '"strong-r7"' })).mockResolvedValueOnce(json(metadata('8', DOC))).mockResolvedValueOnce(json(metadata('8', DOC), { etag: '"strong-r8"' }))
  const result = await service.exportFile({ ...input, ticket: target.ticket })
  expect(result.created).toBe(false)
  const upload = provider.mock.calls.find(([url]) => String(url).startsWith('https://www.googleapis.com/upload/'))
  expect(upload?.[1]?.method).toBe('PATCH'); expect(new Headers(upload?.[1]?.headers).get('If-Match')).toBe('"strong-r7"')
  expect(result.file.id).toBe('selected-file')
})
it('blocks stale target revisions and missing strong ETags without sending a replacement', async () => {
  await connect(); provider.mockReset(); const input = draft()
  provider.mockResolvedValueOnce(json(metadata('7', DOC), { etag: '"strong-r7"' })); const target = await service.inspect('selected-file')
  provider.mockResolvedValueOnce(json(metadata('8', DOC), { etag: '"strong-r8"' }))
  await expect(service.exportFile({ ...input, ticket: target.ticket })).rejects.toThrow(/changed after selection/)
  expect(provider.mock.calls.some(([url]) => String(url).includes('/upload/'))).toBe(false)
  provider.mockResolvedValueOnce(json(metadata('8', DOC))); const unguarded = await service.inspect('selected-file')
  expect(unguarded.updateAvailable).toBe(false)
  await expect(service.exportFile({ ...input, ticket: unguarded.ticket })).rejects.toThrow(/strong revision guard/)
})
it('checks the local saved revision and transfer budget before any Google upload', async () => {
  await connect(); provider.mockReset(); const input = draft()
  await expect(service.exportFile({ ...input, expectedUpdatedAt: 1 })).rejects.toThrow(/local writing changed/)
  await expect(service.exportFile({ ...input, htmlBase64: Buffer.alloc(DRIVE_EXPORT_LIMIT + 1).toString('base64') })).rejects.toThrow(/5 MiB/)
  expect(provider).not.toHaveBeenCalled()
})
it('creates a new Google copy, verifies its metadata, and leaves local writing and 3D data intact', async () => {
  await connect(); provider.mockReset(); const input = draft(), before = db.getKv('writing.v1')
  provider.mockResolvedValueOnce(json(metadata('1', DOC))).mockResolvedValueOnce(json(metadata('1', DOC)))
  const result = await service.exportFile(input)
  expect(result.created).toBe(true); expect(result.file.webViewLink).toBe('https://drive.google.com/file/d/selected-file/view')
  expect(db.getKv('writing.v1')).toEqual(before); expect(db.listNodes()).toEqual([])
  expect(provider.mock.calls[0][1]?.method).toBe('POST')
})
it('rejects cross-origin, non-loopback and missing-client-header HTTP management before any provider request', async () => {
  for (const headers of [{ host: '127.0.0.1:5173', origin: 'https://evil.example', 'x-wv-client': 'test' }, { host: 'public.example', 'x-wv-client': 'test' }, { host: '127.0.0.1:5173' }]) {
    const req = Readable.from([]) as IncomingMessage; req.headers = headers; req.method = 'GET'; req.url = '/api/connections/drive'
    let status = 0; const res = { headersSent: false, destroyed: false, writeHead: (value: number) => { status = value }, end: () => {} } as unknown as ServerResponse
    await handleGoogleDriveRequest(service, req, res); expect(status).toBe(403)
  }
  expect(provider).not.toHaveBeenCalled()
})

it('aborts an in-flight import across a completed restore even when portable revisions repeat', async () => {
  await connect(); provider.mockReset()
  const settings = db.getSettings()!
  let release!: (response: Response) => void
  const pending = new Promise<Response>((resolve) => { release = resolve })
  provider.mockResolvedValueOnce(json(metadata())).mockImplementationOnce(() => pending)
  const importing = service.importFile('selected-file')
  await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(2))
  const generation = db.getReplacementGeneration()
  db.resetWithKv('importInProgress', { state: 'restoring' })
  db.putSettings(settings); db.deleteKv('importInProgress')
  expect(db.getKnowledgeRevision()).toBe(0)
  expect(db.getReplacementGeneration()).toBe(generation + 1)
  release(new Response('A response from before the restore.'))
  await expect(importing).rejects.toThrow(/workspace changed/)
  expect(db.getKv('knowledge.v1')).toBeUndefined()
  expect(db.listAssets()).toEqual([])
})
it('increments the service replacement guard only after successful reset and wipe', async () => {
  const original = db.getReplacementGeneration()
  expect(() => db.resetWithKv('importInProgress', { state: 'restoring' }, [], 999)).toThrow()
  expect(db.getReplacementGeneration()).toBe(original)
  db.wipe()
  expect(db.getReplacementGeneration()).toBe(original + 1)
})
