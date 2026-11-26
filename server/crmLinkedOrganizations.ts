import { departmentArtwork, universityIdentity } from './universityArtwork.ts'
import { findCompanyArtwork } from './companyArtwork.ts'
import { createHash } from 'node:crypto'
import { organizationUrlKey } from './crmOrganizations.ts'
import { discoverProfileWebsite, selectedWikidataProfile } from './crmProfileDiscovery.ts'
import { companyHomepage as homepage, companySourceEvidence, retainedCompanyDomain } from './crmCompanySourceEvidence.ts'
import { organizationHomepageHost } from './crmProfileUrls.ts'
import { CrmError } from './crmStore.ts'
import { enrichWebsite } from './crmWebsiteEnrichment.ts'
import type { CrmAffiliation, CrmCompany } from '../src/crm/types.ts'

export type OrganizationServices = Parameters<typeof enrichWebsite>[0]
type Services = OrganizationServices
type OrgResult = { id: string; name: string; status: 'updated' | 'unchanged' | 'unresolved' }
export const completeCompanyProfile = (company: CrmCompany) => !!(company.description.trim() && company.domain && company.logoAssetId)
const complete = completeCompanyProfile
const publicId = (url: string) => organizationUrlKey(url).replace(/^linkedin\.com\/(?:company|school)\//, 'linkedin.com/')
const nameKey = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const shortId = (parts: unknown) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0,32)

/** Each pass checks up to three distinct workplaces/schools. Contact details never go into searches. */
export async function enrichLinkedOrganizations(services: Services, personId: string, requestId: unknown, authorize: () => void, offset = 0) {
  if (typeof requestId !== 'string' || !requestId || requestId.length > 150 || !Number.isSafeInteger(offset) || offset < 0) throw new CrmError('Choose a valid organization enrichment request.')
  authorize()
  const { store } = services
  let person = store.get('people', personId)
  if (!person || person.archivedAt !== null || person.mergedIntoId) throw new CrmError('Choose an active contact.', 404)
  if (offset === 0 && person.affiliations?.length) {
    store.command({ requestId: 'organization-links:' + shortId([personId,person.revision,store.revision()]), operation: 'link_profile_organizations', id: personId, expectedRecordRevision: person.revision }, 'profile-capture')
    person = store.get('people', personId)!
  }
  const affiliations = person.affiliations ?? []
  const organizationIds = [...new Set([...person.companyIds, ...affiliations.flatMap(role => role.organizationId ?? [])])]
  const companies = organizationIds.flatMap(id => {
    const company = store.get('companies', id)
    return company && company.archivedAt === null ? [company] : []
  })
  const order = (company: CrmCompany) => person!.companyIds.includes(company.id) ? 0 : affiliations.some(role => role.organizationId === company.id && role.kind === 'education') ? 1 : 2
  companies.sort((a,b) => order(a) - order(b))
  const page = companies.slice(offset, offset + 3)
  const ensureLinked = (companyId: string) => {
    authorize()
    const current = store.get('people', personId)
    if (!current || current.archivedAt !== null || current.mergedIntoId || ![...current.companyIds,...(current.affiliations ?? []).map(role => role.organizationId)].includes(companyId)) throw new CrmError('This contact’s organization links changed during enrichment.', 409)
  }
  const results = await Promise.all(page.map(async company => {
    const current = () => ensureLinked(company.id)
    const role = affiliations.find(row => row.organizationId === company.id && row.organizationLogoUrl && row.evidence.some(item => item.sourceRef?.provider === 'profile-capture'))
    const key = shortId([requestId, personId, company.id])
    return populateCompany(services, company, key, current, role)
  }))
  return { results, total: companies.length, nextOffset: offset + page.length < companies.length ? offset + page.length : null }
}

