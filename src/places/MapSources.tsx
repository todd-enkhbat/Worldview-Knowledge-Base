import { useEffect, useRef, useState } from 'react'
import { CalendarDots, UploadSimple } from '@phosphor-icons/react'
import { useRepoStatus } from '../data/repo.ts'
import type { useMapCalendars } from './useMapCalendars.ts'
import { ContactSource } from './ContactSource.tsx'
import { PhotoSource } from './PhotoSource.tsx'
import { importMapLink, importPlaceFiles, usePlaces } from './store.ts'

export function MapSources({calendars}: {calendars: ReturnType<typeof useMapCalendars>}) {
  const writer = useRepoStatus(s=>s.writer), busy = usePlaces(s=>s.busy)
  const [account,setAccount] = useState(''), [status,setStatus] = useState(''), [issues,setIssues] = useState<string[]>([]), [link,setLink] = useState('')
  const picker = useRef<HTMLInputElement>(null), alive=useRef(true)
  useEffect(()=>{alive.current=true; return()=>{alive.current=false}},[])
  async function files(selected: File[]) {
    setIssues([]); setStatus('Reading files…')
    try {
      const r=await importPlaceFiles(selected, {account:account.trim()})
      if (alive.current) { setStatus(r.added+' added · '+r.updated+' updated · '+r.unchanged+' already saved' + (r.skipped ? ' · '+r.skipped+' skipped' : '')); setIssues(r.issues) }
    } catch (e) { if(alive.current) setStatus(String(e)) }
  }
  return <div className="atlas-source-body">
    <section><h3><UploadSimple/>Import place files</h3><p>Google Takeout saved lists and Timeline, Apple Maps place cards, calendar invites, and geotagged JPEGs.</p>
      <label>Account label <input aria-label="Account label for imported places" value={account} maxLength={300} onChange={e=>setAccount(e.target.value)} placeholder="Optional, e.g. personal Google"/></label>
      <input ref={picker} type="file" accept=".zip,.csv,.json,.geojson,.vcf,.ics,.jpg,.jpeg" multiple hidden onChange={e=>{const selected=Array.from(e.target.files??[]);e.target.value=''; if(selected.length)void files(selected)}}/>
      <button type="button" disabled={!writer || busy} onClick={()=>picker.current?.click()}>Choose files</button>
      <form onSubmit={async e=>{ e.preventDefault();setIssues([]);try{const r=await importMapLink(link,{account});if(alive.current){setLink('');setStatus(r.added?'Place saved.':'Place already saved.')}}catch(error){if(alive.current)setStatus(String(error))} }}><label>Map link<input type="url" required placeholder="Paste an Apple or Google Maps link" value={link} onChange={e=>setLink(e.target.value)}/></label><button type="submit" disabled={!writer || busy || !link.trim()}>Save place</button></form></section>
    <section><h3><CalendarDots/>Calendar venues</h3><p>Locations from your selected Google calendars, including Luma and Partiful invitations. Covers the past 300 and next 65 days.</p>
      {calendars.accounts.map(a=><label key={a.id} className="atlas-account-toggle"><input type="checkbox" checked={calendars.cache.accounts.some(c=>c.id===a.id)} disabled={!writer || calendars.busy} onChange={e=>void calendars.toggle(a,e.target.checked)}/>{a.email || a.label}</label>)}
      {calendars.cache.accounts.filter(a=>!calendars.accounts.some(c=>c.id===a.id)).map(a=><small key={a.id}>{a.label} · Saved venues available offline <button type="button" disabled={!writer || calendars.busy} onClick={()=>void calendars.toggle({...a,email:null},false)}>Remove from map</button></small>)}
      <a href="#/people?tab=connections">Manage Google accounts ↗</a>{calendars.cache.accounts.length>0 && <button type="button" disabled={!writer || calendars.busy} onClick={()=>void calendars.sync(true)}>{calendars.busy?'Refreshing…':'Refresh venues'}</button>}
      {calendars.error && <p role="status">{calendars.error}</p>}</section>
    <ContactSource/>
    <PhotoSource preferences={calendars.cache.photos}/>
    {status && <p className="atlas-source-status" role="status">{status}</p>}{issues.length>0 && <details><summary>Import details ({issues.length})</summary><ul>{issues.map((m,i)=><li key={i}>{m}</li>)}</ul></details>}
  </div>
}
