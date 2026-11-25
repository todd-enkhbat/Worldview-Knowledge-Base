import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArticleCapture, ArticleCaptureError } from '../../server/articleCapture.ts'
import { CrmPhotoCoverage } from '../../server/crmPhotoCoverage.ts'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'
import type { CrmPerson } from '../../src/crm/types.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6kcAAAAASUVORK5CYII=', 'base64')
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const origin = `chrome-extension://${'a'.repeat(32)}`, url = 'https://www.linkedin.com/in/ada-example/', photoUrl = 'https://images.example.org/ada.png'
const input = (sequence = 1) => ({ url, title: 'Ada Example | LinkedIn', text: 'Ada Example is a researcher.', profileImages: [{ url: photoUrl, subjectName: 'Ada Example', isProfile: true, label: 'Visible profile photo' }], profileLinks: [], sequence, saveContactPhoto: true })
let db: WorldDb, blobDir: string
beforeEach(async () => { db = openWorldDb(':memory:'); db.putSettings({ T0: 0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: 1, schemaVersion: 1 }); blobDir = await mkdtemp(join(tmpdir(), 'wv-photo-completion-')) })
afterEach(async () => { db.close(); await rm(blobDir, { recursive: true, force: true }) })
function person(id = 'ada', extra: Record<string, unknown> = {}) { return db.crm.command({ requestId: crypto.randomUUID(), operation: 'create', collection: 'people', record: { id, fullName: 'Ada Example', urls: [url], ...extra } }).record as CrmPerson }
function services(fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(PNG))) {
  const coverage = new CrmPhotoCoverage({ db, store: db.crm, blobDir, fetch, lookup: async () => ['93.184.216.34'] }), articles = new ArticleCapture({ db, blobDir, saveContactPhoto: request => coverage.saveCapturedProfile(request), saveFolkPhotos: request => coverage.saveFolkPhotos(request) }), pair = articles.pair({ origin, name: 'Test Reader' })
  return { coverage, articles, token: pair.token, fetch }
}

describe('read-only complete portrait coverage', () => {
  it('checks every active original, separates missing and damaged photos, paginates rows and never mutates contacts', async () => {
    const validId = `crm-avatar-${hash(PNG)}`, bad = Buffer.concat([PNG, Buffer.from('wrong')]), badId = `crm-avatar-${'b'.repeat(64)}`, absentId = `crm-avatar-${'c'.repeat(64)}`
    await writeFile(join(blobDir, validId), PNG); await writeFile(join(blobDir, badId), bad)
    for (const [id, bytes] of [[validId, PNG.length], [badId, bad.length], [absentId, 100]] as const) db.putAssetMeta({ id, kind: 'image', mime: 'image/png', bytes, createdAt: 1, nodeId: null })
    person('valid', { avatarAssetId: validId }); person('damaged', { avatarAssetId: badId }); person('missing-original', { avatarAssetId: absentId }); person('missing')
    const before = db.crm.portableSnapshot(), { coverage, fetch } = services(), result = await coverage.inspect({ limit: 2 })
    expect(result).toMatchObject({ total: 4, available: 1, missing: 3, damaged: 1, missingOriginal: 1, nextOffset: 2 })
    expect(result.rows.map(row => row.status)).toEqual(['available', 'damaged'])
    expect((await coverage.inspect({ status: 'needs-attention' })).rows).toHaveLength(3)
    expect((await coverage.inspect({ offset: 2, limit: 2 })).nextOffset).toBeNull()
    expect(db.crm.portableSnapshot()).toEqual(before); expect(fetch).not.toHaveBeenCalled()
    await expect(coverage.inspect({ limit: 501 })).rejects.toThrow('valid photo coverage')
  })
})

const groupUuid = '11111111-1111-4111-8111-111111111111', groupId = `grp_${groupUuid}`, folkPersonId = 'per_22222222-2222-4222-8222-222222222222', folkUrl = `https://app.folk.app/apps/contacts/network/33333333-3333-4333-8333-333333333333/groups/${groupUuid}`
function folkFixture(extra: Record<string, unknown> = {}, member = true) {
  db.crm.command({ requestId: crypto.randomUUID(), operation: 'create', collection: 'groups', record: { id: groupId, name: 'Research', sourceRefs: [{ provider: 'folk', accountId: 'folk-test', externalId: groupId }] } })
  const p = person(folkPersonId, { sourceRefs: [{ provider: 'folk', accountId: 'folk-test', externalId: folkPersonId }], ...extra })
  if (member) db.crm.command({ requestId: crypto.randomUUID(), operation: 'membership', groupId, entity: { type: 'person', id: p.id } })
  return p
}
const folkInput = (sequence = 1) => ({ saveFolkPhotos: true as const, url: folkUrl, title: 'Research - Folk', sequence, folkPhotos: [{ personId: folkPersonId, name: 'Ada Example', photoUrl, groupId, sourceUrl: `${folkUrl}/people/${folkPersonId.slice(4)}` }], folkPhotoRows: [] })
const folkSearchUrl = 'https://app.folk.app/apps/contacts/network/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/search'

