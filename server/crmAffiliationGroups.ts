import { employmentStatus } from '../src/crm/affiliationStatus.ts'
import type { CrmAffiliation, CrmGroup, CrmMembership, CrmPerson } from '../src/crm/types.ts'
import type { SqliteCrmStore } from './crmStore.ts'
import { organizationNameKey } from './crmOrganizations.ts'

const normalized = (name: string) => organizationNameKey(name.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})]+$/gu, ''))
const institutionalName = /\b(?:university|college|polytechnic|institute of technology)\b/i
const columbia = 'columbia university'
const mit = 'massachusetts institute of technology'
function institution(name: string) {
  const value = normalized(name)
  if (value === 'mit' || value === mit) return mit
  if ([columbia, 'columbia', 'columbia university in the city of new york'].includes(value)) return columbia
  return institutionalName.test(value) ? value : ''
}
export function institutionGroup(group?: Pick<CrmGroup, 'name'> | null) { return group ? institution(group.name) : '' }

function schoolOf(row: CrmAffiliation, store: SqliteCrmStore) {
  const org = row.organizationId ? store.get('companies', row.organizationId) : undefined
  if (row.organizationId && (!org || org.archivedAt !== null)) return ''
  const name = org?.name || row.organization
  const domain = org?.domain || row.organizationUrl || ''
  let host = '', linkedInSlug = ''
  try {
    const page = new URL(domain.includes('://') ? domain : 'https://' + domain)
    host = page.hostname.toLowerCase()
    if (/(^|\.)linkedin\.com$/.test(host)) linkedInSlug = page.pathname.match(/^\/(?:school|company)\/([^/]+)/i)?.[1]?.toLowerCase() || ''
  } catch { /* A school name can be sufficient on its own. */ }
  if (host === 'columbia.edu' || host.endsWith('.columbia.edu')) return columbia
  if (host === 'mit.edu' || host.endsWith('.mit.edu')) return mit
  // A bare ambiguous employer brand (e.g. Columbia Sportswear vs. Columbia
  // University) cannot establish a school connection on its own.
  if (['columbia', 'mit'].includes(normalized(name))) {
    if (host && !/(^|\.)linkedin\.com$/.test(host)) return ''
    if (linkedInSlug && !/^\d+$/.test(linkedInSlug) && !['mit','massachusetts-institute-of-technology','columbia-university','columbia-university-in-the-city-of-new-york'].includes(linkedInSlug)) return ''
    if (row.kind !== 'education' && org?.organizationType !== 'school' && org?.organizationType !== 'university') return ''
  }
  return institution(name)
}

type SaveMembership = (values: Record<string, unknown>, before?: CrmMembership) => void
/** Manual assignments and explicit removals take precedence over affiliation rules. */
export function reconcileAffiliationGroups(store: SqliteCrmStore, people: CrmPerson[], save: SaveMembership, now: number) {
  const groups = new Map<string, string[]>()
  for (const group of store.rows('groups', false)) {
    const key = institutionGroup(group)
    if (key && store.groupSupports(group, 'person')) groups.set(key, [...(groups.get(key) ?? []), group.id])
  }
  if (!groups.size && !store.world.db.prepare("SELECT 1 FROM crm_rows WHERE collection='memberships' AND archived=0 AND json_type(body,'$.affiliationRule')='text' LIMIT 1").get()) return
  // A group called Trinity College cannot distinguish two schools in different
  // cities that use that same name. Each still has its own institution roster.
  const seen = new Set<string>()
  for (const org of groups.size ? store.rows('companies', false) : []) {
    const key = institution(org.name)
    if (!key || key === columbia || key === mit) continue
    if (seen.has(key)) groups.delete(key)
    seen.add(key)
  }
  const memberships = new Map<string, CrmMembership[]>()
  const targets = new Set(people.map(person => person.id))
  for (const member of store.rows('memberships')) {
    if (member.entityType === 'person' && targets.has(member.entityId)) {
      const existing = memberships.get(member.entityId) ?? []
      existing.push(member); memberships.set(member.entityId, existing)
    }
  }
  for (const person of people) {
    const wanted = new Map<string, string>()
    for (const role of person.archivedAt || person.mergedIntoId ? [] : person.affiliations ?? []) {
      if (role.kind !== 'education' && !(role.kind === 'employment' && employmentStatus(role) === 'current')) continue
      const candidates = groups.get(schoolOf(role, store))
      if (candidates?.length === 1) wanted.set(candidates[0], role.id)
    }
    const existing = memberships.get(person.id) ?? []
    for (const member of existing) if (!member.affiliationRule || member.ruleExcluded) wanted.delete(member.groupId)
    for (const member of existing) {
      const managed = typeof member.affiliationRule === 'string'
      if (!managed || member.ruleExcluded) { wanted.delete(member.groupId); continue }
      const evidence = wanted.get(member.groupId)
      if (!evidence && member.archivedAt === null) save({ archivedAt: now }, member)
      if (evidence && (member.archivedAt !== null || member.affiliationRule !== evidence)) save({ archivedAt: null, affiliationRule: evidence }, member)
      wanted.delete(member.groupId)
    }
    for (const [groupId, roleId] of wanted) save({ entityId: person.id, entityType: 'person', groupId, affiliationRule: roleId })
  }
}
