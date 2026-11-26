import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCrmHttp } from '../../server/crmHttp.ts'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'

let db: WorldDb, blobDir: string
beforeEach(async () => {
  db = openWorldDb(':memory:'); blobDir = await mkdtemp(join(tmpdir(), 'wv-org-test-'))
  db.putSettings({ T0: 0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: 1, schemaVersion: 1 })
})
afterEach(async () => { db.close(); await rm(blobDir, { recursive: true, force: true }) })
function html(n: string) {
  const name = 'Studio ' + n, url = 'https://studio' + n + '.example.org/'
  const schema = { '@type': 'Organization', name, url, logo: url + 'logo.png', description: 'Official description of ' + name }
  return '<html><head><script type="application/ld+json">' + JSON.stringify(schema) + '</script></head><body><h1>' + name + '</h1></body></html>'
}
function pause() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const person = (count: number) => ({ requestId: crypto.randomUUID(), url: 'https://writer.example.org/about', title: 'Named person', text: 'Named person · Experience', profile: { entityType: 'person', name: 'Named person', affiliations: Array.from({ length: count }, (_, i) => ({
  kind: 'employment', organization: 'Studio ' + i, organizationUrl: 'https://studio' + i + '.example.org/', role: 'Partner', current: true,
})) } })

it('confirms the local save first, checks every employer in batches of three, and keeps working past an unavailable source', async () => {
  let pending = 0, peak = 0
  const gate = pause()
  const request = vi.fn<typeof fetch>(async raw => {
    const url = new URL(String(raw))
    if (url.hostname === 'www.wikidata.org') return Response.json({ search: [] })
    if (url.pathname === '/logo.png') return new Response(Uint8Array.of(137,80,78,71,13,10,26,10), { headers: { 'content-type': 'image/png' } })
    pending++; peak = Math.max(peak, pending)
    await gate.promise; pending--
    const n = url.hostname.match(/^studio(\d+)/)?.[1]
    if (n === '2') return new Response('', { status: 503 })
    return new Response(html(n!), { headers: { 'content-type': 'text/html' } })
  })
  const service = createCrmHttp(db, { store: db.crm, blobDir, profileMediaFetch: request, profileMediaLookup: async () => ['8.8.8.8'] })
  const draft = await service.capture!.stage(person(5))
  const receipt = await service.quickAdd(draft, crypto.randomUUID())
  expect(receipt.status).toBe('saved'); expect(db.crm.rows('companies')).toHaveLength(5)
  expect(request).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(peak).toBe(3))
  gate.resolve(); await service.organizationQueue.idle()
  expect(peak).toBe(3)
  expect(db.crm.rows('companies').map(row => [row.name, !!row.logoAssetId, !!row.description])).toEqual([
    ['Studio 0',true,true],['Studio 1',true,true],['Studio 2',false,false],['Studio 3',true,true],['Studio 4',true,true],
  ])
})

it('cancels enrichment when the initiating pairing is revoked while the website is loading', async () => {
  const gate = pause(), started = pause()
  let active = true
  const request = vi.fn<typeof fetch>(async () => { started.resolve(); await gate.promise; return new Response(html('0'), { headers: { 'content-type': 'text/html' } }) })
  const service = createCrmHttp(db, { store: db.crm, blobDir, profileMediaFetch: request, profileMediaLookup: async () => ['8.8.8.8'] })
  const draft = await service.capture!.stage(person(1))
  await service.quickAdd(draft, crypto.randomUUID(), undefined, () => { if (!active) throw new Error('Pairing revoked') })
  await started.promise
  active = false; gate.resolve(); await service.organizationQueue.idle()
  expect(request).toHaveBeenCalledOnce()
  expect(db.crm.rows('companies')[0]).toMatchObject({ description: '', logoAssetId: null })
  expect(db.crm.rows('candidates')).toHaveLength(1)
})

it.each([
  { id: '314', expectedDomain: 'lumen.example.org' },
  { id: 'other-lab', expectedDomain: '' },
])('requires corroboration for an official alias with a captured LinkedIn ID of $id', async ({ id, expectedDomain }) => {
  const url = 'https://www.lumen.example.org/', canonical = 'Lumen Institute of Applied Research'
  const statement = (value: unknown) => ({ mainsnak: { datavalue: { value } } })
  const entity = {
    labels: { en: { value: canonical } }, aliases: { en: [{ value: 'Lumen' }] }, descriptions: { en: { value: 'Independent research institute' } },
    claims: { P31: [statement({ id: 'Q43229' })], P856: [statement('http://lumen.example.org'), statement(url)], P4264: [statement('lumen-labs')] },
  }
  const request = vi.fn<typeof fetch>(async raw => {
    const site = new URL(String(raw))
    if (site.hostname === 'www.wikidata.org') return Response.json(site.searchParams.get('action') === 'wbsearchentities'
      ? { search: [{ id: 'Q12', label: canonical, match: { text: 'Lumen' }, description: 'Independent research institute' }] }
      : { entities: { Q12: entity } })
    const html = '<head><title>Welcome</title><meta property="og:site_name" content="' + canonical + '"><meta name="description" content="Our first-party research description"></head><main>Visit our research institute</main>'
    return new Response(html, { headers: { 'content-type': 'text/html' } })
  })
  const service = createCrmHttp(db, { store: db.crm, blobDir, profileMediaFetch: request, profileMediaLookup: async () => ['8.8.8.8'] })
  const input = person(1)
  input.profile.affiliations[0] = { kind: 'employment', organization: 'Lumen', organizationUrl: 'https://www.linkedin.com/school/' + id, role: 'Researcher', current: true }
  const draft = await service.capture!.stage(input)
  await service.quickAdd(draft, crypto.randomUUID())
  await service.organizationQueue.idle()
  const [company] = db.crm.rows('companies')
  expect(company.domain).toBe(expectedDomain)
  expect(company.urls).toContain(input.profile.affiliations[0].organizationUrl)
  expect(company.description).toBe(expectedDomain ? 'Our first-party research description' : '')
  expect(company.profileCaptureIds?.length ?? 0).toBe(expectedDomain ? 2 : 0)
})

