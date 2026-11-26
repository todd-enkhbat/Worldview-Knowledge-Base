import { useEffect, useState } from 'react'
import { MagnifyingGlass, Plus } from '@phosphor-icons/react'
import { useRepoStatus } from '../data/repo.ts'
import { crmCommand, crmMessage, personName, useCrmList, useCrmQuery } from './client.ts'
import { CrmAvatar, CrmDialog, CrmEmpty } from './CrmControls.tsx'
import { ReconnectQueue } from './ReconnectQueue.tsx'
import { reminderFilter, type ReminderTab } from './calendarDate.ts'
import type { CrmPerson } from './types.ts'

const tabs = ['Open', 'Overdue', 'Today', 'Upcoming', 'Completed'] as const
const PAGE = 20
export function FollowUps({ onSelectPerson }: { onSelectPerson: (person: CrmPerson) => void }) {
  const [offset,setOffset] = useState(0), [tab,setTab] = useState<ReminderTab>('Open')
  const [text,setText] = useState(''), [query,setQuery] = useState(''), [error,setError] = useState(''), [saving,setSaving] = useState('')
  const [create,setCreate] = useState(false), [title,setTitle] = useState(''), [due,setDue] = useState('')
  const writer = useRepoStatus(s=>s.writer)
  useEffect(() => { const id = setTimeout(() => { setQuery(text.trim()); setOffset(0) },180); return () => clearTimeout(id) },[text])
  const tasks = useCrmList('tasks',{limit:PAGE,offset,q:query,filter:JSON.stringify(reminderFilter(tab)),sort:JSON.stringify([{field:tab==='Completed' ? 'completedAt' : 'dueAt',direction:tab==='Completed' ? 'desc':'asc'}])})
  const ids = [...new Set(tasks.data.rows.flatMap(t=>t.entityRefs.filter(ref=>ref.type==='person').slice(0,3).map(ref=>ref.id)))]
  const path = ids.length ? 'people?' + new URLSearchParams({limit:String(ids.length),filter:JSON.stringify({field:'id',operator:'in',value:ids})}) : null
  const people = useCrmQuery<{ rows:CrmPerson[] }>(path,{rows:[]})
  const personMap = new Map(people.data.rows.map(p=>[p.id,p]))
  useEffect(() => { if (!tasks.loading && !tasks.error && offset && !tasks.data.rows.length) setOffset(Math.max(0,offset-PAGE)) },[tasks.loading,tasks.error,tasks.data,offset])
  async function action(key:string, run:()=>Promise<void>) {
    if (!writer || saving) return
    setSaving(key); setError('')
    try { await run() } catch (e) { setError(crmMessage(e)) } finally { setSaving('') }
  }
  const start = new Date(); start.setHours(0,0,0,0)
  return <section className="crm-task-workspace"><header className="crm-section-heading"><div><h2>Follow-ups</h2><p>Reminders and people to reconnect with.</p></div>
    <button className="crm-button is-primary" disabled={!writer || !!saving} onClick={()=>setCreate(true)}><Plus size={15}/>New reminder</button></header>
    <div className="crm-reminder-tools"><nav aria-label="Reminder status">{tabs.map(t=><button type="button" key={t} aria-pressed={t===tab} onClick={()=>{setOffset(0);setTab(t)}}>{t}</button>)}</nav>
      <label className="crm-search"><MagnifyingGlass size={15}/><input type="search" value={text} aria-label="Search reminders" placeholder="Search reminders" onChange={e=>setText(e.target.value)}/></label></div>
    {(tasks.error || error) && <p className="crm-error" role="alert">{tasks.error || error}</p>}
    {tasks.loading ? <p role="status">Loading reminders…</p> : !tasks.data.rows.length && !tasks.error && <CrmEmpty title={query ? 'No matching reminders' : 'No '+tab.toLowerCase()+' reminders'}>{query ? 'Try a different search.' : 'Create a reminder here or from a contact.'}</CrmEmpty>}
    <div className="crm-task-list">{tasks.data.rows.map(task=>{
      const overdue = !task.completedAt && task.dueAt !== null && task.dueAt < start.getTime()
      const contacts = task.entityRefs.filter(ref=>ref.type==='person')
      return <article key={task.id} className={task.completedAt ? 'is-complete' : ''}>
        <input type="checkbox" aria-label={'Complete '+task.title} checked={task.completedAt!==null} disabled={!writer || !!saving} onChange={e=>{ const completed=e.target.checked;void action(task.id, async()=>{await crmCommand({operation:'complete_task',id:task.id,expectedRecordRevision:task.revision,completed})})}}/>
        <div><strong>{task.title}</strong>{task.body && <p>{task.body}</p>}<small className={overdue?'is-overdue':''}>{task.dueAt === null ? 'No due date' : (overdue ? 'Overdue · ' : '') + new Date(task.dueAt).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'})}</small>
        <div className="crm-reminder-people">{contacts.slice(0,3).map(ref=>{const p=personMap.get(ref.id);return p ? <button type="button" className="crm-link-button" key={ref.id} onClick={()=>onSelectPerson(p)}><CrmAvatar name={personName(p)} assetId={p.avatarAssetId} size={22}/>{personName(p)}</button> : <a key={ref.id} href={'#/people?person='+encodeURIComponent(ref.id)}>View contact</a>})}
          {contacts.length>3 && <details><summary>{contacts.length-3} more contacts</summary>{contacts.slice(3).map((ref,i)=><a key={ref.id} href={'#/people?person='+encodeURIComponent(ref.id)}>Open contact {i+4}</a>)}</details>}</div></div></article>})}</div>
    <div className="crm-pagination"><span>{tasks.data.total ? (offset+1)+'–'+Math.min(offset+PAGE,tasks.data.total)+' of '+tasks.data.total : '0'} reminders</span>
      {tasks.data.total>PAGE && <><button className="crm-button" disabled={!offset||tasks.loading} onClick={()=>setOffset(Math.max(0,offset-PAGE))}>Previous</button><button className="crm-button" disabled={tasks.data.nextOffset===null||tasks.loading} onClick={()=>setOffset(tasks.data.nextOffset!)}>Next</button></>}</div>
    <ReconnectQueue writer={writer} onSelectPerson={onSelectPerson}/>
    {create && <CrmDialog title="New reminder" onClose={()=>{if(!saving)setCreate(false)}}><form className="crm-form" onSubmit={e=>{e.preventDefault();void action('create',async()=>{
      const date=due ? new Date(due).getTime() : null
      if (date!==null && !Number.isFinite(date)) throw new Error('Choose a valid due date.')
      await crmCommand({operation:'create',collection:'tasks',record:{title:title.trim(),dueAt:date}})
      setCreate(false);setTitle('');setDue('');setTab('Open');setOffset(0);setText('');setQuery('')
    })}}><label>Reminder<input required value={title} onChange={e=>setTitle(e.target.value)} autoFocus/></label><label>When<input type="datetime-local" value={due} onChange={e=>setDue(e.target.value)}/></label>{error && <p className="crm-error" role="alert">{error}</p>}<button className="crm-button is-primary" disabled={!title.trim() || !!saving}>Create reminder</button></form></CrmDialog>}
  </section>
}
