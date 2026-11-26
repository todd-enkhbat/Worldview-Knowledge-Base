import { ArrowSquareOut, PencilSimple, X } from '@phosphor-icons/react'
import { employmentStatus } from './affiliationStatus.ts'
import { OrganizationMark } from './CompanyProfile.tsx'
import { safeProfileUrl, socialProfile } from './socialProfiles.tsx'
import type { CrmAffiliation, CrmCompany } from './types.ts'
import './affiliationTimeline.css'

const sections = { employment: 'Experience', education: 'Education', membership: 'Affiliations', advisory: 'Advisory' } as const
const key = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()

export function affiliationDate(row: CrmAffiliation) {
  const present = employmentStatus(row) === 'current'
  if (row.startDate && (present || row.endDate)) return `${row.startDate} — ${present ? 'Present' : row.endDate}`
  if (present) return 'Present'
  if (row.endDate) return 'Until ' + row.endDate
  return row.startDate ? 'From ' + row.startDate : ''
}

function roleDescription(row: CrmAffiliation) {
  if (row.description?.trim()) return row.description.trim()
  if (row.kind !== 'employment' || !row.excerpt) return ''
  // Older captures stored role metadata and visible responsibilities in one excerpt.
  // Surface intact sentences and leave the complete original available under Source.
  const metadata = [row.organization, row.role, row.startDate, row.endDate].filter(Boolean).map(value => key(value!))
  return row.excerpt.split(/\s+·\s+|\n+/).map(part => part.trim()).filter(part => {
    if (part.length < 25 || metadata.includes(key(part)) || /\b(?:19|20)\d{2}\s*[-–—]/.test(part)) return false
    return /[.!?。]$/.test(part) || /^(?:I |We |Led |Built |Managed |Developed |Founded |Designed |Responsible for )/i.test(part)
  }).join('\n')
}

function mostRecent(first: CrmAffiliation, second: CrmAffiliation) {
  function date(row: CrmAffiliation) { return Date.parse(row.endDate && /\d{4}/.test(row.endDate) ? row.endDate : row.startDate || '') || 0 }
  return Number(employmentStatus(second) === 'current') - Number(employmentStatus(first) === 'current') || date(second) - date(first)
}

export function groupRoles(rows: CrmAffiliation[]) {
  const normalizedUrl = (row: CrmAffiliation) => safeProfileUrl(row.organizationUrl || '').replace(/\/$/, '')
  const idsByUrl = new Map<string, Set<string>>()
  function remember(index: Map<string, Set<string>>, lookup: string, value: string) {
    const matches = index.get(lookup) || new Set<string>()
    matches.add(value); index.set(lookup, matches)
  }
  function only(values?: Set<string>) { return values?.size === 1 ? [...values][0] : '' }
  for (const row of rows) {
    const url = normalizedUrl(row)
    if (url && row.organizationId) remember(idsByUrl, url, row.organizationId)
  }
  function identity(row: CrmAffiliation) {
    const url = normalizedUrl(row), id = row.organizationId || only(idsByUrl.get(url))
    return id ? 'id:' + id : url ? 'url:' + url : ''
  }
  // An older row may have only a name. Join it only if the other rows agree
  // on one organization; keep distinct explicitly linked companies separate.
  const keysByName = new Map<string, Set<string>>()
  for (const row of rows) {
    const id = identity(row)
    if (id) remember(keysByName, key(row.organization), id)
  }
  const groups = new Map<string, CrmAffiliation[]>()
  for (const row of rows) {
    const name = key(row.organization), id = identity(row) || only(keysByName.get(name)) || 'name:' + name
    const group = groups.get(id)
    if (group) group.push(row)
    else groups.set(id, [row])
  }
  return groups
}

