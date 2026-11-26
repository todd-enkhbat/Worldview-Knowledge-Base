import {docTarget,extractApplicationTab} from './applicationDoc.ts'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { strFromU8, unzipSync } from 'fflate'
import type { WorldDb } from '../worldDb.ts'
import type { ChangeBus } from '../changes.ts'
import { memoryOriginAllowed, sendMemoryJson } from '../memoryHttp.ts'
import { extractPdfText } from '../extractText.ts'
import { splitPassages } from '../../src/knowledge/parsers.ts'
import { diffKnowledgeSnapshots } from '../../src/knowledge/storage.ts'
import type { KnowledgeSnapshot, ParsedSource } from '../../src/knowledge/types.ts'
import { decodeWriting } from '../../src/writing/model.ts'

export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const DRIVE_IMPORT_LIMIT = 20 * 1024 * 1024
export const DRIVE_EXPORT_LIMIT = 5 * 1024 * 1024
const DOC = 'application/vnd.google-apps.document', DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const FIELDS = 'id,name,mimeType,version,modifiedTime,size,webViewLink,trashed,capabilities(canDownload,canEdit),appProperties'
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const fail = (message: string, status = 400): never => { throw new DriveError(message, status) }
const check = (condition: unknown, message: string, status = 400): void => { if (!condition) fail(message, status) }
export class DriveError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status } }
export interface DriveFile { id: string; name: string; mimeType: string; version: string; modifiedTime?: string; size?: string; webViewLink?: string; trashed?: boolean; capabilities?: { canDownload?: boolean; canEdit?: boolean }; appProperties?: Record<string, string> }
interface PrivateDrive { schemaVersion: 1; clientId?: string; clientSecret?: string; clientType?: 'desktop' | 'web'; redirectUris?: string[]; pickerKey?: string; appId?: string; tokens?: { access: string; refresh?: string; expiresAt: number }; connectedAt?: number }
interface Options { db: WorldDb; blobDir: string; bus?: ChangeBus; now?: () => number; fetch?: typeof fetch }
interface Session { verifier: string; redirect: string; origin: string; expiresAt: number; epoch: number; generation: number; picker: boolean }
interface Target { file: DriveFile; etag: string; expiresAt: number; epoch: number }
interface Selection { id: string; fileIds: string[]; epoch: number; generation: number; expiresAt: number }
const emptyCorpus = (): KnowledgeSnapshot => ({ schemaVersion: 1, revision: 0, sources: [], versions: [], passages: [], imports: [], jobs: [], proposals: [] })
const validFileId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z\d_-]{1,256}$/.test(value)
const safeLink = (value: unknown): string | undefined => { try { const url = new URL(String(value)); return url.protocol === 'https:' && ['drive.google.com', 'docs.google.com'].includes(url.hostname) && !url.username && !url.password ? url.href : undefined } catch { return undefined } }
const cleanFile = (raw: unknown): DriveFile => { check(object(raw) && validFileId(raw.id) && typeof raw.name === 'string' && typeof raw.mimeType === 'string', 'Google did not return a valid file.', 502); const file = raw as unknown as DriveFile; return { ...file, ...(safeLink(file.webViewLink) ? { webViewLink: safeLink(file.webViewLink) } : { webViewLink: undefined }), version: String(file.version ?? '') } }

