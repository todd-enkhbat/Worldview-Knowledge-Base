import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { CrmProfileMedia, extractProfilePage, fetchProfileResource, profileLinkIdentity, profilePhotoRequestUrl, publicProfileUrl } from '../../server/crmProfileMedia.ts'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6kcAAAAASUVORK5CYII=', 'base64')
const lookup = async () => ['93.184.216.34']
const page = `<h1>Ada Example</h1><script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"Ada Example","image":"/ada.png","sameAs":["https://www.linkedin.com/in/ada-example","https://x.com/adaexample"]}</script><a rel="me" href="https://ada.example.net/about">About</a>`
let db: WorldDb, blobDir: string
beforeEach(async () => { db = openWorldDb(':memory:'); db.putSettings({ T0: 0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: 1, schemaVersion: 1 }); blobDir = await mkdtemp(join(tmpdir(), 'wv-profile-media-')) })
afterEach(async () => { db.close(); await rm(blobDir, { recursive: true, force: true }) })
const person = (patch: Record<string, unknown> = {}) => db.crm.command({ requestId: crypto.randomUUID(), operation: 'create', collection: 'people', record: { id: 'ada', fullName: 'Ada Example', urls: ['https://ada.example.org/'], ...patch } }).record!
const fetcher = () => vi.fn<typeof fetch>(async input => new URL(String(input)).pathname === '/ada.png' ? new Response(PNG, { headers: { 'content-type': 'image/png' } }) : new Response(page, { headers: { 'content-type': 'text/html' } }))
function capturedReader(metadata: Record<string, unknown> = {}): KnowledgeSnapshot {
  const text = 'Retained Reader profile', hash = createHash('sha256').update(text).digest('hex'), blobId = `knowledge-${hash}`
  db.putAssetMeta({ id: blobId, kind: 'file', mime: 'application/json', bytes: text.length, createdAt: 1, nodeId: null })
  return { schemaVersion: 1, revision: 1, sources: [{ id: 'reader-source', externalId: 'web:ada', title: 'Ada profile', kind: 'document', currentVersionId: 'reader-version', createdAt: 1, updatedAt: 1, excluded: false, aiAllowed: false, tags: [] }], versions: [{ id: 'reader-version', sourceId: 'reader-source', contentHash: hash, originalBlobId: blobId, originalName: 'capture.json', text, createdAt: 1, authoredAt: null, origin: 'capture', metadata: { url: 'https://ada.example.org/', captureMethod: 'browser-extension', profileImages: [{ url: 'https://images.example.org/ada.png', isProfile: true, subjectName: 'Ada Example' }], ...metadata } }], passages: [], imports: [], jobs: [], proposals: [] }
}

