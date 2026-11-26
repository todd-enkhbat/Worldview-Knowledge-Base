import { educationStatus, employmentStatus } from '../src/crm/affiliationStatus.ts'
import { normalizeProfileUrl } from '../src/crm/model.ts'
import type { CrmAffiliation, CrmCompany, CrmCompanyRoster, CrmPerson } from '../src/crm/types.ts'

const nameKey = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()

export function organizationNameKey(raw: string) {
  const match = raw.trim().match(/^(.+?)\s*\(([A-Z][A-Z0-9.-]{1,10})\)$/)
  if (match) {
    const initials = nameKey(match[1]).split(/[^\p{L}\p{N}]+/u).filter(word => word && !['of', 'the', 'and', 'for', 'at'].includes(word)).map(word => word[0]).join('')
    if (initials === match[2].replace(/[.-]/g, '').toLowerCase()) return nameKey(match[1])
  }
  return nameKey(raw)
}

/** A domain identifies a corporate homepage. Shared platforms identify the organization by path. */
export function organizationUrlKey(value: string): string {
  const canonical = normalizeProfileUrl(/^[\w.-]+\.[a-z]{2,}(?:\/|$)/i.test(value) ? 'https://' + value : value)
  if (!canonical) return ''
  const parsed = new URL(canonical)
  const host = parsed.hostname.replace(/^www\./, '')
  const path = parsed.pathname.replace(/\/$/, '')
  if (/(^|\.)linkedin\.com$/.test(host)) {
    const match = path.match(/^\/(company|school)\/([^/]+)/i)
    return match ? 'linkedin.com/' + match[1].toLowerCase() + '/' + match[2].toLowerCase() : ''
  }
  if (!path && /(^|\.)(github\.com|instagram\.com|x\.com|twitter\.com|facebook\.com|youtube\.com)$/.test(host)) return ''
  return host + path + parsed.search
}

function roleStatus(role: CrmAffiliation): 'education' | 'other' | 'current' | 'former' {
  if (role.kind === 'education') return 'education'
  if (role.kind !== 'employment') return 'other'
  return employmentStatus(role)
}

function schoolAliases(company: CrmCompany): string[] {
  const domain = organizationUrlKey(company.domain), name = organizationNameKey(company.name)
  if (!domain || domain.includes('/') || domain.includes('?')) return []
  // The institution identifies itself as Michigan Tech at https://www.mtu.edu/.
  // Tie its public short name to this exact institution, not other Michigan campuses.
  const names = name === 'michigan technological university' && domain === 'mtu.edu' ? ['Michigan Tech'] : []
  const official = company.sourceRefs.some(source => source.provider === 'profile-capture' && source.url && organizationUrlKey(source.url) === domain)
  if (!official || !['school','university'].includes(company.organizationType ?? '')) return names
  const acronym = company.name.match(/\(([A-Z][A-Z0-9.-]{1,10})\)$/)?.[1]
  if (acronym && name !== nameKey(company.name)) names.push(acronym)
  // Imported, retained first-party schema.org may explicitly supply alternateName.
  const raw = company.raw
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.url === 'string' && organizationUrlKey(raw.url) === domain &&
    typeof raw.name === 'string' && organizationNameKey(raw.name) === name &&
    [raw['@type']].flat().some(type => ['CollegeOrUniversity','School','EducationalOrganization'].includes(String(type)))) {
    for (const alias of [raw.alternateName].flat().slice(0, 12)) if (typeof alias === 'string' && alias.trim().length >= 2 && alias.length <= 120) names.push(alias)
  }
  return names
}

export class CrmOrganizations {
  readonly byId = new Map<string, CrmCompany>()
  private readonly byName = new Map<string, CrmCompany[]>()
  private readonly byAlias = new Map<string, CrmCompany[]>()
  private readonly byUrl = new Map<string, CrmCompany[]>()

  constructor(companies: CrmCompany[]) { for (const company of companies) this.add(company) }

  add(company: CrmCompany) {
    this.byId.set(company.id, company)
    const index = (map: Map<string, CrmCompany[]>, key: string) => {
      if (key) map.set(key, [...(map.get(key) ?? []).filter(row => row.id !== company.id), company])
    }
    index(this.byName, organizationNameKey(company.name))
    for (const alias of schoolAliases(company)) index(this.byAlias, nameKey(alias))
    for (const url of [...company.urls, company.domain]) index(this.byUrl, organizationUrlKey(url))
  }

  candidates(affiliation: Pick<CrmAffiliation, 'organization' | 'organizationUrl' | 'organizationId'>) {
    if (affiliation.organizationId) {
      const exact = this.byId.get(affiliation.organizationId)
      return exact ? [exact] : []
    }
    const url = organizationUrlKey(affiliation.organizationUrl ?? '')
    const name = organizationNameKey(affiliation.organization), direct = url ? this.byUrl.get(url) : undefined
    const named = this.byName.get(name) ?? [], aliases = this.byAlias.get(name)
    if (!aliases?.length) return direct ?? named
    const possible = [...new Map([...named, ...aliases].map(company => [company.id, company])).values()]
    if (!direct) return possible
    if (direct.length !== 1) return direct
    const agreed = direct.filter(row => possible.some(candidate => candidate.id === row.id))
    return agreed.length ? agreed : [...possible, ...direct]
  }

