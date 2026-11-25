import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CrmPhotoCoverage } from '../../server/crmPhotoCoverage.ts'
import { ArticleCapture } from '../../server/articleCapture.ts'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'
import type { CrmPerson } from '../../src/crm/types.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6kcAAAAASUVORK5CYII=', 'base64'), avatarId = `crm-avatar-${createHash('sha256').update(PNG).digest('hex')}`
const origin = `chrome-extension://${'a'.repeat(32)}`, network = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', searchUrl = `https://app.folk.app/apps/contacts/network/${network}/search`, photoUrl = 'https://images.example.org/ada.png'
let db: WorldDb, directory: string, coverage: CrmPhotoCoverage, articles: ArticleCapture, token: string, fetcher: ReturnType<typeof vi.fn<typeof fetch>>
beforeEach(async () => {
  db = openWorldDb(':memory:'); db.putSettings({ T0: 0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: 1, schemaVersion: 1 }); directory = await mkdtemp(join(tmpdir(), 'wv-folk-search-photos-'))
  fetcher = vi.fn<typeof fetch>(async () => new Response(PNG)); coverage = new CrmPhotoCoverage({ db, store: db.crm, blobDir: directory, fetch: fetcher, lookup: async () => ['93.184.216.34'] }); articles = new ArticleCapture({ db, blobDir: directory, saveFolkPhotos: input => coverage.saveFolkPhotos(input) }); token = articles.pair({ origin, name: 'Search photo test' }).token
})
afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
function person(name = 'Ada Example', emails = ['ada@example.org'], accountId = 'account-a', extra: Record<string, unknown> = {}) {
  const id = `per_${randomUUID()}`; return db.crm.command({ requestId: randomUUID(), operation: 'create', collection: 'people', record: { id, fullName: name, emails, sourceRefs: [{ provider: 'folk', externalId: id, accountId }], ...extra } }).record as CrmPerson
}
async function proof(accountId = 'account-a') {
  const groupUuid = randomUUID(), groupId = `grp_${groupUuid}`, groupUrl = `https://app.folk.app/apps/contacts/network/${network}/groups/${groupUuid}`, p = person('Verified Group Member', [`${randomUUID()}@example.org`], accountId)
  db.crm.command({ requestId: randomUUID(), operation: 'create', collection: 'groups', record: { id: groupId, name: 'Verified imported group', sourceRefs: [{ provider: 'folk', accountId, externalId: groupId }] } }); db.crm.command({ requestId: randomUUID(), operation: 'membership', groupId, entity: { type: 'person', id: p.id } })
  const result = await coverage.saveFolkPhotos({ url: groupUrl, title: 'Group', folkPhotos: [{ personId: p.id, name: p.fullName, photoUrl: 'https://images.example.org/proof.png', groupId, sourceUrl: `${groupUrl}/people/${p.id.slice(4)}` }], folkPhotoRows: [], requestId: randomUUID(), current: () => {} }); expect(result.folkPhotos.saved).toBe(1); fetcher.mockClear(); return { p, groupId, result }
}
function row(extra: Record<string, unknown> = {}) { return { name: 'Ada Example', photoUrl, sourceUrl: searchUrl, visibleEmails: ['ada@example.org'], rowRole: 'li', avatarLabel: 'Ada Example', isPrimaryAvatar: true, imageState: { complete: true, naturalWidth: 100, naturalHeight: 100, currentSrc: photoUrl, requestedSources: [photoUrl] }, ...extra } }
const payload = (rows = [row()], sequence = 1) => ({ saveFolkPhotos: true as const, saveFolkSearchPhotos: true, folkPhotos: [], folkPhotoRows: rows, url: searchUrl, title: 'Search', sequence })

