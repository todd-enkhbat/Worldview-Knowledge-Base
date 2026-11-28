import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WorldDb } from './worldDb.ts'
import { memoryOriginAllowed, sendMemoryJson } from './memoryHttp.ts'
import type { CrmJson } from '../src/crm/types.ts'
import type { CrmCalendar, CrmCalendarEvent, CrmCapturedContactSource, CrmConnectionsStatus, CrmConnectorBatch, CrmImportMapping, GoogleCrmCapability } from '../src/crm/connectionTypes.ts'
import type { KnowledgeSnapshot } from '../src/knowledge/types.ts'
import { batchCrmImport, connectorCandidate, crmEmail, crmHash, crmPerson, crmUrl, parseCrmEmailHeaders, previewCrmImport } from './crmConnectionParsers.ts'
import { googleContactDetails } from './crmGoogleContact.ts'
import { CrmRelationshipHistory } from './crmRelationshipHistory.ts'
import { normalizeFolkExport } from './crmFolk.ts'

export const CRM_GOOGLE_SCOPES: Record<GoogleCrmCapability, string[]> = {
  calendar: ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly'],
  contacts: ['https://www.googleapis.com/auth/contacts.readonly'], otherContacts: ['https://www.googleapis.com/auth/contacts.other.readonly'],
  gmail: ['https://www.googleapis.com/auth/gmail.metadata'], send: ['https://www.googleapis.com/auth/gmail.send'],
}
const IDENTITY_SCOPES = ['openid', 'https://www.googleapis.com/auth/userinfo.email']
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const fail = (message: string, status = 400): never => { throw new CrmConnectionError(message, status) }
const check = (value: unknown, message: string, status = 400): void => { if (!value) fail(message, status) }
const str = (value: unknown, limit = 10000) => typeof value === 'string' ? value.replaceAll('\0', '').slice(0, limit) : ''
const strings = (value: unknown, limit = 1000) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, limit) : []
const jsonValue = (value: unknown): CrmJson => JSON.parse(JSON.stringify(value)) as CrmJson
const validCapabilities = (value: unknown): GoogleCrmCapability[] => [...new Set(strings(value, 5).filter((item): item is GoogleCrmCapability => item in CRM_GOOGLE_SCOPES))]
export class CrmConnectionError extends Error { status: number; retryAt?: number; rateLimited?: boolean; constructor(message: string, status = 400, options: { retryAt?: number; rateLimited?: boolean } = {}) { super(message); this.status = status; this.retryAt = options.retryAt; this.rateLimited = options.rateLimited } }
interface ClientConfig { clientId: string; clientSecret?: string }
interface GmailProgress { mode: 'messages' | 'history'; pageToken: string; historyId: string; baselineHistoryId: string; labelIds: string[]; pendingIds?: string[]; listComplete?: boolean; retryAt?: number | null; includeSubject?: boolean }
interface PrivateAccount { syncWorkspace?: string; includeSubjects?: boolean; autoSyncError?: string; autoSyncAt?: number; id: string; label: string; email?: string; subject?: string; client: ClientConfig; capabilities: GoogleCrmCapability[]; scopes: string[]; tokens?: { access: string; refresh?: string; expiresAt: number }; connectedAt?: number; lastSyncAt?: number; gmailHistoryId?: string; gmailProgress?: GmailProgress; contactsSyncToken?: string; contactsFormat?: number; otherContactsSyncToken?: string }
interface OutboxEntry { id: string; digest: string; accountId: string; status: 'ambiguous' | 'sent' | 'failed'; attemptedAt: number; messageId?: string }
interface PrivateVault { schemaVersion: 1; revision: number; accounts: PrivateAccount[]; happenstanceKey?: string; folkKey?: string; outbox: OutboxEntry[] }
interface OAuthSession { accountId: string; verifier: string; redirect: string; origin: string; epoch: number; generation: number; expiresAt: number }
interface MailPreparation { accountId: string; to: string[]; subject: string; body: string; digest: string; expiresAt: number; epoch: number; generation: number }
export interface CrmConnectionsOptions { db: WorldDb; blobDir: string; now?: () => number; fetch?: typeof fetch; delay?: (milliseconds: number) => Promise<void>; stageBatch?: (batch: CrmConnectorBatch) => unknown | Promise<unknown> }

