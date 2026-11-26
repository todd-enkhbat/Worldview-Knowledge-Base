import type { CrmCompany, CrmPerson } from './types.ts'

export function organizationClusters(people: CrmPerson[], companies: CrmCompany[]) {
  const normalize = (value:string) => value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase()
  const names = new Map(companies.map(c=>[c.id,c.name]))
  const idsByName = new Map<string,string|null>()
  for (const c of companies) {
    const key = normalize(c.name)
    idsByName.set(key,idsByName.has(key) ? null : c.id)
  }
  const byPerson = new Map<string,Set<string>>(), byOrg = new Map<string,Set<string>>()
  for (const person of people) {
    if (person.archivedAt || person.mergedIntoId) continue
    const ids = new Set(person.companyIds.filter(id=>names.has(id)))
    for (const a of person.affiliations ?? []) {
      if (a.organizationId && names.has(a.organizationId)) { ids.add(a.organizationId); continue }
      const key = normalize(a.organization || '')
      if (!key || idsByName.get(key) === null) continue
      const id = idsByName.get(key) ?? 'affiliation:'+key
      ids.add(id); if (!names.has(id)) names.set(id,a.organization.trim())
    }
    byPerson.set(person.id,ids)
    for (const id of ids) {
      const members=byOrg.get(id) ?? new Set<string>()
      members.add(person.id); byOrg.set(id,members)
    }
  }
  return {names,byPerson,byOrg}
}
