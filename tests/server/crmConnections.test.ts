import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CrmConnections, CRM_GOOGLE_SCOPES } from '../../server/crmConnections.ts'
import { batchCrmImport, crmHash, parseCrmCsv, previewCrmImport } from '../../server/crmConnectionParsers.ts'
import { SqliteCrmStore } from '../../server/crmStore.ts'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'
import type { CrmConnectorBatch, GoogleCrmCapability } from '../../src/crm/connectionTypes.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'

let directory: string, db: WorldDb, service: CrmConnections, store: SqliteCrmStore, time: number
const provider = vi.fn<typeof fetch>(), staged = vi.fn<(batch: CrmConnectorBatch) => unknown>()
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const scopes = (capabilities: GoogleCrmCapability[]) => ['openid', 'https://www.googleapis.com/auth/userinfo.email', ...capabilities.flatMap((item) => CRM_GOOGLE_SCOPES[item])].join(' ')
async function configure(capabilities: GoogleCrmCapability[] = ['calendar', 'contacts']) { return service.configure({ label: 'Synthetic account', capabilities, oauthClient: { installed: { client_id: 'synthetic.apps.googleusercontent.com', client_secret: 'SYNTHETIC_NOT_REAL' } } }) }
async function connect(capabilities: GoogleCrmCapability[] = ['calendar', 'contacts']) { const setup = await configure(capabilities), start = await service.connect(setup.accountId, 'http://127.0.0.1:5173'), authorization = new URL(start.authorizationUrl); provider.mockResolvedValueOnce(json({ access_token: 'SYNTHETIC_ACCESS', refresh_token: 'SYNTHETIC_REFRESH', expires_in: 3600, scope: scopes(capabilities) })).mockResolvedValueOnce(json({ sub: 'synthetic-user', email: 'owner@example.test', email_verified: true })); await service.callback(new URL(`http://127.0.0.1:5173/api/crm/connections/google/callback?code=synthetic&state=${authorization.searchParams.get('state')}`), 'http://127.0.0.1:5173'); provider.mockReset(); return { accountId: setup.accountId, authorization } }
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'worldview-crm-connect-')); db = openWorldDb(join(directory, 'world.sqlite')); db.putSettings({ T0: 0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: 1, schemaVersion: 1 }); time = 1000; provider.mockReset(); staged.mockReset(); store = new SqliteCrmStore(db, { now: () => time }); staged.mockImplementation((batch) => store.stageBatch(batch)); service = new CrmConnections({ db, blobDir: join(directory, 'blobs'), now: () => time, fetch: provider, delay: async () => {}, stageBatch: staged }) })
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks() })