/** Private app-owned grants, isolated from Drive and from other applications' connector tokens. */
export class CrmConnections {
  private options: CrmConnectionsOptions
  private state: PrivateVault | null = null
  private loading: Promise<PrivateVault> | null = null
  private writes: Promise<unknown> = Promise.resolve()
  private epoch = 0
  private sessions = new Map<string, OAuthSession>()
  private preparations = new Map<string, MailPreparation>()
  private gmailBusy = new Set<string>()
  private gmailLastRead = new Map<string, number>()
  private history?: { key: string; view: CrmRelationshipHistory }
  private syncRunning = false
  constructor(options: CrmConnectionsOptions) { this.options = options }
  private now() { return this.options.now?.() ?? Date.now() }
  private path() { return join(dirname(this.options.blobDir), 'connections', 'crm-google.private.json') }
  private async privateRead(path: string): Promise<unknown> { const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const stat = await file.stat(); check(stat.isFile() && stat.size <= 2 * 1024 * 1024, 'The private connection file is invalid.'); return JSON.parse(await file.readFile('utf8')) as unknown } finally { await file.close() } }
  private async load() {
    if (this.state) return this.state
    if (!this.loading) this.loading = (async () => { let vault: PrivateVault = { schemaVersion: 1, revision: 0, accounts: [], outbox: [] }; try { const raw = await this.privateRead(this.path()); check(object(raw) && raw.schemaVersion === 1 && Array.isArray(raw.accounts) && Array.isArray(raw.outbox), 'CRM connections need setup again.'); const record = raw as Record<string, unknown>; vault = { ...record, revision: Number(record.revision) || 0 } as unknown as PrivateVault } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } this.state = vault; return vault })()
    return this.loading
  }
  private async persist(update: PrivateVault | ((vault: PrivateVault) => PrivateVault), epoch = this.epoch, current = this.guard()) {
    const task = this.writes.catch(() => {}).then(async () => { current(); const vault = typeof update === 'function' ? update(this.state!) : update; check(epoch === this.epoch && vault.revision === this.state?.revision, 'Connections changed. Start this action again.', 409); const next = { ...vault, revision: vault.revision + 1 }; await mkdir(dirname(this.path()), { recursive: true, mode: 0o700 }); const temporary = `${this.path()}.${randomUUID()}.tmp`; try { current(); await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); current(); check(epoch === this.epoch, 'Connections changed.', 409); await rename(temporary, this.path()); current(); this.state = next } finally { await rm(temporary, { force: true }) } }); this.writes = task; await task
  }
  private guard() { const epoch = this.epoch, generation = this.options.db.getReplacementGeneration(); return () => check(epoch === this.epoch && generation === this.options.db.getReplacementGeneration() && !this.options.db.getKv('importInProgress'), 'The workspace or connection changed. Review this action again.', 409) }
  private async account(id: string, capability?: GoogleCrmCapability) { const account = (await this.load()).accounts.find((item) => item.id === id); check(account, 'Choose a configured Google account.', 404); if (capability) check(account!.capabilities.includes(capability), `Connect the ${capability} permission for this account first.`, 403); return account! }
  private async rawFetch(url: string, init: RequestInit = {}) { const parsed = new URL(url); check(parsed.protocol === 'https:' && ['www.googleapis.com', 'people.googleapis.com', 'oauth2.googleapis.com', 'openidconnect.googleapis.com', 'api.happenstance.ai', 'api.folk.app'].includes(parsed.hostname) && !parsed.username && !parsed.password && !parsed.port, 'This provider endpoint is not allowed.'); return (this.options.fetch ?? fetch)(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30000) }) }
  private async token(account: PrivateAccount): Promise<string> {
    account = (await this.load()).accounts.find((item) => item.id === account.id) ?? account
    check(account.tokens, 'Connect this Google account first.', 401)
    if (account.tokens!.expiresAt > this.now() + 60000) return account.tokens!.access
    check(account.tokens!.refresh, 'Reconnect this Google account to renew access.', 401)
    const current = this.guard(), epoch = this.epoch, body = new URLSearchParams({ grant_type: 'refresh_token', client_id: account.client.clientId, refresh_token: account.tokens!.refresh! }); if (account.client.clientSecret) body.set('client_secret', account.client.clientSecret)
    const response = await this.rawFetch('https://oauth2.googleapis.com/token', { method: 'POST', body }); current(); check(response.ok, 'Google authorization expired. Reconnect this account.', 401)
    const result: unknown = await response.json(); current(); check(object(result) && typeof result.access_token === 'string', 'Google returned an invalid token.', 502)
    if (typeof (result as Record<string, unknown>).scope === 'string') this.validateScopes(String((result as Record<string, unknown>).scope), account.scopes)
    const value = result as Record<string, unknown>, tokens = { access: str(value.access_token), refresh: account.tokens!.refresh, expiresAt: this.now() + Math.max(60, Math.min(86400, Number(value.expires_in) || 3600)) * 1000 }
    current()
    await this.persist(vault => ({ ...vault, accounts: vault.accounts.map(item => item.id === account.id ? { ...item, tokens } : item) }), epoch, current)
    current()
    return tokens.access
  }
  private validateScopes(scope: string, requested: string[]) { const actual = scope.split(/\s+/).filter(Boolean).map((item) => item === 'email' ? 'https://www.googleapis.com/auth/userinfo.email' : item); check(actual.every((item) => requested.includes(item)) && requested.every((item) => actual.includes(item)), 'Google returned different permissions. Reconnect with only the capabilities you chose.', 403) }
  private async google(account: PrivateAccount, url: string) {
    const current = this.guard(), access = await this.token(account); current()
    const response = await this.rawFetch(url, { headers: { authorization: `Bearer ${access}` } }); current()
    if (!response.ok) {
      if (response.status === 410 || response.status === 404) throw new CrmConnectionError('The provider cursor or record expired. Start a fresh sync.', response.status)
      let providerReason = '', reasons: string[] = []
      if (response.status === 403 || response.status === 429) {
        const details: unknown = await response.json().catch(() => null); current()
        if (object(details) && object(details.error)) { providerReason = str(details.error.message, 700); reasons = (Array.isArray(details.error.errors) ? details.error.errors : []).filter(object).map((entry) => str(entry.reason)); reasons.push(str(details.error.status)) }
      }
      const rateLimited = response.status === 429 || response.status === 403 && [...reasons, providerReason].some((reason) => /rate.?limit|quota.?exceed|daily.?limit|resource.?exhausted/i.test(reason))
      if (rateLimited) {
        const retryAfter = response.headers.get('retry-after'), seconds = Number(retryAfter), parsedDate = retryAfter ? Date.parse(retryAfter) : NaN
        const retryAt = Math.max(this.now() + 1000, retryAfter && Number.isFinite(seconds) ? this.now() + seconds * 1000 : Number.isFinite(parsedDate) ? parsedDate : this.now() + 60000)
        throw new CrmConnectionError(`Google paused this read because its quota was reached (HTTP ${response.status}).${providerReason ? ' ' + providerReason : ''}`, response.status, { rateLimited: true, retryAt })
      }
      fail(response.status === 401 ? 'Google access expired. Reconnect this account.' : `Google could not read these records (HTTP ${response.status}).${providerReason ? ' ' + providerReason : ''}`, [400, 401, 403, 429].includes(response.status) ? response.status : 502)
    }
    const value: unknown = await response.json(); current(); check(object(value), 'Google returned an invalid response.', 502); return value as Record<string, unknown>
  }
  private async gmailRead(account: PrivateAccount, url: string, current: () => void) {
    const previous = this.gmailLastRead.get(account.id), remaining = previous === undefined ? 0 : 250 - (this.now() - previous)
    if (remaining > 0) await (this.options.delay ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))))(remaining)
    current(); this.gmailLastRead.set(account.id, this.now()); return this.google(account, url)
  }
  private async driveConfig(): Promise<ClientConfig | null> { try { const raw = await this.privateRead(join(dirname(this.options.blobDir), 'connections', 'google-drive.private.json')); return object(raw) && raw.clientType !== 'web' && typeof raw.clientId === 'string' ? { clientId: raw.clientId, ...(typeof raw.clientSecret === 'string' ? { clientSecret: raw.clientSecret } : {}) } : null } catch { return null } }
  private workspaceKey() {
    const device = this.options.db.db.prepare("SELECT body FROM crm_state WHERE key='device'").get()
    return typeof device?.body === 'string' ? device.body : ''
  }
  private relationshipView() {
    const key = this.workspaceKey() + ':' + this.options.db.getReplacementGeneration()
    if (!this.history || this.history.key !== key) this.history = { key, view: new CrmRelationshipHistory(this.options.blobDir) }
    return this.history.view
  }
  async reconnect(offset: number) {
    check(Number.isSafeInteger(offset) && offset >= 0, 'Choose a valid follow-up page.')
    const current = this.guard(), vault = await this.load(); current()
    return this.relationshipView().reconnect(this.options.db.crm, vault.accounts, this.now(), offset, current)
  }
  async relationship(personId: string, offset: number) {
    check(Number.isSafeInteger(offset) && offset >= 0, 'Choose a valid history page.')
    const current = this.guard(), vault = await this.load(); current()
    const person = this.options.db.crm.resolvePerson(personId)
    check(person && person.archivedAt === null, 'Contact unavailable.', 404)
    return this.relationshipView().read(this.options.db.crm, personId, vault.accounts, this.now(), offset, current)
  }
  async syncPreferences(input: Record<string, unknown>) {
    const current = this.guard(), vault = await this.load(), id = str(input.accountId)
    current()
    check(!this.gmailBusy.has(id), 'The current email batch is finishing. Change sync preferences after it completes.', 409)
    const account = vault.accounts.find(a => a.id === id)
    check(account?.tokens && account.capabilities.some(c => c === 'gmail' || c === 'contacts'), 'Connect a Gmail or Contacts account first.')
    check(typeof input.enabled === 'boolean' && typeof input.includeSubjects === 'boolean', 'Choose sync and subject preferences.')
    const key = this.workspaceKey()
    check(key, 'Workspace unavailable.')
    await this.persist({ ...vault, accounts: vault.accounts.map(a => a.id === id ? { ...a, syncWorkspace: input.enabled ? key : undefined, includeSubjects: input.includeSubjects === true, gmailProgress: a.gmailProgress ? { ...a.gmailProgress, includeSubject: input.includeSubjects === true } : undefined, autoSyncAt: undefined, autoSyncError: undefined } : a) }, this.epoch, current)
    return { ok: true }
  }
  async autoSync() {
    if (this.syncRunning) return { changed: false }
    this.syncRunning = true
    try {
      const current = this.guard(), key = this.workspaceKey(), ids = (await this.load()).accounts.map(a => a.id)
      let changed = false
      for (const accountId of ids) {
        current()
        const a = await this.account(accountId)
        if (!a.tokens || !key || a.syncWorkspace !== key || a.autoSyncError || this.gmailBusy.has(accountId) || (a.autoSyncAt ?? -Infinity) > this.now() - 15 * 60000) continue
        let problem = ''
        try {
          if (a.capabilities.includes('contacts')) { await this.contacts({ accountId }); changed = true }
          current()
          if (a.capabilities.includes('gmail') && (await this.account(accountId)).syncWorkspace === key) {
            const result = await this.gmail({ accountId, limit: 50, includeSubject: a.includeSubjects }) as { errors: string[]; retryAt?: number; partial?: boolean }
            changed = true
            problem = result.errors.find(message => !message.startsWith('Progress was saved.')) ?? ''
          }
        } catch (error) { problem = error instanceof CrmConnectionError ? error.message : 'Discovery was interrupted. Review the account and resume sync.' }
        const vault = await this.load(); current()
        if (vault.accounts.find(row => row.id === accountId)?.syncWorkspace !== key) continue
        await this.persist({ ...vault, accounts: vault.accounts.map(row => row.id === accountId ? { ...row, autoSyncAt: this.now(), autoSyncError: problem } : row) }, this.epoch, current)
        changed = true
      }
      return { changed }
    } finally { this.syncRunning = false }
  }
  async status(): Promise<CrmConnectionsStatus> { const vault = await this.load(); return { available: true, accounts: vault.accounts.map((account) => ({ id: account.id, label: account.label, email: account.email ?? null, configured: true, connected: !!account.tokens, autoSync: !!account.syncWorkspace && account.syncWorkspace === this.workspaceKey(), includeSubjects: account.includeSubjects === true, autoSyncError: account.autoSyncError, capabilities: account.capabilities, scopes: account.scopes, connectedAt: account.connectedAt ?? null, lastSyncAt: account.lastSyncAt ?? null, ...(account.capabilities.includes('gmail') ? { gmailSync: { pendingMessages: account.gmailProgress?.pendingIds?.length ?? 0, hasMore: !!account.gmailProgress && (!account.gmailProgress.listComplete || !!account.gmailProgress.pendingIds?.length), retryAt: account.gmailProgress?.retryAt ?? null } } : {}) })), driveClientAvailable: !!await this.driveConfig(), aiRequired: false, happenstance: { configured: !!vault.happenstanceKey, automaticResearch: false, mcpUrl: 'https://happenstance.ai/mcp' }, folk: { configured: !!vault.folkKey } } }
  async configure(input: Record<string, unknown>) {
    const current = this.guard(), capabilities = validCapabilities(input.capabilities); check(capabilities.length, 'Choose at least one account capability.'); check(str(input.label, 200).trim(), 'Give this account a label.')
    let client: ClientConfig | null = null
    if (input.reuseDriveClient === true) client = await this.driveConfig()
    else { const raw = object(input.oauthClient) ? input.oauthClient : {}, installed = object(raw.installed) ? raw.installed : raw; check(!object(raw.web), 'Use a Desktop OAuth client JSON for this local connection.'); if (typeof installed.client_id === 'string') client = { clientId: installed.client_id, ...(typeof installed.client_secret === 'string' ? { clientSecret: installed.client_secret } : {}) } }
    current(); check(client && /^[\w.-]+\.apps\.googleusercontent\.com$/.test(client.clientId) && client.clientId.length < 1000 && (!client.clientSecret || client.clientSecret.length < 4000), 'Choose a valid Desktop OAuth client JSON, or explicitly reuse your existing local client configuration.')
    const vault = await this.load(), id = str(input.accountId, 200) || randomUUID(), previous = vault.accounts.find((item) => item.id === id); check(previous || !input.accountId, 'This configured account no longer exists.', 404); check(vault.accounts.length < 20 || previous, 'Configure at most twenty accounts.')
    this.epoch++; this.sessions.clear(); this.preparations.clear(); await this.persist({ ...vault, accounts: [...vault.accounts.filter((item) => item.id !== id), { id, label: str(input.label, 200).trim(), ...(previous?.subject ? { subject: previous.subject, email: previous.email } : {}), client: client!, capabilities, scopes: [...IDENTITY_SCOPES, ...capabilities.flatMap((item) => CRM_GOOGLE_SCOPES[item])] }] }); return { accountId: id, ...await this.status() }
  }
  async connect(accountId: string, origin: string) {
    this.guard()(); const account = await this.account(accountId), base = new URL(origin); check(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Connect from the local Worldview app.', 403); if (base.hostname === 'localhost') base.hostname = '127.0.0.1'
    for (const [key, value] of this.sessions) if (value.expiresAt < this.now()) this.sessions.delete(key)
    check(this.sessions.size < 8, 'Finish an existing sign-in before starting another.', 409)
    const nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url'), redirect = `${base.origin}/api/crm/connections/google/callback`, expiresAt = this.now() + 600000
    this.sessions.set(nonce, { accountId, verifier, redirect, origin, epoch: this.epoch, generation: this.options.db.getReplacementGeneration(), expiresAt })
    const params = new URLSearchParams({ client_id: account.client.clientId, redirect_uri: redirect, response_type: 'code', scope: account.scopes.join(' '), access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false', state: nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }); return { authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, expiresAt }
  }
  async callback(url: URL, origin: string) {
    const nonce = url.searchParams.get('state') ?? '', session = this.sessions.get(nonce); check(session && session.expiresAt >= this.now() && session.epoch === this.epoch && session.generation === this.options.db.getReplacementGeneration() && new URL(session.redirect).origin === origin && !this.options.db.getKv('importInProgress'), 'This Google sign-in expired. Start again from Connections.', 403); this.sessions.delete(nonce)
    if (url.searchParams.has('error')) return `${session!.origin}/#/people?connections=google-cancelled`
    const code = url.searchParams.get('code'); check(code && code.length < 10000, 'Google did not return an authorization code.')
    const current = this.guard(), epoch = this.epoch, account = await this.account(session!.accountId), body = new URLSearchParams({ grant_type: 'authorization_code', code: code!, client_id: account.client.clientId, redirect_uri: session!.redirect, code_verifier: session!.verifier }); if (account.client.clientSecret) body.set('client_secret', account.client.clientSecret)
    const response = await this.rawFetch('https://oauth2.googleapis.com/token', { method: 'POST', body }); current(); check(response.ok, 'Google could not connect. Personal mode clients only authorize their creator account; use another account’s own client JSON if needed.', 401)
    const value = await response.json() as Record<string, unknown>; current(); check(typeof value.access_token === 'string' && value.access_token.length < 10000, 'Google did not return a valid access token.', 502); if (typeof value.scope === 'string') this.validateScopes(value.scope, account.scopes)
    const identityResponse = await this.rawFetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${value.access_token}` } }); current(); check(identityResponse.ok, 'Google account identity could not be verified.', 502)
    const identity = await identityResponse.json() as Record<string, unknown>; current(); check(typeof identity.sub === 'string' && typeof identity.email === 'string' && identity.email_verified === true, 'Google did not verify this account identity.', 403)
    check(!account.subject || account.subject === identity.sub, 'This sign-in is a different Google account. Configure it separately.', 409)
    const vault = await this.load(), updated: PrivateAccount = { ...account, email: str(identity.email, 320), subject: str(identity.sub, 1000), tokens: { access: str(value.access_token), ...(typeof value.refresh_token === 'string' ? { refresh: value.refresh_token } : {}), expiresAt: this.now() + Math.max(60, Math.min(86400, Number(value.expires_in) || 3600)) * 1000 }, connectedAt: this.now() }; current(); await this.persist({ ...vault, accounts: vault.accounts.map((item) => item.id === account.id ? updated : item) }, epoch, current); current(); return `${session!.origin}/#/people?connections=google-connected`
  }
  async disconnect(accountId: string) { const vault = await this.load(); check(vault.accounts.some((item) => item.id === accountId), 'Account not found.', 404); this.epoch++; this.sessions.clear(); this.preparations.clear(); await this.persist({ ...vault, accounts: vault.accounts.map((account) => account.id === accountId ? { ...account, tokens: undefined, connectedAt: undefined, syncWorkspace: undefined, autoSyncError: undefined, gmailHistoryId: undefined, gmailProgress: undefined, contactsSyncToken: undefined, otherContactsSyncToken: undefined } : account) }); return { ok: true, message: 'Disconnected locally. You can revoke Google account access separately. Retained CRM records remain available.' } }
  async calendars(accountId: string) { const account = await this.account(accountId, 'calendar'), calendars: CrmCalendar[] = []; let pageToken = ''
    for (let page = 0; page < 20; page++) { const result = await this.google(account, `https://www.googleapis.com/calendar/v3/users/me/calendarList?${new URLSearchParams({ maxResults: '250', ...(pageToken ? { pageToken } : {}) })}`); for (const value of Array.isArray(result.items) ? result.items : []) if (object(value) && !value.deleted) calendars.push({ id: str(value.id), summary: str(value.summary, 1000), primary: value.primary === true, selected: value.selected === true, timeZone: str(value.timeZone), accessRole: str(value.accessRole) }); pageToken = str(result.nextPageToken); if (!pageToken) break }
    return { calendars, complete: !pageToken }
  }
  private cleanEvent(raw: Record<string, unknown>, accountId: string, calendarId: string): CrmCalendarEvent { const start = object(raw.start) ? raw.start : {}, end = object(raw.end) ? raw.end : {}, original = object(raw.originalStartTime) ? raw.originalStartTime : {}, organizer = object(raw.organizer) ? raw.organizer : {}, time = (value: unknown) => { const date = Date.parse(str(value)); return Number.isFinite(date) ? date : null }; return { id: str(raw.id, 1024), accountId, calendarId, iCalUID: str(raw.iCalUID), title: str(raw.summary, 2000) || 'Calendar event', body: str(raw.description, 30000), status: str(raw.status, 100), startAt: time(start.dateTime ?? start.date), endAt: time(end.dateTime ?? end.date), timezone: str(start.timeZone ?? end.timeZone), allDay: !!start.date && !start.dateTime, htmlLink: crmUrl(raw.htmlLink), attendees: (Array.isArray(raw.attendees) ? raw.attendees : []).filter(object).map((item) => ({ email: crmEmail(item.email), name: str(item.displayName, 1000), responseStatus: str(item.responseStatus), self: item.self === true, organizer: item.organizer === true })), organizer: { email: crmEmail(organizer.email), name: str(organizer.displayName, 1000) }, updated: str(raw.updated), originalStartTime: str(original.dateTime ?? original.date), raw: jsonValue(raw) } }
  async events(input: Record<string, unknown>) { const accountId = str(input.accountId), calendarId = str(input.calendarId), account = await this.account(accountId, 'calendar'); check(calendarId && calendarId.length < 1024, 'Choose a calendar.'); const min = Date.parse(str(input.timeMin)), max = Date.parse(str(input.timeMax)); check(Number.isFinite(min) && Number.isFinite(max) && max > min && max - min <= 370 * 86400000, 'Choose an event window up to one year.'); const pageToken = str(input.pageToken, 4000), params = new URLSearchParams({ singleEvents: 'true', showDeleted: 'true', maxResults: '100', timeMin: new Date(min).toISOString(), timeMax: new Date(max).toISOString(), ...(pageToken ? { pageToken } : {}) }); const result = await this.google(account, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`); return { events: (Array.isArray(result.items) ? result.items : []).filter(object).map((raw) => this.cleanEvent(raw, accountId, calendarId)), nextPageToken: str(result.nextPageToken) || null, timeZone: str(result.timeZone), attendanceConfirmed: false } }
  async venues(input: Record<string, unknown>) {
    const page = await this.events(input)
    const venues = page.events.flatMap(event => {
      if (event.status === 'cancelled' || !object(event.raw)) return []
      const location = str(event.raw.location, 4000).trim()
      if (!location || /^https?:\/\/(?:meet\.google\.com|(?:[a-z0-9-]+\.)?zoom\.us|teams\.microsoft\.com)(?:\/|$)/i.test(location)) return []
      const links = (event.body + ' ' + location).match(/https?:\/\/[^\s<>"']+/ig) ?? []
      const hosts = links.flatMap(link => { try { return [new URL(link).hostname.toLowerCase()] } catch { return [] } })
      const domains = [...hosts, (event.organizer.email.split('@')[1] || '').toLowerCase()]
      const matches = (names: string[]) => domains.some(domain => names.some(name => domain === name || domain.endsWith('.' + name)))
      const provider = matches(['lu.ma', 'luma.com']) ? 'luma' : matches(['partiful.com']) ? 'partiful' : 'calendar'
      return [{ id: event.id, title: event.title, location, startAt: event.startAt, endAt: event.endAt, htmlLink: event.htmlLink, provider }]
    })
    return { venues, nextPageToken: page.nextPageToken }
  }
  private async retain(bytes: Uint8Array) { const current = this.guard(), hash = `crm-file-${crmHash(bytes)}`, path = join(this.options.blobDir, hash); await mkdir(this.options.blobDir, { recursive: true }); current(); try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const stat = await file.stat(); check(stat.isFile() && stat.size === bytes.length && crmHash(await file.readFile()) === crmHash(bytes), 'A retained original is damaged. Restore it before importing this source again.', 409) } finally { await file.close() } } current(); this.options.db.putAssetMeta({ id: hash, kind: 'file', mime: 'application/octet-stream', bytes: bytes.length, createdAt: this.now(), nodeId: null }); return hash }
  private async stage(batch: CrmConnectorBatch) { this.guard()(); check(this.options.stageBatch, 'The CRM review store is unavailable.', 503); const result = await this.options.stageBatch!(batch); return { staged: batch.candidates.length, counts: batch.counts, errors: batch.errors, result } }
  async stageEvent(input: Record<string, unknown>) { const current = this.guard(), accountId = str(input.accountId), calendarId = str(input.calendarId), id = str(input.eventId, 1024), account = await this.account(accountId, 'calendar'); check(id && calendarId, 'Choose a calendar event.'); const raw = await this.google(account, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`), event = this.cleanEvent(raw, accountId, calendarId), originalAssetId = await this.retain(Buffer.from(JSON.stringify(raw))), candidates = []
    const externalId = `${calendarId}:${event.id}`, payload = { title: event.title, type: 'event', status: event.status === 'cancelled' ? 'cancelled' : 'scheduled', body: event.body, personIds: strings(input.personIds, 100), companyIds: [], startAt: event.startAt, endAt: event.endAt, occurredAt: null, timezone: event.timezone, allDay: event.allDay, attendanceConfirmed: false, attachmentAssetIds: [], calendarEvent: event }
    candidates.push(connectorCandidate('google-calendar', accountId, externalId, payload, event.raw, originalAssetId, this.now(), 'interaction'))
    if (input.includeAttendees === true && event.status !== 'cancelled') for (const attendee of event.attendees) if (attendee.email && !attendee.self && attendee.responseStatus !== 'declined') candidates.push(connectorCandidate('google-calendar', accountId, `${externalId}:attendee:${attendee.email}`, { ...crmPerson(attendee.name, attendee.email), calendarContext: { eventId: event.id, title: event.title, responseStatus: attendee.responseStatus, attendanceConfirmed: false } }, jsonValue(attendee), originalAssetId, this.now()))
    current(); return this.stage({ provider: 'google-calendar', accountId, name: event.title, originalAssetIds: [originalAssetId], candidates, counts: { events: 1, candidates: candidates.length }, errors: [] })
  }
  async contacts(input: Record<string, unknown>): Promise<unknown> { const operationCurrent = this.guard(), accountId = str(input.accountId), other = input.otherContacts === true, capability = other ? 'otherContacts' : 'contacts', account = await this.account(accountId, capability), cursorField = other ? 'otherContactsSyncToken' : 'contactsSyncToken', params = new URLSearchParams({ pageSize: '500', requestSyncToken: 'true', ...(other ? { readMask: 'names,emailAddresses,phoneNumbers,metadata' } : { personFields: 'names,emailAddresses,phoneNumbers,organizations,urls,biographies,addresses,photos,metadata' }) }), syncToken = input.reset !== true && (other || account.contactsFormat === 2) ? account[cursorField] : undefined; if (syncToken) params.set('syncToken', syncToken)
    const rawRows: Record<string, unknown>[] = []; let token = '', nextSyncToken = '', complete = false
    for (let page = 0; page < 20; page++) { if (token) params.set('pageToken', token); let result: Record<string, unknown>; try { result = await this.google(account, `https://people.googleapis.com/v1/${other ? 'otherContacts' : 'people/me/connections'}?${params}`) } catch (error) { if (syncToken && error instanceof CrmConnectionError && (error.status === 410 || error.status === 400)) return this.contacts({ ...input, reset: true }); throw error } rawRows.push(...(Array.isArray(result[other ? 'otherContacts' : 'connections']) ? result[other ? 'otherContacts' : 'connections'] as unknown[] : []).filter(object)); token = str(result.nextPageToken); nextSyncToken = str(result.nextSyncToken); if (!token) { complete = true; break } }
    check(complete, 'This address book exceeds 10,000 records. Use a contact export to preserve complete coverage.', 413)
    operationCurrent(); const originalAssetId = await this.retain(Buffer.from(JSON.stringify(rawRows))), provider = other ? 'google-other-contacts' : 'google-contacts', candidates = rawRows.filter((raw) => !object(raw.metadata) || raw.metadata.deleted !== true).map((raw) => { const list = (key: string) => (Array.isArray(raw[key]) ? raw[key] as unknown[] : []).filter(object), names = list('names'), emails = list('emailAddresses').map((entry) => crmEmail(entry.value)).filter(Boolean), payload = { ...crmPerson(str(names[0]?.displayName, 1000), emails[0] ?? ''), firstName: str(names[0]?.givenName, 1000), lastName: str(names[0]?.familyName, 1000), emails, phones: list('phoneNumbers').map((entry) => str(entry.value, 100)), urls: list('urls').map((entry) => crmUrl(entry.value)).filter(Boolean), ...googleContactDetails(raw, { provider, accountId, externalId: str(raw.resourceName) }), description: str(list('biographies')[0]?.value, 30000), photos: list('photos').filter(entry => entry.default !== true).map(entry => ({ url: crmUrl(entry.url), default: false })).filter(entry => entry.url) }; return connectorCandidate(provider, accountId, str(raw.resourceName), payload, jsonValue(raw), originalAssetId, this.now()) })
    operationCurrent(); const result = await this.stage({ provider, accountId, name: `${account.label} ${other ? 'Other contacts' : 'contacts'}`, originalAssetIds: [originalAssetId], candidates, counts: { records: rawRows.length, candidates: candidates.length, deleted: rawRows.length - candidates.length }, errors: [] }); operationCurrent(); const vault = await this.load(); await this.persist({ ...vault, accounts: vault.accounts.map((item) => item.id === accountId ? { ...item, ...(nextSyncToken ? { [cursorField]: nextSyncToken } : {}), ...(!other ? { contactsFormat: 2 } : {}), lastSyncAt: this.now() } : item) }); operationCurrent(); return result
  }
  async gmail(input: Record<string, unknown>): Promise<unknown> {
    const accountId = str(input.accountId); check(!this.gmailBusy.has(accountId), 'Email discovery is already running for this account. Wait for its current checkpoint.', 409)
    this.gmailBusy.add(accountId)
    try { return await this.gmailPass(input) } finally { this.gmailBusy.delete(accountId) }
  }
  private async gmailPass(input: Record<string, unknown>): Promise<unknown> {
    const current = this.guard(), accountId = str(input.accountId), account = await this.account(accountId, 'gmail')
    const ownEmails = (await this.load()).accounts.map(row => crmEmail(row.email)).filter(Boolean); current()
    const prior = input.reset === true ? undefined : account.gmailProgress, limit = Math.max(1, Math.min(100, Math.floor(Number(input.limit) || 50))), progress: GmailProgress = prior ? structuredClone(prior) : { mode: input.reset === true || !account.gmailHistoryId ? 'messages' : 'history', pageToken: '', historyId: account.gmailHistoryId ?? '', baselineHistoryId: '', labelIds: strings(input.labelIds, 20), pendingIds: [], listComplete: false, retryAt: null, includeSubject: input.includeSubject === true || account.includeSubjects === true }
    progress.pendingIds = strings(progress.pendingIds, 10000); progress.listComplete ??= false; progress.includeSubject ??= input.includeSubject === true
    const errors: string[] = [], results: unknown[] = [], seen = new Set<string>(ownEmails), buffer: { id: string; record: Record<string, unknown> }[] = []
    let messages = 0, staged = 0, skipped = 0, pages = 0
    const checkpoint = async () => { current(); const vault = await this.load(); current(); await this.persist({ ...vault, accounts: vault.accounts.map((item) => item.id === accountId ? { ...item, gmailProgress: structuredClone(progress) } : item) }, this.epoch, current); current() }
    const finish = async () => {
      const complete = progress.listComplete === true && !progress.pendingIds!.length, retryAt = progress.retryAt && progress.retryAt > this.now() ? progress.retryAt : null
      if (complete) { const vault = await this.load(); current(); await this.persist({ ...vault, accounts: vault.accounts.map((item) => item.id === accountId ? { ...item, gmailHistoryId: progress.baselineHistoryId, gmailProgress: undefined, lastSyncAt: this.now() } : item) }, this.epoch, current) }
      if (!complete && !errors.length) errors.push('Progress was saved. Choose Continue email discovery to read the next small batch. No message body was downloaded.')
      return { staged, counts: { messages, candidates: staged, skipped, pages, complete: complete ? 1 : 0, pendingMessages: progress.pendingIds!.length }, errors, results, partial: !complete, resumable: !complete, completed: complete, retryAt }
    }
    if (progress.retryAt && progress.retryAt > this.now()) { errors.push(`Google quota is paused until ${new Date(progress.retryAt).toISOString()}. Saved messages are safe; resume explicitly after that time.`); return finish() }
    progress.retryAt = null
    const flush = async () => {
      if (!buffer.length) return
      current(); const records = buffer.map((item) => item.record), originalAssetId = await this.retain(Buffer.from(JSON.stringify(records))); current()
      const candidates = []
      for (const item of buffer) { const headers = item.record.headers as { name: string; value: string }[]
        for (const contact of parseCrmEmailHeaders(headers.filter((header) => /^(from|to|cc)$/i.test(header.name)).map((header) => `${header.name}: ${header.value}`).join('\n'))) if (!seen.has(contact.email)) {
          seen.add(contact.email)
          const known = this.options.db.db.prepare("SELECT 1 FROM crm_sources WHERE collection='candidates' AND provider='gmail-headers' AND account_id=? AND external_id=? LIMIT 1").get(accountId, contact.email)
          if (known) continue
          candidates.push(connectorCandidate('gmail-headers', accountId, contact.email, { ...crmPerson(contact.name, contact.email), emailContext: { messageId: item.id, date: item.record.internalDate } }, jsonValue(item.record), originalAssetId, this.now())) }
      }
      current(); const result = await this.stage({ provider: 'gmail-headers', accountId, name: `${account.label} email participants`, originalAssetIds: [originalAssetId], candidates, counts: { messages: buffer.length, candidates: candidates.length }, errors: [] }); current(); results.push(result); staged += candidates.length; messages += buffer.length
      const completed = new Set(buffer.map((item) => item.id)); progress.pendingIds = progress.pendingIds!.filter((id) => !completed.has(id)); buffer.length = 0; await checkpoint()
    }
    const pause = async (error: unknown) => {
      current(); await flush(); current()
      if (error instanceof CrmConnectionError && error.rateLimited) { progress.retryAt = error.retryAt ?? this.now() + 60000; errors.push(`${error.message} Completed metadata was retained and staged. Resume after ${new Date(progress.retryAt).toISOString()}.`) }
      else errors.push(error instanceof CrmConnectionError ? error.message : 'Google temporarily stopped this metadata read. Completed messages were saved; resume discovery to continue.')
      await checkpoint(); return finish()
    }
    if (!progress.baselineHistoryId) { try { const profile = await this.gmailRead(account, 'https://www.googleapis.com/gmail/v1/users/me/profile', current); progress.baselineHistoryId = str(profile.historyId); check(progress.baselineHistoryId, 'Google did not return an email history cursor.', 502); await checkpoint() } catch (error) { return pause(error) } }
    if (!progress.pendingIds.length && !progress.listComplete) {
      const params = new URLSearchParams({ maxResults: String(limit), ...(progress.pageToken ? { pageToken: progress.pageToken } : {}) })
      if (progress.mode === 'history') { params.set('startHistoryId', progress.historyId); params.set('historyTypes', 'messageAdded') } else for (const label of progress.labelIds) params.append('labelIds', label)
      let response: Record<string, unknown>
      try { response = await this.gmailRead(account, `https://www.googleapis.com/gmail/v1/users/me/${progress.mode === 'messages' ? 'messages' : 'history'}?${params}`, current) }
      catch (error) { if (progress.mode === 'history' && error instanceof CrmConnectionError && error.status === 404) return this.gmailPass({ ...input, reset: true }); return pause(error) }
      current(); const ids = new Set<string>()
      if (progress.mode === 'messages') for (const item of (Array.isArray(response.messages) ? response.messages : []).filter(object)) ids.add(str(item.id))
      else for (const entry of (Array.isArray(response.history) ? response.history : []).filter(object)) for (const addition of (Array.isArray(entry.messagesAdded) ? entry.messagesAdded : []).filter(object)) { const message = addition.message; if (object(message) && (!progress.labelIds.length || progress.labelIds.every((label) => strings(message.labelIds).includes(label)))) ids.add(str(message.id)) }
      check(ids.size <= 10000, 'This email history page exceeds 10,000 messages. Start a fresh bounded discovery pass.', 413)
      progress.pendingIds = [...ids].filter(Boolean); progress.pageToken = str(response.nextPageToken); progress.listComplete = !progress.pageToken; pages++; await checkpoint()
    }
    for (const id of progress.pendingIds.slice(0, limit)) {
      const params = new URLSearchParams({ format: 'metadata' }); for (const name of ['From', 'To', 'Cc', 'Date', 'Message-ID', 'List-ID', 'Auto-Submitted', 'Precedence', ...(progress.includeSubject ? ['Subject'] : [])]) params.append('metadataHeaders', name)
      let raw: Record<string, unknown>
      try { raw = await this.gmailRead(account, `https://www.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?${params}`, current) }
      catch (error) { if (error instanceof CrmConnectionError && error.status === 404) { skipped++; progress.pendingIds = progress.pendingIds.filter((item) => item !== id); await checkpoint(); continue } return pause(error) }
      current(); const payload = object(raw.payload) ? raw.payload : {}, headers = (Array.isArray(payload.headers) ? payload.headers : []).filter(object).filter(entry => ['from', 'to', 'cc', 'date', 'message-id', 'list-id', 'auto-submitted', 'precedence', ...(progress.includeSubject ? ['subject'] : [])].includes(str(entry.name).toLowerCase())).map((entry) => ({ name: str(entry.name), value: str(entry.value, 30000) }))
      buffer.push({ id, record: { id, accountEmail: account.email || '', threadId: str(raw.threadId), historyId: str(raw.historyId), internalDate: str(raw.internalDate), labelIds: strings(raw.labelIds), headers } })
      if (buffer.length >= 5) await flush()
    }
    await flush(); current(); return finish()
  }
  private fileInput(input: Record<string, unknown>) { const name = str(input.name, 1000); check(name && /\.(csv|vcf|ics|eml)$/i.test(name), 'Choose a CSV, vCard, ICS or EML file.'); const encoded = str(input.base64, 18 * 1024 * 1024); check(encoded && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded) && encoded.length % 4 === 0, 'The import file encoding is invalid.'); const bytes = Buffer.from(encoded, 'base64'); check(bytes.length <= 12 * 1024 * 1024, 'Choose a file up to 12 MiB.', 413); return { name, bytes, provider: str(input.provider, 100) || 'file', accountId: str(input.accountId, 300) || 'local-import', mapping: object(input.mapping) ? input.mapping as CrmImportMapping : undefined } }
  async previewImport(input: Record<string, unknown>) { const file = this.fileInput(input); return previewCrmImport(file.name, file.bytes, file.provider, file.mapping).preview }
  async stageImport(input: Record<string, unknown>) { const current = this.guard(), file = this.fileInput(input), batch = batchCrmImport(file.name, file.bytes, file.provider, file.accountId, this.now(), file.mapping); check(input.expectedHash === crmHash(file.bytes), 'The selected file changed. Preview this original again.', 409); await this.retain(file.bytes); current(); return this.stage(batch) }
  capturedSources(): { sources: CrmCapturedContactSource[]; total: number } { const knowledge = this.options.db.getKv<KnowledgeSnapshot>('knowledge.v1'), sources: CrmCapturedContactSource[] = []; for (const source of knowledge?.sources ?? []) { if (source.excluded || source.deleted) continue; const version = knowledge?.versions.find((item) => item.id === source.currentVersionId); if (!version || version.originalPurged || !/^knowledge-[a-f0-9]{64}$/.test(version.originalBlobId) || !this.options.db.getAssetMeta(version.originalBlobId)) continue; const metadata = object(version.metadata) ? version.metadata : {}, provider = source.externalId?.startsWith('google-drive:') ? 'google-drive' : metadata.captureMethod === 'browser-extension' || metadata.format === 'article' && version.origin === 'capture' ? 'website-reader' : null; if (provider) sources.push({ id: source.id, title: source.title, url: crmUrl(metadata.url ?? metadata.googleDriveUrl ?? metadata.webViewLink), provider, currentVersionId: version.id }) } return { sources: sources.slice(0, 2000), total: sources.length } }
  private capturedSource(input: Record<string, unknown>) { const selected = this.capturedSources().sources.find((source) => source.id === input.sourceId); check(selected, 'Choose a retained Drive import or Reader capture from this workspace.', 404); check(selected!.currentVersionId === input.expectedVersionId, 'This captured source changed. Select its latest version again.', 409); const knowledge = this.options.db.getKv<KnowledgeSnapshot>('knowledge.v1'), version = knowledge?.versions.find((item) => item.id === selected!.currentVersionId); check(version && version.originalBlobId && !version.originalPurged && this.options.db.getAssetMeta(version.originalBlobId), 'This captured source has no retained original.', 409); check(version?.contentHash === crmHash(version?.text ?? ''), 'The retained source text changed. Capture or import this source again.', 409); return { selected: selected!, version: version! } }
  async stageCapturedSource(input: Record<string, unknown>, profile = false) { const current = this.guard(), { selected, version } = this.capturedSource(input), provider = selected.provider === 'google-drive' ? 'drive-selected-source' : 'reader-selected-source', accountId = 'local-selected-source', originalAssetId = version.originalBlobId!, emails = [...new Set([...version.text.matchAll(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((match) => crmEmail(match[0])).filter(Boolean))]; check(emails.length <= 300, 'This document has more than 300 email addresses. Import a mapped contact export instead.', 413); const sourceRef = { provider, accountId, externalId: selected.id, version: version.id, originalAssetId, observedAt: this.now(), ...(selected.url ? { url: selected.url } : {}) }, candidates = []
    if (profile) { check(selected.provider === 'website-reader', 'Choose a captured website or LinkedIn profile for this action.'); const name = str(input.fullName, 1000).trim(); check(name, 'Enter the person’s name before staging this profile.'); const email = str(input.email, 320).trim(); check(!email || !!crmEmail(email), 'Enter a valid email or leave it empty.'); check(!email || emails.includes(crmEmail(email)), 'That email is not in the captured page. Add personal knowledge directly to the contact after review.'); const payload = { ...crmPerson(name, email ? crmEmail(email) : '', '', selected.url), profileClipSourceId: selected.id }; candidates.push(connectorCandidate(provider, accountId, `${selected.id}:profile`, payload, { sourceId: selected.id, sourceVersionId: version.id, userEnteredName: name }, originalAssetId, this.now())) }
    else for (const email of emails) { const index = version.text.toLowerCase().indexOf(email), excerpt = version.text.slice(Math.max(0, index - 100), index + email.length + 100); const candidate = connectorCandidate(provider, accountId, `${selected.id}:email:${email}`, crmPerson('', email), { email, sourceId: selected.id, sourceVersionId: version.id, excerpt }, originalAssetId, this.now()); candidate.evidence = [{ label: 'Email found in your explicitly selected retained source; identity requires review', sourceId: selected.id, sourceRef, excerpt, ...(selected.url ? { url: selected.url } : {}) }]; candidates.push(candidate) }
    for (const candidate of candidates) candidate.sourceRefs = [{ ...sourceRef, externalId: candidate.externalId }]
    current(); check(this.capturedSource(input).version.id === version.id, 'The source changed. Review it again.', 409); return this.stage({ provider, accountId, name: `Selected source: ${selected.title}`, originalAssetIds: [originalAssetId], candidates, counts: { sources: 1, candidates: candidates.length }, errors: candidates.length ? [] : ['No exact email addresses were found. No contact was guessed.'] })
  }
  async configureHappenstance(input: Record<string, unknown>) { this.guard()(); check(input.remove === true || typeof input.apiKey === 'string' && input.apiKey.length >= 10 && input.apiKey.length <= 10000, 'Enter a Happenstance API key locally.'); const vault = await this.load(); this.epoch++; this.sessions.clear(); this.preparations.clear(); await this.persist({ ...vault, happenstanceKey: input.remove === true ? undefined : str(input.apiKey) }); return this.status() }
  async configureFolk(input: Record<string, unknown>) { this.guard()(); check(input.remove === true || typeof input.apiKey === 'string' && input.apiKey.length >= 10 && input.apiKey.length <= 10000, 'Enter a Folk API key locally.'); const vault = await this.load(); this.epoch++; this.sessions.clear(); this.preparations.clear(); await this.persist({ ...vault, folkKey: input.remove === true ? undefined : str(input.apiKey) }); return this.status() }
  async folkInteractions(input: Record<string, unknown>) {
    const current = this.guard(), vault = await this.load(); check(vault.folkKey, 'Enter your optional Folk API key to retrieve original interaction lists.', 401)
    const snapshot = this.options.db.crm.portableSnapshot(), people = snapshot?.people ?? [], companies = snapshot?.companies ?? [], entities = [...people, ...companies].flatMap((record) => record.sourceRefs.filter((ref) => ref.provider === 'folk').map((ref) => ({ localId: record.id, externalId: ref.externalId, accountId: ref.accountId }))).sort((a, b) => `${a.accountId}:${a.externalId}`.localeCompare(`${b.accountId}:${b.externalId}`)), unique = [...new Map(entities.map((entity) => [`${entity.accountId}:${entity.externalId}`, entity])).values()], offset = Number(input.offset ?? 0); check(Number.isSafeInteger(offset) && offset >= 0, 'Choose a valid interaction import offset.'); const selected = unique.slice(offset, offset + 10), originalRows: Record<string, unknown>[] = [], errors: string[] = [], results: unknown[] = []
    for (const entity of selected) { const interactions: unknown[] = []; for (const timeframe of ['past', 'upcoming']) { let url = `https://api.folk.app/v1/interactions?${new URLSearchParams({ 'entity.id': entity.externalId, timeframe })}`; let complete = false
        for (let page = 0; page < 30; page++) { const parsed = new URL(url, 'https://api.folk.app'); check(parsed.origin === 'https://api.folk.app' && parsed.pathname === '/v1/interactions' && !parsed.username && !parsed.password && parsed.searchParams.get('entity.id') === entity.externalId && parsed.searchParams.get('timeframe') === timeframe, 'Folk returned an unsafe pagination link.', 502); current(); const response = await this.rawFetch(parsed.href, { headers: { authorization: `Bearer ${vault.folkKey}` } }); current(); check(response.ok, `Folk could not read the interaction list (HTTP ${response.status}). No remote record was changed.`, [400, 401, 403, 429].includes(response.status) ? response.status : 502); const value: unknown = await response.json(); current(); check(object(value) && object(value.data) && Array.isArray(value.data.items), 'Folk returned an invalid interaction list.', 502); const data = (value as { data: Record<string, unknown> }).data; originalRows.push({ entity: entity.externalId, timeframe, response: jsonValue(value) }); for (const interaction of data.items as unknown[]) interactions.push({ interaction, historyKind: timeframe }); const pagination = object(data.pagination) ? data.pagination : {}; const next = str(pagination.nextLink); if (!next) { complete = true; break } url = new URL(next, parsed).href }
        if (!complete) errors.push(`An interaction list reached its 30-page limit; the retained original is partial.`)
      }
      const originalAssetId = await this.retain(Buffer.from(JSON.stringify(originalRows))), normalized = normalizeFolkExport({ accountId: entity.accountId, capturedAt: this.now(), people: [], companies: [], groups: [], interactions }), candidates = normalized.snapshot.interactions.map((interaction) => { const refs = interaction.sourceRefs.map((ref) => ({ ...ref, originalAssetId })), mappedPeople = interaction.personIds.map((id) => entities.find((item) => item.externalId === id && item.accountId === entity.accountId)?.localId).filter((id): id is string => !!id && people.some((person) => person.id === id)), mappedCompanies = interaction.companyIds.map((id) => entities.find((item) => item.externalId === id && item.accountId === entity.accountId)?.localId).filter((id): id is string => !!id && companies.some((company) => company.id === id)), candidate = connectorCandidate('folk', entity.accountId, interaction.sourceRefs[0]?.externalId || interaction.id, { ...interaction, personIds: mappedPeople, companyIds: mappedCompanies, sourceRefs: refs }, interaction.raw ?? null, originalAssetId, this.now(), 'interaction'); candidate.sourceRefs = refs; candidate.payload = Object.fromEntries(Object.entries(candidate.payload).filter(([key]) => !['id', 'revision', 'createdAt', 'updatedAt', 'archivedAt'].includes(key))); const existing = refs.flatMap((ref) => this.options.db.crm.findBySource('interactions', ref)); if (existing.length === 1) { candidate.kind = 'update'; candidate.targetId = existing[0].id; candidate.confidence = 'exact'; candidate.payload = { collection: 'interactions', patch: candidate.payload } } return candidate }); current(); results.push(await this.stage({ provider: 'folk', accountId: entity.accountId, name: 'Original Folk interaction lists', originalAssetIds: [originalAssetId], candidates, counts: { entities: 1, interactions: interactions.length, candidates: candidates.length }, errors }))
    }
    return { processed: selected.length, total: unique.length, nextOffset: offset + selected.length < unique.length ? offset + selected.length : null, results, errors, remoteWrites: false }
  }
  async happenstance(input: Record<string, unknown>) { const vault = await this.load(); check(vault.happenstanceKey, 'Configure an optional Happenstance API key first.', 401); const kind = str(input.kind), id = str(input.id, 300); check(['credits', 'groups', 'search', 'research'].includes(kind), 'Choose a supported Happenstance operation.'); const create = ['search', 'research'].includes(kind) && !id; check(!create || input.confirmCredits === true && str(input.text, 5000).trim(), 'Confirm the service-credit cost before starting external research.'); check(!id || /^[A-Za-z0-9_-]+$/.test(id), 'The research identifier is invalid.'); const current = this.guard(), path = kind === 'credits' ? '/v1/usage' : kind === 'groups' ? '/v1/groups' : `/v1/${kind}${id ? `/${id}` : ''}`, response = await this.rawFetch(`https://api.happenstance.ai${path}`, { method: create ? 'POST' : 'GET', headers: { authorization: `Bearer ${vault.happenstanceKey}`, ...(create ? { 'content-type': 'application/json' } : {}) }, ...(create ? { body: JSON.stringify(kind === 'search' ? { text: str(input.text, 5000), include_my_connections: true } : { description: str(input.text, 5000) }) } : {}) }); current(); check(response.ok, `Happenstance could not complete this action (HTTP ${response.status}). Check credits or authorization; no automatic retry was sent.`, response.status === 402 ? 402 : 502); return response.json() }
  async prepareSend(input: Record<string, unknown>) { const accountId = str(input.accountId), account = await this.account(accountId, 'send'); check(account.tokens, 'Connect the optional sending permission first.', 401); const to = [...new Set(strings(input.to, 51).map(crmEmail))], subject = str(input.subject, 1000), body = str(input.body, 500000); check(to.length && to.length <= 50 && to.every(Boolean) && subject.trim() && body.trim(), 'Choose at most 50 valid recipients and enter a subject and message.'); check(!/[\r\n]/.test(subject), 'The subject cannot contain line breaks.'); const digest = crmHash(JSON.stringify({ accountId, to, subject, body })), vault = await this.load(); check(!vault.outbox.some((entry) => entry.digest === digest && entry.status !== 'failed'), 'This exact message was already sent or its delivery is uncertain. Check Sent in Google before composing another.', 409); for (const [key, value] of this.preparations) if (value.expiresAt < this.now()) this.preparations.delete(key); check(this.preparations.size < 100, 'Review an existing prepared message first.'); const confirmationId = randomBytes(32).toString('base64url'), expiresAt = this.now() + 300000; this.preparations.set(confirmationId, { accountId, to, subject, body, digest, expiresAt, epoch: this.epoch, generation: this.options.db.getReplacementGeneration() }); return { confirmationId, digest, expiresAt, to, subject, accountEmail: account.email ?? null, requiresConfirmation: true } }
  async send(input: Record<string, unknown>) { const id = str(input.confirmationId, 100), draft = this.preparations.get(id); check(input.confirmed === true && draft && draft.digest === input.digest && draft.expiresAt >= this.now() && draft.epoch === this.epoch && draft.generation === this.options.db.getReplacementGeneration(), 'Review and confirm the exact message again; this confirmation expired or changed.', 409); this.preparations.delete(id); const current = this.guard(), account = await this.account(draft!.accountId, 'send'), access = await this.token(account); current(); const vault = await this.load(); check(!vault.outbox.some((entry) => entry.digest === draft!.digest && entry.status !== 'failed'), 'This delivery was already attempted. Check Google Sent before retrying.', 409); const entry: OutboxEntry = { id, digest: draft!.digest, accountId: account.id, status: 'ambiguous', attemptedAt: this.now() }; await this.persist({ ...vault, outbox: [...vault.outbox.slice(-999), entry] }); current()
    const mime = [`To: ${draft!.to.join(', ')}`, `Subject: =?UTF-8?B?${Buffer.from(draft!.subject).toString('base64')}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(draft!.body).toString('base64').match(/.{1,76}/g)!.join('\r\n')].join('\r\n')
    let response: Response; try { response = await this.rawFetch('https://www.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify({ raw: Buffer.from(mime).toString('base64url') }) }) } catch { fail('Delivery is uncertain. Check Google Sent before trying again; Worldview will not retry this message automatically.', 409) }
    current(); if (!response!.ok) { if (response!.status >= 500 || response!.status === 408) fail(`Google returned HTTP ${response!.status}; delivery is uncertain. Check Google Sent before composing another. No automatic retry was sent.`, 409); const next = await this.load(); await this.persist({ ...next, outbox: next.outbox.map((item) => item.id === id ? { ...item, status: 'failed' } : item) }); fail(`Google rejected the message (HTTP ${response!.status}). It was not marked sent.`, 502) }
    let result: unknown; try { result = await response!.json() } catch { fail('Google accepted the request but did not return a readable receipt. Check Google Sent; no automatic retry will be sent.', 409) } check(object(result) && typeof result.id === 'string' && result.id, 'Delivery is uncertain. Check Google Sent; no automatic retry will be sent.', 409); const next = await this.load(); await this.persist({ ...next, outbox: next.outbox.map((item) => item.id === id ? { ...item, status: 'sent', messageId: str((result as Record<string, unknown>).id) } : item) }); return { status: 'sent', messageId: str((result as Record<string, unknown>).id), accountId: account.id }
  }
}

async function requestBody(req: IncomingMessage) { let size = 0; const chunks: Buffer[] = []; for await (const chunk of req as AsyncIterable<Buffer>) { size += chunk.length; check(size <= 18 * 1024 * 1024, 'Connection request exceeds 18 MiB.', 413); chunks.push(chunk) } const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); check(object(value), 'Choose a valid connection action.'); return value as Record<string, unknown> }
export async function handleCrmConnectionsRequest(service: CrmConnections, req: IncomingMessage, res: ServerResponse) {
  try { const base = new URL(`http://${req.headers.host ?? ''}`); check(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'CRM connections require the local app.', 403); const url = new URL(req.url ?? '/', base), action = url.pathname.replace(/^\/api\/crm\/connections\/?/, '')
    if (action === 'google/callback' && req.method === 'GET') { const target = await service.callback(url, base.origin); res.writeHead(303, { location: target, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); return }
    check(memoryOriginAllowed(req) && !!req.headers['x-wv-client'], 'Open Connections in the local Worldview app.', 403)
    if (req.method === 'GET' && (!action || action === 'status')) return sendMemoryJson(res, 200, await service.status())
    if (req.method === 'GET' && action === 'reconnect') return sendMemoryJson(res, 200, await service.reconnect(Number(url.searchParams.get('offset') ?? '0')))
    if (req.method === 'GET' && action === 'relationship') return sendMemoryJson(res, 200, await service.relationship(url.searchParams.get('personId') ?? '', Number(url.searchParams.get('offset') ?? '0')))
    if (req.method === 'GET' && action === 'sources') return sendMemoryJson(res, 200, service.capturedSources())
    if (req.method === 'POST') { const input = await requestBody(req); let result: unknown
      switch (action) { case 'sync/preferences': result = await service.syncPreferences(input); break; case 'sync/run': result = await service.autoSync(); break; case 'google/configure': result = await service.configure(input); break; case 'google/connect': result = await service.connect(str(input.accountId), base.origin); break; case 'google/disconnect': result = await service.disconnect(str(input.accountId)); break; case 'google/calendars': result = await service.calendars(str(input.accountId)); break; case 'google/venues': result = await service.venues(input); break; case 'google/events': result = await service.events(input); break; case 'google/event/stage': result = await service.stageEvent(input); break; case 'google/contacts/sync': result = await service.contacts(input); break; case 'google/gmail/sync': result = await service.gmail(input); break; case 'import/preview': result = await service.previewImport(input); break; case 'import/stage': result = await service.stageImport(input); break; case 'source/stage': result = await service.stageCapturedSource(input); break; case 'profile/stage': result = await service.stageCapturedSource(input, true); break; case 'happenstance/configure': result = await service.configureHappenstance(input); break; case 'happenstance/request': result = await service.happenstance(input); break; case 'folk/configure': result = await service.configureFolk(input); break; case 'folk/interactions': result = await service.folkInteractions(input); break; case 'mail/prepare': result = await service.prepareSend(input); break; case 'mail/send': result = await service.send(input); break; default: fail('Choose a supported connection action.', 404) }
      return sendMemoryJson(res, 200, result)
    } return sendMemoryJson(res, 405, { error: 'Choose a supported connection action.' })
  } catch (error) { if (!res.headersSent && !res.destroyed) sendMemoryJson(res, error instanceof CrmConnectionError ? error.status : error instanceof SyntaxError ? 400 : 500, { error: error instanceof CrmConnectionError || error instanceof SyntaxError ? error.message : 'This connection action could not complete. Existing CRM records were preserved.', ...(error instanceof CrmConnectionError && error.rateLimited ? { rateLimited: true, retryAt: error.retryAt } : {}) }) }
}
