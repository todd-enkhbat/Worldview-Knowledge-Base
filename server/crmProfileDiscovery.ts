import type { CapturedProfileData } from '../src/crm/profileCaptureTypes.ts'
import { isIP } from 'node:net'
import { CrmError } from './crmStore.ts'
import { publicProfileUrl } from './crmProfileMedia.ts'
import { isPrivateAddress } from './fetchUrl.ts'

export interface WebsiteSuggestion { name: string; description: string; url: string; sourceUrl: string; source: 'Wikidata' }
interface Hit { id: string; label?: string; description?: string; match?: { text?: string } }
interface Statement { rank?: string; mainsnak?: { datavalue?: { value?: unknown } }; qualifiers?: Record<string, unknown[]> }
interface WikidataEntity { labels?: Record<string, { value?: string }>; aliases?: { en?: { value?: string }[] }; descriptions?: { en?: { value?: string } }; lastrevid?: number; claims?: Record<string, Statement[]> }

const nameKey = (raw: string) => raw.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const organizationTypes = new Set(['Q43229', 'Q4830453', 'Q783794', 'Q891723', 'Q6881511', 'Q163740', 'Q192350', 'Q3357251', 'Q3918', 'Q3914', 'Q79913', 'Q16333333'])
const organizationDescription = /\b(company|firm|corporation|manufacturer|organization|organisation|startup|university|school|institute|nonprofit|foundation|business|agency|association|bank|publisher)\b/i

async function wikidata<T>(query: Record<string, string>, request: typeof fetch): Promise<T> {
  const url = new URL('https://www.wikidata.org/w/api.php')
  url.search = new URLSearchParams({ ...query, format: 'json' }).toString()
  try {
    const response = await request(url, { headers: { accept: 'application/json', 'user-agent': 'Worldview-CRM/1.0 (https://github.com/todd-enkhbat/Worldview-Knowledge-Base)' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(12000) })
    if (!response.ok) throw new Error()
    const reader = response.body?.getReader()
    if (!reader) throw new Error()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > 6 * 1024 * 1024) { await reader.cancel(); throw new Error() }
      chunks.push(value)
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!data || typeof data !== 'object' || data.error) throw new Error()
    return data as T
  } catch { throw new CrmError('Wikidata could not finish the website lookup. Try again or enter a website.', 502) }
}

function values(entity: WikidataEntity, key: string): unknown[] {
  const claims = (entity.claims?.[key] ?? []).filter(claim => claim.rank !== 'deprecated' && !claim.qualifiers?.P582?.length)
  const preferred = claims.filter(claim => claim.rank === 'preferred')
  return (preferred.length ? preferred : claims).map(claim => claim.mainsnak?.datavalue?.value)
}

function matchesType(entity: WikidataEntity, description: string, type: 'company' | 'person') {
  const classes = entityIds(entity, 'P31')
  const human = classes.includes('Q5')
  return type === 'person' ? human : !human && (classes.some(id => organizationTypes.has(id)) || values(entity, 'P452').length > 0 || values(entity, 'P159').length > 0 || organizationDescription.test(description))
}
function entityIds(entity: WikidataEntity, property: string) {
  return values(entity, property).flatMap(value => typeof value === 'object' && value && 'id' in value && /^Q\d+$/.test(String(value.id)) ? [String(value.id)] : [])
}

/** The only third-party query input is the name the user chose to look up. */
export async function discoverProfileWebsite(input: Record<string, unknown>, request: typeof fetch = fetch) {
  if (input.entityType !== 'person' && input.entityType !== 'company' || typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.length > 200)
    throw new CrmError('Enter a person or company name between 2 and 200 characters.')
  const name = input.name.trim()
  const result = await wikidata<{ search: Hit[] }>({ action: 'wbsearchentities', language: 'en', type: 'item', limit: '10', search: name }, request)
  const hits = result.search.filter(hit => /^Q\d+$/.test(hit.id) && [hit.label, hit.match?.text].some(value => value && nameKey(value) === nameKey(name))).slice(0, 5)
  const suggestions: WebsiteSuggestion[] = []
  if (!hits.length) return { suggestions }
  const { entities } = await wikidata<{ entities: Record<string, WikidataEntity> }>({ action: 'wbgetentities', ids: hits.map(hit => hit.id).join('|'), props: 'claims' }, request)
  for (const hit of hits) {
    const entity = entities[hit.id]
    if (!entity) continue
    const description = hit.description ?? ''
    if (!matchesType(entity, description, input.entityType)) continue
    // Wikidata often records the same homepage with http/https and www/apex.
    // Group variants within an item only. Two distinct items stay distinct.
    const sites = new Map<string, string>()
    for (const value of values(entity, 'P856')) {
      const url = publicProfileUrl(value)
      if (!url) continue
      const page = new URL(url), hostname = page.hostname.replace(/^\[|\]$/g, '')
      if (!hostname.includes('.') || isIP(hostname) && isPrivateAddress(hostname)) continue
      const key = hostname.replace(/^www\./, '') + page.pathname.replace(/\/$/, '') + page.search
      const previous = sites.get(key)
      if (!previous || !previous.startsWith('https:') && page.protocol === 'https:') sites.set(key, url)
    }
    const distinctSites = [...sites.values()].filter(raw => {
      const url = new URL(raw), host = url.hostname.replace(/^www\./, '')
      if (!sites.has(host) || url.pathname === '/' && !url.search) return true
      // A language version is equivalent only when the item separately declares
      // that same host's root. Other landing pages can identify distinct units.
      const locale = /^[a-z]{2}(?:[-_][a-z]{2,4})?$/i
      const path = url.pathname.replace(/^\/|\/$/g, '')
      return !(path === '' || locale.test(path)) || [...url.searchParams].some(([key, value]) => !['lang', 'locale'].includes(key) || !locale.test(value))
    })
    for (const url of distinctSites.slice(0, 3)) {
      suggestions.push({ name: hit.label ?? name, description: description.slice(0, 500), url, sourceUrl: 'https://www.wikidata.org/wiki/' + hit.id, source: 'Wikidata' })
    }
  }
  return { suggestions }
}


