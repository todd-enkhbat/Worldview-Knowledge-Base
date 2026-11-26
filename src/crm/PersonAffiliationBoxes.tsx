import { Buildings, GraduationCap, CaretRight } from '@phosphor-icons/react'
import { groupRoles } from './AffiliationTimeline.tsx'
import { educationStatus, employmentStatus } from './affiliationStatus.ts'
import { OrganizationMark } from './CompanyProfile.tsx'
import type { CrmAffiliation, CrmCompany } from './types.ts'

const educationLabels = { student: 'Current student', graduate: 'Graduated', alum: 'Alum', attended: 'Attended' }
type Entry = { name: string; company?: CrmCompany; id?: string; logo?: string; details: string[] }

export function PersonAffiliationBoxes({ affiliations = [], organizations = [], companies = [], onOpen, onBrowse }: {
  onBrowse?: (field: 'almaMater' | 'currentEmployers', name: string) => void
  affiliations?: CrmAffiliation[]; organizations?: CrmCompany[]; companies?: CrmCompany[]; onOpen?: (company: CrmCompany) => void
}) {
  const byId = new Map([...companies, ...organizations].map(company => [company.id, company]))
  function entries(rows: CrmAffiliation[]): Entry[] {
    return [...groupRoles(rows).values()].map(group => {
      const id = group.find(row => row.organizationId)?.organizationId, company = byId.get(id || '')
      const details = group.map(row => row.kind === 'education'
        ? [educationLabels[educationStatus(row)], row.degree, row.field].filter(Boolean).join(' · ')
        : row.role || '')
      return { name: company?.name || group[0].organization, id, company, logo: group.find(row => row.organizationLogoUrl)?.organizationLogoUrl, details: [...new Set(details.filter(Boolean))] }
    })
  }
  const workplaces = entries(affiliations.filter(row => row.kind === 'employment' && employmentStatus(row) === 'current'))
  for (const company of companies) {
    // Older imports can carry only a company association. A school, former role,
    // or other affiliation with this organization cannot establish current work.
    const hasRole = affiliations.some(row => row.organizationId ? row.organizationId === company.id : row.organization.trim().toLowerCase() === company.name.trim().toLowerCase())
    if (!hasRole) workplaces.push({ name: company.name, company, id: company.id, details: ['Linked company · Current role unconfirmed'] })
  }
  const schools = entries(affiliations.filter(row => row.kind === 'education'))
  return <div className="crm-affiliation-boxes">{[
    { kind: 'company', title: workplaces.length > 1 ? 'Current companies' : 'Current company', Icon: Buildings, rows: workplaces, empty: 'No current company recorded' },
    { kind: 'school', title: 'Alma mater & schools', Icon: GraduationCap, rows: schools, empty: 'No education recorded' },
  ].map(({ kind, title, Icon, rows, empty }) => <section key={kind} aria-label={title}>
    <h3><Icon size={15} />{title}</h3>
    {rows.length ? rows.map(row => <a key={row.id || row.name} className="crm-affiliation-box-link"
      href={row.id ? `#/people?tab=companies&company=${encodeURIComponent(row.id)}` : `#/people?tab=people&${kind === 'school' ? 'school' : 'currentEmployer'}=${encodeURIComponent(row.name)}`}
      onClick={event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        if (row.company && onOpen) { event.preventDefault(); onOpen(row.company) }
        else if (!row.id && onBrowse) { event.preventDefault(); onBrowse(kind === 'school' ? 'almaMater' : 'currentEmployers', row.name) }
      }}>
      <OrganizationMark company={row.company} name={row.name} logo={row.logo} />
      <span><strong>{row.name}</strong>{row.details.map(detail => <small key={detail}>{detail}</small>)}</span>
      <CaretRight size={13} />
    </a>) : <p>{empty}</p>}
  </section>)}</div>
}