it('repairs a missing domain from a previously accepted primary website when that site is temporarily unavailable', async () => {
  const url = 'https://www.studio.example.org/'
  const request = vi.fn<typeof fetch>(async () => new Response('', { status: 503 }))
  const service = createCrmHttp(db, { store: db.crm, blobDir, profileMediaFetch: request, profileMediaLookup: async () => ['8.8.8.8'] })
  const draft = await service.capture!.stage({ requestId: 'old-homepage', url, title: 'Studio', text: 'Studio official home', profile: { entityType: 'company', name: 'Studio', urls: [url] } })
  const saved = await service.quickAdd(draft, crypto.randomUUID())
  const company = db.crm.get('companies', saved.recordId!)!
  db.crm.command({ requestId: 'simulate-old-domain-field', operation: 'update', collection: 'companies', id: company.id, expectedRecordRevision: company.revision, patch: { domain: '', urls: [url, 'http://studio.example.org'] } })
  const input = person(1)
  input.profile.affiliations[0] = { kind: 'employment', organization: 'Studio', organizationUrl: url, role: 'Partner', current: true }
  const personDraft = await service.capture!.stage(input)
  await service.quickAdd(personDraft, crypto.randomUUID())
  await service.organizationQueue.idle()
  expect(db.crm.rows('companies')).toHaveLength(1)
  expect(db.crm.get('companies', company.id)).toMatchObject({ domain: 'studio.example.org', name: 'Studio', description: '', profileCaptureIds: [draft.id] })
})

it.each([
  { path: '/de/', foreign: false, conflicting: false, expectDomain: 'uni-beispiel.example.org' },
  { path: '/de/faculty/', foreign: false, conflicting: false, expectDomain: '' },
  { path: '/de/', foreign: true, conflicting: false, expectDomain: '' },
  { path: '/de/', foreign: false, conflicting: true, expectDomain: '' },
])('verifies a localized catalog homepage and rejects conflicting identities ($path, foreign=$foreign, conflicting=$conflicting)', async ({ path, foreign, conflicting, expectDomain }) => {
  const site = 'https://www.uni-beispiel.example.org' + path, name = 'University of Example', local = 'Universität Beispiel'
  const statement = (value: unknown) => ({ mainsnak: { datavalue: { value } } })
  const entry = { labels: { en: { value: name }, de: { value: local } }, descriptions: { en: { value: 'Public university' } },
    claims: { P31: [statement({ id: 'Q3918' })], P856: [statement(site)] } }
  const request = vi.fn<typeof fetch>(async raw => {
    const url = new URL(String(raw))
    if (url.hostname === 'www.wikidata.org') return Response.json(url.searchParams.get('action') === 'wbsearchentities' ? { search: [{ id: 'Q128', label: name }] } : { entities: { Q128: entry } })
    if (foreign && url.hostname === 'www.uni-beispiel.example.org') return new Response(null, { status: 302, headers: { location: 'https://different.example.org/de/' } })
    if (url.pathname === '/logo.png') return new Response(Uint8Array.of(137,80,78,71,13,10,26,10), { headers: { 'content-type': 'image/png' } })
    return new Response('<html lang="de"><head><title>' + local + '</title>' + (conflicting ? '<meta property="og:site_name" content="A Different Institution">' : '') +
      '<meta name="description" content="Offizielle Beschreibung"><link rel="icon" href="/logo.png" type="image/png"></head><main>Willkommen an unserer Universität.</main></html>', { headers: { 'content-type': 'text/html' } })
  })
  const service = createCrmHttp(db, { store: db.crm, blobDir, profileMediaFetch: request, profileMediaLookup: async () => ['8.8.8.8'] })
  const draft = await service.capture!.stage({ requestId: 'campus', url: 'https://faculty.example.org/bio', title: 'Scholar', text: 'PhD, University of Example',
    profile: { entityType: 'person', name: 'Scholar', affiliations: [{ kind: 'education', organization: name, degree: 'PhD' }] } })
  await service.quickAdd(draft, 'campus')
  await service.organizationQueue.idle()
  const [school] = db.crm.rows('companies')
  expect(school.name).toBe(name)
  expect(school.domain).toBe(expectDomain)
  expect(!!school.logoAssetId).toBe(!!expectDomain)
  expect(school.description).toBe(expectDomain ? 'Offizielle Beschreibung' : '')
  expect(school.profileCaptureIds?.length ?? 0).toBe(expectDomain ? 2 : 0)
})