export async function populateCompany(services: Services, company: CrmCompany, key: string, current: () => void, role?: CrmAffiliation) {
  const base = { id: company.id, name: company.name }
  if (complete(company)) return { ...base, status: 'unchanged' as const, complete: true, failed: false }
  let failed = false
  const unavailable = (error: unknown) => {
    if (!(error instanceof CrmError) || error.status >= 500 || error.status === 404 || /HTTP \d+|requires sign-in|unavailable network|timed? out|timeout/i.test(error.message)) failed = true
  }
  try { await enrichOrganization(company, role, key, services, current, unavailable) }
  catch { current(); failed = true }
  let record = services.store.get('companies', company.id)
  if (services.media && record && !record.logoAssetId && !record.archivedAt) {
    const media=services.media
    let catalog:Awaited<ReturnType<typeof universityIdentity>>
    try {
      catalog=await universityIdentity(record,current,services.fetch)
      current()
      if(catalog && !record.domain && record.revision===services.store.get('companies',record.id)?.revision) {
        services.store.command({operation:'update',collection:'companies',id:record.id,expectedRecordRevision:record.revision,requestId:'org-ror:'+key,
          patch:{domain:catalog.domain,urls:[...new Set([...record.urls,catalog.site])],websiteSource:{provider:'ror',url:catalog.source,label:'Registered university website'}}},'profile-capture')
        record=services.store.get('companies',record.id)!
      }
    } catch {current()}
    const baseline=record
    async function retain(art:{site:string;icons:string[]}|undefined,kind:string) {
      for(const [i,url] of (art?.icons ?? []).entries()) {
        current()
        if(services.store.get('companies',baseline.id)?.revision!==baseline.revision) return false
        try { if(await media.saveProfileImage('company',baseline.id,url,art!.site,'org-'+kind+':'+key+':'+i,current)==='saved') return true } catch {current()}
      }
      return false
    }
    try {
      const saved=await retain(await findCompanyArtwork(record,current,services.fetch),'icon')
      if(!saved && catalog) await retain(await departmentArtwork(catalog,current,services.fetch),'university-mark')
    } catch {current()}
  }
  const after = services.store.get('companies', company.id)
  const changed = after && (after.domain !== company.domain || after.description !== company.description || after.logoAssetId !== company.logoAssetId ||
    after.urls.length !== company.urls.length || after.location !== company.location || after.industry !== company.industry)
  const status: OrgResult['status'] = changed ? 'updated' : 'unresolved'
  return { ...base, status, complete: !!after && complete(after), failed }
}

