import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowSquareOut, BookmarkSimple, CalendarBlank, Camera, CaretRight, Compass, Crosshair, GlobeHemisphereWest, MagnifyingGlass, MapPin, Path, PlugsConnected, Users, X } from '@phosphor-icons/react'
import { crmAll } from '../crm/client.ts'
import { CrmAvatar } from '../crm/CrmControls.tsx'
import { subscribeRepo } from '../data/repo.ts'
import { AtlasMap } from './AtlasMap.tsx'
import { MapSources } from './MapSources.tsx'
import { contactPlaces, groupAtlasEntries, layerNames, locateEntry, photoVisit, photosDuringVisit, sourceNames, visitDuration, type AtlasEntry, type AtlasGroup } from './atlas.ts'
import { initializePlaces, nativePhotoId, usePlaces } from './store.ts'
import { useMapCalendars } from './useMapCalendars.ts'
import './atlas.css'

const icons = { saved:BookmarkSimple, event:CalendarBlank, photo:Camera, person:Users, visit:Path }
function dateLabel(value: string | null) {
  if (!value) return ''
  const d=new Date(value)
  return Number.isFinite(d.getTime()) ? d.toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',...(!/^\d{4}-\d\d-\d\d$/.test(value) ? {hour:'numeric',minute:'2-digit'} as const : {timeZone:'UTC'})}) : value
}
function EntryPicture({entry}: {entry:AtlasEntry}) {
  const [picture,setPicture]=useState(''), Icon=icons[entry.kind]
  const id=entry.provider==='apple-photos' && entry.kind==='photo' ? nativePhotoId({...entry,kind:'photo',provider:'apple-photos'}) : null
  useEffect(()=>{
    let alive=true
    if(id && !entry.thumbnail) void window.worldviewDesktop?.photoPlaceThumbnail?.(id).then(src=>{if(alive && src)setPicture(src)}).catch(()=>{})
    return()=>{alive=false}
  },[id,entry.thumbnail])
  if (entry.kind==='person') return <CrmAvatar name={entry.title} assetId={entry.avatarAssetId} size={33}/>
  return entry.thumbnail || picture ? <img className="atlas-thumb" alt="" src={entry.thumbnail || picture}/> : <i className="atlas-kind-icon"><Icon size={17}/></i>
}
function PhotoDetail({photo, photos, visits, onClose, onPhoto}: {photo:AtlasEntry;photos:AtlasEntry[];visits:AtlasEntry[];onClose:()=>void;onPhoto:(photo:AtlasEntry)=>void}) {
  const dialog=useRef<HTMLDialogElement>(null)
  const [limit,setLimit]=useState(24)
  const context=useMemo(()=>photoVisit(photo,photos,visits),[photo,photos,visits])
  useEffect(()=>{const el=dialog.current;el?.showModal();return()=>el?.close()},[])
  const others=context.photos.filter(p=>p.id!==photo.id)
  const span=visitDuration(context.photos.at(0)?.startedAt ?? null,context.photos.at(-1)?.startedAt ?? null)
  return <dialog className="atlas-photo-detail" ref={dialog} aria-label="Photo details" onCancel={onClose}>
    <header><h2>{photo.title}</h2><button type="button" aria-label="Close photo" onClick={onClose}><X/></button></header>
    <div className="atlas-photo-preview"><EntryPicture key={photo.id} entry={photo}/></div>
    <p><strong>{dateLabel(photo.startedAt) || 'Capture time unavailable'}</strong></p><p>{photo.address || photo.nearby || 'Recorded location'} · {photo.latitude?.toFixed(4)}°, {photo.longitude?.toFixed(4)}°</p>
    {context.visit ? <p><b>{visitDuration(context.visit.startedAt,context.visit.endedAt)} recorded visit</b> · {context.visit.title}</p> :
    <p>{others.length ? 'Photos span '+span+' at this location. Arrival and departure are unknown.' : 'Visit duration unavailable from this photo.'}</p>}
    {others.length>0 && <><h3>{others.length} other {others.length===1?'photo':'photos'} {context.visit?'during this visit':'taken nearby'}</h3><div className="atlas-photo-strip">{others.slice(0,limit).map(p=><button type="button" key={p.id} aria-label={'View '+p.title} onClick={()=>onPhoto(p)}><EntryPicture entry={p}/><small>{dateLabel(p.startedAt)}</small></button>)}</div>{others.length>limit && <button type="button" onClick={()=>setLimit(limit+24)}>More photos</button>}</>}
  </dialog>
}
function Records({group, photos,onPhoto}: {group:AtlasGroup; photos:AtlasEntry[];onPhoto:(p:AtlasEntry)=>void}) {
  const [limit,setLimit]=useState(18)
  return <div className="atlas-records">
    {group.entries.slice(0,limit).map(entry=>{
      const nearbyPhotos=photosDuringVisit(entry,photos)
      const duration = entry.kind==='visit' ? visitDuration(entry.startedAt,entry.endedAt) : ''
      if(entry.kind==='person') return <article className="atlas-person-card" key={entry.id}><EntryPicture entry={entry}/><div>
        <a className="atlas-person-name" href={entry.url || undefined}>{entry.title}<CaretRight size={13}/></a>
        {entry.detail && <p title={entry.detail}>{entry.detail}</p>}
        {!!entry.organizations?.length && <div className="atlas-person-orgs">{entry.organizations.map(org=>{
          const content=<>{org.logo && <CrmAvatar organization name={org.name} assetId={org.logo} size={19}/>}<span>{org.name}</span></>
          return org.linked ? <a key={org.id} href={'#/people?tab=companies&company='+encodeURIComponent(org.id)}>{content}</a> : <span key={org.id}>{content}</span>
        })}</div>}
      </div></article>
      return <article key={entry.id}>{entry.kind==='photo'?<button className="atlas-photo-button" aria-label={'View '+entry.title} onClick={()=>onPhoto(entry)}><EntryPicture entry={entry}/></button>:<EntryPicture entry={entry}/>}<div>
        <strong>{entry.kind==='photo'?<button className="atlas-photo-title" onClick={()=>onPhoto(entry)}>{entry.title}</button>:entry.url ? <a href={entry.url} target="_blank" rel="noreferrer noopener">{entry.title}<ArrowSquareOut size={11}/></a> : entry.title}</strong>
        <span>{[sourceNames[entry.provider],entry.account,entry.city && entry.approximate?'City estimate':''].filter(Boolean).join(' · ')}</span>
        <small>{[dateLabel(entry.startedAt),duration && duration+' visit',entry.address || (entry.nearby && 'Near '+entry.nearby),entry.detail].filter(Boolean).join(' · ')}</small>
        {nearbyPhotos.length>0 && <details className="atlas-visit-photos"><summary>{nearbyPhotos.length} {nearbyPhotos.length===1?'photo':'photos'} during this visit</summary><small>Captured within 500 m during the recorded visit.</small>{nearbyPhotos.slice(0,12).map(photo=><div key={photo.id}><button className="atlas-photo-button" aria-label={'View '+photo.title} onClick={()=>onPhoto(photo)}><EntryPicture entry={photo}/></button><span>{photo.title}<small>{dateLabel(photo.startedAt)}</small></span></div>)}{nearbyPhotos.length>12 && <small>Showing the first 12 photos.</small>}</details>}
        {entry.lists?.length ? <small>{entry.lists.map(list=>list.name).join(' · ')}</small> : null}
        {entry.visualLabels?.length ? <small>{entry.visualLabels.join(' · ')}</small> : null}
      </div></article>
    })}
    {limit<group.entries.length && <button type="button" onClick={()=>setLimit(limit+30)}>Show more records</button>}
  </div>
}
function PlaceDetails({groups,chosen,onChoose,photos,onPhoto,onLocate,close}: {
  groups:AtlasGroup[]; chosen?:AtlasGroup; onChoose:(group:AtlasGroup|null)=>void; photos:AtlasEntry[];
  onPhoto:(photo:AtlasEntry)=>void; onLocate:(group:AtlasGroup)=>void; close:()=>void
}) {
  const heading=useRef<HTMLHeadingElement>(null), [limit,setLimit]=useState(40)
  useEffect(()=>{heading.current?.focus({preventScroll:true}); if(matchMedia('(max-width:780px)').matches) heading.current?.scrollIntoView({block:'nearest'})},[groups,chosen?.id])
  const counts=new Map<string,number>()
  for(const entry of chosen?.entries ?? []) counts.set(entry.kind,(counts.get(entry.kind) ?? 0)+1)
  const labels:Record<string,[string,string]>={person:['person','people'],photo:['photo','photos'],event:['event','events'],visit:['visit','visits'],saved:['place','places']}
  return <section className="atlas-place-detail" aria-label="Explore location">
    <header><div><h3 ref={heading} tabIndex={-1}>{chosen?.title ?? 'Nearby locations'}</h3><p>{chosen ? [...counts].map(([kind,n])=>n.toLocaleString()+' '+labels[kind][n===1?0:1]).join(' · ') : groups.length.toLocaleString()+' locations'}</p></div><button aria-label="Close location" title="Back to location index" onClick={close}><X size={18}/></button></header>
    <div className="atlas-panel-scroll" key={chosen?.id ?? 'locations'}>
    {chosen ? <><div className="atlas-location-actions">
      {groups.length>1 && <button onClick={()=>onChoose(null)}>All {groups.length} locations</button>}
      {chosen.latitude!==null && <button onClick={()=>onLocate(chosen)}><Crosshair size={14}/>Zoom here</button>}
      {chosen.entries.every(e=>e.approximate) && <small>City-level location</small>}</div>
      <Records key={chosen.id} group={chosen} photos={photos} onPhoto={onPhoto}/></> :
      <>{groups.slice(0,limit).map(g=><button key={g.id} className="atlas-place-row" onClick={()=>onChoose(g)}><MapPin/><span><strong>{g.title}</strong><small>{g.latitude?.toFixed(3)}°, {g.longitude?.toFixed(3)}°</small></span><em>{g.entries.length}</em><CaretRight/></button>)}
      {groups.length>limit && <button className="atlas-more" onClick={()=>setLimit(limit+40)}>More locations</button>}</>}
    </div></section>
}
export default function PlacesWorkspace() {
  const entries=usePlaces(s=>s.entries), placesError=usePlaces(s=>s.error), loaded=usePlaces(s=>s.loaded)
  const calendars=useMapCalendars()
  const [people,setPeople]=useState<AtlasEntry[]>([]), [peopleError,setPeopleError]=useState(''), [peopleLoading,setPeopleLoading]=useState(true)
  const [query,setQuery]=useState(''), [layer,setLayer]=useState(''), [account,setAccount]=useState(''), [selected,setSelected]=useState(''), [focus,setFocus]=useState<AtlasGroup | null>(null), [limit,setLimit]=useState(30)
  const search=useRef<HTMLInputElement>(null), results=useRef<HTMLDivElement>(null)
  useEffect(()=>{
    void initializePlaces().catch(()=>{})
    let controller:AbortController | null=null
    function reload() {
      controller?.abort(); const next=new AbortController(); controller=next
      void Promise.all([crmAll('people',next.signal),crmAll('companies',next.signal)]).then(([rows,companies])=>{ if(!next.signal.aborted){ setPeople(contactPlaces(rows,companies)); setPeopleError('');setPeopleLoading(false) } }).catch(e=>{ if(!next.signal.aborted){setPeopleError(e instanceof Error?e.message:String(e));setPeopleLoading(false)} })
    }
    reload(); const stop=subscribeRepo(c=>{ if(c.type==='kv' && c.keys.includes('crm.v1'))reload() })
    window.addEventListener('worldview:crm-changed',reload)
    return()=>{controller?.abort();stop();window.removeEventListener('worldview:crm-changed',reload)}
  },[])
  const rows=useMemo(()=>[...entries.map(locateEntry),...calendars.cache.accounts.flatMap(a=>a.entries.map(locateEntry)),...people],[entries,calendars.cache.accounts,people])
  const accounts=useMemo(()=>Array.from(new Set(rows.map(e=>e.account).filter(Boolean))).sort(),[rows])
  const [openPhoto,setOpenPhoto]=useState<AtlasEntry|null>(null)
  const visits=useMemo(()=>rows.filter(r=>r.kind==='visit'),[rows])
  const photos=useMemo(()=>rows.filter(e=>e.kind==='photo' && e.startedAt && Number.isFinite(Date.parse(e.startedAt))).sort((a,b)=>Date.parse(a.startedAt!)-Date.parse(b.startedAt!)),[rows])
  const groups=useMemo(()=>groupAtlasEntries(rows,query,layer,account),[rows,query,layer,account])
  const chosen=groups.find(g=>g.id===selected)
  const count=groups.reduce((total,g)=>total+g.entries.length,0)
  const [expanded,setExpanded]=useState(false)
  const invoker=useRef<HTMLElement|null>(null)
  function resetResults() { setOpened([]); setSelected(''); setFocus(null); setLimit(30); if(results.current) results.current.scrollTop=0 }
  const [opened,setOpened]=useState<AtlasGroup[]>([])
  const openGroups=useCallback((items:AtlasGroup[])=>{
    invoker.current=document.activeElement instanceof HTMLElement ? document.activeElement : null
    setOpened(items); setSelected(items.length===1 ? items[0].id : '')
  },[])
  function closeLocation() {
    setOpened([]);setSelected('')
    requestAnimationFrame(()=>{if(invoker.current?.isConnected)invoker.current.focus({preventScroll:true});else search.current?.focus({preventScroll:true})})
  }
  return <div className="world-atlas">
    <header className="atlas-title"><div><h2>Your atlas</h2><p>{!loaded || peopleLoading ? 'Finding your places…' : groups.length.toLocaleString()+(groups.length===1?' location · ':' locations · ')+count.toLocaleString()+(count===1?' record':' records')}</p></div>
      <a className="atlas-source-jump" href="#atlas-source-panel" onClick={e=>{e.preventDefault();const el=document.getElementById('atlas-source-panel') as HTMLDetailsElement|null;if(el){el.open=!el.open; if(el.open){el.scrollIntoView({block:'nearest'});el.querySelector('summary')?.focus()}}}}><PlugsConnected size={16}/>Sources</a></header>
    <div className="atlas-controls"><label className="atlas-search"><MagnifyingGlass size={17}/><input ref={search} type="search" aria-label="Search your atlas" placeholder="Search places, people, organizations or photos…" value={query} onChange={e=>{setQuery(e.target.value);resetResults()}}/>{query && <button type="button" aria-label="Clear atlas search" onClick={()=>{setQuery('');resetResults();search.current?.focus()}}><X size={14}/></button>}</label>
      <a className="atlas-source-jump" href={'#/people?tab=people&network='+encodeURIComponent(query)}>People network</a>
      {accounts.length>0 && <select aria-label="Filter by source account" value={account} onChange={e=>{setAccount(e.target.value);resetResults()}}><option value="">All accounts</option>{accounts.map(a=><option key={a}>{a}</option>)}</select>}
    </div>
    <div className="atlas-layers" role="group" aria-label="Map layers">{['',...Object.keys(layerNames)].map(k=>{
      const key=k as keyof typeof icons, Icon=icons[key] ?? GlobeHemisphereWest
      return <button key={key} type="button" aria-pressed={layer===key} onClick={()=>{setLayer(key);resetResults()}}><Icon size={14}/>{layerNames[key] ?? 'All'}</button>
    })}</div>
    <div className={'atlas-layout'+(expanded?' is-expanded':'')} onKeyDown={e=>{if(e.key==='Escape' && opened.length){ e.preventDefault();closeLocation() }}}><AtlasMap expanded={expanded} onExpand={setExpanded} groups={groups} active={selected} select={openGroups} focus={focus}/>
      {opened.length ? <PlaceDetails groups={opened} chosen={chosen} onChoose={g=>setSelected(g?.id ?? '')} photos={photos} onPhoto={setOpenPhoto} onLocate={g=>setFocus({...g})} close={closeLocation}/> : <section className="atlas-index"><header><h3>Location index</h3><span>{groups.length.toLocaleString()}</span></header>
        <div className="atlas-index-scroll" ref={results}>{groups.length ? <>{groups.slice(0,limit).map(g=><button type="button" className="atlas-place-row" key={g.id} onClick={()=>{openGroups([g]);setFocus(g)}}>
          <MapPin size={16} weight={g.latitude===null?'light':'duotone'}/><span><strong>{g.title}</strong><small>{[...new Set(g.entries.map(e=>sourceNames[e.provider]))].join(' · ')}{g.latitude===null?' · Unmapped':''}</small></span><em>{g.entries.length}</em><CaretRight size={13}/></button>)}
          {limit<groups.length && <button type="button" className="atlas-more" onClick={()=>setLimit(limit+50)}>Show more places</button>}</> :
        <div className="atlas-empty"><Compass size={28}/><strong>{!loaded || peopleLoading?'Loading places…':query || layer || account?'No matching locations':'Your atlas starts here'}</strong><p>{query || layer || account?'Try another search or map layer.':'Connect a calendar or import saved places in Sources.'}</p></div>}</div></section>}
    </div>
    {(peopleError || placesError) && <p role="status" className="atlas-error">{[placesError,peopleError].filter(Boolean).join(' · ')}</p>}

    {openPhoto && <PhotoDetail photo={openPhoto} photos={photos} visits={visits} onPhoto={setOpenPhoto} onClose={()=>setOpenPhoto(null)}/>}
    <details id="atlas-source-panel" className="atlas-sources"><summary><PlugsConnected size={17}/>Map sources<CaretRight size={14}/></summary><MapSources calendars={calendars}/></details>
  </div>
}
