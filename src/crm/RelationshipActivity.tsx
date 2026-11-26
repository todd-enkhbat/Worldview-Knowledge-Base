import { useState } from 'react'
import { useCrmQuery } from './client.ts'
import type { RelationshipHistory } from './connectionTypes.ts'
import type { CrmPerson, CrmTask } from './types.ts'

const when = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
interface Props {
  person: CrmPerson
  tasks: CrmTask[]
  onSelectPerson?: (id: string) => void
  disabled: boolean
  saveContext: (text: string) => Promise<boolean>
  followUp: () => Promise<boolean>
}
export function RelationshipActivity({ person, tasks, onSelectPerson, disabled, saveContext, followUp }: Props) {
  const [offset, setOffset] = useState(0), [draft, setDraft] = useState<string | null>(null)
  const { data, loading, error } = useCrmQuery<RelationshipHistory | null>('connections/relationship?' + new URLSearchParams({ personId: person.id, offset: String(offset) }), null)
  const context = typeof person.connectionContext === 'string' ? person.connectionContext : ''
  const next = tasks.filter(task => task.completedAt === null && task.dueAt !== null).sort((a, b) => a.dueAt! - b.dueAt!)[0]
  return <section className="crm-person-section crm-relationship-summary">
    <header><h3>Interaction history</h3><button type="button" className="crm-person-text-button" disabled={disabled} onClick={() => setDraft(context)}>{context ? 'Edit how we met' : 'Add how we met'}</button></header>
    {draft !== null ? <form className="crm-person-manual-form" onSubmit={async event => { event.preventDefault(); if (await saveContext(draft.trim())) setDraft(null) }}>
      <label>How we met<textarea maxLength={4000} value={draft} onChange={event => setDraft(event.target.value)} autoFocus /></label>
      <div><button className="crm-person-small-button" type="submit">Save context</button> <button className="crm-person-text-button" type="button" onClick={() => setDraft(null)}>Cancel</button></div>
    </form> : context && <p>{context}</p>}
    {loading && !data && <p>Loading relationship history…</p>}
    {error && <p role="alert">{error}</p>}
    {data && typeof data.total === 'number' && <>
      {data.introductions?.map(intro => <p key={intro.personId}>Introduced by {onSelectPerson ? <button type="button" className="crm-person-text-button" onClick={() => onSelectPerson(intro.personId)}>{intro.name}</button> : intro.name} · {intro.source}</p>)}
      {data.last && data.first ? <>
        <p><strong>Last interaction · {when(data.last.at)}</strong><br />{data.last.title} · {data.last.source}</p>
        <p>{data.recentCount} in the last 90 days · {data.total} across synced email and logged activity</p>
        {data.first.id !== data.last.id && <p>Earliest recorded · {when(data.first.at)} · {data.first.title} · {data.first.source}</p>}
        {!!(data.sent + data.received) && <p>Email · {data.sent} sent · {data.received} received</p>}
        <div aria-label="Combined interaction timeline">
          <div className="crm-person-timeline">{data.timeline.map(event => <article key={event.id}><i /><div><header><strong>{event.url ? <a href={event.url} target="_blank" rel="noreferrer">{event.title}</a> : event.title}</strong></header><p>{when(event.at)} · {event.channel && event.channel + ' · '}{event.direction} · {event.source}</p></div></article>)}</div>
          {data.total > 25 && <div><button type="button" className="crm-person-text-button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 25))}>Newer</button> <button type="button" className="crm-person-text-button" disabled={offset + 25 >= data.total} onClick={() => setOffset(offset + 25)}>Older</button></div>}
        </div>
      </> : <p className="crm-person-help">No matched email or logged interactions yet. Connect a mailbox in People → Connections or log an interaction below.</p>}
      {data.ambiguousEmails > 0 && <small>A shared contact address was excluded from email matching.</small>}
      {data.unavailableSources > 0 && <small>Some saved email sources are unavailable. This history is partial.</small>}
    </>}
    {person.phones.filter(phone => /^\+?[0-9 ()-]{5,30}$/.test(phone)).map(phone =>
      <a key={phone} className="crm-person-small-button" href={'tel:' + phone.replace(/[ ()-]/g, '')}>Call {phone}</a>)}
    {next ? <p>Next task · {next.title} · {when(next.dueAt!)}</p> : <button type="button" className="crm-person-small-button" disabled={disabled} onClick={() => void followUp()}>Follow up in a week</button>}
  </section>
}
