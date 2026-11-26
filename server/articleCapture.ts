import { accessTodos, TodoError } from './todoHttp.ts'
import { entityUrl } from './crmProfileCapture.ts'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { zipSync } from 'fflate'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WorldDb } from './worldDb.ts'
import type { ChangeBus } from './changes.ts'
import { memoryOriginAllowed, sendMemoryJson } from './memoryHttp.ts'
import { diffKnowledgeSnapshots } from '../src/knowledge/storage.ts'
import type { KnowledgeSnapshot, ParsedSource } from '../src/knowledge/types.ts'
import { splitPassages } from '../src/knowledge/parsers.ts'
import { applyReadingHighlight, applyReadingItem, decodeReading } from '../src/reading/model.ts'
import { articleIdentity } from '../src/reading/articleIdentity.ts'
import { capturedProfileMetadata } from './articleProfile.ts'
import { CrmError } from './crmStore.ts'
import type { QuickAddResult } from './crmProfileQuickAdd.ts'
import type { CrmProfileCaptureDraft } from '../src/crm/profileCaptureTypes.ts'
import { assertUniqueFolkPhotoPeople, type CapturedPhotoRequest, type FolkPhotoInput, type SavedContactPhoto, type SavedFolkPhotos } from './crmPhotoCoverage.ts'

const CLIENTS = 'reading.capture.clients.v1', RECEIPTS = 'reading.capture.receipts.v1'
const PHOTO_RECEIPTS = 'reading.capture.photo.receipts.v1'
const FOLK_PHOTO_RECEIPTS = 'reading.capture.folk-photo.receipts.v1'
const PROFILE_DATA_RECEIPTS = 'reading.capture.profile-data.receipts.v1'
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const extensionOrigin = (value: string) => /^chrome-extension:\/\/[a-p]{32}$/.test(value)
const emptyCorpus = (): KnowledgeSnapshot => ({ schemaVersion: 1, revision: 0, sources: [], versions: [], passages: [], imports: [], jobs: [], proposals: [] })
interface Client { id: string; origin: string; name: string; tokenHash: string; createdAt: number; expiresAt: number; revokedAt: number | null }
interface Clients { schemaVersion: 1; revision: number; clients: Client[] }
interface ConnectionRequest { id: string; origin: string; name: string; secretHash: string; createdAt: number; expiresAt: number; token?: string; clientId?: string }
export interface ArticleCaptureResult { sourceId: string; versionId: string; highlightId?: string; sequence: number; contactPhoto?: SavedContactPhoto }
export interface FolkPhotoCaptureResult extends SavedFolkPhotos { sequence: number }
export interface ProfileDataCaptureResult { sequence: number; profileDraft: CrmProfileCaptureDraft; reviewUrl: string; quickAdd?: QuickAddResult; workspaceFingerprint?: string }
interface ProfileDataReceipts { schemaVersion: 1; revision: number; entries: Record<string, { hash: string; result?: ProfileDataCaptureResult }> }
interface Receipts { schemaVersion: 1; revision: number; clients: Record<string, { sequence: number; hash: string; result: ArticleCaptureResult }> }
interface PhotoReceipts { schemaVersion: 1; revision: number; entries: Record<string, { hash: string; capture: ArticleCaptureResult; result?: ArticleCaptureResult }> }
interface FolkPhotoReceipts { schemaVersion: 1; revision: number; entries: Record<string, { hash: string; result?: FolkPhotoCaptureResult }> }
interface ArticleCaptureOptions { quickAddProfile?: (draft: CrmProfileCaptureDraft, requestId: string, groupId?: string, authorize?: () => void) => Promise<QuickAddResult>; db: WorldDb; blobDir: string; bus?: ChangeBus; now?: () => number; saveContactPhoto?: (input: CapturedPhotoRequest) => Promise<SavedContactPhoto>; saveFolkPhotos?: (input: FolkPhotoInput & { requestId: string; current: () => void }) => Promise<SavedFolkPhotos>; saveProfileData?: (input: Record<string, unknown> & { requestId: string; current: () => void }) => Promise<CrmProfileCaptureDraft> }
export class ArticleCaptureError extends Error { readonly status: number; constructor(message: string, status = 400) { super(message); this.status = status } }
function assert(condition: unknown, message: string, status = 400): asserts condition { if (!condition) throw new ArticleCaptureError(message, status) }