describe('public profile extraction and identity', () => {
  it('excludes known Folk sample avatars from automatic candidates while keeping genuine Folk pictures eligible', async () => {
    const sample = 'https://documents.folk.app/sample-contact-avatar-purple.webp', genuine = 'https://documents.folk.app/34c7fcd6-74c2-4f5c-a0ed-fce73b9b718b'
    person({ photos: [sample, genuine] }); const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(PNG)), service = new CrmProfileMedia({ db, store: db.crm, blobDir, fetch, lookup })
    expect((await service.inspect('ada')).photoCandidates.map(value => [value.url, value.automatic])).toEqual([[sample, false], [genuine, true]])
    const saved = await service.populatePerson('ada', { requestId: 'genuine-folk-only', expectedRecordRevision: 1 }); expect(saved.downloaded).toBe(true); expect(saved.record.portraitSource).toMatchObject({ url: genuine }); expect(fetch).toHaveBeenCalledOnce(); expect(String(fetch.mock.calls[0][0])).toBe(genuine)
  })
  it('rejects explicit automatic Folk sample requests before downloading but preserves deliberate manual selection', async () => {
    const sample = 'https://documents.folk.app/sample-contact-avatar-blue.webp'; person({ photos: [sample] }); const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(PNG)), service = new CrmProfileMedia({ db, store: db.crm, blobDir, fetch, lookup })
    const automatic = await service.populatePerson('ada', { requestId: 'skip-folk-sample', expectedRecordRevision: 1 }); expect(automatic.downloaded).toBe(false); expect(automatic.record.avatarAssetId).toBeNull(); expect(fetch).not.toHaveBeenCalled()
    await expect(service.populatePerson('ada', { requestId: 'explicit-automatic-sample', expectedRecordRevision: 1, photoUrl: sample, sourceUrl: 'https://ada.example.org/' })).rejects.toMatchObject({ status: 422, message: expect.stringContaining('known Folk sample avatar') }); expect(fetch).not.toHaveBeenCalled(); expect(db.listAssets()).toEqual([])
    const manual = await service.populatePerson('ada', { requestId: 'manual-sample-selection', expectedRecordRevision: 1, photoUrl: sample, sourceUrl: 'https://ada.example.org/', confirmManualPhoto: true }); expect(manual.downloaded).toBe(true); expect(manual.record.portraitSource).toMatchObject({ url: sample }); expect(fetch).toHaveBeenCalledOnce()
  })
  it('rejects automatic redirects to Folk sample avatars before retaining or activating them', async () => {
    person({ photos: ['https://images.example.org/ada.png'] }); const fetch = vi.fn<typeof globalThis.fetch>(async input => new URL(String(input)).hostname === 'images.example.org' ? new Response(null, { status: 302, headers: { location: 'https://documents.folk.app/sample-contact-avatar-yellow.webp' } }) : new Response(PNG)), service = new CrmProfileMedia({ db, store: db.crm, blobDir, fetch, lookup })
    await expect(service.populatePerson('ada', { requestId: 'redirect-default', expectedRecordRevision: 1 })).rejects.toMatchObject({ status: 422 }); expect(db.listAssets()).toEqual([]); expect(db.crm.get('people', 'ada')?.avatarAssetId).toBeNull(); expect(await readdir(blobDir)).toEqual([])
  })
  it('extracts actual Person photos, social profiles and rel=me without evaluating scripts', () => {
    const result = extractProfilePage(page + '<script>throw new Error("never runs")</script>', 'https://ada.example.org/', { fullName: 'Ada Example', firstName: '', lastName: '', urls: [] })
    expect(result.photos).toEqual([expect.objectContaining({ url: 'https://ada.example.org/ada.png', automatic: true })]); expect(result.links.map(value => value.platform)).toEqual(['website', 'linkedin', 'x'])
  })
  it('leaves generic preview images for review and excludes unrelated global social links', () => {
    const result = extractProfilePage('<meta property="og:image" content="/banner.jpg"><a href="https://x.com/publisher">Follow publisher</a><script type="application/ld+json">{"@type":"Person","name":"Somebody Else","image":"/somebody.jpg"}</script>', 'https://ada.example.org/', { fullName: 'Ada Example', firstName: '', lastName: '', urls: [] })
    expect(result.photos).toEqual([expect.objectContaining({ automatic: false, url: 'https://ada.example.org/banner.jpg' })]); expect(result.links).toEqual([])
  })
  it('leaves social marketing cards for review even when the page declares og:type=profile', () => {
    const result = extractProfilePage('<meta property="og:type" content="profile"><meta property="og:image" content="/og/image/ada.jpg">', 'https://ada.example.org/', { fullName: 'Ada Example', firstName: '', lastName: '', urls: [] })
    expect(result.photos).toEqual([expect.objectContaining({ automatic: false, url: 'https://ada.example.org/og/image/ada.jpg' })])
  })
  it('compares canonical social accounts and website aliases without rewriting originals', () => {
    expect(profileLinkIdentity('http://www.linkedin.com/in/AdaExample/')).toBe(profileLinkIdentity('https://linkedin.com/in/adaexample'))
    expect(profileLinkIdentity('https://twitter.com/AdaExample')).toBe(profileLinkIdentity('https://x.com/adaexample/'))
    expect(profileLinkIdentity('http://Example.org')).toBe(profileLinkIdentity('http://example.org/'))
    expect(profileLinkIdentity('linkedin.com/in/AdaExample')).toBe(profileLinkIdentity('https://www.linkedin.com/in/adaexample'))
  })
  it('accepts an explicitly named headshot on the named person page, and ignores share URLs', () => {
    const result = extractProfilePage('<h1>Ada Example</h1><img alt="Ada Example" src="/ada.png"><img alt="Other Person" src="/other.png"><a href="https://x.com/intent/share?url=a">share</a>', 'https://ada.example.org/', { fullName: 'Ada Example', firstName: '', lastName: '', urls: [] })
    expect(result.photos).toEqual([expect.objectContaining({ automatic: true, url: 'https://ada.example.org/ada.png' })]); expect(result.links).toEqual([])
  })
  it('never assigns department/footer social accounts to an individual even on a named profile', () => {
    const result = extractProfilePage('<h1>Ada Example</h1><img alt="Ada Example" src="/ada.png"><footer><a href="https://x.com/university">University X</a><a href="https://www.linkedin.com/school/university/">School</a></footer>', 'https://ada.example.org/', { fullName: 'Ada Example', firstName: '', lastName: '', urls: [] })
    expect(result.photos[0].automatic).toBe(true); expect(result.links).toEqual([])
  })
  it('rejects credentials, local names, ports and unsupported URL protocols', () => {
    for (const url of ['https://user:password@example.org/', 'http://localhost/x', 'https://machine.local/x', 'http://example.org:3000/x', 'file:///etc/passwd', 'javascript:alert(1)']) expect(publicProfileUrl(url)).toBeNull()
  })
})

