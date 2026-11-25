import { useMemo } from 'react'
import { ArrowUpRight, Buildings, MapPin } from '@phosphor-icons/react'
import { CrmAvatar, CrmEmpty } from './CrmControls.tsx'
import { personName } from './client.ts'
import { SocialProfileLinks } from './socialProfiles.tsx'
import type { CrmCompany, CrmGroup, CrmMembership, CrmPerson } from './types.ts'
import './crmVisuals.css'

export function CrmContactGallery({ people, companies, groups, memberships, selectedIds, onToggle, onSelect }: { people: CrmPerson[]; companies: CrmCompany[]; groups: CrmGroup[]; memberships: CrmMembership[]; selectedIds: Set<string>; onToggle: (id: string) => void; onSelect: (person: CrmPerson) => void }) {
  const companyMap = useMemo(() => new Map(companies.map(company => [company.id, company.name])), [companies])
  const groupMap = useMemo(() => new Map(groups.map(group => [group.id, group])), [groups])
  const linkedGroups = useMemo(() => {
    const result = new Map<string, CrmGroup[]>()
    for (const membership of memberships) { if (membership.entityType !== 'person') continue; const group = groupMap.get(membership.groupId); if (group) result.set(membership.entityId, [...(result.get(membership.entityId) ?? []), group]) }
    return result
  }, [memberships, groupMap])
  return <div className="crm-contact-gallery" aria-label="Contact gallery">{people.map(person => {
    const name = personName(person), company = person.companyIds.map(id => companyMap.get(id)).filter(Boolean).slice(0, 2).join(', '), badges = linkedGroups.get(person.id) ?? []
    return <article className="crm-contact-card" key={person.id} data-selected={selectedIds.has(person.id)}>
      <div className="crm-card-top"><label className="crm-card-select"><input type="checkbox" aria-label={`Select ${name}`} checked={selectedIds.has(person.id)} onChange={() => onToggle(person.id)} /></label><span className="crm-card-status">{person.avatarAssetId ? 'Photo saved' : 'In your circle'}</span><ArrowUpRight size={16} aria-hidden="true" /></div>
      <button className="crm-card-open" onClick={() => onSelect(person)} aria-label={`Open ${name}`}><CrmAvatar name={name} assetId={person.avatarAssetId} size={72} /><strong>{name}</strong><span>{person.jobTitle || 'Add a little context'}</span></button>
      <div className="crm-card-context">{company && <span><Buildings size={13} />{company}</span>}{person.location && <span><MapPin size={13} />{person.location}</span>}</div>
      <SocialProfileLinks urls={person.urls} compact />
      <div className="crm-card-groups">{badges.slice(0, 2).map(group => <span key={group.id}>{group.emoji && <i aria-hidden="true">{group.emoji}</i>}{group.name}</span>)}{badges.length > 2 && <span>+{badges.length - 2}</span>}</div>
    </article>
  })}{!people.length && <CrmEmpty title="No people in this view">Try a different search or add someone to this group.</CrmEmpty>}</div>
}
