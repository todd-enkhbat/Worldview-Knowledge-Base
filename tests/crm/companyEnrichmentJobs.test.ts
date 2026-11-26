import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'
import { createCrmHttp } from '../../server/crmHttp.ts'

let directory: string, db: WorldDb
const settings = { T0: 0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto' as const, firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: 1, schemaVersion: 1 as const }
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'worldview-company-jobs-')); db = openWorldDb(join(directory, 'world.sqlite')); db.putSettings(settings) })
afterEach(async () => { if (db.db.isOpen) db.close(); await rm(directory, { force: true, recursive: true }) })
const record = (n: number) => ({ id: 'company-' + n, name: 'Lab ' + n, urls: ['https://lab' + n + '.example.org/'] })
const build = (request: typeof fetch) => createCrmHttp(db, { store: db.crm, blobDir: directory, profileMediaFetch: request, profileMediaLookup: async () => ['8.8.8.8'] })
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { resolve, promise }
}
const page: typeof fetch = async raw => {
  const url = new URL(String(raw))
  if (url.hostname === 'www.wikidata.org') return Response.json({ search: [] })
  if (url.pathname === '/logo.png') return new Response(Uint8Array.of(137,80,78,71,13,10,26,10), { headers: { 'content-type': 'image/png' } })
  if (url.hostname === 'lab6.example.org') return new Response('', { status: 503 })
  const n = Number(url.hostname.match(/lab(\d+)/)?.[1])
  const source = record(n)
  const schema = { '@type': 'Organization', name: source.name, url: source.urls[0], description: 'Our official homepage description', ...(n === 5 ? {} : { logo: '/logo.png' }) }
  return new Response('<main><h1>' + source.name + '</h1></main><script type="application/ld+json">' + JSON.stringify(schema) + '</script>', { headers: { 'content-type': 'text/html' } })
}

describe('durable organization population', () => {
  it('freezes the active list, checkpoints and resumes in a reopened SQLite database while retaining manual values', async () => {
    db.crm.command({ operation: 'import', requestId: 'old-companies', collections: { companies: Array.from({ length: 8 }, (_, i) => ({ ...record(i), ...(i === 0 ? { description: 'My private notes' } : {}), ...(i === 7 ? { archivedAt: 10 } : {}) })) } })
    const hold = gate(), started = gate()
    let concurrent = 0, peak = 0
    const firstRequest = vi.fn<typeof fetch>(async raw => {
      const host = new URL(String(raw)).hostname
      if (['lab3.example.org','lab4.example.org','lab5.example.org'].includes(host)) { concurrent++; peak = Math.max(peak, concurrent); if (peak === 3) started.resolve(); await hold.promise; concurrent-- }
      return page(raw)
    })
    const first = build(firstRequest), jobs = first.companyJobs!
    expect(jobs.status().state).toBe('idle')
    const begun = jobs.start('backfill')
    expect(begun).toMatchObject({ state: 'running', total: 7, processed: 0 })
    expect(firstRequest).not.toHaveBeenCalled()
    expect(jobs.start('another-click').runId).toBe(begun.runId)
    await started.promise
    expect(jobs.status()).toMatchObject({ state: 'running', total: 7, processed: 3, updated: 3 })
    jobs.close(); db.close(); hold.resolve(); await first.organizationQueue.idle()
    db = openWorldDb(join(directory, 'world.sqlite'))
    const resumedRequest = vi.fn<typeof fetch>(page)
    const resumed = build(resumedRequest)
    await resumed.organizationQueue.idle()
    expect(resumed.companyJobs!.status()).toMatchObject({ state: 'complete', runId: begun.runId, total: 7, processed: 7, remaining: 0, updated: 6, unresolved: 1, failed: 1, completeRecords: 5, partial: 2 })
    expect(resumedRequest.mock.calls.some(([url]) => new URL(String(url)).hostname === 'lab0.example.org')).toBe(false)
    expect(db.crm.get('companies','company-0')).toMatchObject({ name: 'Lab 0', description: 'My private notes', domain: 'lab0.example.org' })
    expect(resumed.companyJobs!.start('backfill').runId).toBe(begun.runId)
    expect(db.crm.get('companies','company-7')?.domain).toBe('')
    resumed.companyJobs!.close()
  })
  it('automatically fills direct profile saves, typed companies and imported companies without starting a list scan', async () => {
    const service = build(page)
    db.crm.command({ operation: 'create', requestId: 'manual', collection: 'companies', record: record(0) })
    db.crm.command({ operation: 'import', requestId: 'file', collections: { companies: [record(1)] } })
    const direct = await service.capture!.stage({ requestId: 'direct', title: 'Lab 2', text: 'Lab 2 company page', url: 'https://linkedin.com/company/lab-two', profile: { entityType: 'company', name: 'Lab 2', urls: record(2).urls } })
    const saved = await service.quickAdd(direct, 'direct-save')
    expect(saved.status).toBe('saved')
    await service.organizationQueue.idle()
    const companies = db.crm.rows('companies')
    expect(companies).toHaveLength(3)
    expect(companies.every(company => company.logoAssetId && company.domain && company.description)).toBe(true)
    expect(service.companyJobs!.status().state).toBe('idle')
    service.companyJobs!.close()
  })
})