/** Re-read the user's selection so only Wikidata's own named subject and current statements supply fields. */
export async function selectedWikidataProfile(sourceUrl: unknown, website: unknown, name: string, type: 'company' | 'person', request: typeof fetch = fetch) {
  const id = typeof sourceUrl === 'string' && sourceUrl.match(/^https:\/\/www\.wikidata\.org\/wiki\/(Q[1-9]\d*)$/)?.[1]
  if (!id) throw new CrmError('Select a website from the Wikidata results.')
  const { entities } = await wikidata<{ entities: Record<string, WikidataEntity> }>({ action: 'wbgetentities', ids: id, props: 'labels|descriptions|aliases|claims|info', ...(type === 'person' ? { languages: 'en' } : {}) }, request)
  const entity = entities[id], description = entity?.descriptions?.en?.value ?? ''
  const names = [entity?.labels?.en?.value, ...(entity?.aliases?.en ?? []).map(alias => alias.value)]
  const officialUrl = publicProfileUrl(website)
  if (!entity || !officialUrl || !names.some(label => label && nameKey(label) === nameKey(name)) ||
      !matchesType(entity, description, type) || !values(entity, 'P856').some(url => publicProfileUrl(url) === officialUrl))
    throw new CrmError('This Wikidata entry no longer matches the selected name, type and website. Search again.', 409)
  const locationIds = entityIds(entity, type === 'company' ? 'P159' : 'P551').slice(0, 5)
  const industryIds = type === 'company' ? entityIds(entity, 'P452').slice(0, 5) : []
  const ids = [...new Set([...locationIds, ...industryIds])]
  const labels = ids.length ? (await wikidata<{ entities: Record<string, WikidataEntity> }>({ action: 'wbgetentities', ids: ids.join('|'), props: 'labels', languages: 'en' }, request)).entities : {}
  const label = (ids: string[]) => ids.flatMap(key => labels[key]?.labels?.en?.value ?? [])
  const urls = [officialUrl]
  const platforms = { [type === 'company' ? 'P4264' : 'P6634']: type === 'company' ? 'https://www.linkedin.com/company/' : 'https://www.linkedin.com/in/', P2002: 'https://x.com/', P2003: 'https://www.instagram.com/' }
  for (const [key, prefix] of Object.entries(platforms)) {
    for (const handle of values(entity, key).slice(0, 3)) if (typeof handle === 'string' && /^[\w.-]{1,100}$/.test(handle)) urls.push(prefix + encodeURIComponent(handle))
  }
  const filename = values(entity, type === 'company' ? 'P154' : 'P18').find((value): value is string => typeof value === 'string' && value.length <= 250 && !value.includes('/'))
  const profile: CapturedProfileData = { entityType: type, name, description, urls, location: locationIds.length === 1 ? label(locationIds)[0] ?? '' : '', industry: label(industryIds).join(', '),
    images: filename ? [{ url: 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(filename) + '?width=256', subjectName: name, label: type === 'company' ? 'Wikidata logo' : 'Wikidata portrait', isProfile: true }] : [] }
  const companyLabels = Object.fromEntries(Object.entries(entity.labels ?? {}).flatMap(([language, label]) =>
    /^[a-z]{2,3}(?:-[a-z0-9]+)*$/i.test(language) && typeof label.value === 'string' && label.value.length <= 400 ? [[language.toLowerCase(), label.value]] : []))
  const catalogWebsite = { url: officialUrl, labels: companyLabels }
  const text = JSON.stringify({ id, revision: entity.lastrevid, name, description, officialUrl, ...(type === 'company' ? { companyLabels } : {}), locationIds, industryIds, labels, urls, filename, profile }, null, 2)
  return { url: String(sourceUrl), title: name + ' · Wikidata', text, profile, canonicalName: entity.labels?.en?.value || name, catalogWebsite }
}