  match(affiliation: CrmAffiliation) {
    const candidates = this.candidates(affiliation)
    if (candidates.length !== 1) return undefined
    const company = candidates[0], url = organizationUrlKey(affiliation.organizationUrl ?? '')
    if (!affiliation.organizationId && url && !this.byUrl.has(url)) {
      if (organizationNameKey(affiliation.organization) !== organizationNameKey(company.name) && this.byAlias.get(organizationNameKey(affiliation.organization))?.some(row => row.id === company.id)) return undefined
      const isLinkedIn = (key: string) => key.startsWith('linkedin.com/')
      const existingKeys = [...company.urls, company.domain].map(organizationUrlKey).filter(Boolean)
      const samePlatform = existingKeys.filter(key => isLinkedIn(key) === isLinkedIn(url))
      // LinkedIn uses numeric IDs and public slugs for the same page. A single exact
      // organization name plus mixed numeric/slug forms can resolve that case.
      const numericAlias = (key: string) => isLinkedIn(url) && isLinkedIn(key) &&
        /^\d+$/.test(url.split('/')[2]) !== /^\d+$/.test(key.split('/')[2])
      if (samePlatform.some(key => !numericAlias(key))) return undefined
    }
    return company
  }

  consolidateHeaders(roles: CrmAffiliation[]) {
    const normalizeRole = (entry: CrmAffiliation) => nameKey(entry.role ?? '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const hidden = new Set<string>(), replacements = new Map<string, CrmAffiliation>()
    for (const header of roles) {
      if (header.kind !== 'employment' || header.startDate || header.endDate || header.current !== true) continue
      const sameSourceTime = new Map(header.evidence.flatMap(item => item.sourceRef?.provider === 'profile-capture'
        ? [[item.sourceRef.externalId, item.sourceRef.observedAt ?? 0] as const] : []))
      if (!sameSourceTime.size) continue
      const headerName = normalizeRole(header), organizationId = this.match(header)?.id
      const matches = roles.filter(role => role.kind === 'employment' && role.startDate &&
        (organizationNameKey(header.organization) === organizationNameKey(role.organization) || organizationId && this.match(role)?.id === organizationId) &&
        (!headerName || normalizeRole(role) === headerName) &&
        role.evidence.some(item => item.sourceRef?.provider === 'profile-capture' && sameSourceTime.has(item.sourceRef.externalId)))
      const active = matches.filter(role => employmentStatus(role) === 'current')
      let detail = active.length === 1 ? active[0] : undefined
      // A later capture can explicitly end the only matching, previously undated role.
      if (!detail && headerName && matches.length === 1 && employmentStatus(matches[0]) === 'former' && matches[0].evidence.some(item => {
        const ref = item.sourceRef
        return ref?.provider === 'profile-capture' && sameSourceTime.has(ref.externalId) && (ref.observedAt ?? 0) > sameSourceTime.get(ref.externalId)!
      })) detail = matches[0]
      if (!detail) continue
      const previous = replacements.get(detail.id) ?? detail
      const evidence = [...new Map([...header.evidence, ...previous.evidence].map(item => [JSON.stringify(item), item])).values()]
      // Fill missing facts in the dated role while preserving its title, dates, and evidence.
      const restored = { ...previous, evidence }
      for (const field of ['organizationLogoUrl','organizationUrl','organizationId','description'] as const) {
        if (!restored[field] && header[field]) restored[field] = header[field]
      }
      replacements.set(detail.id, restored)
      hidden.add(header.id)
    }
    return roles.filter(role => !hidden.has(role.id)).map(role => replacements.get(role.id) ?? role)
  }

  person(person: CrmPerson) {
    const current = new Set(person.companyIds)
    const former = new Set<string>(), confirmed = new Set<string>()
    const affiliations = person.affiliations?.map(affiliation => {
      const company = this.match(affiliation)
      if (!company) return affiliation
      const status = roleStatus(affiliation)
      if (status === 'current') confirmed.add(company.id)
      if (status === 'former') former.add(company.id)
      return affiliation.organizationId === company.id ? affiliation : { ...affiliation, organizationId: company.id }
    })
    for (const id of former) current.delete(id)
    for (const id of confirmed) current.add(id)
    return { ...person, companyIds: [...current], ...(affiliations ? { affiliations } : {}) }
  }

  roster(companyId: string, people: CrmPerson[]): CrmCompanyRoster {
    const educationStatuses: NonNullable<CrmCompanyRoster['educationStatuses']> = Object.create(null)
    const result: CrmCompanyRoster = { current: [], former: [], education: [], other: [], educationStatuses }
    for (const person of people) {
      if (person.archivedAt !== null || person.mergedIntoId) continue
      const resolved = this.person(person)
      const roles = (resolved.affiliations ?? []).filter(entry => entry.organizationId === companyId)
      const statuses = new Set(roles.map(roleStatus))
      if (statuses.has('education')) educationStatuses[person.id] = [...new Set(roles.filter(row => row.kind === 'education').map(educationStatus))]
      // Legacy company lists sometimes include schools as generic organizations.
      // Once affiliations exist, use the actual relationship to assign a roster.
      if (!roles.length && resolved.companyIds.includes(companyId)) statuses.add('current')
      if (statuses.has('current')) statuses.delete('former')
      for (const status of statuses) result[status].push(person)
    }
    return result
  }
}