/** Per-world pairing credentials never enter portable exports; only their hashes are stored. */
export class ArticleCapture {
  private readonly options: ArticleCaptureOptions
  private queue: Promise<unknown> = Promise.resolve()
  // A five-minute, explicit approval handshake. Pending bearer tokens are memory-only,
  // never written to the world, portable backups, logs, or a webpage response.
  private readonly connections = new Map<string, ConnectionRequest>()
  constructor(options: ArticleCaptureOptions) { this.options = options }
  private now() { return this.options.now?.() ?? Date.now() }
  private clients(): Clients { return this.options.db.getKv<Clients>(CLIENTS) ?? { schemaVersion: 1, revision: 0, clients: [] } }
  private expireConnections() { for (const [id, request] of this.connections) if (request.expiresAt <= this.now()) this.connections.delete(id) }
  status() { this.expireConnections(); return { available: true, clients: this.clients().clients.map(({ tokenHash: _tokenHash, ...client }) => client), requests: [...this.connections.values()].filter((entry) => !entry.token).map(({ id, origin, name, createdAt, expiresAt }) => ({ id, origin, name, createdAt, expiresAt })), endpoint: '/api/reading-capture/capture' } }
  requestConnection(origin: string, input: Record<string, unknown>) {
    assert(extensionOrigin(origin), 'Open the Worldview Reader extension to connect.', 403)
    assert(!this.options.db.getKv('importInProgress'), 'Finish workspace recovery before connecting.', 409)
    this.expireConnections()
    const name = String(input.name ?? 'Worldview Reader').trim()
    assert(name.length > 0 && name.length <= 80, 'Choose a browser name up to 80 characters.')
    assert(this.connections.size < 8, 'There are several pending browser connections. Wait five minutes or approve one in Worldview.', 429)
    const secret = `wvconnect_${randomBytes(32).toString('base64url')}`, now = this.now()
    const request: ConnectionRequest = { id: randomUUID(), origin, name, secretHash: hash(secret), createdAt: now, expiresAt: now + 5 * 60_000 }
    this.connections.set(request.id, request)
    return { requestId: request.id, secret, expiresAt: request.expiresAt }
  }
  approveConnection(id: string) {
    this.expireConnections()
    const request = this.connections.get(id)
    assert(request, 'This browser request expired. Click Connect in the extension again.', 404)
    if (!request.token) { const paired = this.pair({ origin: request.origin, name: request.name }); request.token = paired.token; request.clientId = paired.clientId }
    return this.status()
  }
  connectionStatus(id: string, origin: string, secret: string, acknowledge = false) {
    this.expireConnections()
    const request = this.connections.get(id)
    assert(request && request.origin === origin && /^wvconnect_[A-Za-z0-9_-]{43}$/.test(secret) && timingSafeEqual(Buffer.from(request.secretHash, 'hex'), Buffer.from(hash(secret), 'hex')), 'This browser request expired. Click Connect again.', 401)
    if (acknowledge) { assert(request.token, 'Approve this browser in Worldview first.', 409); this.connections.delete(id); return { connected: true } }
    return request.token ? { connected: true, token: request.token, clientId: request.clientId } : { connected: false, expiresAt: request.expiresAt }
  }
  async download(): Promise<Uint8Array> {
    const files = ['manifest.json', 'background.js', 'content.js', 'folk-content.js', 'extract.js', 'popup.html', 'popup.js', 'group-icon.js', 'worldview-128.png', 'popup.css', 'application-form.js', 'contact-ui.js', 'contact-ui.css', 'todo-ui.js', 'todo-ui.css', 'README.md']
    const entries = await Promise.all(files.map(async (name) => [`WorldviewReader/${name}`, await readFile(resolve('extensions/worldview-reader', name))] as const))
    return zipSync(Object.fromEntries(entries), { level: 6 })
  }
  pair(input: Record<string, unknown>) {
    assert(!this.options.db.getKv('importInProgress'), 'Finish workspace recovery before pairing.', 409)
    const origin = String(input.origin ?? '').replace(/\/$/, ''), name = String(input.name ?? 'Browser reader').trim()
    assert(extensionOrigin(origin), 'Enter the 32-letter extension ID shown by Chrome or Edge, as chrome-extension://ID.')
    assert(name.length > 0 && name.length <= 80, 'Choose a browser name up to 80 characters.')
    const before = this.clients()
    assert(before.clients.filter((client) => !client.revokedAt && client.expiresAt > this.now()).length < 8, 'Revoke an existing browser before adding another.', 409)
    const token = `wvread_${randomBytes(32).toString('base64url')}`
    const client: Client = { id: randomUUID(), origin, name, tokenHash: hash(token), createdAt: this.now(), expiresAt: this.now() + 90 * 24 * 60 * 60_000, revokedAt: null }
    assert(this.options.db.compareAndSwapKv(CLIENTS, { ...before, revision: before.revision + 1, clients: [...before.clients.slice(-63), client] }, before.revision), 'Pairing changed; refresh and try again.', 409)
    return { ...this.status(), token, clientId: client.id }
  }
  revoke(id: string) {
    const before = this.clients(), next = structuredClone(before), client = next.clients.find((entry) => entry.id === id)
    assert(client, 'This browser pairing does not exist.', 404)
    client.revokedAt = this.now(); next.revision++
    assert(this.options.db.compareAndSwapKv(CLIENTS, next, before.revision), 'Pairing changed; refresh and try again.', 409)
    return this.status()
  }
  originAllowed(origin: string) { return extensionOrigin(origin) && this.clients().clients.some((client) => client.origin === origin && !client.revokedAt && client.expiresAt > this.now()) }
  todos(origin: string, token: string, edit?: Record<string,unknown>) {
    this.authenticate(origin,token)
    try { return accessTodos(this.options.db,this.options.bus,edit) }
    catch (error) {
      if (error instanceof TodoError) throw new ArticleCaptureError(error.message,error.status)
      throw new ArticleCaptureError('Worldview could not access your saved to-do lists.',500)
    }
  }
  profileGroups(type: unknown, origin: string, token: string, url?: unknown) {
    this.authenticate(origin, token)
    assert(type === 'person' || type === 'company', 'Choose a person or company profile.')
    const store = this.options.db.crm
    const key = typeof url === 'string' && entityUrl(url, type)
    const existing = key ? this.profileMatches(type, new Set([key])).get(key) ?? null : null
    return { ...(key ? { existing, workspaceFingerprint: store.workspaceFingerprint() } : {}), groups: store.rows('groups', false).filter(group => store.groupSupports(group, type)).map(({ id, name, emoji, icon }) => ({ id, name, emoji: emoji ?? '', ...(icon ? { icon } : {}) })).sort((a, b) => a.name.localeCompare(b.name)) }
  }
  private profileMatches(type: 'person' | 'company', keys: Set<string>) {
    const store = this.options.db.crm
    const matches = new Map<string, {recordId: string; groupIds: string[]} | null>()
    const assigned = new Map<string, string[]>()
    for (const membership of store.rows('memberships', false)) {
      if (membership.entityType !== type) continue
      const list = assigned.get(membership.entityId) || []
      list.push(membership.groupId)
      assigned.set(membership.entityId, list)
    }
    for (const record of store.rows(type === 'person' ? 'people' : 'companies', false)) {
      if (record.mergedIntoId) continue
      const links = [...record.urls, ...record.sourceRefs.filter(ref => ref.provider === 'profile-capture').map(ref => ref.url ?? ref.externalId)]
      const unique = new Set(links.map(link => entityUrl(link, type)).filter(Boolean))
      for (const url of unique) if (url && keys.has(url)) {
        matches.set(url, matches.has(url) ? null : { recordId: record.id, groupIds: assigned.get(record.id) || [] })
      }
    }
    return matches
  }
  visiblePeople(urls: unknown, origin: string, token: string) {
    this.authenticate(origin, token)
    assert(Array.isArray(urls) && urls.length <= 40 && urls.every(url => typeof url === 'string' && url.length <= 2048), 'Choose up to forty visible profiles.')
    const keys = new Map(urls.map(url => [url as string, entityUrl(url, 'person')]))
    const matches = this.profileMatches('person', new Set([...keys.values()].filter((value): value is string => !!value)))
    return { workspaceFingerprint: this.options.db.crm.workspaceFingerprint(), existing: Object.fromEntries([...keys].map(([url, key]) => [url, key && matches.get(key) || null])) }
  }
  private authenticate(origin: string, token: string): Client {
    assert(extensionOrigin(origin) && /^wvread_[A-Za-z0-9_-]{43}$/.test(token), 'A paired browser token is required.', 401)
    const digest = Buffer.from(hash(token), 'hex')
    const client = this.clients().clients.find((entry) => entry.origin === origin && !entry.revokedAt && entry.expiresAt > this.now() && timingSafeEqual(Buffer.from(entry.tokenHash, 'hex'), digest))
    assert(client, 'This browser pairing is unavailable, expired or revoked.', 401)
    return client
  }
  capture(input: Record<string, unknown> & { saveFolkPhotos: true }, origin: string, token: string): Promise<FolkPhotoCaptureResult>
  capture(input: Record<string, unknown> & { saveProfileData: true }, origin: string, token: string): Promise<ProfileDataCaptureResult>
  capture(input: Record<string, unknown>, origin: string, token: string): Promise<ArticleCaptureResult>
  capture(input: Record<string, unknown>, origin: string, token: string): Promise<ArticleCaptureResult | FolkPhotoCaptureResult | ProfileDataCaptureResult> {
    const run = this.queue.catch(() => {}).then(async (): Promise<ArticleCaptureResult | FolkPhotoCaptureResult | ProfileDataCaptureResult> => {
      assert(input.saveFolkPhotos === undefined || typeof input.saveFolkPhotos === 'boolean', 'Choose an explicit Folk photo action.')
      assert(input.saveFolkSearchPhotos === undefined || typeof input.saveFolkSearchPhotos === 'boolean', 'Choose an explicit matched Search photo action.')
      assert(input.saveFolkSearchPhotos !== true || input.saveFolkPhotos === true, 'Matched Search photos require the private Folk capture action.')
      assert(input.saveProfileData === undefined || typeof input.saveProfileData === 'boolean', 'Choose an explicit profile or company capture action.')
      assert(input.saveProfileData !== true || input.saveFolkPhotos !== true && input.saveContactPhoto !== true && input.intent === undefined && input.progress === undefined && input.selection === undefined && input.remark === undefined, 'Profile data capture is a separate CRM action, without article tracking or photo-only intent.')
      return input.saveProfileData === true ? this.saveProfileData(input, origin, token) : input.saveFolkPhotos === true ? this.saveFolkPhotos(input, origin, token) : this.saveWithPhoto(input, origin, token)
    })
    this.queue = run
    return run
  }
  private async saveProfileData(input: Record<string, unknown>, origin: string, token: string): Promise<ProfileDataCaptureResult> {
    const client = this.authenticate(origin, token), db = this.options.db, generation = db.getReplacementGeneration(), sequence = Number(input.sequence)
    assert(Number.isSafeInteger(sequence) && sequence > 0, 'A positive capture sequence is required.')
    assert(articleIdentity(String(input.url ?? '')).host.replace(/\.$/, '').toLowerCase() !== 'app.folk.app', 'Folk pages use the dedicated private photo import, not profile data capture.', 403)
    const current = () => { this.authenticate(origin, token); assert(generation === db.getReplacementGeneration() && !db.getKv('importInProgress') && db.getSettings()?.firstRunComplete, 'The workspace changed before this profile could be captured. Capture it again.', 409) }
    current(); const key = `${client.id}:${sequence}`, fingerprint = hash(JSON.stringify(input)), prior = db.getKv<ProfileDataReceipts>(PROFILE_DATA_RECEIPTS)?.entries[key]
    if (prior) { assert(prior.hash === fingerprint, 'This profile capture sequence was already used for different data.', 409); if (prior.result) return prior.result }
    const writeReceipt = (result?: ProfileDataCaptureResult) => {
      current(); const before = db.getKv<ProfileDataReceipts>(PROFILE_DATA_RECEIPTS) ?? { schemaVersion: 1, revision: 0, entries: {} }, entries = { ...before.entries, [key]: { hash: fingerprint, ...(result ? { result } : {}) } }
      const keys = Object.keys(entries); for (const old of keys.slice(0, Math.max(0, keys.length - 2048))) if (old !== key) delete entries[old]
      assert(db.compareAndSwapKv(PROFILE_DATA_RECEIPTS, { schemaVersion: 1, revision: before.revision + 1, entries }, before.revision), 'The profile capture receipt changed. Retry this retained capture.', 409)
    }
    assert(this.options.saveProfileData, 'Profile data capture is unavailable in this workspace.', 503)
    if (input.quickAdd === true) {
      assert(this.options.quickAddProfile, 'Update Worldview to save directly to the CRM.', 503)
      assert(input.groupId === undefined || typeof input.groupId === 'string' && input.groupId.length > 0 && input.groupId.length <= 1000, 'Choose a valid CRM group.')
    }
    if (!prior) writeReceipt()
    try {
      const profileDraft = await this.options.saveProfileData({ ...input, requestId: `reader-profile:${client.id}:${sequence}`, current }); current()
      const result: ProfileDataCaptureResult = { sequence, profileDraft, reviewUrl: `http://127.0.0.1:5173/#/people?capture=${encodeURIComponent(profileDraft.id)}` }
      if (input.quickAdd === true) result.quickAdd = await this.options.quickAddProfile!(profileDraft, `reader-add:${key}`, input.groupId as string | undefined, current)
      current()
      result.workspaceFingerprint = db.crm.workspaceFingerprint()
      const saved = result.quickAdd
      if (saved?.status === 'saved' && saved.recordId) db.crm.rememberBrowserSave(profileDraft.profile.entityType, saved.recordId)
      writeReceipt(result)
      if (saved?.status === 'saved') this.options.bus?.publish({ v: 1, from: 'reader-profile', change: { type: 'kv', keys: ['crm.v1'] } })
      return result
    } catch (error) { current(); if (error instanceof ArticleCaptureError) throw error; throw new ArticleCaptureError(`The profile is not confirmed. Retry the retained capture. ${error instanceof Error ? error.message : ''}`.trim(), error instanceof CrmError && [400, 401, 403, 404, 409, 413, 422].includes(error.status) ? error.status : 503) }
  }
  private async saveFolkPhotos(input: Record<string, unknown>, origin: string, token: string): Promise<FolkPhotoCaptureResult> {
    const client = this.authenticate(origin, token), db = this.options.db, generation = db.getReplacementGeneration(), sequence = Number(input.sequence)
    assert(Number.isSafeInteger(sequence) && sequence > 0, 'A positive capture sequence is required.')
    assert(input.text === undefined && input.progress === undefined && input.remark === undefined && input.selection === undefined && input.saveContactPhoto !== true && input.intent === undefined, 'Folk photos use a private CRM-only capture, without article text or reading activity.')
    try { assertUniqueFolkPhotoPeople(input.folkPhotos) } catch (error) { throw new ArticleCaptureError(error instanceof Error ? error.message : 'This Folk batch has ambiguous person IDs.') }
    const current = () => { this.authenticate(origin, token); assert(generation === db.getReplacementGeneration() && !db.getKv('importInProgress') && db.getSettings()?.firstRunComplete, 'The workspace changed before these Folk photos could be saved. Capture them again.', 409) }
    current(); const key = `${client.id}:${sequence}`, fingerprint = hash(JSON.stringify(input)), prior = db.getKv<FolkPhotoReceipts>(FOLK_PHOTO_RECEIPTS)?.entries[key]
    if (prior) { assert(prior.hash === fingerprint, 'This Folk photo sequence was already used for different data.', 409); if (prior.result) return prior.result }
    const writeReceipt = (result?: FolkPhotoCaptureResult) => {
      current(); const before = db.getKv<FolkPhotoReceipts>(FOLK_PHOTO_RECEIPTS) ?? { schemaVersion: 1, revision: 0, entries: {} }, entries = { ...before.entries, [key]: { hash: fingerprint, ...(result ? { result } : {}) } }
      const keys = Object.keys(entries); for (const old of keys.slice(0, Math.max(0, keys.length - 2048))) if (old !== key) delete entries[old]
      assert(db.compareAndSwapKv(FOLK_PHOTO_RECEIPTS, { schemaVersion: 1, revision: before.revision + 1, entries }, before.revision), 'The private Folk photo receipt changed. Retry this capture.', 409)
    }
    assert(this.options.saveFolkPhotos, 'Private Folk photo import is unavailable in this workspace.', 503)
    if (!prior) writeReceipt()
    try { const saved = await this.options.saveFolkPhotos({ url: input.url, title: input.title, folkPhotos: input.folkPhotos, folkPhotoRows: input.folkPhotoRows, saveFolkSearchPhotos: input.saveFolkSearchPhotos, requestId: `reader-folk:${client.id}:${sequence}`, current }); current(); const result = { ...saved, sequence }; writeReceipt(result); return result }
    catch (error) { current(); if (error instanceof ArticleCaptureError) throw error; throw new ArticleCaptureError(`Folk photos are not confirmed. Retry the retained capture. ${error instanceof Error ? error.message : ''}`.trim(), error instanceof CrmError && [400, 401, 403, 404, 409, 413].includes(error.status) ? error.status : 503) }
  }
  private async saveWithPhoto(input: Record<string, unknown>, origin: string, token: string): Promise<ArticleCaptureResult> {
    assert(input.saveContactPhoto === undefined || typeof input.saveContactPhoto === 'boolean', 'Choose an explicit contact photo action.')
    assert(input.intent === undefined || input.intent === 'contact-photo', 'Choose a supported Reader action.')
    assert(articleIdentity(String(input.url ?? '')).host.replace(/\.$/, '').toLowerCase() !== 'app.folk.app', 'Folk pages contain private CRM data. Use Import visible Folk photos; article capture is disabled for Folk.', 403)
    if (input.saveContactPhoto !== true && input.intent !== 'contact-photo') return this.save(input, origin, token)
    const client = this.authenticate(origin, token), db = this.options.db, generation = db.getReplacementGeneration(), sequence = Number(input.sequence)
    assert(Number.isSafeInteger(sequence) && sequence > 0, 'A positive capture sequence is required.')
    const current = () => { this.authenticate(origin, token); assert(generation === db.getReplacementGeneration() && !db.getKv('importInProgress') && db.getSettings()?.firstRunComplete, 'The workspace changed before this contact photo could be saved. Capture it again.', 409) }
    current(); const key = `${client.id}:${sequence}`, fingerprint = hash(JSON.stringify(input)), prior = db.getKv<PhotoReceipts>(PHOTO_RECEIPTS)?.entries[key]
    if (prior) { assert(prior.hash === fingerprint, 'This photo capture sequence was already used for different data.', 409); if (prior.result) return prior.result }
    // Source capture commits independently. A failed image download can retry this same
    // sequence even after a later ordinary progress event advanced the capture receipt.
    const captured = prior?.capture ?? await this.save(input, origin, token); current()
    const writeReceipt = (result?: ArticleCaptureResult) => {
      current(); const before = db.getKv<PhotoReceipts>(PHOTO_RECEIPTS) ?? { schemaVersion: 1, revision: 0, entries: {} }, entries = { ...before.entries, [key]: { hash: fingerprint, capture: captured, ...(result ? { result } : {}) } }
      const keys = Object.keys(entries); for (const old of keys.slice(0, Math.max(0, keys.length - 2048))) if (old !== key) delete entries[old]
      assert(db.compareAndSwapKv(PHOTO_RECEIPTS, { schemaVersion: 1, revision: before.revision + 1, entries }, before.revision), 'The photo receipt changed. Retry the retained capture.', 409)
    }
    if (!prior) writeReceipt()
    let contactPhoto: SavedContactPhoto
    try { contactPhoto = this.options.saveContactPhoto ? await this.options.saveContactPhoto({ sourceId: captured.sourceId, versionId: captured.versionId, requestId: `reader-photo:${client.id}:${sequence}`, current }) : { status: 'unavailable', message: 'The profile was captured, but contact photo saving is unavailable in this workspace.' }; current() }
    catch (error) { current(); if (error instanceof ArticleCaptureError) throw error; throw new ArticleCaptureError(`The profile capture is retained. Its photo has not been confirmed; retry this capture. ${error instanceof Error ? error.message : ''}`.trim(), error instanceof CrmError && [401, 403, 409].includes(error.status) ? error.status : 503) }
    const result: ArticleCaptureResult = { ...captured, contactPhoto }; writeReceipt(result); return result
  }
  private async save(input: Record<string, unknown>, origin: string, token: string): Promise<ArticleCaptureResult> {
    const client = this.authenticate(origin, token), db = this.options.db
    assert(!db.getKv('importInProgress') && db.getSettings()?.firstRunComplete, 'Finish workspace setup or recovery before capturing.', 409)
    const identity = articleIdentity(String(input.url ?? '')), sequence = Number(input.sequence)
    assert(identity.host.replace(/\.$/, '').toLowerCase() !== 'app.folk.app', 'Folk pages contain private CRM data. Use Import visible Folk photos; article capture is disabled for Folk.', 403)
    assert(Number.isSafeInteger(sequence) && sequence > 0, 'A positive capture sequence is required.')
    const receipts = db.getKv<Receipts>(RECEIPTS) ?? { schemaVersion: 1, revision: 0, clients: {} }
    const fingerprint = hash(JSON.stringify(input)), prior = receipts.clients[client.id]
    if (prior && sequence <= prior.sequence) { assert(sequence === prior.sequence && fingerprint === prior.hash, 'This capture sequence is stale or was already used.', 409); return prior.result }
    const before = db.getKv<KnowledgeSnapshot>('knowledge.v1') ?? emptyCorpus(), next = structuredClone(before)
    let source = next.sources.find((entry) => entry.externalId === identity.externalId)
    assert(!source?.deleted && !source?.excluded, 'This article was excluded or deleted. Restore its source policy in the app before capturing again.', 409)
    const now = this.now(), suppliedText = input.text !== undefined
    assert(!suppliedText || typeof input.text === 'string', 'Article text must be plain text.')
    const text = suppliedText ? String(input.text) : next.versions.find((entry) => entry.id === source?.currentVersionId)?.text
    assert(typeof text === 'string' && text.trim().length > 0 && Buffer.byteLength(text) <= 512 * 1024, 'Provide article text up to 512 KiB when saving a new article.')
    const title = String(input.title ?? source?.title ?? '').trim()
    assert(title.length > 0 && title.length <= 300, 'Provide a title up to 300 characters.')
    if (!source) { source = { id: randomUUID(), externalId: identity.externalId, title, kind: 'document', currentVersionId: '', createdAt: now, updatedAt: now, excluded: false, aiAllowed: true, tags: [] }; next.sources.push(source) }
    const currentVersion = next.versions.find((entry) => entry.id === source!.currentVersionId)
    const profile = capturedProfileMetadata({ ...currentVersion?.metadata, ...input }, identity.url)
    const previousProfile = capturedProfileMetadata(currentVersion?.metadata ?? {}, identity.url)
    let version = currentVersion, asset: { id: string; kind: 'file'; mime: string; bytes: number; createdAt: number; nodeId: null } | undefined
    if (!version || version.text !== text || JSON.stringify(profile) !== JSON.stringify(previousProfile)) {
      const original = Buffer.from(JSON.stringify({ format: 'worldview-article-capture.v1', url: identity.url, title, text, ...profile }), 'utf8')
      const id = `knowledge-${hash(original)}`, path = join(this.options.blobDir, id)
      await mkdir(this.options.blobDir, { recursive: true })
      if (!existsSync(path)) { const temporary = `${path}.${randomUUID()}.tmp`; try { await writeFile(temporary, original, { mode: 0o600 }); await rename(temporary, path) } finally { await rm(temporary, { force: true }) } }
      this.authenticate(origin, token)
      assert(!db.getKv('importInProgress') && db.getKnowledgeRevision() === before.revision, 'The workspace changed before the article was saved. Retry the retained capture.', 409)
      asset = { id, kind: 'file', mime: 'application/json', bytes: original.byteLength, createdAt: now, nodeId: null }
      version = { id: randomUUID(), sourceId: source.id, contentHash: hash(text), originalBlobId: id, originalName: 'article-capture.json', text, createdAt: now, authoredAt: null, origin: 'capture', ...(currentVersion ? { previousVersionId: currentVersion.id } : {}), metadata: { url: identity.url, canonicalUrl: identity.canonicalUrl, host: identity.host, format: 'article', captureMethod: 'browser-extension', ...profile } }
      next.versions.push(version); source.currentVersionId = version.id; source.updatedAt = now
      const parsed: ParsedSource = { externalId: source.externalId, title, kind: 'document', text, authoredAt: null, messages: [{ text, role: 'third-party', authoredAt: null, start: 0, end: text.length }] }
      next.passages.push(...splitPassages(parsed).map((part) => ({ id: randomUUID(), sourceId: source!.id, versionId: version!.id, title, text: part.text, start: part.start, end: part.end, role: part.role, authoredAt: part.authoredAt })))
    }
    source.title = title
    const reading = decodeReading(db.getKv('reading.v1')), readingRevision = reading.revision
    const item = applyReadingItem(reading, source.id, {}, now)
    if (input.progress !== undefined) {
      const progress = input.progress as Record<string, unknown>
      assert(progress && typeof progress === 'object' && !Array.isArray(progress), 'Reading progress must be an object.')
      const fraction = Number(progress.fraction), position = Number(progress.position), activeMs = Number(progress.activeMs)
      assert(Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 && Number.isFinite(position) && position >= 0 && Number.isSafeInteger(activeMs) && activeMs >= 0 && activeMs <= 60_000, 'Reading progress is out of range.')
      assert(progress.following === undefined || typeof progress.following === 'boolean', 'Following must be a boolean.')
      const accumulated = (item.activeReadMs ?? 0) + activeMs
      applyReadingItem(reading, source.id, { progress: accumulated >= 15_000 ? Math.max(item.progress, fraction) : item.progress, position, lastOpenedAt: now, activeReadMs: accumulated, ...(item.status === 'unread' && (progress.following === true || activeMs > 0) ? { status: 'reading' } : {}), ...(typeof progress.following === 'boolean' ? { following: progress.following } : {}) }, now)
    }
    const result: ArticleCaptureResult = { sourceId: source.id, versionId: version!.id, sequence }
    if (input.selection !== undefined) {
      const selection = input.selection as Record<string, unknown>
      assert(selection && typeof selection === 'object' && typeof selection.quote === 'string' && selection.quote.length > 0 && selection.quote.length <= 20_000, 'Select an article quote up to 20,000 characters.')
      const quote = selection.quote, prefix = typeof selection.prefix === 'string' ? selection.prefix.slice(-200) : '', suffix = typeof selection.suffix === 'string' ? selection.suffix.slice(0, 200) : ''
      let start = Number(selection.start), end = Number(selection.end)
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || text.slice(start, end) !== quote) {
        const candidates: number[] = []; let offset = text.indexOf(quote)
        while (offset >= 0) { if ((!prefix || text.slice(Math.max(0, offset - prefix.length), offset).endsWith(prefix)) && (!suffix || text.slice(offset + quote.length, offset + quote.length + suffix.length).startsWith(suffix))) candidates.push(offset); offset = text.indexOf(quote, offset + 1) }
        assert(candidates.length === 1, 'The quote cannot be anchored unambiguously. Select a unique passage or capture this article again.', 409)
        start = candidates[0]; end = start + quote.length
      }
      const note = typeof selection.note === 'string' ? selection.note : ''
      assert(note.length <= 20_000, 'Keep a highlight comment under 20,000 characters.')
      const highlight = applyReadingHighlight(reading, { sourceId: source.id, versionId: version!.id, start, end, quote, prefix, suffix, note }, next.versions, now)
      if (note.trim() && highlight.note !== note) { const combined = highlight.note ? `${highlight.note}\n\n${note}` : note; assert(combined.length <= 100_000, 'This highlight has many comments. Add a separate article note instead.', 409); highlight.note = combined; highlight.updatedAt = now }
      result.highlightId = highlight.id
    }
    if (input.remark !== undefined) { assert(typeof input.remark === 'string' && input.remark.length <= 20_000, 'Keep your article note under 20,000 characters.'); if (input.remark.trim()) reading.notes.push({ id: randomUUID(), sourceId: source.id, text: input.remark.trim(), createdAt: now, updatedAt: now }) }
    this.authenticate(origin, token)
    reading.revision++; next.revision++
    const receiptState: Receipts = { ...receipts, revision: receipts.revision + 1, clients: { ...receipts.clients, [client.id]: { sequence, hash: fingerprint, result } } }
    assert(db.commitKnowledge(diffKnowledgeSnapshots(before, next), { expectedRevision: before.revision, idempotencyKey: `article:${client.id}:${sequence}`, ...(asset ? { assets: [asset] } : {}), state: [{ key: 'reading.v1', value: reading, expectedRevision: readingRevision }, { key: RECEIPTS, value: receiptState, expectedRevision: receipts.revision }] }), 'Reading data changed before this capture was committed. Retry it.', 409)
    this.options.bus?.publish({ v: 1, from: 'browser-reader', change: { type: 'kv', keys: ['knowledge.v1', 'reading.v1'] } })
    return result
  }
}