describe('explicit exactly matched Folk Search photo imports', () => {
  it('never activates known Folk demo avatars even when Search email/name/account evidence matches exactly', async () => {
    await proof(); const p = person(), sample = 'https://documents.folk.app/sample-contact-avatar-gray.webp', result = await articles.capture(payload([row({ photoUrl: sample, imageState: { complete: true, naturalWidth: 64, naturalHeight: 64, currentSrc: sample, requestedSources: [sample] } })]), origin, token)
    expect(result.folkPhotos).toMatchObject({ saved: 0, unavailable: 1 }); expect(result.folkPhotos.results[0].message).toContain('known Folk sample avatar'); expect(db.crm.get('people', p.id)).toEqual(p); expect(fetcher).not.toHaveBeenCalled()
  })
  it('proves the account from completed group originals and saves only the unique email/name primary portrait with private provenance', async () => {
    await proof(); const p = person('Ada Example', ['ada@example.org'], 'account-a', { raw: { website: 'https://extra.example.org' } }), foreign = person('Foreign contact', ['ada@example.org'], 'another-account'), beforeCount = db.crm.rows('people', false).length
    const result = await articles.capture(payload(), origin, token); expect(result.folkPhotos).toMatchObject({ saved: 1, kept: 0, unmatched: 0, unavailable: 0, diagnostic: false, results: [{ status: 'saved', personId: p.id, avatarAssetId: avatarId }] })
    const original = JSON.parse(await readFile(join(directory, result.originalAssetId), 'utf8')); expect(original).toMatchObject({ format: 'worldview-folk-search-photo-capture.v1', accountBinding: { networkId: network, accountId: 'account-a', proofs: [{ groupId: expect.stringMatching(/^grp_/) }] }, folkPhotoRows: [{ visibleEmails: ['ada@example.org'] }], matches: [{ personId: p.id, revision: 1, emails: ['ada@example.org'] }] })
    const saved = db.crm.get('people', p.id)!; expect(saved.urls).toEqual([]); expect(saved.sourceRefs).toEqual(p.sourceRefs); expect(saved.raw).toEqual(p.raw); expect(db.crm.get('people', foreign.id)).toEqual(foreign); expect(db.crm.rows('people', false)).toHaveLength(beforeCount)
    expect(await articles.capture(payload(), origin, token)).toEqual(result); expect(fetcher).toHaveBeenCalledOnce(); expect(db.getKv('knowledge.v1')).toBeUndefined(); expect(db.getKv('reading.v1')).toBeUndefined()
  })
  it('leaves diagnostic Search requests read-only even when every row could match', async () => {
    await proof(); const p = person(), result = await articles.capture({ ...payload(), saveFolkSearchPhotos: false }, origin, token)
    expect(result.folkPhotos).toMatchObject({ diagnostic: true, saved: 0 }); expect(db.crm.get('people', p.id)).toEqual(p); expect(fetcher).not.toHaveBeenCalled()
  })
  it('allows the explicit People query mode with the same strict contact matching', async () => {
    await proof(); const p = person(), url = searchUrl + '?type=person', result = await articles.capture({ ...payload([row({ sourceUrl: url })]), url }, origin, token)
    expect(result.folkPhotos.results).toMatchObject([{ status: 'saved', personId: p.id }]); expect(fetcher).toHaveBeenCalledOnce()
  })
  it.each(['?type=company', '?type=unknown', '?type=', '?type=person&type=person', '?type=person&type=company', '?TYPE=person', '?Type=company'])('rejects unsafe Search query mode before any photo or original write: %s', async query => {
    await proof(); const p = person(), files = (await readdir(directory)).sort(), url = searchUrl + query, imports = db.crm.rows('imports', false)
    await expect(articles.capture({ ...payload([row({ sourceUrl: url })]), url }, origin, token)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('People view') })
    expect(db.crm.get('people', p.id)).toEqual(p); expect(db.crm.rows('imports', false)).toEqual(imports); expect((await readdir(directory)).sort()).toEqual(files); expect(fetcher).not.toHaveBeenCalled(); expect(db.getKv('knowledge.v1')).toBeUndefined(); expect(db.getKv('reading.v1')).toBeUndefined()
  })
  it('keeps Company Search diagnostics read-only instead of treating their rows as people', async () => {
    const p = person(), url = searchUrl + '?type=company', result = await articles.capture({ ...payload([row({ sourceUrl: url })]), url, saveFolkSearchPhotos: false }, origin, token)
    expect(result.folkPhotos).toMatchObject({ diagnostic: true, saved: 0 }); expect(db.crm.get('people', p.id)).toEqual(p); expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['unknown-account', 'conflicting-accounts'])('rejects %s instead of choosing the first account', async reason => {
    if (reason === 'conflicting-accounts') { await proof(); await proof('account-b') }
    const p = person(); await expect(articles.capture(payload(), origin, token)).rejects.toMatchObject({ status: 409 }); expect(db.crm.get('people', p.id)).toEqual(p); expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['damaged-original', 'incomplete-import', 'changed-membership'])('does not bind accounts from unverified evidence: %s', async reason => {
    const evidence = await proof(), p = person()
    if (reason === 'damaged-original') await writeFile(join(directory, evidence.result.originalAssetId), 'tampered original')
    if (reason === 'incomplete-import') { const imported = db.crm.rows('imports', false)[0]; db.crm.command({ requestId: randomUUID(), operation: 'update', collection: 'imports', id: imported.id, expectedRecordRevision: imported.revision, patch: { status: 'partial' } }) }
    if (reason === 'changed-membership') db.crm.command({ requestId: randomUUID(), operation: 'membership', groupId: evidence.groupId, entity: { type: 'person', id: evidence.p.id }, remove: true, expectedRecordRevision: db.crm.rows('memberships', false).find(row => row.groupId === evidence.groupId && row.entityId === evidence.p.id)!.revision })
    await expect(articles.capture(payload(), origin, token)).rejects.toMatchObject({ status: 409 }); expect(db.crm.get('people', p.id)).toEqual(p); expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['shared-email', 'name-mismatch', 'company-avatar', 'secondary-avatar', 'not-loaded', 'stale-image', 'other-source', 'no-email'])('rejects unsafe Search row: %s', async reason => {
    await proof(); const p = person(); if (reason === 'shared-email') person('Another Person')
    const changes: Record<string, Record<string, unknown>> = { 'name-mismatch': { name: 'Other Person', avatarLabel: 'Other Person' }, 'company-avatar': { avatarLabel: 'Company Inc' }, 'secondary-avatar': { isPrimaryAvatar: false }, 'not-loaded': { imageState: { complete: false, naturalWidth: 100, naturalHeight: 100, currentSrc: photoUrl, requestedSources: [photoUrl] } }, 'stale-image': { imageState: { complete: true, naturalWidth: 100, naturalHeight: 100, currentSrc: 'https://images.example.org/old.png', requestedSources: [photoUrl] } }, 'other-source': { sourceUrl: 'https://app.folk.app/other' }, 'no-email': { visibleEmails: [] } }
    const result = await articles.capture(payload([row(changes[reason] || {})]), origin, token); expect(result.folkPhotos.saved).toBe(0); expect(result.folkPhotos.unmatched + result.folkPhotos.unavailable).toBe(1); expect(db.crm.get('people', p.id)).toEqual(p); expect(fetcher).not.toHaveBeenCalled()
  })
  it('supports exact display-email fallback for an unnamed imported person without treating the email as a human name', async () => {
    await proof(); const p = person('', ['ada@example.org']), result = await articles.capture(payload([row({ name: 'ada@example.org', avatarLabel: 'ada@example.org' })]), origin, token)
    expect(result.folkPhotos.results).toMatchObject([{ status: 'saved', personId: p.id }])
  })
  it('rejects duplicate matched people, changed request bodies and client-proposed Search person IDs', async () => {
    await proof(); const p = person(); await expect(articles.capture(payload([row(), row()]), origin, token)).rejects.toMatchObject({ status: 400 }); expect(db.crm.get('people', p.id)).toEqual(p)
    await expect(articles.capture({ ...payload([], 2), folkPhotos: [{ personId: p.id }] }, origin, token)).rejects.toMatchObject({ status: 400 }); expect(fetcher).not.toHaveBeenCalled()
  })
  it('preserves existing pictures and the rejected-image guard', async () => {
    await proof(); const existing = person('Ada Example', ['ada@example.org'], 'account-a', { avatarAssetId: avatarId }), result = await articles.capture(payload(), origin, token); expect(result.folkPhotos.kept).toBe(1); expect(fetcher).not.toHaveBeenCalled(); expect(db.crm.get('people', existing.id)).toEqual(existing)
    const rejected = person('Rejected Example', ['rejected@example.org'], 'account-a', { portraitRejectedAssetIds: [avatarId] }), rejectedResult = await articles.capture(payload([row({ name: 'Rejected Example', avatarLabel: 'Rejected Example', visibleEmails: ['rejected@example.org'] })], 2), origin, token)
    expect(rejectedResult.folkPhotos).toMatchObject({ saved: 0, unavailable: 1 }); expect(db.crm.get('people', rejected.id)?.avatarAssetId).toBeNull(); expect(db.crm.get('people', rejected.id)?.portraitRejectedAssetIds).toEqual([avatarId])
  })
  it('does not claim an existing portrait is kept when its metadata has been corrupted to file kind', async () => {
    await proof(); const p = person('Ada Example', ['ada@example.org'], 'account-a', { avatarAssetId: avatarId }), meta = db.getAssetMeta(avatarId)!; db.putAssetMeta({ ...meta, kind: 'file' })
    expect((await articles.capture(payload(), origin, token)).folkPhotos).toMatchObject({ saved: 0, kept: 0, unavailable: 1 }); expect(db.crm.get('people', p.id)).toEqual(p); expect(fetcher).not.toHaveBeenCalled()
  })
  it('checkpoints a partial download and retries each row once without recreating sources', async () => {
    await proof(); const p = person(), other = person('Grace Example', ['grace@example.org']); fetcher.mockResolvedValueOnce(new Response(PNG)).mockRejectedValueOnce(new Error('Offline'))
    const body = payload([row(), row({ name: 'Grace Example', avatarLabel: 'Grace Example', visibleEmails: ['grace@example.org'] })])
    await expect(articles.capture(body, origin, token)).rejects.toMatchObject({ status: 503 }); expect(db.crm.get('people', p.id)?.revision).toBe(2); expect(db.crm.get('people', other.id)?.avatarAssetId).toBeNull()
    await expect(articles.capture({ ...body, title: 'changed' }, origin, token)).rejects.toMatchObject({ status: 409 })
    const result = await articles.capture(body, origin, token); expect(result.folkPhotos.saved).toBe(2); expect(fetcher).toHaveBeenCalledTimes(3); expect(db.crm.get('people', p.id)?.revision).toBe(2); expect(db.crm.rows('imports', false).filter(row => row.provider === 'folk-reader-search-photos')).toHaveLength(1)
  })
  it('rejects stale revisions during download and stops revoked tokens before any portrait write', async () => {
    await proof(); const p = person(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve }); fetcher.mockImplementationOnce(async () => { await gate; return new Response(PNG) })
    const pending = articles.capture(payload(), origin, token); await vi.waitFor(() => expect(fetcher).toHaveBeenCalled()); db.crm.command({ requestId: 'edit-during-download', operation: 'update', collection: 'people', id: p.id, expectedRecordRevision: p.revision, patch: { description: 'User edit' } }); release()
    expect((await pending).folkPhotos).toMatchObject({ saved: 0, unavailable: 1 }); expect(db.crm.get('people', p.id)?.avatarAssetId).toBeNull(); expect(db.crm.get('people', p.id)?.description).toBe('User edit')
    let resume!: () => void; const revokedGate = new Promise<void>(resolve => { resume = resolve }); fetcher.mockClear(); fetcher.mockImplementationOnce(async () => { await revokedGate; return new Response(PNG) }); const revoked = articles.capture(payload([row()], 2), origin, token); await vi.waitFor(() => expect(fetcher).toHaveBeenCalled()); articles.revoke(articles.status().clients[0].id); resume(); await expect(revoked).rejects.toMatchObject({ status: 401 }); expect(db.crm.get('people', p.id)?.avatarAssetId).toBeNull()
  })
  it('stops a late download after the workspace is replaced', async () => {
    await proof(); person(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve }); fetcher.mockImplementationOnce(async () => { await gate; return new Response(PNG) })
    const pending = articles.capture(payload(), origin, token); await vi.waitFor(() => expect(fetcher).toHaveBeenCalled()); db.resetWithKv('importInProgress', { startedAt: 1 }); release(); await expect(pending).rejects.toMatchObject({ status: 401 }); expect(db.crm.rows('people', false)).toEqual([]); expect(db.crm.rows('imports', false)).toEqual([])
  })
})
