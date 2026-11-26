import { useState } from 'react'
import { GraduationCap, Plus } from '@phosphor-icons/react'
import { AffiliationTimeline } from './AffiliationTimeline.tsx'
import type { CrmAffiliation, CrmCompany } from './types.ts'
import './ProfileCapture.css'

export { affiliationDate } from './AffiliationTimeline.tsx'
const kinds = [{ id: 'education', label: 'Education' }, { id: 'employment', label: 'Experience' }, { id: 'membership', label: 'Affiliations' }, { id: 'advisory', label: 'Advisory' }] as const

interface AffiliationProps {
  affiliations?: CrmAffiliation[]; organizations?: CrmCompany[]; linkedCompanies?: CrmCompany[]; jobTitle?: string
  onOpenCompany?: (company: CrmCompany) => void; revision: number; disabled: boolean
  onSave: (next: CrmAffiliation[], expectedRevision: number) => Promise<boolean>; onCollect?: () => void
  onEnrichOrganizations?: () => void; enrichmentNotice?: string
}
export function ProfileCaptureAffiliations({ affiliations = [], organizations = [], linkedCompanies = [], jobTitle, onOpenCompany, revision, disabled, onSave, onCollect, onEnrichOrganizations, enrichmentNotice }: AffiliationProps) {
  const [draft, setDraft] = useState<CrmAffiliation | null>(null), [isNew, setIsNew] = useState(false), [baseline, setBaseline] = useState<{ revision: number; rows: CrmAffiliation[] } | null>(null)
  const stale = !!(draft && baseline && baseline.revision !== revision)
  const save = async () => {
    if (!draft || !baseline || !draft.organization.trim() || disabled || stale) return
    const next = { ...draft, organization: draft.organization.trim() }
    const original = baseline.rows.find(row => row.id === next.id)
    if (original && (original.organization !== next.organization || original.organizationUrl !== next.organizationUrl)) {
      delete next.organizationId; delete next.organizationLogoUrl
    }
    if (await onSave(isNew ? [...baseline.rows, next] : baseline.rows.map(value => value.id === next.id ? next : value), baseline.revision)) setDraft(null)
  }
  return <section className="crm-person-section crm-affiliations"><header><div><h3>Background</h3></div>{onCollect && <button type="button" className="crm-person-small-button" disabled={disabled} onClick={onCollect}>Collect from a profile</button>}</header>
    {(onEnrichOrganizations || enrichmentNotice) && <div className="crm-career-enrichment">
      {onEnrichOrganizations && <button type="button" className="crm-person-small-button" disabled={disabled} onClick={onEnrichOrganizations}>Fill missing organization details</button>}
      {enrichmentNotice && <small role="status">{enrichmentNotice}</small>}
    </div>}
    {!affiliations.length && !linkedCompanies.length && !draft && <div className="crm-affiliation-empty"><GraduationCap size={26} weight="duotone" /><p>Capture their profile to add schools, roles, and organizations with the source attached.</p></div>}
    <AffiliationTimeline affiliations={affiliations} organizations={organizations} linkedCompanies={linkedCompanies} jobTitle={jobTitle}
      disabled={disabled} onOpenCompany={onOpenCompany} onEdit={row => { setDraft({ ...row }); setIsNew(false); setBaseline({ revision, rows: affiliations }) }}
      onRemove={row => void onSave(affiliations.filter(value => value.id !== row.id), revision)} />
    {draft ? <fieldset className="crm-person-edit-scope" disabled={disabled}><form className="crm-affiliation-form" onSubmit={event => { event.preventDefault(); void save() }}><div><label>Type<select value={draft.kind} onChange={event => setDraft(value => value ? { ...value, kind: event.target.value as CrmAffiliation['kind'] } : null)}>{kinds.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label><label>School or organization<input required autoFocus value={draft.organization} onChange={event => setDraft(value => value ? { ...value, organization: event.target.value } : null)} /></label></div><div><label>{draft.kind === 'education' ? 'Degree' : 'Role'}<input value={draft.kind === 'education' ? draft.degree ?? '' : draft.role ?? ''} onChange={event => setDraft(value => value ? { ...value, [value.kind === 'education' ? 'degree' : 'role']: event.target.value } : null)} /></label><label>{draft.kind === 'education' ? 'Field of study' : 'Organization URL'}<input value={draft.kind === 'education' ? draft.field ?? '' : draft.organizationUrl ?? ''} onChange={event => setDraft(value => value ? { ...value, [value.kind === 'education' ? 'field' : 'organizationUrl']: event.target.value } : null)} /></label></div><div><label>From<input placeholder="2022" value={draft.startDate ?? ''} onChange={event => setDraft(value => value ? { ...value, startDate: event.target.value } : null)} /></label><label>To<input placeholder="2026" disabled={draft.current === true} value={draft.endDate ?? ''} onChange={event => setDraft(value => value ? { ...value, endDate: event.target.value } : null)} /></label></div>{draft.kind === 'employment' && <label>Role description<textarea rows={4} maxLength={4000} value={draft.description ?? ''} onChange={event => setDraft(value => value ? { ...value, description: event.target.value } : null)} /></label>}<label className="crm-checkbox-label"><input type="checkbox" checked={draft.current === true} onChange={event => setDraft(value => value ? { ...value, current: event.target.checked, ...(event.target.checked ? { endDate: undefined } : {}) } : null)} />Current</label><footer>{stale && <p role="status">This contact changed. Cancel this edit to review the latest affiliations.</p>}<button type="button" className="crm-person-text-button" onClick={() => setDraft(null)}>Cancel</button><button type="submit" className="crm-person-small-button" disabled={disabled || stale || !draft.organization.trim()}>Save affiliation</button></footer></form></fieldset> : <button type="button" className="crm-person-text-button" disabled={disabled} onClick={() => { setDraft({ id: crypto.randomUUID(), kind: 'education', organization: '', evidence: [] }); setIsNew(true); setBaseline({ revision, rows: affiliations }) }}><Plus size={13} />Add an affiliation</button>}
  </section>
}