export function loopback(req: IncomingMessage): boolean {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(`http://${req.headers.host ?? ''}`).hostname) && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') } catch { return false }
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  assert(String(req.headers['content-type'] ?? '').split(';')[0] === 'application/json', 'Send application/json.', 415)
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) { size += chunk.byteLength; assert(size <= 1024 * 1024, 'Article capture exceeds 1 MiB.', 413); chunks.push(chunk) }
  try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); assert(value && typeof value === 'object' && !Array.isArray(value), 'Send a capture object.'); return value as Record<string, unknown> } catch (error) { if (error instanceof ArticleCaptureError) throw error; throw new ArticleCaptureError('Capture is not valid JSON.') }
}
export async function handleArticleCaptureRequest(service: ArticleCapture, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    assert(loopback(req), 'Browser capture requires a loopback local service.', 403)
    const path = (req.url ?? '').split('?')[0], origin = String(req.headers.origin ?? '')
    if (path === '/api/reading-capture/connect' || /^\/api\/reading-capture\/connect\/[^/]+$/.test(path)) {
      assert(extensionOrigin(origin), 'Connect from the Worldview Reader extension.', 403)
      res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'Origin'); res.setHeader('access-control-allow-private-network', 'true'); res.setHeader('cache-control', 'no-store')
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': 'authorization,content-type', 'access-control-max-age': '300' }); res.end(); return }
      if (path.endsWith('/connect')) { assert(req.method === 'POST', 'Use Connect in the extension.', 405); return sendMemoryJson(res, 201, service.requestConnection(origin, await body(req))) }
      assert(req.method === 'GET' || req.method === 'POST', 'Check the connection or acknowledge it.', 405)
      const secret = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? ''
      const input = req.method === 'POST' ? await body(req) : { action: 'check' }
      assert(input.action === 'check' || input.action === 'acknowledge', 'Choose a connection check or acknowledgement.')
      return sendMemoryJson(res, 200, service.connectionStatus(decodeURIComponent(path.split('/').at(-1)!), origin, secret, input.action === 'acknowledge'))
    }
    if (['/api/reading-capture/capture','/api/reading-capture/profile-groups','/api/reading-capture/profile-people','/api/reading-capture/todos-state','/api/reading-capture/todos-mutate'].includes(path)) {
      assert(service.originAllowed(origin), 'Pair this extension in the local workspace first.', 403)
      res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'Origin'); res.setHeader('access-control-allow-private-network', 'true')
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'authorization,content-type', 'access-control-max-age': '300' }); res.end(); return }
      assert(req.method === 'POST', 'Use POST for explicit article captures.', 405)
      const token = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? ''
      const input = await body(req)
      if (path.endsWith('/todos-state') || path.endsWith('/todos-mutate')) return sendMemoryJson(res,200,service.todos(origin,token,path.endsWith('/todos-mutate') ? input : undefined))
      if (path.endsWith('/profile-people')) return sendMemoryJson(res, 200, service.visiblePeople(input.urls, origin, token))
      if (path.endsWith('/profile-groups')) return sendMemoryJson(res, 200, service.profileGroups(input.entityType, origin, token, input.url))
      if (input.saveProfileData === true && req.socket.localPort) {
        const receipt = await service.capture({ ...input, saveProfileData: true }, origin, token)
        return sendMemoryJson(res, 200, { ...receipt, reviewUrl: `http://127.0.0.1:${req.socket.localPort}/#/people?capture=${encodeURIComponent(receipt.profileDraft.id)}` })
      }
      return sendMemoryJson(res, 200, await service.capture(input, origin, token))
    }
    assert(memoryOriginAllowed(req) && !!req.headers['x-wv-client'], 'Open the local workspace to manage browser pairing.', 403)
    if (/^\/api\/reading-capture\/connect\/[^/]+\/approve$/.test(path) && req.method === 'POST') return sendMemoryJson(res, 200, service.approveConnection(decodeURIComponent(path.split('/').at(-2)!)))
    if (path === '/api/reading-capture/download' && req.method === 'GET') { const zip = await service.download(); res.writeHead(200, { 'content-type': 'application/zip', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="WorldviewReader.zip"' }); res.end(zip); return }
    if (path === '/api/reading-capture' && req.method === 'GET') return sendMemoryJson(res, 200, service.status())
    if (path === '/api/reading-capture' && req.method === 'POST') return sendMemoryJson(res, 201, service.pair(await body(req)))
    if (/^\/api\/reading-capture\/[^/]+$/.test(path) && req.method === 'DELETE') return sendMemoryJson(res, 200, service.revoke(decodeURIComponent(path.split('/').at(-1)!)))
    return sendMemoryJson(res, 405, { error: 'Use the browser pairing or capture controls.' })
  } catch (error) { return sendMemoryJson(res, error instanceof ArticleCaptureError ? error.status : 400, { error: error instanceof Error ? error.message : 'Browser capture failed.' }) }
}