it('starts disconnected, defaults to no sending or cloud research, and never leaks private credentials', async () => {
  expect(await service.status()).toMatchObject({ available: true, accounts: [], aiRequired: false, happenstance: { configured: false, automaticResearch: false } }); expect(provider).not.toHaveBeenCalled()
  await connect(); const status = await service.status(); expect(status.accounts[0].capabilities).toEqual(['calendar', 'contacts']); expect(status.accounts[0].scopes).not.toContain(CRM_GOOGLE_SCOPES.send[0]); const path = join(directory, 'connections', 'crm-google.private.json'); expect(statSync(path).mode & 0o777).toBe(0o600); expect(readFileSync(path, 'utf8')).toContain('SYNTHETIC_REFRESH'); expect(JSON.stringify(status)).not.toMatch(/SYNTHETIC_(ACCESS|REFRESH|NOT_REAL)/); expect(JSON.stringify(db.readWorldSnapshot(['crm.v1']))).not.toMatch(/SYNTHETIC_(ACCESS|REFRESH|NOT_REAL)/)
})
it('uses PKCE, exact user-selected scopes, verified identity and single-use state', async () => {
  const { authorization } = await connect(['gmail']); expect(authorization.searchParams.get('scope')).toBe(scopes(['gmail'])); expect(authorization.searchParams.get('include_granted_scopes')).toBe('false'); expect(authorization.searchParams.get('code_challenge_method')).toBe('S256'); expect(authorization.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5173/api/crm/connections/google/callback'); await expect(service.callback(new URL(`http://127.0.0.1:5173/api/crm/connections/google/callback?code=replay&state=${authorization.searchParams.get('state')}`), 'http://127.0.0.1:5173')).rejects.toThrow(/expired/); expect(provider).not.toHaveBeenCalled()
})
it('rejects broader or missing capabilities before saving a grant', async () => {
  const setup = await configure(['contacts']), start = new URL((await service.connect(setup.accountId, 'http://127.0.0.1:5173')).authorizationUrl); provider.mockResolvedValueOnce(json({ access_token: 'unexpected', scope: `${scopes(['contacts'])} https://www.googleapis.com/auth/drive` })); await expect(service.callback(new URL(`http://127.0.0.1:5173/api/crm/connections/google/callback?code=x&state=${start.searchParams.get('state')}`), 'http://127.0.0.1:5173')).rejects.toThrow(/different permissions/); expect((await service.status()).accounts[0].connected).toBe(false); expect(provider).toHaveBeenCalledTimes(1)
})
it('reuses only explicitly selected Drive client configuration without changing or copying the Drive grant', async () => {
  const path = join(directory, 'connections'); mkdirSync(path, { recursive: true }); const original = JSON.stringify({ schemaVersion: 1, clientType: 'desktop', clientId: 'drive-client.apps.googleusercontent.com', clientSecret: 'SYNTHETIC_CLIENT', tokens: { access: 'DRIVE_ACCESS_MUST_NOT_COPY', refresh: 'DRIVE_REFRESH_MUST_NOT_COPY' } }); writeFileSync(join(path, 'google-drive.private.json'), original)
  expect((await service.status()).driveClientAvailable).toBe(true); await service.configure({ label: 'Separate CRM', reuseDriveClient: true, capabilities: ['calendar'] }); const vault = readFileSync(join(path, 'crm-google.private.json'), 'utf8'); expect(vault).toContain('drive-client.apps.googleusercontent.com'); expect(vault).not.toMatch(/DRIVE_ACCESS|DRIVE_REFRESH|drive\.file/); expect(readFileSync(join(path, 'google-drive.private.json'), 'utf8')).toBe(original)
})
it('invalidates pending authorization when the workspace changes', async () => {
  const setup = await configure(), start = new URL((await service.connect(setup.accountId, 'http://127.0.0.1:5173')).authorizationUrl); db.wipe(); await expect(service.callback(new URL(`http://127.0.0.1:5173/api/crm/connections/google/callback?code=x&state=${start.searchParams.get('state')}`), 'http://127.0.0.1:5173')).rejects.toThrow(/expired/); expect(provider).not.toHaveBeenCalled()
})

it('keeps an established account bound to the same verified identity when permissions are reconfigured', async () => {
  const { accountId } = await connect(['contacts']); await service.configure({ accountId, label: 'Same account, new capability', capabilities: ['calendar'], oauthClient: { installed: { client_id: 'another-client.apps.googleusercontent.com' } } }); const start = new URL((await service.connect(accountId, 'http://127.0.0.1:5173')).authorizationUrl); provider.mockResolvedValueOnce(json({ access_token: 'another-grant', scope: scopes(['calendar']) })).mockResolvedValueOnce(json({ sub: 'different-account', email: 'another@example.test', email_verified: true })); await expect(service.callback(new URL(`http://127.0.0.1:5173/api/crm/connections/google/callback?code=x&state=${start.searchParams.get('state')}`), 'http://127.0.0.1:5173')).rejects.toThrow(/different Google account/); expect((await service.status()).accounts[0].connected).toBe(false)
})

it('rejects an OAuth identity body that finishes after workspace replacement without persisting its grant', async () => {
  const setup = await configure(['contacts']), start = new URL((await service.connect(setup.accountId, 'http://127.0.0.1:5173')).authorizationUrl); let release: ((value: unknown) => void) | undefined; const identity = json({}); vi.spyOn(identity, 'json').mockImplementation(() => new Promise((resolve) => { release = resolve })); provider.mockResolvedValueOnce(json({ access_token: 'STALE_MUST_NOT_SAVE', scope: scopes(['contacts']) })).mockResolvedValueOnce(identity); const attempt = service.callback(new URL(`http://127.0.0.1:5173/api/crm/connections/google/callback?code=x&state=${start.searchParams.get('state')}`), 'http://127.0.0.1:5173'); for (let index = 0; !release && index < 100; index++) await new Promise((resolve) => setTimeout(resolve, 1)); expect(release).toBeDefined(); db.wipe(); release!({ sub: 'synthetic-user', email: 'owner@example.test', email_verified: true }); await expect(attempt).rejects.toThrow(/workspace or connection changed/); expect((await service.status()).accounts[0].connected).toBe(false); expect(readFileSync(join(directory, 'connections', 'crm-google.private.json'), 'utf8')).not.toContain('STALE_MUST_NOT_SAVE')
})
it('paginates saved contacts, retains originals and stages candidates without creating people or graph edges', async () => {
  const { accountId } = await connect(['contacts']); provider.mockResolvedValueOnce(json({ connections: [{ resourceName: 'people/c1', names: [{ displayName: 'Ada Example' }], emailAddresses: [{ value: 'ada@example.test' }], arbitraryOriginal: 'retain me' }], nextPageToken: 'page-two' })).mockResolvedValueOnce(json({ connections: [{ resourceName: 'people/c2', names: [{ displayName: 'Ben Example' }] }], nextSyncToken: 'sync-first' })); await service.contacts({ accountId }); expect(staged).toHaveBeenCalledTimes(1); const batch = staged.mock.calls[0][0]; expect(batch.candidates).toHaveLength(2); expect(batch.candidates[0].raw).toMatchObject({ arbitraryOriginal: 'retain me' }); expect(batch.originalAssetIds[0]).toMatch(/^crm-file-[a-f0-9]{64}$/); expect(db.getAssetMeta(batch.originalAssetIds[0])).toMatchObject({ kind: 'file', nodeId: null }); expect(store.list('people').total).toBe(0); expect(store.list('relationships').total).toBe(0); expect(store.list('candidates').total).toBe(2); expect(new URL(String(provider.mock.calls[1][0])).searchParams.get('pageToken')).toBe('page-two')
  provider.mockResolvedValueOnce(json({ connections: [], nextSyncToken: 'sync-next' })); await service.contacts({ accountId }); expect(new URL(String(provider.mock.calls[2][0])).searchParams.get('syncToken')).toBe('sync-first')
})
it('keeps cancelled events, recurring instance identity and unconfirmed RSVP context without friendship inference', async () => {
  const { accountId } = await connect(['calendar']), raw = { id: 'instance-1', iCalUID: 'stable-series', summary: 'A real meeting', status: 'confirmed', start: { dateTime: '2026-11-23T10:00:00-05:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-11-23T11:00:00-05:00' }, originalStartTime: { dateTime: '2026-11-23T09:00:00-05:00' }, attendees: [{ email: 'attendee@example.test', displayName: 'A Person', responseStatus: 'accepted' }, { email: 'declined@example.test', responseStatus: 'declined' }, { email: 'owner@example.test', self: true }], organizer: { email: 'host@example.test' } }; provider.mockResolvedValueOnce(json(raw)); await service.stageEvent({ accountId, calendarId: 'selected-calendar', eventId: 'instance-1', includeAttendees: true }); const batch = staged.mock.calls[0][0]; expect(batch.candidates).toHaveLength(2); expect(batch.candidates[0].payload).toMatchObject({ status: 'scheduled', attendanceConfirmed: false, timezone: 'America/New_York', calendarEvent: { iCalUID: 'stable-series', originalStartTime: '2026-11-23T09:00:00-05:00' } }); expect(batch.candidates.some((candidate) => candidate.kind === 'relationship')).toBe(false); expect(store.list('interactions').total).toBe(0)
  provider.mockResolvedValueOnce(json({ ...raw, id: 'cancelled-event', status: 'cancelled' })); await service.stageEvent({ accountId, calendarId: 'selected-calendar', eventId: 'cancelled-event', includeAttendees: true }); expect(staged.mock.calls[1][0].candidates).toHaveLength(1); expect(staged.mock.calls[1][0].candidates[0].payload.status).toBe('cancelled')
})
it('reads only selected Gmail metadata headers with no q, body, attachment or send request', async () => {
  const { accountId } = await connect(['gmail']); provider.mockResolvedValueOnce(json({ emailAddress: 'owner@example.test', historyId: 'history-1' })).mockResolvedValueOnce(json({ messages: [{ id: 'message-1' }] })).mockResolvedValueOnce(json({ id: 'message-1', payload: { headers: [{ name: 'From', value: 'Ada <ada@example.test>' }, { name: 'To', value: 'Owner <owner@example.test>' }], body: { data: 'BODY_MUST_NOT_RETAIN' }, parts: [{ filename: 'attachment' }] } })); await service.gmail({ accountId }); const urls = provider.mock.calls.map(([url]) => new URL(String(url))); expect(urls.some((url) => url.searchParams.has('q'))).toBe(false); const message = urls.find((url) => url.pathname.endsWith('/message-1'))!; expect(message.searchParams.get('format')).toBe('metadata'); expect(message.searchParams.getAll('metadataHeaders')).not.toContain('Subject'); const batch = staged.mock.calls[0][0]; expect(batch.candidates).toHaveLength(1); expect(batch.candidates[0].payload.emails).toEqual(['ada@example.test']); expect(readFileSync(join(directory, 'blobs', batch.originalAssetIds[0]), 'utf8')).not.toContain('BODY_MUST_NOT_RETAIN'); expect(urls.some((url) => /send|attachments/.test(url.pathname))).toBe(false)
  provider.mockResolvedValueOnce(json({ historyId: 'history-2' })).mockResolvedValueOnce(json({ history: [] })); await service.gmail({ accountId }); expect(new URL(String(provider.mock.calls[4][0])).searchParams.get('startHistoryId')).toBe('history-1')
})
it('requires original hash review and makes repeated contact exports idempotent', async () => {
  const bytes = Buffer.from('Name,Email,Interesting unknown column\r\nAda,ada@example.test,Keep this exactly\r\n'), input = { name: 'guests.csv', provider: 'partiful', base64: bytes.toString('base64') }, preview = await service.previewImport(input); expect(preview.count).toBe(1); expect(preview.columns).toContain('Interesting unknown column'); await expect(service.stageImport({ ...input, expectedHash: 'wrong' })).rejects.toThrow(/changed/); expect(staged).not.toHaveBeenCalled(); await service.stageImport({ ...input, expectedHash: preview.hash }); await service.stageImport({ ...input, expectedHash: preview.hash }); expect(store.list('candidates').total).toBe(1); expect(store.list('people').total).toBe(0); const batch = staged.mock.calls[0][0]; expect(batch.candidates[0].raw).toMatchObject({ 'Interesting unknown column': 'Keep this exactly' }); expect(readFileSync(join(directory, 'blobs', batch.originalAssetIds[0]))).toEqual(bytes)
})
it('parses quoted multiline CSV and refuses duplicate headers or malformed rows', () => {
  expect(parseCrmCsv('Name,Notes\n"Ada, A.","Line one\nLine two with ""quote"""')).toEqual([{ Name: 'Ada, A.', Notes: 'Line one\nLine two with "quote"' }]); expect(() => parseCrmCsv('Name,Name\na,b')).toThrow(/duplicate/); expect(() => parseCrmCsv('Name\n"broken')).toThrow(/unfinished/)
})
it('keeps all vCard identities and unresolved ICS recurrence/timezone originals for review', () => {
  const card = batchCrmImport('contact.vcf', Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada Example\r\nEMAIL;TYPE=WORK:ada@example.test\r\nEMAIL;TYPE=HOME:ada2@example.test\r\nX-UNKNOWN:retain\r\nEND:VCARD'), 'contacts', 'local', time); expect(card.candidates[0].payload.emails).toEqual(['ada@example.test', 'ada2@example.test']); expect(card.candidates[0].raw).toMatchObject({ 'X-UNKNOWN': 'retain' })
  const ics = batchCrmImport('events.ics', Buffer.from('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:series1\nSUMMARY:Floating event\nDTSTART:20261123T120000\nRRULE:FREQ=WEEKLY\nEND:VEVENT\nEND:VCALENDAR'), 'calendar', 'local', time); expect(ics.candidates[0].payload).toMatchObject({ startAt: null, recurrence: 'FREQ=WEEKLY', attendanceConfirmed: false }); expect(ics.errors.length).toBe(1)
})
it('does not extract email bodies as people and does not guess missing Partiful identities', () => {
  const email = previewCrmImport('selected.eml', Buffer.from('From: Ada <ada@example.test>\r\nTo: Ben <ben@example.test>\r\nSubject: Test\r\n\r\nFrom: Secret <body@example.test>')); expect(email.preview.count).toBe(2); expect(JSON.stringify(email.rows)).not.toContain('body@example.test'); const csv = batchCrmImport('partiful.csv', Buffer.from('Name,RSVP\nAda,Going'), 'partiful', 'local', time); expect(csv.candidates[0].payload.emails).toEqual([]); expect(csv.candidates[0].confidence).toBe('unknown')
})
it('never starts optional Happenstance paid research without explicit confirmation', async () => {
  await service.configureHappenstance({ apiKey: 'SYNTHETIC_HAPPENSTANCE_KEY' }); await expect(service.happenstance({ kind: 'research', text: 'Ada Example' })).rejects.toThrow(/Confirm/); expect(provider).not.toHaveBeenCalled(); expect(JSON.stringify(await service.status())).not.toContain('SYNTHETIC_HAPPENSTANCE_KEY'); provider.mockResolvedValueOnce(json({ credits: 4 })); await service.happenstance({ kind: 'credits' }); expect(provider.mock.calls[0][1]?.method).toBe('GET'); expect(provider.mock.calls[0][0]).toBe('https://api.happenstance.ai/v1/usage')
})
it('requires optional send grant and an exact one-time confirmation, marking sent only with a provider receipt', async () => {
  const { accountId } = await connect(['contacts']); await expect(service.prepareSend({ accountId, to: ['a@example.test'], subject: 'Hi', body: 'Hello' })).rejects.toThrow(/send permission/); expect(provider).not.toHaveBeenCalled(); const sending = await connect(['send']), draft = await service.prepareSend({ accountId: sending.accountId, to: ['a@example.test'], subject: 'Hello é', body: 'A real draft' }); await expect(service.send({ ...draft, digest: 'changed', confirmed: true })).rejects.toThrow(/expired or changed/); expect(provider).not.toHaveBeenCalled(); provider.mockResolvedValueOnce(json({ id: 'verified-google-receipt' })); expect(await service.send({ ...draft, confirmed: true })).toMatchObject({ status: 'sent', messageId: 'verified-google-receipt' }); await expect(service.send({ ...draft, confirmed: true })).rejects.toThrow(/expired or changed/); expect(provider).toHaveBeenCalledTimes(1); expect(new URL(String(provider.mock.calls[0][0])).pathname).toBe('/gmail/v1/users/me/messages/send')
})
it('persists ambiguous mail delivery before dispatch, blocks duplicate retries across restarts and never auto retries', async () => {
  const { accountId } = await connect(['send']), input = { accountId, to: ['a@example.test'], subject: 'One message', body: 'Keep exact' }, draft = await service.prepareSend(input); provider.mockRejectedValueOnce(new Error('connection dropped')); await expect(service.send({ ...draft, confirmed: true })).rejects.toThrow(/uncertain/); expect(provider).toHaveBeenCalledTimes(1); const privateFile = JSON.parse(readFileSync(join(directory, 'connections', 'crm-google.private.json'), 'utf8')) as { outbox: { status: string }[] }; expect(privateFile.outbox[0].status).toBe('ambiguous'); const restarted = new CrmConnections({ db, blobDir: join(directory, 'blobs'), fetch: provider }); await expect(restarted.prepareSend(input)).rejects.toThrow(/uncertain/); expect(provider).toHaveBeenCalledTimes(1); expect(crmHash(Buffer.from('exact'))).toHaveLength(64)
})

it('resumes a bounded Gmail initial scan before advancing to a history cursor', async () => {
  const { accountId } = await connect(['gmail']); provider.mockResolvedValueOnce(json({ historyId: 'baseline-1' })).mockResolvedValueOnce(json({ messages: [{ id: 'message-1' }], nextPageToken: 'page-2' })).mockResolvedValueOnce(json({ id: 'message-1', payload: { headers: [] } })); await service.gmail({ accountId }); expect(staged.mock.calls[0][0].counts.messages).toBe(1); expect(new URL(String(provider.mock.calls[1][0])).searchParams.get('maxResults')).toBe('50'); provider.mockResolvedValueOnce(json({ messages: [] })); await service.gmail({ accountId }); expect(new URL(String(provider.mock.calls[3][0])).searchParams.get('pageToken')).toBe('page-2'); provider.mockResolvedValueOnce(json({ historyId: 'latest' })).mockResolvedValueOnce(json({ history: [] })); await service.gmail({ accountId }); expect(new URL(String(provider.mock.calls[5][0])).searchParams.get('startHistoryId')).toBe('baseline-1')
})

it('stages successful Gmail metadata on quota failure, saves pending IDs and resumes only the unread messages after Retry-After', async () => {
  const { accountId } = await connect(['gmail']), metadata = (id: string) => ({ id, internalDate: '1', payload: { headers: [{ name: 'From', value: `Contact ${id} <${id}@example.test>` }] } }), quota = new Response(JSON.stringify({ error: { message: 'Quota exceeded for TotalQueryCost Units per minute per user', errors: [{ reason: 'rateLimitExceeded' }] } }), { status: 403, headers: { 'content-type': 'application/json', 'retry-after': '30' } })
  provider.mockResolvedValueOnce(json({ historyId: 'baseline-A' })).mockResolvedValueOnce(json({ messages: ['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => ({ id })) })).mockResolvedValueOnce(json(metadata('m1'))).mockResolvedValueOnce(json(metadata('m2'))).mockResolvedValueOnce(quota)
  const partial = await service.gmail({ accountId }) as { staged: number; partial: boolean; retryAt: number; counts: { messages: number } }; expect(partial).toMatchObject({ staged: 2, partial: true, retryAt: 31000, counts: { messages: 2 } }); expect(store.list('candidates').total).toBe(2); expect((await service.status()).accounts[0].gmailSync).toMatchObject({ pendingMessages: 3, hasMore: true, retryAt: 31000 })
  const restarted = new CrmConnections({ db, blobDir: join(directory, 'blobs'), fetch: provider, now: () => time, delay: async () => {}, stageBatch: staged }); const beforeCooldown = provider.mock.calls.length; await restarted.gmail({ accountId }); expect(provider).toHaveBeenCalledTimes(beforeCooldown)
  time = 32000; provider.mockReset(); for (const id of ['m3', 'm4', 'm5']) provider.mockResolvedValueOnce(json(metadata(id))); const completed = await restarted.gmail({ accountId }) as { completed: boolean; counts: { messages: number } }; expect(completed).toMatchObject({ completed: true, counts: { messages: 3 } }); expect(provider.mock.calls.map(([url]) => new URL(String(url)).pathname.split('/').at(-1))).toEqual(['m3', 'm4', 'm5']); expect(store.list('candidates').total).toBe(5)
  provider.mockReset(); provider.mockResolvedValueOnce(json({ historyId: 'baseline-B' })).mockResolvedValueOnce(json({ messages: ['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => ({ id })) })); for (const id of ['m1', 'm2', 'm3', 'm4', 'm5']) provider.mockResolvedValueOnce(json(metadata(id))); await restarted.gmail({ accountId, reset: true }); expect(store.list('candidates').total).toBe(5); expect(provider.mock.calls.every(([url]) => !new URL(String(url)).searchParams.has('q'))).toBe(true)
})

it('treats HTTP 429 as a persisted explicit-resume pause and paces Gmail read requests', async () => {
  const { accountId } = await connect(['gmail']), delay = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined), paced = new CrmConnections({ db, blobDir: join(directory, 'blobs'), fetch: provider, now: () => time, delay, stageBatch: staged }); provider.mockResolvedValueOnce(json({ historyId: 'history-A' })).mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Too many requests' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': new Date(time + 45000).toUTCString() } })); const result = await paced.gmail({ accountId }) as { partial: boolean; retryAt: number }; expect(result).toMatchObject({ partial: true, retryAt: 46000 }); expect(delay).toHaveBeenCalledWith(250); expect(provider).toHaveBeenCalledTimes(2); expect(store.list('candidates').total).toBe(0)
})

it('keeps Folk fallback read-only, scoped to imported identities and rejects unsafe pagination before forwarding a key', async () => {
  db.crm.command({ requestId: 'folk-person', operation: 'create', collection: 'people', record: { id: 'local-person', fullName: 'Ada Example', sourceRefs: [{ provider: 'folk', accountId: 'synthetic-workspace', externalId: 'per_original' }] } }); await service.configureFolk({ apiKey: 'SYNTHETIC_FOLK_KEY' }); provider.mockResolvedValueOnce(json({ data: { items: [{ id: 'interaction-1', interactionType: 'calendar', dateTime: '2026-11-20T15:00:00Z', title: 'Original context', privacyLevel: 'sharedMetadata', entity: { id: 'per_original', entityType: 'person' }, content: { body: 'BODY_NOT_PERMITTED_AS_VISIBLE_TEXT' } }], pagination: { nextLink: null } } })).mockResolvedValueOnce(json({ data: { items: [], pagination: { nextLink: null } } })); const result = await service.folkInteractions({ offset: 0 }); expect(result).toMatchObject({ processed: 1, total: 1, nextOffset: null, remoteWrites: false }); expect(provider.mock.calls.every(([url, init]) => String(url).startsWith('https://api.folk.app/v1/interactions?') && !init?.method)).toBe(true); expect(staged.mock.calls[0][0].candidates[0].payload).toMatchObject({ personIds: ['local-person'], body: '', attendanceConfirmed: false }); expect(JSON.stringify(await service.status())).not.toContain('SYNTHETIC_FOLK_KEY'); provider.mockReset(); provider.mockResolvedValueOnce(json({ data: { items: [], pagination: { nextLink: 'https://attacker.invalid/leak' } } })); await expect(service.folkInteractions({ offset: 0 })).rejects.toThrow(/unsafe pagination/); expect(provider).toHaveBeenCalledTimes(1)
})

it('extracts exact identities only from explicitly selected retained Drive or Reader sources with version-bound provenance', async () => {
  const text = 'Visible profile for Ada. Contact ada@example.test about the project.', blobId = `knowledge-${crmHash(text)}`, snapshot: KnowledgeSnapshot = { schemaVersion: 1, revision: 1, sources: [{ id: 'selected-source', externalId: 'web:profile', title: 'Ada profile', kind: 'document', currentVersionId: 'version1', createdAt: time, updatedAt: time, excluded: false, aiAllowed: false, tags: [] }], versions: [{ id: 'version1', sourceId: 'selected-source', contentHash: crmHash(text), originalBlobId: blobId, originalName: 'capture.json', text, createdAt: time, authoredAt: null, origin: 'capture', metadata: { format: 'article', captureMethod: 'browser-extension', url: 'https://example.test/ada' } }], passages: [], imports: [], jobs: [], proposals: [] }; db.putAssetMeta({ id: blobId, kind: 'file', mime: 'text/plain', bytes: text.length, createdAt: time, nodeId: null }); db.putKv('knowledge.v1', snapshot)
  expect(service.capturedSources().sources).toMatchObject([{ id: 'selected-source', provider: 'website-reader', url: 'https://example.test/ada' }]); await expect(service.stageCapturedSource({ sourceId: 'selected-source', expectedVersionId: 'stale' })).rejects.toThrow(/changed/); await service.stageCapturedSource({ sourceId: 'selected-source', expectedVersionId: 'version1' }); const batch = staged.mock.calls[0][0]; expect(batch.candidates[0].payload).toMatchObject({ fullName: 'ada@example.test', emails: ['ada@example.test'] }); expect(batch.candidates[0].sourceRefs[0]).toMatchObject({ originalAssetId: blobId, version: 'version1' }); expect(batch.candidates[0].evidence[0].excerpt).toContain('ada@example.test'); await expect(service.stageCapturedSource({ sourceId: 'selected-source', expectedVersionId: 'version1', fullName: 'Ada Example', email: 'notvisible@example.test' }, true)).rejects.toThrow(/not in the captured page/); await service.stageCapturedSource({ sourceId: 'selected-source', expectedVersionId: 'version1', fullName: 'Ada Example' }, true); expect(staged.mock.calls[1][0].candidates[0].payload.urls).toEqual(['https://example.test/ada']); expect(provider).not.toHaveBeenCalled(); snapshot.sources[0].excluded = true; db.putKv('knowledge.v1', snapshot); expect(service.capturedSources().sources).toHaveLength(0)
})

it('rebuilds relationship history from saved headers for later captures, counts only exchanges, and excludes ambiguous addresses', async () => {
  const { accountId } = await connect(['gmail'])
  const rows = [
    { id: 'first', at: '100', from: 'friend@example.test', to: 'owner@example.test', subject: 'Office hours', key: 'same-id' },
    { id: 'copy', at: '100', from: 'friend@example.test', to: 'owner@example.test', subject: 'Office hours', key: 'same-id' },
    { id: 'second', at: '500', from: 'owner@example.test', to: 'friend@example.test', subject: 'Next steps', key: 'second-id' },
    { id: 'co-recipients', at: '800', from: 'stranger@example.test', to: 'friend@example.test, owner@example.test', subject: 'Newsletter', key: 'third-id' },
  ]
  provider.mockResolvedValueOnce(json({ historyId: 'first-cursor' })).mockResolvedValueOnce(json({ messages: rows.map(row => ({ id: row.id })) }))
  for (const row of rows) provider.mockResolvedValueOnce(json({ internalDate: row.at, payload: { headers: [
    { name: 'From', value: row.from }, { name: 'To', value: row.to }, { name: 'Subject', value: row.subject }, { name: 'Message-ID', value: row.key },
  ] } }))
  await service.gmail({ accountId, includeSubject: true })
  const person = store.command({ requestId: 'create-friend', operation: 'create', collection: 'people', record: { fullName: 'Known contact', emails: ['friend@example.test'] } }).record!
  store.command({ requestId: 'future-visit', operation: 'create', collection: 'interactions', record: { title: 'Future visit', status: 'scheduled', startAt: 1001, personIds: [person.id] } })
  const history = await service.relationship(person.id, 0)
  expect(history).toMatchObject({ total: 2, sent: 1, received: 1, recentCount: 2, first: { title: 'Office hours', at: 100 }, last: { title: 'Next steps', at: 500 }, unavailableSources: 0, ambiguousEmails: 0 })
  expect(history.timeline[0].url).toContain('authuser=owner%40example.test')
  const introducer = store.command({ requestId: 'introducer', operation: 'create', collection: 'people', record: { fullName: 'Sam' } }).record!
  store.command({ requestId: 'introduction', operation: 'create', collection: 'relationships', record: { from: { type: 'person', id: person.id }, to: { type: 'person', id: introducer.id }, relation: 'Introduced by', confirmed: true } })
  expect((await service.relationship(person.id, 0)).introductions).toEqual([{ personId: introducer.id, name: 'Sam', source: 'Saved relationship' }])
  time += 31 * 86400000
  expect(await service.reconnect(0)).toMatchObject({ total: 1, rows: [{ id: person.id, idleDays: 31, last: { title: 'Next steps' } }] })
  store.command({ requestId: 'followup', operation: 'create', collection: 'tasks', record: { title: 'Get coffee', entityRefs: [{ id: person.id, type: 'person' }] } })
  expect((await service.reconnect(0)).total).toBe(0)
  store.command({ requestId: 'another-friend', operation: 'create', collection: 'people', record: { fullName: 'Shared inbox', emails: ['FRIEND@example.test'] } })
  expect(await service.relationship(person.id, 0)).toMatchObject({ total: 0, ambiguousEmails: 1 })
})

it('automatically syncs an opted-in mailbox once per interval, pauses on quota and isolates a replacement workspace', async () => {
  const { accountId } = await connect(['gmail'])
  expect(await service.autoSync()).toEqual({ changed: false })
  expect(provider).not.toHaveBeenCalled()
  await service.syncPreferences({ accountId, enabled: true, includeSubjects: true })
  provider.mockResolvedValueOnce(json({ historyId: 'sync-cursor' })).mockResolvedValueOnce(json({ messages: [] }))
  expect(await service.autoSync()).toEqual({ changed: true })
  expect(await service.autoSync()).toEqual({ changed: false })
  expect(provider).toHaveBeenCalledTimes(2)
  time += 15 * 60000
  provider.mockResolvedValueOnce(new Response('{}', { status: 429 }))
  await service.autoSync()
  expect((await service.status()).accounts[0].autoSyncError).toMatch(/quota/i)
  time += 15 * 60000
  expect(await service.autoSync()).toEqual({ changed: false })
  db.wipe()
  expect((await service.status()).accounts[0].autoSync).toBe(false)
})

it('carries Google contact cities and distinct school, current, and former roles into accepted CRM records', async () => {
  const { accountId } = await connect(['contacts'])
  provider.mockResolvedValueOnce(json({ connections: [{
    resourceName: 'people/c1', names: [{ displayName: 'Ada Test' }], addresses: [{ type: 'work', city: 'Boston' }, { type: 'home', city: 'New York', region: 'NY' }],
    organizations: [{ type: 'work', name: 'Past Inc', title: 'Director', endDate: { year: 2021 } }, { type: 'work', name: 'Current Inc', title: 'Engineer', current: true, location: 'Boston', domain: 'current.example' }, { type: 'school', name: 'Example College' }],
  }] }))
  await service.contacts({ accountId })
  const candidate = store.rows('candidates')[0]
  const accepted = store.command({ requestId: 'accept-gc', operation: 'review_candidate', id: candidate.id, expectedRecordRevision: candidate.revision, accept: true })
  expect(accepted.record).toMatchObject({ location: 'New York, NY', jobTitle: 'Engineer', affiliations: [{ organization: 'Past Inc', current: false, endDate: '2021' }, { organization: 'Current Inc', current: true, organizationUrl: 'https://current.example/' }, { organization: 'Example College', kind: 'education' }] })
})
it('counts calendar participation only after confirmation and links the same event to a second selected contact', async () => {
  const save = (id: string) => store.command({ requestId: 'create-' + id, operation: 'create', collection: 'people', record: { id, fullName: id } })
  save('person-a'); save('person-b')
  const event = { title: 'Coffee', type: 'calendar', startAt: 200, sourceRefs: [{ provider: 'google-calendar', accountId: 'work', externalId: 'event-1' }] }
  store.command({ requestId: 'attach-a', operation: 'log_calendar', record: { ...event, personIds: ['person-a'] } })
  const existing = store.command({ requestId: 'attach-b', operation: 'log_calendar', record: { ...event, personIds: ['person-b'] } }).record!
  expect(await service.relationship('person-a', 0)).toMatchObject({ total: 0 })
  store.command({ requestId: 'confirm', operation: 'log_calendar', expectedRecordRevision: existing.revision, record: event, confirmAttendance: true })
  expect(store.rows('interactions')).toHaveLength(1)
  expect((await service.relationship('person-b', 0)).total).toBe(1)
  save('person-c')
  store.command({ requestId: 'attach-after-confirmation', operation: 'log_calendar', record: { ...event, personIds: ['person-c'] } })
  expect((await service.relationship('person-c', 0)).total).toBe(0)
})
it('retains an accepted past Folk email timestamp without requiring calendar attendance', async () => {
  const id = 'friend'
  store.command({ requestId: 'person', operation: 'create', collection: 'people', record: { id, fullName: 'Friend' } })
  const candidate = store.command({ requestId: 'candidate', operation: 'create', collection: 'candidates', record: { kind: 'interaction', provider: 'folk', accountId: 'team', externalId: 'em-1', payload: { type: 'email', status: 'logged', title: 'Hello', occurredAt: 200, personIds: [id] } } }).record!
  store.command({ requestId: 'accept', operation: 'review_candidate', accept: true, id: candidate.id, expectedRecordRevision: candidate.revision })
  expect((await service.relationship(id, 0)).last).toMatchObject({ at: 200, title: 'Hello' })
})

it('returns physical calendar venues with source and pagination, keeping private invite details out of Maps', async () => {
  const { accountId }=await connect(['calendar'])
  const event={id:'venue',summary:'Reading group',location:'Cambridge, MA',description:'Invitation https://lu.ma/test',attendees:[{email:'private@example.test'}],start:{dateTime:'2026-06-01T15:00:00Z'}}
  provider.mockResolvedValueOnce(json({items:[event,{...event,id:'remote',location:'https://meet.google.com/example'},{...event,id:'cancelled',status:'cancelled'},{...event,id:'second',description:'https://partiful.com/e/test'}],nextPageToken:'second-page'}))
  const page=await service.venues({accountId,calendarId:'primary',timeMin:'2026-01-01',timeMax:'2026-12-01'})
  expect(page.nextPageToken).toBe('second-page')
  expect(page.venues.map(v=>v.provider)).toEqual(['luma','partiful'])
  expect(page.venues[0]).toMatchObject({title:'Reading group',location:'Cambridge, MA'})
  expect(JSON.stringify(page)).not.toContain('private@example.test')
})