describe('private diagnostic-only Folk Search capture', () => {
  it('retains bounded visible diagnostics under a separate account namespace without inferring or changing ungrouped contacts', async () => {
    person(folkPersonId, { sourceRefs: [{ provider: 'folk', accountId: 'imported-account', externalId: folkPersonId }] }); db.crm.command({ requestId: 'search-company', operation: 'create', collection: 'companies', record: { id: 'company', name: 'Unchanged company' } })
    const people = db.crm.rows('people', false), companies = db.crm.rows('companies', false), { articles, token, fetch } = services(), payload = { saveFolkPhotos: true as const, sequence: 1, url: folkSearchUrl, title: 'All contacts', folkPhotos: [], folkPhotoRows: [{ name: 'Ada Example', photoUrl, nearbyLinks: [{ href: `${folkSearchUrl}/people/${folkPersonId.slice(4)}`, text: 'Ada Example' }], attributes: { 'data-person-id': folkPersonId, hidden: 'strip' }, imageState: { complete: true, naturalWidth: 40, naturalHeight: 40, currentSrc: photoUrl, requestedSources: [photoUrl], personLinkCount: 1, verifiedReason: 'diagnostic-only' } }] }
    const result = await articles.capture(payload, origin, token); expect(result.folkPhotos).toMatchObject({ total: 0, saved: 0, diagnostic: true, results: [] }); expect(result).not.toHaveProperty('sourceId')
    const original = JSON.parse(await readFile(join(blobDir, result.originalAssetId), 'utf8')); expect(original).toMatchObject({ scope: 'network-search-diagnostic', networkId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', folkPhotos: [], folkPhotoRows: [{ attributes: { 'data-person-id': folkPersonId }, imageState: { complete: true, naturalWidth: 40, verifiedReason: 'diagnostic-only' } }] }); expect(original.folkPhotoRows[0].attributes.hidden).toBeUndefined()
    const imported = db.crm.rows('imports', false)[0]; expect(imported).toMatchObject({ provider: 'folk-reader-search-diagnostic', status: 'partial', originalAssetIds: [result.originalAssetId], counts: { visibleRows: 1, verifiedRows: 0, saved: 0 } }); expect(imported.accountId).toMatch(/^folk-search-diagnostic-[a-f0-9]{24}$/); expect(imported.accountId).not.toBe('imported-account'); expect(imported.accountId).not.toBe(original.networkId)
    expect(await articles.capture(payload, origin, token)).toEqual(result); expect(db.crm.rows('imports', false)).toHaveLength(1); expect(db.crm.rows('people', false)).toEqual(people); expect(db.crm.rows('companies', false)).toEqual(companies); expect(db.getKv('knowledge.v1')).toBeUndefined(); expect(db.getKv('reading.v1')).toBeUndefined(); expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects writable Search rows and nonexact routes before retaining originals or changing CRM records', async () => {
    person(folkPersonId); const { coverage, fetch } = services(), before = db.crm.portableSnapshot(), base = { requestId: 'search-invalid', current: () => {}, url: folkSearchUrl, folkPhotos: [], folkPhotoRows: [] }
    await expect(coverage.saveFolkPhotos({ ...base, folkPhotos: folkInput().folkPhotos })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('diagnostic only') })
    for (const invalid of [folkSearchUrl.replace('https:', 'http:'), folkSearchUrl.replace('app.folk.app', 'other.example.org'), folkSearchUrl + '/people/person', folkSearchUrl.replace('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'not-a-uuid')]) await expect(coverage.saveFolkPhotos({ ...base, url: invalid })).rejects.toMatchObject({ status: 400 })
    await expect(coverage.saveFolkPhotos({ ...base, folkPhotoRows: Array.from({ length: 51 }, () => ({})) })).rejects.toMatchObject({ status: 400 })
    expect(db.crm.portableSnapshot()).toEqual(before); expect(await readdir(blobDir)).toEqual([]); expect(db.getKv('knowledge.v1')).toBeUndefined(); expect(db.getKv('reading.v1')).toBeUndefined(); expect(fetch).not.toHaveBeenCalled()
  })
  it('retains only bounded explicit Search identity diagnostics and never uses them to edit a person', async () => {
    person(folkPersonId, { emails: ['ada@example.org'] }); const { coverage, fetch } = services(), beforePeople = db.crm.rows('people', false), row = { name: 'Ada Example', photoUrl, visibleEmails: ['ada@example.org', ...Array.from({ length: 12 }, () => 'e'.repeat(500)), 42], rowRole: 'r'.repeat(100), avatarLabel: 'a'.repeat(300), isPrimaryAvatar: true, hiddenEmailState: 'never retain' }
    const result = await coverage.saveFolkPhotos({ url: folkSearchUrl, title: 'Search', folkPhotos: [], folkPhotoRows: [row], requestId: 'search-extra-evidence', current: () => {} }), raw = JSON.parse(await readFile(join(blobDir, result.originalAssetId), 'utf8'))
    expect(raw.folkPhotoRows[0]).toMatchObject({ visibleEmails: ['ada@example.org', ...Array.from({ length: 7 }, () => 'e'.repeat(320))], rowRole: 'r'.repeat(40), avatarLabel: 'a'.repeat(200), isPrimaryAvatar: true }); expect(raw.folkPhotoRows[0].hiddenEmailState).toBeUndefined(); expect(db.crm.rows('people', false)).toEqual(beforePeople); expect(result.folkPhotos).toMatchObject({ diagnostic: true, saved: 0 }); expect(fetch).not.toHaveBeenCalled()
    expect(db.getKv('knowledge.v1')).toBeUndefined(); expect(db.getKv('reading.v1')).toBeUndefined()
  })
})

describe('private paired visible Folk portrait imports', () => {
  it('retains grouped sample-avatar evidence without activating or downloading Folk demo defaults', async () => {
    folkFixture(); const { articles, token, fetch } = services(), body = folkInput(); body.folkPhotos[0].photoUrl = 'https://documents.folk.app/sample-contact-avatar-green.webp'
    const result = await articles.capture(body, origin, token); expect(result.folkPhotos).toMatchObject({ saved: 0, unavailable: 1 }); expect(result.folkPhotos.results[0].message).toContain('known Folk sample avatar'); expect(db.crm.get('people', folkPersonId)?.avatarAssetId).toBeNull(); expect(fetch).not.toHaveBeenCalled()
  })
  it('retains a CRM-only source, saves the exact Folk member photo, replays a confirmed receipt and preserves original contact data', async () => {
    const original = folkFixture({ raw: { imported: 'untouched' } }), { articles, token, fetch } = services(), result = await articles.capture(folkInput(), origin, token)
    expect(result).toMatchObject({ sequence: 1, originalAssetId: expect.stringMatching(/^crm-file-[a-f0-9]{64}$/), folkPhotos: { total: 1, saved: 1, kept: 0, unmatched: 0, unavailable: 0, diagnostic: false, results: [{ status: 'saved', personId: folkPersonId, avatarAssetId: `crm-avatar-${hash(PNG)}` }] } })
    expect(result).not.toHaveProperty('sourceId'); expect(result).not.toHaveProperty('versionId')
    const retained = JSON.parse(await readFile(join(blobDir, result.originalAssetId), 'utf8')); expect(retained.format).toBe('worldview-folk-photo-capture.v1'); expect(retained.folkPhotos[0].personId).toBe(folkPersonId)
    const p = db.crm.get('people', folkPersonId)!; expect(p.raw).toEqual(original.raw); expect(p.sourceRefs).toEqual(original.sourceRefs); expect(p.urls).toEqual(original.urls)
    expect(db.crm.rows('imports', false)).toMatchObject([{ originalAssetIds: [result.originalAssetId], status: 'complete', counts: { saved: 1 } }])
    expect(db.getKv('knowledge.v1')).toBeUndefined(); expect(db.getKv('reading.v1')).toBeUndefined(); expect(db.listNodes()).toEqual([])
    expect(await articles.capture(folkInput(), origin, token)).toEqual(result); expect(fetch).toHaveBeenCalledOnce()
  })
  it('retains bounded visible-row diagnostics privately when Folk exposes no verified person IDs', async () => {
    folkFixture(); const { articles, token, fetch } = services(), payload = { ...folkInput(), folkPhotos: [], folkPhotoRows: [{ name: 'Ada Example', photoUrl, attributes: { 'data-row-id': 'row-1', 'data-secret': 'strip this', id: 'i'.repeat(1000) }, nearbyLinks: [{ href: url, text: 'Profile' }], imageState: { alt: 'a'.repeat(300), ariaLabel: 'Photo', title: 'Visible image', rowImageCount: 2, complete: true, naturalWidth: 16.8, naturalHeight: -4, currentSrc: 's'.repeat(5000), requestedSources: Array.from({ length: 12 }, () => 'p'.repeat(5000)), personLinkCount: 1, verifiedReason: 'image-too-small', hiddenState: 'never retain' } }] }, result = await articles.capture(payload, origin, token)
    expect(result.folkPhotos).toMatchObject({ total: 0, saved: 0, diagnostic: true }); expect(fetch).not.toHaveBeenCalled(); expect(db.crm.get('people', folkPersonId)?.avatarAssetId).toBeNull()
    const raw = JSON.parse(await readFile(join(blobDir, result.originalAssetId), 'utf8')); expect(raw.folkPhotoRows[0].attributes).toEqual({ 'data-row-id': 'row-1', id: 'i'.repeat(500) })
    expect(raw.folkPhotoRows[0].imageState).toEqual({ alt: 'a'.repeat(200), ariaLabel: 'Photo', title: 'Visible image', rowImageCount: 2, complete: true, naturalWidth: 16, naturalHeight: 0, currentSrc: 's'.repeat(4096), requestedSources: Array.from({ length: 8 }, () => 'p'.repeat(4096)), personLinkCount: 1, verifiedReason: 'image-too-small' })
    expect(db.crm.rows('imports', false)[0].status).toBe('partial'); expect(db.getKv('knowledge.v1')).toBeUndefined(); expect(db.getKv('reading.v1')).toBeUndefined()
  })
  it.each([false, true])('rejects duplicate person IDs before originals, receipts or contact writes (conflicting photo: %s)', async conflicting => {
    folkFixture(); const { articles, token, fetch } = services(), before = db.crm.portableSnapshot(), payload = folkInput()
    payload.folkPhotos.push({ ...payload.folkPhotos[0], photoUrl: conflicting ? 'https://images.example.org/other-person.png' : photoUrl })
    await expect(articles.capture(payload, origin, token)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('ambiguous duplicate person IDs') })
    expect(db.crm.portableSnapshot()).toEqual(before); expect(db.getKv('reading.capture.folk-photo.receipts.v1')).toBeUndefined(); expect(db.getKv('knowledge.v1')).toBeUndefined(); expect(db.getKv('reading.v1')).toBeUndefined(); expect(await readdir(blobDir)).toEqual([]); expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['wrong-id', 'wrong-name', 'wrong-account', 'wrong-group', 'not-member'])('never guesses identity for %s', async reason => {
    folkFixture(reason === 'wrong-account' ? { sourceRefs: [{ provider: 'folk', accountId: 'another-account', externalId: folkPersonId }] } : {}, reason !== 'not-member')
    const payload = folkInput(); if (reason === 'wrong-id') payload.folkPhotos[0].personId = 'per_44444444-4444-4444-8444-444444444444'; if (reason === 'wrong-name') payload.folkPhotos[0].name = 'Other Person'; if (reason === 'wrong-group') payload.folkPhotos[0].groupId = 'grp_55555555-5555-4555-8555-555555555555'
    const { articles, token, fetch } = services(), result = await articles.capture(payload, origin, token); expect(result.folkPhotos).toMatchObject({ saved: 0, unmatched: 1 }); expect(fetch).not.toHaveBeenCalled(); expect(db.crm.get('people', folkPersonId)?.avatarAssetId).toBeNull()
  })
  it('keeps the existing photo without a network request', async () => {
    const existing = `crm-avatar-${hash(PNG)}`; await writeFile(join(blobDir, existing), PNG); db.putAssetMeta({ id: existing, kind: 'image', mime: 'image/png', bytes: PNG.length, createdAt: 1, nodeId: null }); folkFixture({ avatarAssetId: existing })
    const { articles, token, fetch } = services(), result = await articles.capture(folkInput(), origin, token); expect(result.folkPhotos).toMatchObject({ kept: 1, saved: 0 }); expect(fetch).not.toHaveBeenCalled()
  })
  it('retries a transient public download using the retained CRM source and rejects changed data for that sequence', async () => {
    folkFixture(); const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(new Response(PNG)), { articles, token } = services(fetch)
    await expect(articles.capture(folkInput(), origin, token)).rejects.toMatchObject({ status: 503 }); expect(db.crm.rows('imports', false)).toHaveLength(1)
    await expect(articles.capture({ ...folkInput(), title: 'different' }, origin, token)).rejects.toMatchObject({ status: 409 })
    expect((await articles.capture(folkInput(), origin, token)).folkPhotos).toMatchObject({ saved: 1 }); expect(db.crm.rows('imports', false)).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(2); expect(db.getKv('knowledge.v1')).toBeUndefined()
  })
  it('checkpoints each confirmed row so a partial batch retry does not download or write earlier rows again', async () => {
    folkFixture(); const secondId = 'per_66666666-6666-4666-8666-666666666666'; person(secondId, { fullName: 'Grace Example', sourceRefs: [{ provider: 'folk', accountId: 'folk-test', externalId: secondId }] }); db.crm.command({ requestId: crypto.randomUUID(), operation: 'membership', groupId, entity: { type: 'person', id: secondId } })
    const payload = folkInput(); payload.folkPhotos.push({ personId: secondId, name: 'Grace Example', photoUrl: 'https://images.example.org/grace.png', groupId, sourceUrl: `${folkUrl}/people/${secondId.slice(4)}` })
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(PNG)).mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(new Response(PNG)), { articles, token } = services(fetch)
    await expect(articles.capture(payload, origin, token)).rejects.toMatchObject({ status: 503 }); expect(db.crm.get('people', folkPersonId)?.revision).toBe(2)
    expect((await articles.capture(payload, origin, token)).folkPhotos).toMatchObject({ saved: 2 }); expect(fetch).toHaveBeenCalledTimes(3); expect(db.crm.get('people', folkPersonId)?.revision).toBe(2)
  })
  it('rechecks browser authorization after the image download and does not write after revocation', async () => {
    folkFixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve }), fetch = vi.fn<typeof globalThis.fetch>(async () => { await gate; return new Response(PNG) }), { articles, token } = services(fetch), client = articles.status().clients[0]
    const pending = articles.capture(folkInput(), origin, token); await vi.waitFor(() => expect(fetch).toHaveBeenCalled()); articles.revoke(client.id); release()
    await expect(pending).rejects.toMatchObject({ status: 401 }); expect(db.crm.get('people', folkPersonId)?.avatarAssetId).toBeNull(); expect(db.getKv('knowledge.v1')).toBeUndefined()
  })
  it('rejects article content, other websites, unknown groups, huge batches and unpaired requests', async () => {
    folkFixture(); const { articles, token, fetch } = services()
    await expect(articles.capture({ ...folkInput(), text: 'Private contact list' }, origin, token)).rejects.toMatchObject({ status: 400 })
    await expect(articles.capture({ ...folkInput(2), url: folkUrl.replace('app.folk.app', 'other.example.org') }, origin, token)).rejects.toMatchObject({ status: 400 })
    await expect(articles.capture({ ...folkInput(3), url: folkUrl.replace(groupUuid, '77777777-7777-4777-8777-777777777777') }, origin, token)).rejects.toMatchObject({ status: 404 })
    await expect(articles.capture({ ...folkInput(4), folkPhotos: Array.from({ length: 51 }, () => folkInput().folkPhotos[0]) }, origin, token)).rejects.toMatchObject({ status: 400 })
    await expect(articles.capture(folkInput(5), origin, 'wrong')).rejects.toMatchObject({ status: 401 }); expect(fetch).not.toHaveBeenCalled(); expect(db.crm.rows('imports', false)).toEqual([]); expect(db.getKv('knowledge.v1')).toBeUndefined()
  })
})

describe('explicit paired Reader contact photo completion', () => {
  it('retains the source, downloads the exact matched person photo and replays its confirmed receipt without another request', async () => {
    person(); const { articles, token, fetch, coverage } = services(), first = await articles.capture(input(), origin, token)
    expect(first.contactPhoto).toMatchObject({ status: 'saved', personId: 'ada', name: 'Ada Example', avatarAssetId: `crm-avatar-${hash(PNG)}` })
    expect(await readFile(join(blobDir, first.contactPhoto!.avatarAssetId!))).toEqual(PNG)
    const saved = db.crm.get('people', 'ada')!; expect(saved.sourceRefs).toEqual([]); expect(saved.revision).toBe(2)
    expect(await articles.capture(input(), origin, token)).toEqual(first); expect(fetch).toHaveBeenCalledOnce()
    expect(await coverage.inspect()).toMatchObject({ total: 1, available: 1, missing: 0 })
    expect(db.getKv('knowledge.v1')).toMatchObject({ sources: [{ id: first.sourceId }], versions: [{ id: first.versionId }] }); expect(db.listNodes()).toEqual([])
  })
  it('does not download a photo for a normal article capture or overwrite an existing contact photo', async () => {
    const p = person(), { articles, token, fetch } = services(); expect((await articles.capture({ ...input(), saveContactPhoto: false }, origin, token)).contactPhoto).toBeUndefined(); expect(fetch).not.toHaveBeenCalled()
    const existingId = `crm-avatar-${hash(PNG)}`; await writeFile(join(blobDir, existingId), PNG); db.putAssetMeta({ id: existingId, kind: 'image', mime: 'image/png', bytes: PNG.length, createdAt: 1, nodeId: null })
    db.crm.command({ requestId: 'existing', operation: 'update', collection: 'people', id: p.id, expectedRecordRevision: p.revision, patch: { avatarAssetId: existingId } })
    expect((await articles.capture(input(2), origin, token)).contactPhoto).toMatchObject({ status: 'kept', personId: p.id }); expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['missing', 'ambiguous', 'wrong-name', 'no-profile-photo'])('returns an honest terminal outcome for %s instead of claiming a photo was saved', async reason => {
    if (reason !== 'missing') person('ada', reason === 'wrong-name' ? { fullName: 'Somebody Else' } : {})
    if (reason === 'ambiguous') person('duplicate')
    const { articles, token, fetch } = services(), payload = input(); if (reason === 'no-profile-photo') payload.profileImages = []
    const saved = await articles.capture(payload, origin, token)
    expect(saved.contactPhoto?.status).toBe(reason === 'no-profile-photo' ? 'unavailable' : 'unmatched'); expect(fetch).not.toHaveBeenCalled(); expect(db.getKv('knowledge.v1')).toBeDefined()
  })
  it('retains a failed download for retry even after a later progress sequence while avoiding duplicate source/reading records', async () => {
    person(); const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new Error('Network interrupted')).mockResolvedValue(new Response(PNG)), { articles, token } = services(fetch)
    await expect(articles.capture(input(), origin, token)).rejects.toMatchObject({ status: 503 })
    const before = db.getKv<{ sources: unknown[]; versions: unknown[] }>('knowledge.v1')!; expect(before.sources).toHaveLength(1); expect(db.crm.get('people', 'ada')?.avatarAssetId).toBeNull()
    await articles.capture({ url, title: input().title, sequence: 2, progress: { fraction: 0, position: 0, activeMs: 0, following: false } }, origin, token)
    const retried = await articles.capture(input(), origin, token); expect(retried.contactPhoto?.status).toBe('saved'); expect(fetch).toHaveBeenCalledTimes(2)
    expect(db.getKv<{ versions: unknown[] }>('knowledge.v1')!.versions).toHaveLength(1); expect(await articles.capture(input(), origin, token)).toEqual(retried)
  })
  it('does not write a photo after revocation during the public download', async () => {
    person(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve }), fetch = vi.fn<typeof globalThis.fetch>(async () => { await gate; return new Response(PNG) }), { articles, token } = services(fetch), client = articles.status().clients[0]
    const pending = articles.capture(input(), origin, token); await vi.waitFor(() => expect(fetch).toHaveBeenCalled()); articles.revoke(client.id); release()
    await expect(pending).rejects.toBeInstanceOf(ArticleCaptureError); expect(db.crm.get('people', 'ada')?.avatarAssetId).toBeNull()
  })
  it('rejects altered data for an already retained photo sequence and source changes during a pending retry', async () => {
    person(); const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new Error('Interrupted')).mockResolvedValue(new Response(PNG)), { articles, token } = services(fetch)
    await expect(articles.capture(input(), origin, token)).rejects.toMatchObject({ status: 503 })
    await expect(articles.capture({ ...input(), title: 'Changed' }, origin, token)).rejects.toMatchObject({ status: 409 })
    await articles.capture({ ...input(2), saveContactPhoto: false, text: 'The profile changed.' }, origin, token)
    expect((await articles.capture(input(), origin, token)).contactPhoto?.status).toBe('unavailable'); expect(db.crm.get('people', 'ada')?.avatarAssetId).toBeNull()
  })
})
