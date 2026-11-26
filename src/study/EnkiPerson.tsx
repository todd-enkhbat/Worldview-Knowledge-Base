import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { contactActions, renderPeopleRows, renderProfileIdentity, type VisiblePerson } from '../../extensions/worldview-reader/contact-ui.js'
import { groupDisplay } from '../../extensions/worldview-reader/group-icon.js'
import '../../extensions/worldview-reader/contact-ui.css'

type Source = 'dia' | 'browser'
type Existing = { recordId: string; groupIds: string[] }
type Profile = {
  entityType: 'person' | 'company'; name: string; headline: string; url: string; photo: string
  companies: string[]; schools: string[]; savedCompanies?: boolean; savedSchools?: boolean
  website: string; industry: string; location?: string
}
type Group = { id: string; name: string; emoji?: string; icon?: string }
type Preview = { id: string; profile: Profile; groups: Group[]; workspace: string; existing?: Existing | null }
type ReadError = {error: string; sourceUrl?: string}
export interface ProfileBridge {
  listVisiblePeople?: (source: Source) => Promise<{people: VisiblePerson[]; sourceUrl: string} | ReadError>
  read: (source: Source, selectedUrl?:string) => Promise<Preview | ReadError>
  save: (id: string, group: string) => Promise<{ status: string; existing?: Existing | null; profile?: Profile; message?: string; notice?: string }>
  profileAction?: (id:string, action:'review-fields'|'photo-only') => Promise<{status:string;message:string}>
  openBrowser: (url: string) => Promise<void>
  openRecord: (action?: 'activity', previewId?:string) => Promise<void>
}
function groupName(group: Group) {
  const {icon, name} = groupDisplay(group)
  return [icon, name].filter(Boolean).join(' ')
}
function PeopleList({people, busy, onAction}: {people: VisiblePerson[]; busy:boolean; onAction:(person:VisiblePerson,action:'primary'|'review')=>void}) {
  const host = useRef<HTMLUListElement>(null)
  const current = useRef(onAction)
  useEffect(() => {current.current = onAction})
  useEffect(() => {
    if (host.current) renderPeopleRows(host.current, people, (person,action) => current.current(person,action),busy)
  }, [people,busy])
  return <section className="wv-people"><h2>People on this page</h2><ul ref={host}/></section>
}
function ProfileHeader({person,saved}: {person:Profile;saved:boolean}) {
  const host = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (host.current) renderProfileIdentity(host.current,{
      name:person.name, entityType:person.entityType, headline:person.headline,
      photoUrl:person.photo, location:person.location,
      current:person.savedCompanies ? [] : person.companies, schools:person.savedSchools ? [] : person.schools,
    },{saved,nameId:'enki-preview-name'})
  },[person,saved])
  return <div ref={host} className="wv-profile-identity enki-identity" />
}
export function EnkiPerson({bridge, autoRead = false}: {bridge?:ProfileBridge; autoRead?:boolean}) {
  const [source,setSource] = useState<Source>('dia')
  const [address,setAddress] = useState('')
  const [record,setRecord] = useState<Preview | null>(null)
  const [people,setPeople] = useState<VisiblePerson[]>([])
  const [selectedUrl,setSelectedUrl] = useState('')
  const [groupId,setGroupId] = useState('')
  const [chooseGroup,setChooseGroup] = useState(false)
  const [review,setReview] = useState(false)
  const [message,setMessage] = useState('')
  const [error,setError] = useState('')
  const [busy,setBusy] = useState(false)
  const locked = useRef(false)
  const groupField = useRef<HTMLSelectElement>(null)
  const recordButton = useRef<HTMLButtonElement>(null)
  const justRead = useRef(false)
  useEffect(() => {
    if (busy || !justRead.current) return
    justRead.current = false
    const field = record?.existing || review ? recordButton.current : groupField.current
    if (!field || field.closest('[hidden]')) return
    const scroller = field.closest('.enki-panes')
    if (scroller) scroller.scrollTop = 0
    field.focus({preventScroll:true})
  }, [record,busy,review])
  function clearDetail() { setSelectedUrl(''); setGroupId(''); setChooseGroup(false); setReview(false); setRecord(null); setError(''); setMessage('') }
  async function run(label: string, action:(api:ProfileBridge)=>Promise<void>) {
    if (!bridge || locked.current) return
    locked.current = true
    setBusy(true); setMessage(label); setError('')
    try { await action(bridge) }
    catch (e) { setMessage(''); setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')) }
    finally { setBusy(false); locked.current = false }
  }
  function showRecord(value: Preview, selected = '') {
    setRecord(value); setSelectedUrl(selected); setGroupId(''); setChooseGroup(false); setReview(false); setMessage('')
    justRead.current = true
  }
  function read() {
    void run('Reading page…', async api => {
      clearDetail(); setPeople([])
      const list = await api.listVisiblePeople?.(source)
      const rows = list && 'people' in list ? list.people : []
      const primary = await api.read(source)
      if ('error' in primary) {
        setAddress(primary.sourceUrl || '')
        setPeople(rows)
        if (!rows.length) throw Error(list && 'error' in list ? list.error : primary.error)
        return
      }
      setPeople(rows.filter(row => row.url.replace(/\/$/,'') !== primary.profile.url.replace(/\/$/,'')))
      setAddress(primary.profile.url); showRecord(primary)
    })
  }
  const initialRead = useRef(false)
  useEffect(() => {
    if (autoRead && bridge && !initialRead.current) { initialRead.current = true; read() }
  })
  async function update(api:ProfileBridge, chosen:Preview, id:string) {
    const receipt = await api.save(chosen.id,id)
    if (receipt.status !== 'saved' && receipt.status !== 'review') throw Error('Worldview did not confirm the save.')
    const value = { ...chosen, existing: receipt.existing ?? chosen.existing, profile:receipt.profile ?? chosen.profile }
    if (value.existing) setPeople(prev => prev.map(row => row.url === value.profile.url ? {...row,existing:value.existing} : row))
    setRecord(value); setReview(receipt.status === 'review'); setGroupId(''); setChooseGroup(false)
    setMessage([receipt.status === 'saved' ? (id ? 'Added to group.' : 'Saved to Worldview.') : receipt.message || 'Ready for review in Worldview.',receipt.notice].filter(Boolean).join(' '))
  }
  function chooseRow(row:VisiblePerson, action:'primary'|'review') {
    void run('',async api => {
      const value = await api.read(source,row.url)
      if ('error' in value) throw Error(value.error)
      if (value.profile.name !== row.name || value.profile.url !== row.url) throw Error('The person changed. Read the page again.')
      if (action === 'review') { showRecord(value,row.url); return }
      if (value.existing) {
        setPeople(prev => prev.map(item => item.url === row.url ? {...item,existing:value.existing} : item))
        await api.openRecord(undefined,value.id)
      } else {
        const receipt = await api.save(value.id,'')
        if (receipt.status === 'saved' && receipt.existing) {
          setPeople(prev => prev.map(item => item.url === row.url ? {...item,existing:receipt.existing} : item))
          setMessage(row.name + ' saved.')
        } else if (receipt.status === 'review') {
          showRecord(value,row.url); setReview(true); setMessage(receipt.message || 'Ready for review in Worldview.'); return
        } else throw Error('Worldview did not confirm the save.')
      }
      // Reading a row replaces the native preview handle. Read the primary again before using its actions.
      if (record && !selectedUrl) {
        const primary = await api.read(source)
        setRecord('error' in primary ? null : primary)
      }
    })
  }
  const person = record?.profile, existing = record?.existing
  const labels = contactActions(person?.entityType || 'person')
  const available = record?.groups.filter(group => !existing?.groupIds.includes(group.id)) || []
  const captureControls = <>
    <div className="enki-profile-tools"><label className="enki-field">Read from
      <select value={source} disabled={busy} onChange={event => {clearDetail();setPeople([]);setSource(event.target.value as Source)}}>
        <option value="dia">Active Dia tab</option><option value="browser">Worldview browser</option>
      </select></label>
      <button className="enki-primary" data-primary disabled={!bridge || busy} onClick={read}>Read profile</button>
    </div>
    {source === 'browser' && <form className="enki-address" onSubmit={event => {event.preventDefault();void run('Opening browser…',async api => {
      clearDetail();setPeople([]);await api.openBrowser(address.trim() || 'https://www.linkedin.com/');setMessage('Open the page, then choose Read profile.')
    })}}>
      <label className="enki-field">Profile URL<input type="url" name="profileUrl" autoComplete="off" spellCheck={false} placeholder="Paste a profile URL…" value={address} onChange={e=>setAddress(e.target.value)}/></label>
      <button disabled={!bridge || busy}>{address.trim() ? 'Open page' : 'Open LinkedIn'}</button></form>}
  </>
  return <>
    {!record && !people.length && <><h1>Capture a contact</h1>{captureControls}</>}
    {!record && !people.length && !message && !error && <p className="enki-hint">{bridge ? 'Read a profile or a page with links to people.' : 'Open Worldview for Mac to capture a browser profile.'}</p>}
    {selectedUrl && <button className="enki-text-action" disabled={busy} onClick={read}>‹ People on this page</button>}
    {record && person && <article className="enki-profile">
      <ProfileHeader person={person} saved={!!existing}/>
      {existing && <div className="enki-membership"><div>{existing.groupIds.length ? record.groups.filter(g=>existing.groupIds.includes(g.id)).map(g=><span key={g.id}>{groupName(g)}</span>):'No groups yet'}</div>
        {!!available.length && <button className="enki-text-action" aria-expanded={chooseGroup} disabled={busy} onClick={()=>setChooseGroup(!chooseGroup)}>+ Add group</button>}</div>}
      {(!existing || chooseGroup) && !review && <div className="enki-profile-tools">
        <label className="enki-field">Group<select ref={groupField} name="group" data-primary disabled={busy} value={groupId} aria-describedby="enki-preview-name" onChange={event=>{
          const id = event.target.value
          setGroupId(id)
          if (existing && id) void run('Saving group…', api=>update(api,record,id))
        }}><option value="">{existing ? 'Choose group' : person.entityType === 'company' ? 'All companies' : 'All contacts'}</option>{available.map(g=><option key={g.id} value={g.id}>{groupName(g)}</option>)}</select></label>
        {!existing && <button className="enki-primary" disabled={busy} onClick={()=>void run('Saving…',api=>update(api,record,groupId))}>{labels.save}</button>}
      </div>}
      {(existing || review) && <div className="enki-record-actions"><button ref={recordButton} className="enki-primary" data-primary disabled={busy} onClick={()=>void run('',api=>api.openRecord(undefined,record.id))}>{review ? 'Review capture' : labels.open}</button>
        {existing && person.entityType === 'person' && <button className="enki-text-action" disabled={busy} onClick={()=>void run('',api=>api.openRecord('activity',record.id))}>{labels.activity}</button>}</div>}
      <details><summary>Profile details</summary><dl>
        {(person.entityType === 'person' ? [['Current company',person.companies.join(', '),person.savedCompanies],['Alma mater',person.schools.join(', '),person.savedSchools]] : [['Website',person.website,false],['Industry',person.industry,false]]).map(([label,value,retained])=><div key={String(label)}><dt>{label}</dt><dd>{value || 'Not shown'} {retained && <small>From Worldview</small>}</dd></div>)}
        <div><dt>Source</dt><dd>{person.url}</dd></div></dl>
        {bridge?.profileAction && <div className="enki-profile-detail-actions">
          <button className="enki-text-action" disabled={busy} onClick={()=>void run('Collecting fields…',async api=>{
            const result = await api.profileAction!(record.id,'review-fields');setMessage(result.message)
          })}>Review profile fields in People</button>
          {person.entityType === 'person' && <button className="enki-text-action" disabled={busy || !person.photo} title={!person.photo ? 'No named portrait on this profile' : undefined} onClick={()=>void run('Saving portrait…',async api=>{
            const result = await api.profileAction!(record.id,'photo-only');setMessage(result.message)
          })}>Save contact photo only</button>}
        </div>}
      </details>
      <details className="enki-change-source" key={record.id}><summary>Read another profile</summary>{captureControls}</details>
    </article>}
    {!selectedUrl && !!people.length && <PeopleList people={people} onAction={chooseRow} busy={busy}/>}
    {!record && !!people.length && <details className="enki-change-source"><summary>Read another page</summary>{captureControls}</details>}
    <p className="enki-help-status" role="status">{message}</p>
    {error && <p className="enki-help-error" role="alert">{error}</p>}
    {error && source === 'dia' && /^https?:\/\//.test(address) && <button className="enki-text-action" disabled={busy} onClick={()=>void run('Opening browser…', async api => {
      await api.openBrowser(address); setSource('browser'); setMessage('Choose Read profile when the page is ready.')
    })}>Open this page in Worldview</button>}
  </>
}
