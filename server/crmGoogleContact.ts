import { crmHash, crmUrl } from './crmConnectionParsers.ts'
import type { CrmAffiliation, CrmSourceRef } from '../src/crm/types.ts'

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max = 1000) => typeof v === 'string' ? v.trim().slice(0, max) : ''
function date(value: unknown) {
  if (!isObject(value) || !Number.isInteger(value.year) || Number(value.year) < 1 || Number(value.year) > 9999) return ''
  const year = String(value.year).padStart(4, '0')
  if (!Number.isInteger(value.month) || Number(value.month) < 1 || Number(value.month) > 12) return year
  const prefix = year + '-' + String(value.month).padStart(2, '0')
  return Number.isInteger(value.day) && Number(value.day) > 0 && Number(value.day) <= 31 ? prefix + '-' + String(value.day).padStart(2, '0') : prefix
}

/** Google distinguishes an organization's office from the contact's own addresses. */
export function googleContactDetails(raw: Record<string, unknown>, sourceRef: CrmSourceRef) {
  const ordered = (key: string) => Array.isArray(raw[key]) ? raw[key].filter(isObject).sort((a, b) => Number(isObject(b.metadata) && b.metadata.primary === true) - Number(isObject(a.metadata) && a.metadata.primary === true)) : []
  const addresses = ordered('addresses')
  const city = (address: Record<string, unknown>) => [text(address.city), text(address.region), text(address.country) || text(address.countryCode)].filter(Boolean).join(', ')
  const address = addresses.find(a => a.type === 'home' && city(a)) ?? addresses.find(a => a.type !== 'work' && city(a))
  const roles = new Map<string, CrmAffiliation>()
  for (const org of ordered('organizations').slice(0, 500)) {
    const organization = text(org.name)
    if (!organization) continue
    const kind = org.type === 'school' ? 'education' : !org.type || org.type === 'work' ? 'employment' : 'membership'
    const role = text(org.title), startDate = date(org.startDate), endDate = date(org.endDate)
    const id = 'google-org-' + crmHash(JSON.stringify([sourceRef.accountId, sourceRef.externalId, kind, organization, role, startDate])).slice(0, 24)
    const domain = text(org.domain), organizationUrl = /^[a-z\d.-]+\.[a-z]{2,}$/i.test(domain) ? crmUrl('https://' + domain) : ''
    // Omit observation timestamps and retained batch hashes from role identity and fingerprints.
    const ref = { provider: sourceRef.provider, accountId: sourceRef.accountId, externalId: sourceRef.externalId }
    roles.set(id, { id, kind, organization, ...(role ? { role } : {}), ...(startDate ? { startDate } : {}), ...(endDate ? { endDate } : {}),
      ...(endDate ? { current: false } : typeof org.current === 'boolean' ? { current: org.current } : {}),
      ...(organizationUrl ? { organizationUrl } : {}), evidence: [{ label: 'Saved Google Contact', sourceRef: ref }] })
  }
  const affiliations = [...roles.values()], primary = affiliations.find(role => role.kind === 'employment' && role.current === true)
  return { ...(address ? { location: city(address) } : {}), ...(affiliations.length ? { affiliations } : {}), jobTitle: primary?.role ?? '', importedCompanyName: primary?.organization ?? '' }
}
