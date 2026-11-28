import { useState } from 'react'
import { crmRecordLocation } from './recordLocation.ts'
import { CrmAvatar } from './CrmControls.tsx'
import { personName, type CrmDetail } from './client.ts'
import { safeProfileUrl, SocialProfileLinks } from './socialProfiles.tsx'
import type { CrmCompany, CrmCompanyRoster, CrmPerson } from './types.ts'

export function OrganizationMark({ company, name, logo, allowRemote = true, size = 32 }: { company?: CrmCompany; name: string; logo?: string; allowRemote?: boolean; size?: number }) {
  const [failed, setFailed] = useState('')
  const remote = safeProfileUrl(String(company?.logoUrl || logo || ''))
  return allowRemote && !company?.logoAssetId && remote !== failed && remote.startsWith('https://')
    ? <img className="crm-org-mark" width={size} height={size} referrerPolicy="no-referrer" loading="lazy" alt="" src={remote} onError={() => setFailed(remote)} />
    : <CrmAvatar name={name} assetId={company?.logoAssetId} size={size} organization />
}

function OrganizationRoster({ roster, onSelect }: { roster: CrmCompanyRoster; onSelect: (person: CrmPerson) => void }) {
  const [query, setQuery] = useState(''), [limits, setLimits] = useState<Record<string,number>>({})
  const term = query.trim().toLocaleLowerCase()
  const status = (person: CrmPerson) => roster.educationStatuses?.[person.id] || ['attended']
  const alumni = (person: CrmPerson) => status(person).some(value => value === 'graduate' || value === 'alum')
  const student = (person: CrmPerson) => status(person).includes('student')
  const sections = [
    { label: 'Current students', people: roster.education.filter(student) },
    { label: 'Alumni', people: roster.education.filter(alumni) },
    { label: 'Attended', people: roster.education.filter(person => !student(person) && !alumni(person)) },
    { label: 'Currently working here', people: roster.current },
    { label: 'Former employees', people: roster.former },
    { label: 'Other affiliations', people: roster.other },
  ].filter(section => section.people.length)
  const total = new Set(sections.flatMap(section => section.people.map(p => p.id))).size
  const filtered = sections.map(section => ({...section, people:section.people.filter(p => !term || personName(p).toLocaleLowerCase().includes(term))})).filter(section=>section.people.length)
  return <section className="crm-organization-roster"><h3>People in your CRM <small>{total}</small></h3>
    {total>10 && <label className="crm-roster-search">Find a contact<input type="search" value={query} placeholder="Search all linked people" onChange={e=>{setQuery(e.target.value);setLimits({})}}/></label>}
    {filtered.map(({ label, people }) => <section key={label} aria-label={label}><h4>{label} ({people.length})</h4>
      <div>{people.slice(0,limits[label] || 10).map(person => <a key={person.id} className="crm-company-contact" href={`#/people?person=${encodeURIComponent(person.id)}`} onClick={event => {
        if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onSelect(person) }
      }}><CrmAvatar name={personName(person)} assetId={person.avatarAssetId} /><span>{personName(person)}</span></a>)}</div>
      {people.length > (limits[label] || 10) && <button type="button" className="crm-link-button" onClick={()=>setLimits(old=>({...old,[label]:(old[label] || 10) + 10}))}>Show more {label.toLocaleLowerCase()}</button>}
    </section>)}
    {!filtered.length && <p>{term ? 'No linked contacts match this name.' : 'No linked contacts yet.'}</p>}
  </section>
}

export function CompanyProfile({ company, roster, introductionPaths = [], onSelect }: { company: CrmCompany; roster?: CrmDetail['related']['companyRoster']; introductionPaths?: CrmDetail['related']['introductionPaths']; onSelect: (person: CrmPerson) => void }) {
  const domain = company.domain && safeProfileUrl(company.domain.includes('://') ? company.domain : 'https://' + company.domain)
  const homeHost = domain ? new URL(domain).host.replace(/^www\./, '') : ''
  const links = company.urls.filter(raw => {
    const safe = safeProfileUrl(raw)
    if (!homeHost || !safe) return true
    const url = new URL(safe)
    return url.host.replace(/^www\./, '') !== homeHost || url.pathname !== '/' || !!url.search || !!url.hash
  })
  return <section className="crm-company-profile">
    <header><OrganizationMark company={company} name={company.name} /><h2>{company.name}</h2></header>
    {company.tagline && <p>{company.tagline}</p>}
    <p>{[company.industry, crmRecordLocation(company)].filter(Boolean).join(' · ')}</p>
    {company.description && <p>{company.description}</p>}
    <SocialProfileLinks urls={[...(domain ? [domain] : []), ...links]} websiteLabel="Website" />
    {roster && <OrganizationRoster key={company.id} roster={roster} onSelect={onSelect} />}
    {!!introductionPaths.length && <section className="crm-introduction-paths"><h3>Potential introductions</h3>
      {introductionPaths.map(path => {
        const [from, to] = path.fromId === path.via.id ? [path.via, path.employee] : [path.employee, path.via]
        return <article key={path.id}><p>Ask <a href={`#/people?person=${encodeURIComponent(path.via.id)}`}>{path.via.name}</a> about <a href={`#/people?person=${encodeURIComponent(path.employee.id)}`}>{path.employee.name}</a></p>
          <small>{from.name} · {path.relation} · {to.name}</small>{path.context && <p>{path.context}</p>}</article>
      })}
    </section>}
  </section>
}