/** An explicit selected-files bridge. Credentials are service-private files, never portable KV or client storage. */
export class GoogleDriveConnection {
  private options: Options
  private state: Promise<PrivateDrive> | null = null
  private writes: Promise<unknown> = Promise.resolve()
  private epoch = 0
  private sessions = new Map<string, Session>()
  private targets = new Map<string, Target>()
  private selection: Selection | null = null
  private authorizationRevision = 0
  private authorizationResult: 'connected' | 'cancelled' | null = null
  constructor(options: Options) { this.options = options }
  private now() { return this.options.now?.() ?? Date.now() }
  private path() { return join(dirname(this.options.blobDir), 'connections', 'google-drive.private.json') }
  private async load(): Promise<PrivateDrive> {
    if (!this.state) this.state = (async () => {
      let value: PrivateDrive = { schemaVersion: 1 }
      try { const raw: unknown = JSON.parse(await readFile(this.path(), 'utf8')); check(object(raw) && raw.schemaVersion === 1, 'The private Google connection needs setup again.'); value = raw as unknown as PrivateDrive } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (process.env.GOOGLE_DRIVE_CLIENT_ID) value = { ...value, clientId: process.env.GOOGLE_DRIVE_CLIENT_ID, clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? value.clientSecret, clientType: 'desktop' }
      value.pickerKey = process.env.GOOGLE_PICKER_API_KEY ?? value.pickerKey; value.appId = process.env.GOOGLE_DRIVE_APP_ID ?? value.appId
      return value
    })()
    return this.state
  }
  private async persist(value: PrivateDrive, epoch = this.epoch) {
    const task = this.writes.catch(() => {}).then(async () => { check(epoch === this.epoch, 'The Google connection changed. Reconnect before continuing.', 409); await mkdir(dirname(this.path()), { recursive: true, mode: 0o700 }); const temporary = `${this.path()}.${randomUUID()}.tmp`; try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); check(epoch === this.epoch, 'The Google connection changed.', 409); await rename(temporary, this.path()); this.state = Promise.resolve(value) } finally { await rm(temporary, { force: true }) } })
    this.writes = task; await task
  }
  private scope() { const epoch = this.epoch, generation = this.options.db.getReplacementGeneration(); return () => check(epoch === this.epoch && generation === this.options.db.getReplacementGeneration() && !this.options.db.getKv('importInProgress'), 'The connection or workspace changed. Review this operation again.', 409) }
  private async provider(url: string, init: RequestInit = {}, authenticated = true, beforeSend?: () => void): Promise<Response> {
    const parsed = new URL(url); check(parsed.protocol === 'https:' && (['www.googleapis.com', 'oauth2.googleapis.com'].includes(parsed.hostname) || parsed.hostname==='docs.googleapis.com' && /^\/v1\/documents\/[a-zA-Z0-9_-]+$/.test(parsed.pathname) && !init.method), 'This Google endpoint is not permitted.')
    const headers = new Headers(init.headers); if (authenticated) headers.set('authorization', `Bearer ${await this.access()}`)
    beforeSend?.()
    const response = await (this.options.fetch ?? fetch)(url, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(30000) })
    if (response.status===403 && parsed.hostname==='docs.googleapis.com'){
      const detail=await response.clone().json().catch(()=>null)
      if(detail?.error?.details?.some((d:{reason?:string})=>d.reason==='SERVICE_DISABLED'))fail('The Google Docs API is disabled for this OAuth client. Enable it in your Google Cloud project to preview a specific tab, or import a text file you export from that tab.',403)
    }
    if (!response.ok) { if (response.status === 401) fail('Google authorization expired. Disconnect and reconnect your account.', 401); if ([409, 412].includes(response.status)) fail('The Google file changed. Select it again before updating; no retry was sent.', 409); fail(`Google could not complete this request (HTTP ${response.status}). Check its file permissions or reconnect.`, response.status === 403 ? 403 : 502) }
    return response
  }
  private async access(): Promise<string> {
    const state = await this.load(), current = this.scope()
    check(state.clientId && state.tokens, 'Connect Google Drive before opening selected files.', 401)
    if (state.tokens!.expiresAt > this.now() + 60000) return state.tokens!.access
    check(state.tokens!.refresh, 'Reconnect Google Drive to renew this session.', 401)
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: state.clientId!, refresh_token: state.tokens!.refresh! }); if (state.clientSecret) body.set('client_secret', state.clientSecret)
    const response = await this.provider('https://oauth2.googleapis.com/token', { method: 'POST', body }, false), token = await response.json() as Record<string, unknown>; current()
    check(typeof token.access_token === 'string' && token.access_token.length <= 10000, 'Google did not issue a usable access token.', 502)
    if (typeof token.scope === 'string') check(token.scope.split(/\s+/).every((scope) => scope === GOOGLE_DRIVE_SCOPE), 'Google returned broader permissions than this bridge requested. Reconnect using a dedicated client.', 403)
    const next = { ...state, tokens: { access: token.access_token as string, refresh: state.tokens!.refresh, expiresAt: this.now() + Math.max(60, Math.min(86400, Number(token.expires_in) || 3600)) * 1000 } }; await this.persist(next); current(); return next.tokens.access
  }
  async applicationTab(link:string,account:string) {
    const current=this.scope(), target=docTarget(link)
    if(account){
      const profile=await (await this.provider('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)')).json()
      if(profile.user?.emailAddress?.toLowerCase()!==account.toLowerCase())throw Error('The selected-file connection belongs to a different account. Connect the requested Drive account for read-only discovery.')
    }
    const raw=await this.provider('https://docs.googleapis.com/v1/documents/'+target.id+'?includeTabsContent=true')
    const bytes=await this.bytes(raw,8*1024*1024)
    const doc=extractApplicationTab(JSON.parse(Buffer.from(bytes).toString('utf8')),target.tab)
    current()
    return {...doc,source:target.source,confirmation:false,date:''}
  }
  async discoveryClient() {
    const config = await this.load()
    if (!config.clientId) throw Error('Configure a Google OAuth client under Sources → Google Drive first.')
    return { id:config.clientId, secret:config.clientSecret, desktop:config.clientType !== 'web', redirects:config.redirectUris || [] }
  }
  async status() { const state = await this.load(), desktop = state.clientType !== 'web', selection = this.selection; return { available: true, configured: !!state.clientId, connected: !!state.tokens, connectionRevision: this.epoch, authorizationRevision: this.authorizationRevision, authorizationResult: this.authorizationResult, pickerMode: desktop ? 'desktop' : 'web', pickerConfigured: desktop ? !!state.clientId : !!state.pickerKey && !!state.appId, ...(selection && selection.epoch === this.epoch && selection.generation === this.options.db.getReplacementGeneration() && selection.expiresAt > this.now() ? { selection: { id: selection.id, fileIds: selection.fileIds } } : {}), scope: GOOGLE_DRIVE_SCOPE, connectedAt: state.connectedAt ?? null, importLimit: DRIVE_IMPORT_LIMIT, exportLimit: DRIVE_EXPORT_LIMIT, setupUrl: 'https://console.cloud.google.com/auth/overview/personal', credentialsStored: 'private-local-service-file', aiRequired: false } }
  async configure(input: Record<string, unknown>) {
    check(!this.options.db.getKv('importInProgress'), 'Finish restore recovery before configuring Google.', 409)
    const raw = object(input.oauthClient) ? input.oauthClient : {}, client = object(raw.installed) ? raw.installed : object(raw.web) ? raw.web : raw
    check(typeof client.client_id === 'string' && /^[\w.-]+\.apps\.googleusercontent\.com$/.test(client.client_id) && client.client_id.length < 1000, 'Choose the OAuth client JSON downloaded from your Google Cloud project.')
    check(client.client_secret === undefined || typeof client.client_secret === 'string' && client.client_secret.length < 4000, 'The OAuth client secret is invalid.')
    check(input.pickerKey === undefined || typeof input.pickerKey === 'string' && input.pickerKey.length < 1000, 'Use a valid Picker API key.')
    check(input.appId === undefined || typeof input.appId === 'string' && /^\d{1,30}$/.test(input.appId), 'Use the Google Cloud project number for Picker.')
    this.epoch++; this.sessions.clear(); this.targets.clear(); this.selection = null
    await this.persist({ schemaVersion: 1, clientId: client.client_id as string, clientSecret: client.client_secret as string | undefined, clientType: object(raw.web) ? 'web' : 'desktop', redirectUris: Array.isArray(client.redirect_uris) ? client.redirect_uris.filter((uri): uri is string => typeof uri === 'string').slice(0, 20) : [], pickerKey: input.pickerKey as string | undefined, appId: input.appId as string | undefined }); return this.status()
  }
  async start(origin: string, pickFiles = false) {
    check(!this.options.db.getKv('importInProgress'), 'Finish workspace recovery before connecting Google.', 409)
    const state = await this.load(); check(state.clientId, 'Set up your app’s Google OAuth client first.', 409)
    const base = new URL(origin); check(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Connect from the local app.', 403)
    if (state.clientType !== 'web' && base.hostname === 'localhost') base.hostname = '127.0.0.1'
    const redirect = `${base.origin}/api/connections/drive/callback`
    if (state.clientType === 'web') check(state.redirectUris?.includes(redirect), `Add ${redirect} to this web OAuth client’s authorized redirect URIs.`, 409)
    for (const [key, value] of this.sessions) if (value.expiresAt < this.now()) this.sessions.delete(key)
    check(this.sessions.size < 8, 'Finish an existing Google connection attempt before starting another.', 409)
    const nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url')
    const picker = pickFiles && state.clientType !== 'web'
    this.sessions.set(nonce, { verifier, redirect, origin, expiresAt: this.now() + 600000, epoch: this.epoch, generation: this.options.db.getReplacementGeneration(), picker })
    const params = new URLSearchParams({ client_id: state.clientId!, redirect_uri: redirect, response_type: 'code', scope: GOOGLE_DRIVE_SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state: nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...(picker ? { trigger_onepick: 'true', allow_multiple: 'false' } : {}) })
    return { authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, expiresAt: this.now() + 600000, connectionRevision: this.epoch, authorizationRevision: this.authorizationRevision, picker }
  }
  async callback(url: URL, origin: string) {
    const nonce = url.searchParams.get('state') ?? '', session = this.sessions.get(nonce)
    check(session && session.expiresAt >= this.now() && session.epoch === this.epoch && session.generation === this.options.db.getReplacementGeneration() && !this.options.db.getKv('importInProgress') && new URL(session.redirect).origin === origin, 'This Google connection request expired. Start again from Worldview.', 403)
    this.sessions.delete(nonce)
    if (url.searchParams.has('error')) { this.authorizationRevision++; this.authorizationResult = 'cancelled'; return `${session!.origin}/#/sources?connection=drive&drive=cancelled` }
    const picked = url.searchParams.getAll('picked_file_ids'), ids = picked.length === 1 ? picked[0].split(',') : []
    check(session!.picker ? picked.length === 1 && picked[0].length <= 256 && ids.length === 1 && ids.every(validFileId) : picked.length === 0, 'Google did not return one valid selected file. Start the file picker again.')
    const code = url.searchParams.get('code'); check(code && code.length < 10000, 'Google did not return an authorization code.')
    const state = await this.load(), current = this.scope(), body = new URLSearchParams({ grant_type: 'authorization_code', code: code!, client_id: state.clientId!, redirect_uri: session!.redirect, code_verifier: session!.verifier }); if (state.clientSecret) body.set('client_secret', state.clientSecret)
    const response = await this.provider('https://oauth2.googleapis.com/token', { method: 'POST', body }, false), token = await response.json() as Record<string, unknown>; current()
    check(typeof token.access_token === 'string' && token.access_token.length <= 10000, 'Google did not return a usable access token.', 502)
    if (typeof token.scope === 'string') check(token.scope.split(/\s+/).every((scope) => scope === GOOGLE_DRIVE_SCOPE), 'This app only accepts the selected-file Drive permission.', 403)
    this.epoch++; this.targets.clear(); this.sessions.clear(); this.selection = null; const connectedEpoch = this.epoch, generation = this.options.db.getReplacementGeneration()
    await this.persist({ ...state, tokens: { access: token.access_token as string, ...(typeof token.refresh_token === 'string' ? { refresh: token.refresh_token } : {}), expiresAt: this.now() + Math.max(60, Math.min(86400, Number(token.expires_in) || 3600)) * 1000 }, connectedAt: this.now() }); check(connectedEpoch === this.epoch, 'The Google connection changed. Start again.', 409)
    check(generation === this.options.db.getReplacementGeneration() && !this.options.db.getKv('importInProgress'), 'The workspace changed. Open the Google connection again.', 409)
    if (session!.picker) this.selection = { id: randomUUID(), fileIds: ids, epoch: connectedEpoch, generation, expiresAt: this.now() + 600000 }
    this.authorizationRevision++; this.authorizationResult = 'connected'
    return `${session!.origin}/#/sources?connection=drive&drive=connected`
  }
  async disconnect() { this.epoch++; this.sessions.clear(); this.targets.clear(); this.selection = null; const state = await this.load(); await this.persist({ ...state, tokens: undefined, connectedAt: undefined }); return { ok: true, message: 'Disconnected locally. You can also remove Worldview in your Google account’s third-party access settings.' } }
  async picker() { const state = await this.load(); check(state.clientType === 'web', 'Desktop connections choose files in Google’s browser flow. Choose a file from the connection panel.', 409); check(state.pickerKey && state.appId, 'Add a Picker API key and project number to choose existing files. App-created files remain available below.', 409); return { accessToken: await this.access(), developerKey: state.pickerKey, appId: state.appId } }
  async files(query = '', pageToken = '') { check(query.length <= 200 && pageToken.length <= 2000, 'Narrow the file search.'); const params = new URLSearchParams({ pageSize: '40', fields: `nextPageToken,files(${FIELDS})`, q: `trashed = false and mimeType != 'application/vnd.google-apps.folder'${query ? ` and name contains '${query.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : ''}`, orderBy: 'modifiedTime desc', ...(pageToken ? { pageToken } : {}) }); const response = await this.provider(`https://www.googleapis.com/drive/v3/files?${params}`), body = await response.json() as { files?: unknown[]; nextPageToken?: string }; return { files: (body.files ?? []).map(cleanFile), nextPageToken: body.nextPageToken ?? null } }
  private async file(id: string) { check(validFileId(id), 'Choose a valid Google file ID.'); const response = await this.provider(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?${new URLSearchParams({ fields: FIELDS, supportsAllDrives: 'true' })}`), file = cleanFile(await response.json()); check(!file.trashed, 'This Google file is in Trash. Restore it in Drive first.', 409); return { file, etag: response.headers.get('etag') ?? '' } }
  async inspect(id: string) { const current = this.scope(), target = await this.file(id); current(); for (const [key, value] of this.targets) if (value.expiresAt < this.now() || value.epoch !== this.epoch) this.targets.delete(key); check(this.targets.size < 100, 'Reconnect or reuse a recently selected target.', 409); const ticket = randomBytes(24).toString('base64url'); this.targets.set(ticket, { ...target, epoch: this.epoch, expiresAt: this.now() + 600000 }); return { ...target, ticket, updateAvailable: target.file.capabilities?.canEdit === true && /^"[^\r\n]+"$/.test(target.etag) && !!target.file.version && [DOC, 'text/html'].includes(target.file.mimeType) } }
  private async bytes(response: Response, limit: number) { check(Number(response.headers.get('content-length') ?? 0) <= limit, 'This Google file exceeds the local transfer limit.', 413); const reader = response.body?.getReader(); check(reader, 'Google returned an empty file.', 502); const parts: Uint8Array[] = []; let size = 0; try { while (true) { const item = await reader!.read(); if (item.done) break; size += item.value.byteLength; check(size <= limit, 'This Google file exceeds the local transfer limit.', 413); parts.push(item.value) } } finally { await reader!.cancel().catch(() => {}) } return Buffer.concat(parts) }
  private async retainedOriginal(id: string, mime: string, limit: number) {
    if (!/^knowledge-[a-f\d]{64}$/.test(id)) return false
    const asset = this.options.db.getAssetMeta(id)
    if (!asset || asset.kind !== 'file' || asset.mime !== mime || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > limit) return false
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      file = await open(join(this.options.blobDir, id), constants.O_RDONLY | constants.O_NOFOLLOW)
      const stat = await file.stat()
      if (!stat.isFile() || stat.size !== asset.bytes) return false
      const bytes = Buffer.alloc(asset.bytes + 1); let size = 0
      while (size < bytes.length) { const read = await file.read(bytes, size, bytes.length - size, size); if (!read.bytesRead) break; size += read.bytesRead }
      return size === asset.bytes && sha(bytes.subarray(0, size)) === id.slice('knowledge-'.length)
    } catch { return false } finally { await file?.close() }
  }
  async importFile(id: string) {
    const current = this.scope(), before = this.options.db.getKv<KnowledgeSnapshot>('knowledge.v1') ?? emptyCorpus(); check(this.options.db.getSettings()?.firstRunComplete, 'Finish local workspace setup before importing.', 409)
    const { file, etag } = await this.file(id); current(); check(file.capabilities?.canDownload !== false, 'This file’s owner has disabled downloads.', 403)
    const native = file.mimeType.startsWith('application/vnd.google-apps.'), mime = file.mimeType === DOC ? DOCX : native ? 'application/pdf' : file.mimeType, name = `${file.name}${file.mimeType === DOC ? '.docx' : native ? '.pdf' : ''}`
    const retainedSource = before.sources.find((entry) => entry.externalId === `google-drive:${id}`), retained = before.versions.find((entry) => entry.id === retainedSource?.currentVersionId)
    check(!retainedSource?.deleted && !retainedSource?.excluded, 'Restore this source’s local inclusion policy before importing another version.', 409)
    // Native exports can change ZIP/PDF timestamps without a Google revision change.
    // Reuse the original revision only after verifying the actual retained bytes.
    if (native && file.version && retainedSource && retained?.sourceId === retainedSource.id && !retained.originalPurged && retained.contentHash === sha(retained.text) && retained.metadata?.googleDriveFileId === id && retained.metadata.googleDriveVersion === file.version && retained.metadata.googleDriveMimeType === file.mimeType && retained.metadata.mime === mime && retained.metadata.extraction === 'complete') {
      const available = await this.retainedOriginal(retained.originalBlobId, mime, 10 * 1024 * 1024); current()
      check(this.options.db.getKnowledgeRevision() === before.revision, 'The local library changed during import. Retry the retained file.', 409)
      if (available) {
        const after = await this.file(id); current()
        check(after.file.capabilities?.canDownload !== false, 'This file’s owner has disabled downloads.', 403)
        check(after.file.version === file.version && after.file.mimeType === file.mimeType, 'The Google file changed during import. Import it again to retain a consistent version.', 409)
        check(this.options.db.getKnowledgeRevision() === before.revision, 'The local library changed during import. Retry the retained file.', 409)
        return { sourceId: retainedSource.id, versionId: retained.id, extraction: 'complete', extractionMessage: typeof retained.metadata.extractionMessage === 'string' ? retained.metadata.extractionMessage : '', unchanged: true }
      }
    }
    const endpoint = native ? `https://www.googleapis.com/drive/v3/files/${id}/export?${new URLSearchParams({ mimeType: mime })}` : `https://www.googleapis.com/drive/v3/files/${id}?alt=media`
    const bytes = await this.bytes(await this.provider(endpoint, { headers: etag ? { 'If-Match': etag } : {} }), native ? 10 * 1024 * 1024 : DRIVE_IMPORT_LIMIT); current()
    const after = await this.file(id); current(); check(after.file.version === file.version, 'The Google file changed during download. Import it again to retain a consistent version.', 409)
    const blobId = `knowledge-${sha(bytes)}`; await mkdir(this.options.blobDir, { recursive: true }); const path = join(this.options.blobDir, blobId), temporary = `${path}.${randomUUID()}.tmp`; try { await writeFile(temporary, bytes, { mode: 0o600 }); current(); await rename(temporary, path) } finally { await rm(temporary, { force: true }) }
    let text = '', extraction = 'complete', extractionMessage = ''
    try {
      if (mime === DOCX || /\.docx$/i.test(name)) { const files = unzipSync(bytes, { filter: (entry) => { if (entry.name !== 'word/document.xml') return false; check(entry.originalSize <= 8 * 1024 * 1024, 'This document text exceeds the local extraction limit.'); return true } }); check(files['word/document.xml'], 'This Word export contains no readable document.'); text = strFromU8(files['word/document.xml']).replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:br\b[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&') }
      else if (mime === 'application/pdf') text = (await extractPdfText(bytes)).text
      else if (mime.startsWith('text/') || /\.(?:md|txt|csv|json|xml|html?)$/i.test(name)) text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      else { extraction = 'unsupported'; extractionMessage = 'Original retained. Text extraction for this file type is unavailable.' }
      check(text.length <= 2000000, 'Original retained; extracted text exceeds the local indexing limit.')
    } catch (error) { text = ''; extraction = 'unavailable'; extractionMessage = error instanceof Error ? error.message : 'Original retained; text extraction failed.' }
    current(); check(this.options.db.getKnowledgeRevision() === before.revision, 'The local library changed during import. Retry the retained file.', 409)
    const next = structuredClone(before), externalId = `google-drive:${id}`, now = this.now(); let source = next.sources.find((entry) => entry.externalId === externalId)
    check(!source?.deleted && !source?.excluded, 'Restore this source’s local inclusion policy before importing another version.', 409)
    const previous = next.versions.find((entry) => entry.id === source?.currentVersionId)
    if (source && previous?.metadata?.googleDriveVersion === file.version && !previous.originalPurged && previous.originalBlobId === blobId && previous.contentHash === sha(text) && previous.metadata.extraction === extraction) {
      const asset = this.options.db.getAssetMeta(blobId)
      if (!asset || asset.kind !== 'file' || asset.mime !== mime || asset.bytes !== bytes.byteLength) this.options.db.putAssetMeta({ id: blobId, kind: 'file', mime, bytes: bytes.byteLength, createdAt: asset?.createdAt ?? previous.createdAt, nodeId: null })
      return { sourceId: source.id, versionId: previous.id, extraction, extractionMessage, unchanged: true }
    }
    if (!source) { source = { id: randomUUID(), externalId, title: file.name.slice(0, 300), kind: 'document', currentVersionId: '', createdAt: now, updatedAt: now, excluded: false, aiAllowed: true, tags: [] }; next.sources.push(source) }
    const version = { id: randomUUID(), sourceId: source.id, contentHash: sha(text), originalBlobId: blobId, originalName: name.slice(0, 500), text, createdAt: now, authoredAt: null, origin: 'import' as const, ...(previous ? { previousVersionId: previous.id } : {}), metadata: { format: mime === 'application/pdf' ? 'pdf' : 'google-drive', googleDriveFileId: id, googleDriveVersion: file.version, googleDriveUrl: file.webViewLink, googleDriveMimeType: file.mimeType, mime, extraction, extractionMessage } }
    next.versions.push(version); source.currentVersionId = version.id; source.title = file.name.slice(0, 300); source.updatedAt = now; next.revision++
    const parsed: ParsedSource = { externalId, title: source.title, kind: 'document', text, authoredAt: null, messages: [{ text, role: 'third-party', authoredAt: null, start: 0, end: text.length }] }
    if (text.trim()) next.passages.push(...splitPassages(parsed).map((part) => ({ ...part, id: randomUUID(), sourceId: source!.id, versionId: version.id, title: source!.title })))
    const importKey = `drive:${sha(JSON.stringify({ id, version: file.version, bytes: sha(bytes), text: sha(text), extraction, previous: previous?.id ?? null }))}`
    check(this.options.db.commitKnowledge(diffKnowledgeSnapshots(before, next), { expectedRevision: before.revision, idempotencyKey: importKey, assets: [{ id: blobId, kind: 'file', mime, bytes: bytes.byteLength, createdAt: now, nodeId: null }] }), 'The local library changed. Retry this import.', 409)
    this.options.bus?.publish({ v: 1, from: 'google-drive', change: { type: 'kv', keys: ['knowledge.v1'] } }); return { sourceId: source.id, versionId: version.id, extraction, extractionMessage, unchanged: false }
  }
  async exportFile(input: Record<string, unknown>) {
    const current = this.scope(), documentId = String(input.documentId ?? ''), getDocument = () => decodeWriting(this.options.db.getKv('writing.v1')).docs.find((doc) => doc.id === documentId && !doc.archivedAt), doc = getDocument()
    check(doc && doc.updatedAt === input.expectedUpdatedAt, 'The local writing changed. Select its latest saved version before exporting.', 409)
    check(typeof input.htmlBase64 === 'string' && input.htmlBase64.length <= Math.ceil(DRIVE_EXPORT_LIMIT / 3) * 4 && /^[A-Za-z\d+/]*={0,2}$/.test(input.htmlBase64), 'Choose a formatted HTML export up to 5 MiB.', 413)
    const bytes = Buffer.from(input.htmlBase64 as string, 'base64'); check(bytes.length > 0 && bytes.length <= DRIVE_EXPORT_LIMIT, 'This Google export exceeds 5 MiB.', 413)
    const target = input.ticket ? this.targets.get(String(input.ticket)) : null
    if (input.ticket) {
      check(target && target.epoch === this.epoch && target.expiresAt > this.now() && target.file.capabilities?.canEdit && /^"[^\r\n]+"$/.test(target.etag) && target.file.version && [DOC, 'text/html'].includes(target.file.mimeType), 'Select a writable Google document with a current strong revision guard, or create a new copy.', 409)
      const latest = await this.file(target!.file.id); current(); check(latest.file.version === target!.file.version && latest.etag === target!.etag, 'The Google file changed after selection. Select it again before replacing its contents.', 409)
    }
    current(); check(getDocument()?.updatedAt === doc!.updatedAt, 'The local writing changed before export. Select its latest version.', 409)
    const native = target ? target.file.mimeType === DOC : input.nativeDocument !== false, metadata = { name: target?.file.name ?? `${doc!.title || 'Untitled writing'}${native ? '' : '.html'}`, mimeType: native ? DOC : 'text/html', appProperties: { worldviewWritingId: doc!.id } }, boundary = `worldview_${randomBytes(18).toString('hex')}`
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)])
    const response = await this.provider(`https://www.googleapis.com/upload/drive/v3/files${target ? `/${target.file.id}` : ''}?${new URLSearchParams({ uploadType: 'multipart', fields: FIELDS, supportsAllDrives: 'true' })}`, { method: target ? 'PATCH' : 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}`, ...(target ? { 'If-Match': target.etag } : {}) }, body }, true, () => { current(); check(getDocument()?.updatedAt === doc!.updatedAt, 'The local writing changed before the Google transfer. Export its latest saved version.', 409) }); current()
    const saved = cleanFile(await response.json()); check(!target || saved.id === target.file.id, 'Google returned a different file than the selected update target.', 502)
    const verified = await this.file(saved.id); current(); check(verified.file.id === saved.id && verified.file.mimeType === metadata.mimeType, 'Google did not confirm the exported file type. Check Drive before retrying.', 502)
    if (input.ticket) this.targets.delete(String(input.ticket))
    return { file: verified.file, documentId: doc!.id, exportedUpdatedAt: doc!.updatedAt, created: !target }
  }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> { let size = 0; const parts: Buffer[] = []; for await (const part of req as AsyncIterable<Buffer>) { size += part.length; check(size <= 8 * 1024 * 1024, 'This Google transfer request exceeds 8 MiB.', 413); parts.push(part) } const value: unknown = JSON.parse(Buffer.concat(parts).toString('utf8')); check(object(value), 'Choose a valid Google connection action.'); return value as Record<string, unknown> }
export async function handleGoogleDriveRequest(service: GoogleDriveConnection, req: IncomingMessage, res: ServerResponse) {
  try {
    let origin: string; try { const url = new URL(`http://${req.headers.host ?? ''}`); check(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Google connections require the local app.', 403); origin = url.origin } catch { return sendMemoryJson(res, 403, { error: 'Google connections require a loopback host.' }) }
    const url = new URL(req.url ?? '/', origin), action = url.pathname.split('/').filter(Boolean)[3] ?? ''
    if (action === 'callback' && req.method === 'GET') { const target = await service.callback(url, origin); res.writeHead(303, { location: target, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); return }
    check(memoryOriginAllowed(req) && !!req.headers['x-wv-client'], 'Open Connections in the local app before using Google Drive.', 403)
    if (req.method === 'GET') { if (!action || action === 'status') return sendMemoryJson(res, 200, await service.status()); if (action === 'files') return sendMemoryJson(res, 200, await service.files(url.searchParams.get('q') ?? '', url.searchParams.get('pageToken') ?? '')) }
    if (req.method === 'POST') { const input = await body(req); if (action === 'configure') return sendMemoryJson(res, 200, await service.configure(input)); if (action === 'connect') return sendMemoryJson(res, 200, await service.start(origin, input.pickFiles === true)); if (action === 'disconnect') return sendMemoryJson(res, 200, await service.disconnect()); if (action === 'picker') return sendMemoryJson(res, 200, await service.picker()); if (action === 'inspect') return sendMemoryJson(res, 200, await service.inspect(String(input.fileId ?? ''))); if (action === 'import') return sendMemoryJson(res, 200, await service.importFile(String(input.fileId ?? ''))); if (action === 'export') return sendMemoryJson(res, 200, await service.exportFile(input)) }
    return sendMemoryJson(res, 405, { error: 'Choose a supported Google Drive action.' })
  } catch (error) { if (!res.headersSent && !res.destroyed) return sendMemoryJson(res, error instanceof DriveError ? error.status : 500, { error: error instanceof DriveError ? error.message : 'The Google connection could not complete this action. Your local originals were preserved.' }) }
}