async function enrichOrganization(company: CrmCompany, role: CrmAffiliation | undefined, key: string, services: Services, current: () => void, unavailable: (error: unknown) => void) {
  const { store, media } = services
  const evidence = companySourceEvidence(company)
  const patch = retainedCompanyDomain(company, evidence)
  if (patch) {
    current()
    store.command({ operation: 'update', collection: 'companies', id: company.id, expectedRecordRevision: company.revision, requestId: 'org-import-site:' + key, patch }, 'profile-capture')
    company = store.get('companies', company.id)!
  }
  if (!company.logoAssetId && media) {
    // A direct capture may already contain the exact source logo even when its
    // original download was interrupted after the record was committed.
    for (const id of (company.profileCaptureIds ?? []).slice(-4).reverse()) {
      const candidate = store.get('candidates', id)
      if (candidate?.provider !== 'profile-capture' || candidate.kind !== 'company' || candidate.archivedAt !== null || candidate.status !== 'accepted' || candidate.targetId !== company.id) continue
      const draft = services.capture.detail(id)
      const image = draft.profile.images.find(item => item.isProfile && item.subjectName === draft.profile.name && (!company.logoUrl || company.logoUrl === item.url))
      if (!image || nameKey(draft.profile.name) !== nameKey(company.name)) continue
      try { await media.saveProfileImage('company', company.id, image.url, draft.source.url, 'org-capture-logo:' + key, current) } catch (error) { current(); unavailable(error) }
      break
    }
  }
  if (evidence?.logoUrl && !company.logoAssetId && media) {
    try { await media.saveProfileImage('company', company.id, evidence.logoUrl, evidence.ref.url || evidence.website || evidence.logoUrl, 'org-import-logo:' + key, current, evidence.ref) }
    catch (error) { current(); unavailable(error) }
  }
  const logoSource = role?.evidence.findLast(item => item.sourceRef?.provider === 'profile-capture')?.sourceRef?.url
  if (!company.logoAssetId && role?.organizationLogoUrl && logoSource && media) {
    try { await media.saveProfileImage('company', company.id, role.organizationLogoUrl, logoSource, 'org-logo:' + key, current) } catch { current() }
  }
  if (complete(store.get('companies',company.id)!)) return
  const storedSites = [...new Map([company.domain, ...company.urls].filter(Boolean).map(homepage).filter(Boolean).map(url => [organizationUrlKey(url), url])).values()]
  if (storedSites.length > 1) return
  const base = { type: 'company', targetId: company.id, name: company.name }
  if (storedSites.length) {
    // Older accepted company captures sometimes have the verified URL but no
    // domain. Recover that field from its retained primary website source.
    if (!company.domain && company.profileCaptureIds?.some(id => {
      const draft = store.get('candidates', id)
      return draft?.status === 'accepted' && draft.provider === 'profile-capture' && draft.kind === 'company' && draft.targetId === company.id &&
        draft.sourceRefs.some(ref => ref.provider === 'profile-capture' && ref.url && organizationUrlKey(ref.url) === organizationUrlKey(storedSites[0]))
    })) {
      current()
      const saved = store.get('companies', company.id)!
      if (!saved.domain) store.command({ operation: 'update', collection: 'companies', id: saved.id, requestId: 'org-domain:' + key, expectedRecordRevision: saved.revision, patch: { domain: organizationUrlKey(storedSites[0]) } }, 'profile-capture')
      if (complete(store.get('companies',company.id)!)) return
    }
    try { await enrichWebsite(services, { ...base, url: storedSites[0], requestId: 'org-site:' + key }, current) } catch (error) { current(); unavailable(error) }
    if (complete(store.get('companies',company.id)!)) return
  }
  const identity = store.get('companies', company.id)
  if (!identity || identity.archivedAt !== null || identity.name !== company.name ||
    company.domain && identity.domain !== company.domain || company.urls.some(url => !identity.urls.includes(url))) return
  const { suggestions } = await discoverProfileWebsite({ entityType: 'company', name: company.name }, services.fetch)
  current()
  const candidates = suggestions.filter(site => !storedSites.length || storedSites.some(stored => organizationUrlKey(stored) === organizationUrlKey(site.url) || organizationHomepageHost(stored) === organizationHomepageHost(site.url)))
  if (candidates.length !== 1) return
  const site = candidates[0]
  if (identity.domain && organizationUrlKey(identity.domain) !== new URL(site.url).hostname.replace(/^www\./, '')) return
  const catalog = await selectedWikidataProfile(site.sourceUrl, site.url, company.name, 'company', services.fetch)
  current()
  const declared = new Set(catalog.profile.urls?.map(publicId).filter(Boolean))
  const sharedProfile = company.urls.some(url => declared.has(publicId(url)))
  const linkedInIds = (urls: string[]) => urls.map(publicId).filter(url => url.startsWith('linkedin.com/')).map(url => url.slice('linkedin.com/'.length))
  const originalIds = linkedInIds(company.urls), catalogIds = linkedInIds(catalog.profile.urls ?? [])
  const hasConflict = (ids: string[]) => originalIds.some(original => ids.some(id => /^\d+$/.test(id) === /^\d+$/.test(original)) && !ids.includes(original))
  if (hasConflict(catalogIds)) return
  let checkedHomepage
  if (!storedSites.length && !sharedProfile) {
    // A name (including a registered alias) needs independent corroboration
    // from the official homepage. Distinct records with that name need review.
    const validNames = new Set([company.name, ...Object.values(catalog.catalogWebsite.labels)].map(nameKey))
    if (store.rows('companies', false).some(other => other.id !== company.id && validNames.has(nameKey(other.name)))) return
    const siteUrl = new URL(site.url)
    const homepages = [site.url]
    if (siteUrl.pathname === '/' && !siteUrl.search && !siteUrl.hostname.startsWith('www.')) {
      siteUrl.hostname = 'www.' + siteUrl.hostname
      homepages.push(siteUrl.href)
    }
    let lastError
    for (const [index, url] of homepages.entries()) {
      try { checkedHomepage = await services.collect.fromUrl({ url, requestId: 'org-official:' + index + key, expectedCompanyName: company.name }, current, catalog.catalogWebsite); break }
      catch (error) { current(); lastError = error }
    }
    if (!checkedHomepage && lastError) unavailable(lastError)
    if (!checkedHomepage || checkedHomepage.profile.entityType !== 'company' || !validNames.has(nameKey(checkedHomepage.profile.name)) ||
      new URL(checkedHomepage.source.url).hostname.replace(/^www\./, '') !== siteUrl.hostname.replace(/^www\./, '') ||
      hasConflict(linkedInIds(checkedHomepage.profile.urls))) return
  }
  if (store.get('companies', company.id)?.revision !== identity.revision) return
  await enrichWebsite(services, { ...base, requestId: 'org-data:' + key, url: site.url, wikidataSourceUrl: site.sourceUrl }, current, { homepage: checkedHomepage, catalog })
}


/** One worker per open workspace. The same user and workspace checks guard every asynchronous write. */
export class OrganizationEnrichmentQueue {
  private readonly pending = new Map<string, () => Promise<void>>()
  private running: Promise<void> | undefined
  enqueue(personId: string, run: () => Promise<void>) {
    this.pending.set(personId, run)
    if (!this.running) this.running = this.drain()
  }
  private async drain() {
    // Let the local contact and portrait save return its receipt before starting discovery.
    await new Promise<void>(resolve => setImmediate(resolve))
    try {
      while (this.pending.size) {
        const [id, run] = this.pending.entries().next().value!
        this.pending.delete(id)
        try { await run() } catch { /* A revoked client or replaced/closed workspace cancels its pending work. */ }
      }
    } finally { this.running = undefined }
  }
  async idle() { await this.running }
}
