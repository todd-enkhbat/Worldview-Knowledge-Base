import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowsOut, ArrowSquareOut, MagnifyingGlass, Minus, Plus, UsersThree } from '@phosphor-icons/react'
import { crmAll, crmCommand, crmMessage, personName, useCrmQuery, type CrmStatus } from './client.ts'
import { CrmAvatar, CrmDialog, CrmEmpty } from './CrmControls.tsx'
import { useRepoStatus } from '../data/repo.ts'
import { organizationClusters } from './organizationClusters.ts'
import type { CrmCompany, CrmGroup, CrmInteraction, CrmMembership, CrmPerson, CrmRelationship } from './types.ts'
import './peopleNetwork.css'

const PAGE = 18
const EMPTY = { companies: [] as CrmCompany[], people: [] as CrmPerson[], groups: [] as CrmGroup[], memberships: [] as CrmMembership[], relationships: [] as CrmRelationship[] }
const displayName = (p: CrmPerson) => personName(p)
const searchText = (p: CrmPerson) => [displayName(p), p.jobTitle, ...p.emails, ...p.tags, ...(p.affiliations ?? []).flatMap(a => [a.organization, a.role, a.degree, a.field])].filter(Boolean).join(' ').toLocaleLowerCase()

export default function PeopleNetwork({ onSelectPerson, groupId, initialQuery = '' }: { onSelectPerson: (person: CrmPerson) => void; groupId?: string; initialQuery?: string }) {
  const writer = useRepoStatus(state => state.writer)
  const { data: status } = useCrmQuery<CrmStatus | null>('status', null)
  const [data, setData] = useState(EMPTY), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [organization,setOrganization] = useState('')
  const [query, setQuery] = useState(initialQuery), [focusId, setFocus] = useState(''), [bucket, setBucket] = useState(''), [page, setPage] = useState(0)
  const [context, setContext] = useState(false), [events, setEvents] = useState<CrmInteraction[]>([]), [eventError, setEventError] = useState('')
  const [connection, setConnection] = useState(false), [target, setTarget] = useState(''), [targetQuery, setTargetQuery] = useState(''), [relation, setRelation] = useState('knows'), [note, setNote] = useState(''), [busy, setBusy] = useState(false)
  const [width, setWidth] = useState(900), [view, setView] = useState({ zoom: 1, x: 0, y: 0 })
  const scene = useRef<HTMLDivElement>(null), drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void Promise.all([crmAll('people', controller.signal), crmAll('groups', controller.signal), crmAll('memberships', controller.signal), crmAll('relationships', controller.signal),crmAll('companies',controller.signal)]).then(([people, groups, memberships, relationships, companies]) => {
      if (!controller.signal.aborted) { setData({ people, groups, memberships, relationships, companies }); setError(''); setLoading(false) }
    }).catch(cause => { if (!controller.signal.aborted) { setError(crmMessage(cause)); setLoading(false) } })
    return () => controller.abort()
  }, [status?.revision])
  useEffect(() => {
    if (!context) return
    const controller = new AbortController()
    setEventError(''); setEvents([])
    void crmAll('interactions', controller.signal).then(rows => { if (!controller.signal.aborted) setEvents(rows) })
      .catch(cause => { if (!controller.signal.aborted) setEventError(crmMessage(cause)) })
    return () => controller.abort()
  }, [context, status?.revision])
  const graph = useMemo(() => {
    const members = new Map<string, Set<string>>()
    for (const m of data.memberships) if (m.entityType === 'person') {
      if (!members.has(m.entityId)) members.set(m.entityId, new Set())
      members.get(m.entityId)!.add(m.groupId)
    }
    const groups = new Map(data.groups.map(g => [g.id,g.name]))
    const people = data.people.filter(p => !p.mergedIntoId && (!groupId || members.get(p.id)?.has(groupId))).sort((a,b) => displayName(a).localeCompare(displayName(b)) || a.id.localeCompare(b.id))
    const personById = new Map(people.map(p => [p.id,p]))
    const links = data.relationships.filter(e => e.confirmed && e.from.type === 'person' && e.to.type === 'person' && personById.has(e.from.id) && personById.has(e.to.id))
    const buckets = new Map<string,{name:string; count:number}>()
    const counts = new Map<string,number>(), text = new Map<string,string>()
    const orgs=organizationClusters(people,data.companies)
    for (const p of people) {
      text.set(p.id,[searchText(p),p.location,p.description,...Array.from(orgs.byPerson.get(p.id) ?? [],id=>orgs.names.get(id))].join(' ').toLowerCase())
      const ids = members.get(p.id)
      for (const id of ids?.size ? ids : ['ungrouped']) counts.set(id,(counts.get(id) ?? 0) + 1)
    }
    for (const [id,count] of counts) buckets.set(id,{name:groups.get(id) || 'Ungrouped people',count})
    return { people, personById, members, links, buckets, text, orgs }
  }, [data,groupId])
  const focused = graph.personById.get(focusId), term = query.toLocaleLowerCase().trim(), activeBucket = groupId || bucket
  const visiblePool = useMemo(() => {
    let pool=graph.people.filter(p => (focused || !term || graph.text.get(p.id)!.includes(term)) &&
      (!organization || graph.orgs.byOrg.get(organization)?.has(p.id)) &&
      (!activeBucket || (activeBucket==='ungrouped' ? !graph.members.get(p.id)?.size : graph.members.get(p.id)?.has(activeBucket))))
    if (focused) {
      const ids = new Set(graph.links.flatMap(e=>e.from.id===focused.id?[e.to.id]:e.to.id===focused.id?[e.from.id]:[]))
      for (const id of graph.orgs.byPerson.get(focused.id) ?? []) for (const member of graph.orgs.byOrg.get(id) ?? []) ids.add(member)
      pool=pool.filter(p=>p.id!==focused.id && ids.has(p.id))
    }
    return pool
  }, [graph,focused,term,activeBucket,organization])
  const pageSize = focused ? PAGE - 1 : PAGE, maxPage = Math.max(0,Math.ceil(visiblePool.length / pageSize) - 1), currentPage = Math.min(page,maxPage)
  const slice = visiblePool.slice(currentPage * pageSize,(currentPage + 1) * pageSize), visible = focused ? [focused,...slice] : slice
  const columns = Math.max(1, Math.min(6, Math.floor(width / 130), visible.length)), rows = Math.ceil(visible.length / columns), height = Math.max(210, rows * 92 + 44)
  const points = new Map(visible.map((p,i) => {
    const row = Math.floor(i / columns), count = Math.min(columns,visible.length - row * columns)
    return [p.id,{ x: width * ((i % columns) + 1) / (count + 1), y: height * (row + .5) / Math.max(1,rows) - 10 }]
  }))
  const shownLinks = graph.links.filter(e => points.has(e.from.id) && points.has(e.to.id) && (!focused || e.from.id === focused.id || e.to.id === focused.id))
  const shared = [...graph.orgs.byOrg].map(([id,members])=>({id,name:graph.orgs.names.get(id)!,members:visible.filter(p=>members.has(p.id))})).filter(org=>org.members.length>1 && (!organization || org.id===organization))
  const drawnLinks = shownLinks.slice(0, 2 * PAGE)
  const sceneVisible = !loading && visible.length > 0
  useEffect(() => {
    const element = scene.current
    if (!element) return
    const measure = () => { if (element.clientWidth) setWidth(element.clientWidth) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure); observer.observe(element)
    return () => observer.disconnect()
  }, [sceneVisible])
  function resetView() { setView({ x:0,y:0,zoom:1 }); setPage(0) }
  function choosePerson(id: string) { setFocus(id); resetView() }
  async function addConnection() {
    if (!writer || busy || !focused || !target || target === focused.id) return
    setBusy(true); setError('')
    try {
      await crmCommand({ operation:'create', collection:'relationships', record:{ from:{type:'person',id:focused.id},to:{type:'person',id:target},relation:relation.trim() || 'knows',confirmed:true,context:note,evidence:[{label:'Added by you'}] } })
      setConnection(false)
    } catch (cause) { setError(crmMessage(cause)) } finally { setBusy(false) }
  }
  const eventContexts = context ? events.filter(e => ['calendar','event','meeting'].includes(e.type) && e.status !== 'cancelled' && e.personIds.filter(id => points.has(id)).length > 1).slice(0, 100) : []
  return <section className="crm-network crm-network-browser">
    <header className="crm-network-toolbar"><div><UsersThree size={20}/><strong>Relationship network</strong><span>{graph.people.length.toLocaleString()} people · {graph.links.length.toLocaleString()} confirmed connections</span></div>
      <label className="crm-search"><MagnifyingGlass size={16}/><input aria-label="Find someone on the map" value={query} placeholder="Find a person, role or organization" onChange={e => { setQuery(e.target.value); setFocus(''); resetView() }}/></label>
      <label className="crm-context-toggle"><input type="checkbox" checked={context} onChange={e => setContext(e.target.checked)}/>Event context</label>
    </header>
    {error && <p role="alert" className="crm-error">{error}</p>}
    {loading ? <p role="status">Loading your network…</p> : !graph.people.length ? <CrmEmpty title="Your network starts with a contact">Add someone to People or import a group.</CrmEmpty> :
    <>{!groupId && graph.people.length > PAGE && <label className="crm-network-groups">Group<select aria-label="Explore a network group" value={bucket} onChange={e => { setBucket(e.target.value); setFocus(''); setQuery(''); resetView() }}><option value="">All groups</option>{[...graph.buckets].sort((a,b) => b[1].count-a[1].count || a[1].name.localeCompare(b[1].name)).map(([id,g]) => <option key={id} value={id}>{g.name} ({g.count})</option>)}</select></label>}
    <label className="crm-network-groups">Shared organization<select aria-label="Explore a shared organization" value={organization} onChange={e=>{setOrganization(e.target.value);setFocus('');setQuery('');resetView()}}>
      <option value="">All employers and schools</option>{[...graph.orgs.byOrg].filter(([,ids])=>ids.size>1).sort((a,b)=>graph.orgs.names.get(a[0])!.localeCompare(graph.orgs.names.get(b[0])!)).map(([id,ids])=><option key={id} value={id}>{graph.orgs.names.get(id)} ({ids.size})</option>)}</select></label>
    <div className="crm-network-context">
      {(focused || bucket || term || organization) && <button className="crm-link-button" type="button" onClick={() => { if (focused) setFocus(''); else { setOrganization(''); setBucket(''); setQuery('') } resetView() }}>{focused ? 'Back to people' : 'All groups'}</button>}
      {focused ? <div className="crm-network-focus"><CrmAvatar name={displayName(focused)} assetId={focused.avatarAssetId} size={42}/><div><strong>{displayName(focused)}</strong><span>{focused.jobTitle || focused.emails[0]}</span></div>
        <button className="crm-icon" aria-label="Open selected contact" onClick={() => onSelectPerson(focused)}><ArrowSquareOut size={18}/></button><button className="crm-button" disabled={!writer || busy} onClick={() => { setConnection(true); setTarget(''); setTargetQuery(''); setNote(''); setRelation('knows') }}><Plus size={14}/>Connect</button></div> :
        <strong>{organization ? graph.orgs.names.get(organization) : activeBucket ? graph.buckets.get(activeBucket)?.name : term ? 'Search results' : 'All people'}</strong>}
      <span aria-live="polite">{focused ? visiblePool.length + ' related people' : visiblePool.length + ' people'}</span>
    </div>
    {visible.length > 0 ? <div className="crm-network-canvas" ref={scene}>
      <svg viewBox={'0 0 ' + width + ' ' + height} style={{ height }} role="group" aria-label="People relationship map" onPointerDown={e => {
        if (e.target !== e.currentTarget && (e.target as Element).tagName !== 'rect') return
        drag.current = {x:e.clientX,y:e.clientY,vx:view.x,vy:view.y}; e.currentTarget.setPointerCapture(e.pointerId)
      }} onPointerMove={e => { const d = drag.current; if (d) setView(v => ({...v,x:d.vx + e.clientX-d.x,y:d.vy + e.clientY-d.y})) }} onPointerUp={() => { drag.current=null }} onPointerCancel={() => { drag.current=null }}>
        <rect width={width} height={height} fill="transparent"/>
        <g transform={`translate(${width/2+view.x} ${height/2+view.y}) scale(${view.zoom}) translate(${-width/2} ${-height/2})`}>
          {shared.map(org=><g key={org.id} className="crm-org-links"><title>{org.name}</title>{org.members.slice(1).map((p,i)=>{
            const a=points.get(org.members[i].id)!, b=points.get(p.id)!
            return <line key={p.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y}/>
          })}</g>)}
          <g className="crm-graph-edges">{drawnLinks.map(edge => {const a=points.get(edge.from.id)!,b=points.get(edge.to.id)!;return <line key={edge.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={focused ? 'is-focused' : ''}><title>{edge.relation}{edge.context ? ' · '+edge.context : ''}</title></line>})}</g>
          {eventContexts.map(event => { const attendees=event.personIds.flatMap(id => points.has(id) ? [points.get(id)!] : []), x=attendees.reduce((sum,p)=>sum+p.x,0)/attendees.length,y=attendees.reduce((sum,p)=>sum+p.y,0)/attendees.length; return <g className="crm-event-context" key={event.id}>{attendees.map((p,i)=><line key={i} x1={p.x} y1={p.y} x2={x} y2={y+14}/>)}<circle cx={x} cy={y+14} r={3}/><title>{event.title} · attendance {event.attendanceConfirmed ? 'confirmed' : 'unconfirmed'}</title></g>})}
          {visible.map(p => { const point = points.get(p.id)!, name = displayName(p), labelWidth = Math.max(45,width/(columns+1)-9)
            return <g className={'crm-graph-person' + (p.id === focused?.id ? ' is-selected' : '')} key={p.id} transform={`translate(${point.x} ${point.y})`} role="button" tabIndex={0} aria-label={name} onClick={() => choosePerson(p.id)} onDoubleClick={() => onSelectPerson(p)} onKeyDown={e => { if (e.key==='Enter' || e.key===' ') {e.preventDefault();choosePerson(p.id)} }}>
              <circle r={21} className="crm-person-outline"/><foreignObject x={-17} y={-17} width={34} height={34} pointerEvents="none"><CrmAvatar name={name} assetId={p.avatarAssetId} size={34}/></foreignObject>
              <foreignObject x={-labelWidth/2} y={23} width={labelWidth} height={23} pointerEvents="none" aria-hidden="true"><span className="crm-network-label">{name}</span></foreignObject><title>{name}{p.jobTitle ? ' · '+p.jobTitle : ''}</title></g>
          })}</g>
      </svg></div> : <p role="status">No people match this search.</p>}
    {shared.length>0 && <div className="crm-shared-clusters" aria-label="Shared organizations in view">{shared.map(org=><button key={org.id} onClick={()=>{setOrganization(org.id);setFocus('');setQuery('');resetView()}}>{org.name} · {org.members.length}</button>)}</div>}
    <div className="crm-network-controls"><span>{shownLinks.length > drawnLinks.length ? 'Showing '+drawnLinks.length+' of '+shownLinks.length+' connections here. Select a person to see their connections.' : context ? 'Solid lines show confirmed connections. Dotted lines show shared events.' : 'Solid lines show confirmed connections. Dashed lines link people at the same organization.'}</span>
      {maxPage > 0 && <nav aria-label="Network pages"><button type="button" disabled={!currentPage} onClick={() => setPage(currentPage-1)}>Previous</button><small>{currentPage+1} / {maxPage+1}</small><button type="button" disabled={currentPage===maxPage} onClick={() => setPage(currentPage+1)}>Next</button></nav>}
      {!!visible.length && <div><button className="crm-icon" aria-label="Zoom out" disabled={view.zoom<=1} onClick={() => setView(v=>({...v,zoom:Math.max(1,v.zoom/1.25)}))}><Minus size={15}/></button><button className="crm-icon" aria-label="Zoom in" disabled={view.zoom>=4} onClick={() => setView(v=>({...v,zoom:Math.min(4,v.zoom*1.25)}))}><Plus size={15}/></button><button className="crm-icon" aria-label="Fit network" onClick={() => setView({x:0,y:0,zoom:1})}><ArrowsOut size={15}/></button></div>}</div>
    {eventError && <p className="crm-error" role="alert">{eventError}</p>}</>}
    {connection && focused && <CrmDialog title={'Connect '+displayName(focused)} onClose={() => setConnection(false)}><form className="crm-form" onSubmit={e=>{e.preventDefault();void addConnection()}}>
      <label>Find a contact<input type="search" value={targetQuery} onChange={e=>{setTargetQuery(e.target.value);setTarget('')}}/></label>
      <label>Person<select required value={target} onChange={e=>setTarget(e.target.value)}><option value="">Choose someone</option>{graph.people.filter(p=>p.id!==focused.id && graph.text.get(p.id)!.includes(targetQuery.trim().toLocaleLowerCase())).slice(0,100).map(p=><option key={p.id} value={p.id}>{displayName(p)}{p.jobTitle ? ' · '+p.jobTitle : ''}</option>)}</select></label>
      <label>Relationship<input value={relation} onChange={e=>setRelation(e.target.value)}/></label><label>Context<textarea value={note} onChange={e=>setNote(e.target.value)}/></label>
      {error && <p className="crm-error" role="alert">{error}</p>}<button className="crm-button is-primary" disabled={!writer||busy||!target}>{busy?'Saving…':'Add connection'}</button></form></CrmDialog>}
  </section>
}