describe('profile downloads', () => {
  it('blocks initial private DNS and private redirect destinations before the request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }))
    await expect(fetchProfileResource('https://ada.example.org/', { fetch, lookup: async () => ['127.0.0.1'] })).rejects.toThrow('private'); expect(fetch).not.toHaveBeenCalled()
    await expect(fetchProfileResource('https://ada.example.org/', { fetch, lookup })).rejects.toThrow('private'); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('rejects oversized streamed bodies and HTTPS downgrade redirects', async () => {
    await expect(fetchProfileResource('https://ada.example.org/', { fetch: async () => new Response(new Uint8Array(11)), lookup, maxBytes: 10 })).rejects.toThrow('too large')
    await expect(fetchProfileResource('https://ada.example.org/', { fetch: async () => new Response(null, { status: 302, headers: { location: 'http://ada.example.org/' } }), lookup })).rejects.toThrow('unsupported')
  })
  it('previews without writes, then retains real local photo bytes, provenance and contact history', async () => {
    person(); const fetch = fetcher(), service = new CrmProfileMedia({ db, store: db.crm, blobDir, fetch, lookup, now: () => 200 })
    const preview = await service.inspect('ada', true); expect(preview.photoCandidates[0].automatic).toBe(true); expect(db.crm.get('people', 'ada')?.avatarAssetId).toBeNull(); expect(db.listAssets()).toEqual([])
    const result = await service.populatePerson('ada', { requestId: 'save', expectedRecordRevision: 1, discover: true })
    expect(result).toMatchObject({ downloaded: true, addedLinks: 3, record: { revision: 2, portraitSource: { sourceUrl: 'https://ada.example.org/', provider: 'page', observedAt: 200 } } })
    expect(await readFile(join(blobDir, result.record.avatarAssetId!))).toEqual(PNG); expect(db.getAssetMeta(result.record.avatarAssetId!)?.mime).toBe('image/png'); expect(db.crm.rows('history')).toContainEqual(expect.objectContaining({ operation: 'update', actor: 'profile-media' }))
    const count = fetch.mock.calls.length; expect(await service.populatePerson('ada', { requestId: 'save', expectedRecordRevision: 1, discover: true })).toEqual(result); expect(fetch).toHaveBeenCalledTimes(count)
    await expect(service.populatePerson('ada', { requestId: 'save', expectedRecordRevision: 2, discover: false })).rejects.toThrow('already used')
  })
  it('saves original imported photos and skips default Google placeholders', async () => {
    person({ photos: [{ url: 'https://images.example.org/default.png', default: true }, { url: 'https://images.example.org/ada.png', default: false }] }); const fetch = fetcher(), service = new CrmProfileMedia({ db, store: db.crm, blobDir, fetch, lookup })
    expect((await service.inspect('ada')).photoCandidates.map(value => value.url)).toEqual(['https://images.example.org/ada.png'])
    expect((await service.populatePerson('ada', { requestId: 'import', expectedRecordRevision: 1 })).downloaded).toBe(true)
  })
  it('does not reinstall a rejected picture automatically, while allowing an explicit manual override', async () => {
    const rejected = `crm-avatar-${createHash('sha256').update(PNG).digest('hex')}`
    person({ photos: [{ url: 'https://images.example.org/ada.png', default: false }], portraitRejectedAssetIds: [rejected] })
    const service = new CrmProfileMedia({ db, store: db.crm, blobDir, fetch: fetcher(), lookup })
    const automatic = await service.populatePerson('ada', { requestId: 'rejected-default', expectedRecordRevision: 1 })
    expect(automatic.downloaded).toBe(false); expect(automatic.record.avatarAssetId).toBeNull(); expect(automatic.record.revision).toBe(1)
    expect(automatic.notices.join(' ')).toContain('previously rejected'); expect(db.listAssets()).toHaveLength(0)
    const manual = await service.populatePerson('ada', { requestId: 'explicit-override', expectedRecordRevision: 1, photoUrl: 'https://images.example.org/ada.png', sourceUrl: 'https://ada.example.org/', confirmManualPhoto: true })
    expect(manual.downloaded).toBe(true); expect(manual.record.avatarAssetId).toBe(rejected); expect(manual.record.portraitRejectedAssetIds).toEqual([rejected])
  })
  it('makes a missing Gravatar fail instead of downloading its silhouette fallback', async () => {
    const original = `https://secure.gravatar.com/avatar/${'a'.repeat(64)}?s=96&d=mm&f=y&default=identicon&forcedefault=y`, normalized = new URL(profilePhotoRequestUrl(original))
    expect(normalized.searchParams.get('d')).toBe('404'); expect(normalized.searchParams.has('f')).toBe(false); expect(normalized.searchParams.has('default')).toBe(false); expect(normalized.searchParams.has('forcedefault')).toBe(false)
    person({ photos: [original] }); const fetch = vi.fn<typeof globalThis.fetch>(async input => new URL(String(input)).searchParams.get('d') === '404' ? new Response(null, { status: 404 }) : new Response(PNG)), service = new CrmProfileMedia({ db, store: db.crm, blobDir, fetch, lookup })
    await expect(service.populatePerson('ada', { requestId: 'missing-gravatar', expectedRecordRevision: 1 })).rejects.toThrow('HTTP 404'); expect(db.crm.get('people', 'ada')?.avatarAssetId).toBeNull(); expect(db.listAssets()).toEqual([])
  })
  it('preserves every original URL verbatim while appending only genuinely new profile links', async () => {
    const originals = ['http://ada.example.org', 'https://www.linkedin.com/in/AdaExample', 'http://ada.example.org', 'http://twitter.com/AdaExample/']
    person({ urls: originals }); const profile = '<script type="application/ld+json">{"@type":"Person","name":"Ada Example","sameAs":["https://linkedin.com/in/adaexample/","https://x.com/adaexample","https://github.com/adaexample"]}</script>', service = new CrmProfileMedia({ db, store: db.crm, blobDir, lookup, fetch: async () => new Response(profile, { headers: { 'content-type': 'text/html' } }) })
    const result = await service.populatePerson('ada', { requestId: 'canonical-links', expectedRecordRevision: 1, discover: true }); expect(result.addedLinks).toBe(1); expect(result.record.urls).toEqual([...originals, 'https://github.com/adaexample']); expect(result.record.profileLinkSources).toEqual([expect.objectContaining({ url: 'https://github.com/adaexample' })])
  })
  it('does not contact LinkedIn or social sign-in pages automatically', async () => {
    person({ urls: ['https://www.linkedin.com/in/ada', 'https://x.com/ada'] }); const fetch = fetcher(), service = new CrmProfileMedia({ db, store: db.crm, blobDir, fetch, lookup })
    const result = await service.populatePerson('ada', { requestId: 'blocked', expectedRecordRevision: 1, discover: true }); expect(result.downloaded).toBe(false); expect(fetch).not.toHaveBeenCalled(); expect(result.notices.join(' ')).toContain('restrict automated')
  })
  it('retains an existing portrait unless replacement is explicit', async () => {
    db.putAssetMeta({ id: `crm-avatar-${'a'.repeat(64)}`, kind: 'image', mime: 'image/png', bytes: 1, createdAt: 1, nodeId: null }); person({ avatarAssetId: `crm-avatar-${'a'.repeat(64)}`, photos: [{ url: 'https://images.example.org/ada.png' }] }); const fetch = fetcher(), service = new CrmProfileMedia({ db, store: db.crm, blobDir, fetch, lookup })
    const result = await service.populatePerson('ada', { requestId: 'keep', expectedRecordRevision: 1 }); expect(result.downloaded).toBe(false); expect(result.record.avatarAssetId).toBe(`crm-avatar-${'a'.repeat(64)}`); expect(fetch).not.toHaveBeenCalled()
  })
  it('requires an attached source and explicit manual selection for arbitrary photo URLs', async () => {
    person(); const fetch = fetcher(), service = new CrmProfileMedia({ db, store: db.crm, blobDir, fetch, lookup })
    await expect(service.populatePerson('ada', { requestId: 'unattached', expectedRecordRevision: 1, photoUrl: 'https://images.example.org/ada.png', sourceUrl: 'https://unrelated.example.org/', confirmManualPhoto: true })).rejects.toThrow('Add the source')
    const result = await service.populatePerson('ada', { requestId: 'manual', expectedRecordRevision: 1, photoUrl: 'https://images.example.org/ada.png', sourceUrl: 'https://ada.example.org/', confirmManualPhoto: true }); expect(result.downloaded).toBe(true)
  })
  it('rejects HTML masquerading as a portrait', async () => {
    person({ photos: ['https://images.example.org/photo'] }); const service = new CrmProfileMedia({ db, store: db.crm, blobDir, lookup, fetch: async () => new Response('<html>Sign in</html>', { headers: { 'content-type': 'image/png' } }) })
    await expect(service.populatePerson('ada', { requestId: 'fake', expectedRecordRevision: 1 })).rejects.toThrow('real PNG'); expect(db.listAssets()).toEqual([]); expect(db.crm.get('people', 'ada')?.revision).toBe(1)
  })
  it('refuses late downloads after a record edit or workspace replacement', async () => {
    person({ photos: ['https://images.example.org/ada.png'] }); let release: (() => void) | undefined; const gate = new Promise<void>(resolve => { release = resolve }), fetch = vi.fn<typeof globalThis.fetch>(async () => { await gate; return new Response(PNG) }), service = new CrmProfileMedia({ db, store: db.crm, blobDir, fetch, lookup })
    const pending = service.populatePerson('ada', { requestId: 'late', expectedRecordRevision: 1 }); await vi.waitFor(() => expect(fetch).toHaveBeenCalled()); db.crm.command({ requestId: 'edit', operation: 'update', collection: 'people', id: 'ada', expectedRecordRevision: 1, patch: { description: 'Newer edit' } }); release!(); await expect(pending).rejects.toThrow('changed'); expect(db.listAssets()).toEqual([])
    const another = new CrmProfileMedia({ db, store: db.crm, blobDir, lookup, fetch: async () => { db.wipe(); return new Response(PNG) } }); await expect(another.populatePerson('ada', { requestId: 'wipe', expectedRecordRevision: 2 })).rejects.toThrow('workspace changed'); expect(db.listAssets()).toEqual([]); expect(await readdir(blobDir)).toEqual([])
  })
  it('populates only eligible attached public pages in bounded resumable batches', async () => {
    person(); db.crm.command({ requestId: 'two', operation: 'create', collection: 'people', record: { id: 'second', fullName: 'Second Person', urls: ['https://www.linkedin.com/in/second'] } }); db.crm.command({ requestId: 'three', operation: 'create', collection: 'people', record: { id: 'third', fullName: 'Third Person', photos: ['https://images.example.org/ada.png'] } })
    const fetch = fetcher(), service = new CrmProfileMedia({ db, store: db.crm, blobDir, fetch, lookup }); const result = await service.populate({ requestId: 'batch', limit: 1, eligibleOnly: true, discover: true }); expect(result).toMatchObject({ total: 2, processed: 1, nextOffset: 1, downloaded: 1, results: [{ personId: 'ada', status: 'updated' }] }); const calls = fetch.mock.calls.length; expect(await service.populate({ requestId: 'batch', limit: 1, eligibleOnly: true, discover: true })).toEqual(result); expect(fetch).toHaveBeenCalledTimes(calls); await expect(service.populate({ requestId: 'batch', limit: 2, eligibleOnly: true, discover: true })).rejects.toThrow('already used'); const next = await service.populate({ requestId: 'batch-next', limit: 1, offset: 1, eligibleOnly: true, discover: true }); expect(next).toMatchObject({ total: 2, nextOffset: null, downloaded: 1, results: [{ personId: 'third' }] })
  })
  it('coalesces identical in-flight batches and rejects changed inputs for that identity', async () => {
    person({ photos: ['https://images.example.org/ada.png'] }); let release: (() => void) | undefined; const wait = new Promise<void>(resolve => { release = resolve }), fetch = vi.fn<typeof globalThis.fetch>(async () => { await wait; return new Response(PNG) }), service = new CrmProfileMedia({ db, store: db.crm, blobDir, fetch, lookup })
    const first = service.populate({ requestId: 'flight', limit: 1 }); await vi.waitFor(() => expect(fetch).toHaveBeenCalled()); const second = service.populate({ requestId: 'flight', limit: 1 }); await expect(service.populate({ requestId: 'flight', limit: 2 })).rejects.toThrow('already used'); release!(); expect(await second).toEqual(await first); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('uses only retained, available explicitly attached Reader sources and matching subjects', async () => {
    const text = 'Captured profile', hash = createHash('sha256').update(text).digest('hex'), blobId = `knowledge-${hash}`
    const snapshot: KnowledgeSnapshot = { schemaVersion: 1, revision: 1, sources: [{ id: 'source', externalId: 'web:ada', title: 'Ada', kind: 'document', currentVersionId: 'version', createdAt: 1, updatedAt: 1, excluded: false, aiAllowed: false, tags: [] }], versions: [{ id: 'version', sourceId: 'source', contentHash: hash, originalBlobId: blobId, originalName: 'capture.json', text, createdAt: 1, authoredAt: null, origin: 'capture', metadata: { url: 'https://ada.example.org/', profileImages: [{ url: 'https://images.example.org/wrong.png', isProfile: true, subjectName: 'Other Person' }, { url: 'https://images.example.org/ada.png', isProfile: true, subjectName: 'Ada Example' }, { url: 'https://images.example.org/banner.png', isProfile: false }], profileLinks: [{ url: 'https://x.com/somebodyelse', subjectName: 'Other Person' }, { url: 'https://x.com/ada', subjectName: 'Ada Example' }] } }], passages: [], imports: [], jobs: [], proposals: [] }
    db.putAssetMeta({ id: blobId, kind: 'file', mime: 'application/json', bytes: text.length, createdAt: 1, nodeId: null }); db.putKv('knowledge.v1', snapshot); person({ profileClipSourceId: 'source' }); const service = new CrmProfileMedia({ db, store: db.crm, blobDir, fetch: fetcher(), lookup })
    const result = await service.inspect('ada'); expect(result.photoCandidates.map(value => [value.url, value.automatic])).toEqual([['https://images.example.org/ada.png', true], ['https://images.example.org/banner.png', false]]); expect(result.links.some(value => value.url === 'https://x.com/somebodyelse')).toBe(false)
    snapshot.revision++; snapshot.sources[0].excluded = true; db.putKv('knowledge.v1', snapshot); expect((await service.inspect('ada')).photoCandidates).toEqual([])
  })
  it('discovers an exact existing-profile Reader capture without adding a source reference or editing the contact', async () => {
    person({ urls: ['http://www.linkedin.com/in/AdaExample'] }); const snapshot = capturedReader({ canonicalUrl: 'https://linkedin.com/in/adaexample/', url: 'https://www.linkedin.com/in/adaexample' }); db.putKv('knowledge.v1', snapshot)
    const fetch = fetcher(), service = new CrmProfileMedia({ db, store: db.crm, blobDir, fetch, lookup }), before = structuredClone(db.crm.get('people', 'ada'))
    expect((await service.inspect('ada')).photoCandidates).toEqual([expect.objectContaining({ url: 'https://images.example.org/ada.png', automatic: true, kind: 'captured' })]); expect(db.crm.get('people', 'ada')).toEqual(before); expect(fetch).not.toHaveBeenCalled()
    const result = await service.populatePerson('ada', { requestId: 'reader-save', expectedRecordRevision: 1, photoUrl: 'https://images.example.org/ada.png', sourceUrl: 'https://www.linkedin.com/in/adaexample' }); expect(result.downloaded).toBe(true); expect(result.record.sourceRefs).toEqual([]); expect(await readFile(join(blobDir, result.record.avatarAssetId!))).toEqual(PNG)
  })
  it.each([
    ['wrong subject', { profileImages: [{ url: 'https://images.example.org/ada.png', isProfile: true, subjectName: 'Another Person' }] }],
    ['unannotated image', { profileImages: [{ url: 'https://images.example.org/ada.png', isProfile: true }] }],
    ['preview image', { profileImages: [{ url: 'https://images.example.org/ada.png', isProfile: false, subjectName: 'Ada Example' }] }],
    ['different source URL', { url: 'https://ada.example.org/someone-else' }],
    ['not Reader', { captureMethod: 'document-import' }],
  ])('does not implicitly attach a same-name source with %s', async (_label, metadata) => {
    person(); db.putKv('knowledge.v1', capturedReader(metadata)); const service = new CrmProfileMedia({ db, store: db.crm, blobDir, fetch: fetcher(), lookup }); expect((await service.inspect('ada')).photoCandidates).toEqual([])
  })
  it('allows a subject-bound link to associate its exact Reader profile while generic page images remain review-only', async () => {
    person(); db.putKv('knowledge.v1', capturedReader({ profileImages: [{ url: 'https://images.example.org/banner.png', isProfile: false }], profileLinks: [{ url: 'https://x.com/ada', subjectName: 'Ada Example' }] })); const service = new CrmProfileMedia({ db, store: db.crm, blobDir, fetch: fetcher(), lookup }); const result = await service.inspect('ada'); expect(result.photoCandidates).toEqual([expect.objectContaining({ automatic: false })]); expect(result.links.some(value => value.url === 'https://x.com/ada')).toBe(true); expect(db.crm.get('people', 'ada')?.revision).toBe(1)
  })
  it.each(['excluded', 'deleted', 'purged', 'missing-original', 'invalid-text-hash', 'historical-version'])('rejects implicit Reader media for a source that is %s', async reason => {
    person(); const snapshot = capturedReader(), version = snapshot.versions[0]
    if (reason === 'excluded') snapshot.sources[0].excluded = true
    if (reason === 'deleted') snapshot.sources[0].deleted = true
    if (reason === 'purged') version.originalPurged = true
    if (reason === 'missing-original') db.deleteAssetMeta(version.originalBlobId)
    if (reason === 'invalid-text-hash') version.contentHash = 'f'.repeat(64)
    if (reason === 'historical-version') { snapshot.versions.push({ ...version, id: 'new-current', previousVersionId: version.id, metadata: { ...version.metadata, profileImages: [{ url: 'https://images.example.org/other.png', isProfile: true, subjectName: 'Another Person' }] } }); snapshot.sources[0].currentVersionId = 'new-current' }
    db.putKv('knowledge.v1', snapshot); const service = new CrmProfileMedia({ db, store: db.crm, blobDir, fetch: fetcher(), lookup }); expect((await service.inspect('ada')).photoCandidates).toEqual([])
  })
})