function OrganizationHeader({ name, company, rows, onOpenCompany }: { name: string; company?: CrmCompany; rows: CrmAffiliation[]; onOpenCompany?: (company: CrmCompany) => void }) {
  const id = company?.id || rows.find(row => row.organizationId)?.organizationId
  const domain = company?.domain?.trim()
  const urls = [
    ...(domain ? [/^https?:\/\//i.test(domain) ? domain : 'https://' + domain] : []),
    ...(company?.urls || []), ...rows.flatMap(row => row.organizationUrl ? [row.organizationUrl] : []),
  ].map(socialProfile).filter(item => !!item)
  const website = urls.find(item => item.platform.id === 'website'), linkedIn = urls.find(item => item.platform.id === 'linkedin')
  return <header className="crm-career-org">
    <OrganizationMark company={company} name={name} logo={rows.find(row => row.organizationLogoUrl)?.organizationLogoUrl} />
    <div>
      <h5>{id ? <a href={`#/people?tab=companies&company=${encodeURIComponent(id)}`} onClick={event => {
        if (company && onOpenCompany && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onOpenCompany(company) }
      }}>{name}</a> : name}</h5>
      {(website || linkedIn) && <div className="crm-career-links">
        {website && <a href={website.url} target="_blank" rel="noreferrer noopener">{website.handle}<ArrowSquareOut size={11} /></a>}
        {linkedIn && <a href={linkedIn.url} target="_blank" rel="noreferrer noopener">LinkedIn<ArrowSquareOut size={11} /></a>}
      </div>}
    </div>
  </header>
}

function Evidence({ row }: { row: CrmAffiliation }) {
  const evidence = row.evidence || []
  if (!evidence.length && !row.excerpt) return null
  const excerpts = new Set(evidence.map(item => item.excerpt).filter(Boolean))
  return <details className="crm-career-evidence"><summary>Source & context</summary>
    {evidence.map((item, index) => {
      const url = safeProfileUrl(item.url || item.sourceRef?.url || '')
      return <div key={index}>{url ? <a href={url} target="_blank" rel="noreferrer noopener">{item.label || 'Profile source'} <ArrowSquareOut size={11} /></a> : <span>{item.label || 'Saved source'}</span>}
        {item.excerpt && <blockquote>{item.excerpt}</blockquote>}
      </div>
    })}
    {row.excerpt && !excerpts.has(row.excerpt) && <blockquote>{row.excerpt}</blockquote>}
  </details>
}

interface Props {
  affiliations: CrmAffiliation[]
  organizations: CrmCompany[]
  linkedCompanies: CrmCompany[]
  jobTitle?: string
  disabled: boolean
  onEdit: (row: CrmAffiliation) => void
  onRemove: (row: CrmAffiliation) => void
  onOpenCompany?: (company: CrmCompany) => void
}

export function AffiliationTimeline({ affiliations, organizations, linkedCompanies, jobTitle, disabled, onEdit, onRemove, onOpenCompany }: Props) {
  const byId = new Map([...linkedCompanies, ...organizations].map(company => [company.id, company]))
  const employment = affiliations.filter(row => row.kind === 'employment')
  const legacy = linkedCompanies.filter(org => !affiliations.some(row => row.organizationId ? row.organizationId === org.id : key(row.organization) === key(org.name)))
  return <>{(Object.keys(sections) as CrmAffiliation['kind'][]).map(kind => {
    const rows = affiliations.filter(row => row.kind === kind).sort(mostRecent)
    const groups = groupRoles(rows)
    if (!groups.size && !(kind === 'employment' && legacy.length)) return null
    return <section key={kind} className="crm-career-section" aria-label={sections[kind]}>
      <h4>{sections[kind]}</h4>
      {[...groups].map(([id, roles]) => {
        const first = roles[0], company = byId.get(roles.find(row => row.organizationId)?.organizationId || '')
        return <article key={id} className="crm-career-employer">
          <OrganizationHeader name={company?.name || first.organization} company={company} rows={roles} onOpenCompany={onOpenCompany} />
          <ol className={roles.length > 1 ? 'crm-career-roles is-grouped' : 'crm-career-roles'}>{roles.map(row => {
            const title = kind === 'education' ? [row.degree, row.field].filter(Boolean).join(' · ') : row.role
            const status = employmentStatus(row), description = roleDescription(row)
            const actionLabel = [row.organization, sections[kind].toLowerCase(), ...(roles.length > 1 ? [title || affiliationDate(row)] : [])].filter(Boolean).join(' ')
            return <li key={row.id}>
              <div className="crm-career-role-heading">
                <div>{title && <strong>{title}</strong>}
                  <div className="crm-career-period">
                    {kind === 'employment' && <span data-status={status}>{{ current: 'Current role', former: 'Former role', other: 'Dates unconfirmed' }[status]}</span>}
                    {affiliationDate(row) && <span>{affiliationDate(row)}</span>}
                  </div>
                </div>
                <div className="crm-career-actions">
                  <button type="button" className="crm-person-icon" aria-label={`Edit ${actionLabel}`} title={`Edit ${title || row.organization}`} disabled={disabled} onClick={() => onEdit(row)}><PencilSimple size={14} /></button>
                  <button type="button" className="crm-person-icon" aria-label={`Remove ${actionLabel}`} title={`Remove ${title || row.organization}`} disabled={disabled} onClick={() => onRemove(row)}><X size={14} /></button>
                </div>
              </div>
              {description && <p className="crm-career-description">{description}</p>}
              <Evidence row={row} />
            </li>
          })}</ol>
        </article>
      })}
      {kind === 'employment' && legacy.map(company => <article key={company.id} className="crm-career-employer">
        <OrganizationHeader company={company} name={company.name} rows={[]} onOpenCompany={onOpenCompany} />
        <div className="crm-career-legacy">{linkedCompanies.length === 1 && !employment.length && jobTitle && <strong>{jobTitle}</strong>}<small>Linked company · Dates unconfirmed</small></div>
      </article>)}
    </section>
  })}</>
}
