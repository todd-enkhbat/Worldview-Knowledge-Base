import { isIP } from 'node:net'
import type { CrmCompany } from '../src/crm/types.ts'
import { profilePlatform, publicProfileUrl } from './crmProfileUrls.ts'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const key = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
const brandKey = (value: string) => key(value.replace(/(?:[,\s]+(?:inc\.?|llc|ltd\.?|corp\.?|corporation|limited))$/i, ''))
export function companyHomepage(raw: unknown) {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  const url = publicProfileUrl(raw.includes('://') ? raw.trim() : 'https://' + raw.trim())
  if (!url || profilePlatform(url) !== 'website') return ''
  const parsed = new URL(url)
  if (parsed.pathname !== '/' || parsed.search || !parsed.hostname.includes('.') || isIP(parsed.hostname) ||
    /(^|\.)(?:wikipedia\.org|wikidata\.org|crunchbase\.com|pitchbook\.com|linktr\.ee|gmail\.com|outlook\.com|yahoo\.com|google\.com|app\.folk\.app)$/i.test(parsed.hostname)) return ''
  parsed.protocol = 'https:'
  return parsed.href
}
const host = (url: string) => new URL(url).hostname.replace(/^www\./, '')

/** Folk's plain URLs can contain investors, press, or directories. Recover a
 * homepage only from explicit fields or independent company-bound identifiers. */
export function companySourceEvidence(company: CrmCompany) {
  const raw = company.raw
  if (!object(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string' || key(raw.name) !== key(company.name)) return
  const ref = company.sourceRefs.find(source => source.provider === 'folk' && source.externalId === raw.id)
  if (!ref) return
  const explicit = [...new Map([raw.website, raw.websiteUrl, raw.domain].map(companyHomepage).filter(Boolean).map(url => [host(url), url])).values()]
  const imported = Array.isArray(raw.urls) ? raw.urls.filter((url): url is string => typeof url === 'string').slice(0, 100) : []
  const homepages = [...new Map(imported.map(companyHomepage).filter(Boolean).map(url => [host(url), url])).values()]
  let website = explicit.length === 1 ? explicit[0] : '', websiteLabel = 'Official website field retained from Folk'
  if (!explicit.length && homepages.length === 1) {
    const candidate = homepages[0], domain = host(candidate), labels = domain.split('.')
    const simpleDomain = labels.length === 2 || labels.length === 3 && labels[2].length === 2 && ['ac','co','com','org','net','edu','gov'].includes(labels[1])
    const brand = brandKey(raw.name), matchesBrand = simpleDomain && key(labels[0]) === brand && brand.length >= 2
    const linked = imported.some(value => {
      const link = publicProfileUrl(value)
      if (!link || profilePlatform(link) !== 'linkedin') return false
      const slug = new URL(link).pathname.match(/^\/(?:company|school)\/([^/]+)\/?$/i)?.[1]
      return !!slug && !/^\d+$/.test(slug) && brandKey(slug.replace(/-/g, ' ')) === brand
    })
    const email = Array.isArray(raw.emails) && raw.emails.some(value => typeof value === 'string' && value.toLowerCase().trim().split('@').at(-1) === domain && value.includes('@'))
    const stillPresent = company.urls.some(url => { const root = companyHomepage(url); return root && host(root) === domain })
    if (stillPresent && matchesBrand && (linked || email)) {
      website = candidate
      websiteLabel = 'Imported homepage corroborated by the company name and ' + (linked ? 'its LinkedIn company profile' : 'its company email domain')
    }
  }
  const existingDomains = new Set([company.domain, ...company.urls].map(companyHomepage).filter(Boolean).map(host))
  if (website && existingDomains.size && (existingDomains.size !== 1 || !existingDomains.has(host(website)))) website = ''
  const logo = raw.logo
  const logoValue = raw.logoUrl ?? (object(logo) ? logo.default || logo.isDefault ? undefined : logo.url || logo.contentUrl : logo)
  const logoUrl = publicProfileUrl(logoValue)
  return { ref, website, websiteLabel, domain: website ? host(website) : '', logoUrl: logoUrl && (!company.logoUrl || publicProfileUrl(company.logoUrl) === logoUrl) ? logoUrl : '' }
}

export function retainedCompanyDomain(company: CrmCompany, evidence = companySourceEvidence(company)) {
  if (company.domain || !evidence?.website) return
  const websiteSource = { provider: 'folk', sourceRef: evidence.ref, url: evidence.website, label: evidence.websiteLabel }
  const alreadyLinked = company.urls.some(url => { const root = companyHomepage(url); return root && host(root) === evidence.domain })
  return { domain: evidence.domain, urls: alreadyLinked ? company.urls : [...company.urls, evidence.website], websiteSource }
}