it('recovers only identity-bound Folk website and logo fields, recording where each came from', async () => {
  const source = (id: string) => ({ provider: 'folk', accountId: 'imported-workspace', externalId: id })
  const retained = (id: string, name: string, urls: string[], fields: Record<string, unknown> = {}) =>
    ({ id, name, urls, description: 'Keep my description', sourceRefs: [source(id)], raw: { id, name, urls, ...fields } })
  const accepted = retained('research', 'Acme Research', ['https://acmeresearch.org', 'https://www.linkedin.com/company/acme-research/'])
  const explicit = retained('studio', 'Old Studio', [], { website: 'https://studio.example.org', logo: { url: 'https://media.example.org/logo.png' } })
  const directoryOnly = retained('wrong-target', 'Directory Only', ['https://directoryonly.com', 'https://www.linkedin.com/company/unrelated'])
  const mismatch = retained('reused', 'Different name', [], { id: 'unrelated', website: 'https://unrelated.example.org', logoUrl: 'https://media.example.org/unrelated.png' })
  const service = build(async raw => new URL(String(raw)).pathname === '/logo.png' ? page(raw) : new Response('', { status: 503 }))
  db.crm.command({ operation: 'import', requestId: 'import-evidence', collections: { companies: [accepted, explicit, directoryOnly, mismatch] } })
  await service.organizationQueue.idle()
  expect(db.crm.get('companies', 'research')).toMatchObject({ domain: 'acmeresearch.org', websiteSource: { sourceRef: expect.objectContaining(source('research')) } })
  const saved = db.crm.get('companies', 'studio')!
  expect(saved).toMatchObject({ domain: 'studio.example.org', description: 'Keep my description', urls: ['https://studio.example.org/'], logoSource: { provider: 'folk', sourceRef: expect.objectContaining(source('studio')), url: 'https://media.example.org/logo.png' } })
  expect(db.getAssetMeta(saved.logoAssetId!)?.mime).toBe('image/png')
  for (const id of ['wrong-target', 'reused']) expect(db.crm.get('companies', id)).toMatchObject({ domain: '', logoAssetId: null })
  service.companyJobs!.close()
})

it('recovers a directly captured company logo from its accepted source after the first download fails', async () => {
  let images = 0
  const service = build(async raw => {
    if (new URL(String(raw)).pathname === '/logo.png' && ++images === 1) return new Response('', { status: 503 })
    return page(raw)
  })
  const sourceUrl = 'https://linkedin.com/company/independent-research'
  const draft = await service.capture!.stage({ requestId: 'logo-source', title: 'Independent Research', text: 'Independent Research company page', url: sourceUrl, profile: {
    entityType: 'company', name: 'Independent Research', images: [{ url: 'https://images.example.org/logo.png', isProfile: true, subjectName: 'Independent Research' }],
  } })
  const first = await service.quickAdd(draft, 'logo-failed')
  expect(first).toMatchObject({ status: 'saved', image: 'unavailable' })
  await service.organizationQueue.idle()
  const saved = db.crm.get('companies', first.recordId!)!
  expect(saved.logoAssetId).toBeTruthy()
  expect(saved.logoSource).toMatchObject({ url: 'https://images.example.org/logo.png', sourceUrl })
  expect(images).toBe(2)
  service.companyJobs!.close()
})

it('recovers corroborated domains in a local-only idempotent command without scheduling Internet work', async () => {
  const retained = (id: string, fields: Record<string, unknown> = {}) => ({ id, name: id, urls: ['https://' + id + '.org/'], sourceRefs: [{ provider: 'folk', accountId: 'demo', externalId: id }], raw: { id, name: id, urls: ['https://' + id + '.org/','https://www.linkedin.com/company/' + id] }, ...fields })
  db.crm.command({ operation: 'import', requestId: 'retained', collections: { companies: [retained('foundry'), retained('manual', { domain: 'user-entered.org' }), retained('removed', { urls: [] }), retained('archived', { archivedAt: 52 })] } })
  const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 503 }))
  const service = build(fetcher)
  const args = { operation: 'recover_company_domains', requestId: 'offline' }
  expect(db.crm.command(args)).toMatchObject({ counts: { examined: 2, recovered: 1 } })
  expect(db.crm.command(args)).toMatchObject({ replayed: true, counts: { examined: 2, recovered: 1 } })
  expect(db.crm.command({ ...args, requestId: 'offline-again' })).toMatchObject({ counts: { examined: 1, recovered: 0 } })
  await service.organizationQueue.idle()
  expect(fetcher).not.toHaveBeenCalled()
  expect(db.crm.get('companies','foundry')).toMatchObject({ domain: 'foundry.org', websiteSource: { provider: 'folk' } })
  expect(db.crm.get('companies','removed')?.domain).toBe('')
  expect(db.crm.get('companies','manual')?.domain).toBe('user-entered.org')
  service.companyJobs!.close()
})
