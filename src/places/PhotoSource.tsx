import { useCallback, useEffect, useRef, useState } from 'react'
import { Images } from '@phosphor-icons/react'
import { getStore, getWorldGeneration, isRepoReady, useRepoStatus } from '../data/repo.ts'
import { setPhotoAutoRefresh } from './calendar.ts'
import { replacePhotoLibraryRecords, type NativePhotoRecord } from './store.ts'

export function PhotoSource({preferences}: { preferences?: {automatic:boolean;lastRead:number} }) {
  const writer=useRepoStatus(s=>s.writer), [labels,setLabels]=useState(false), [scanning,setScanning]=useState(false), [status,setStatus]=useState('')
  const lifetime=useRef(0), running=useRef(false), lastAttempt=useRef(0)
  useEffect(()=>{const token=++lifetime.current; return()=>{lifetime.current=token+1;running.current=false}},[])
  const read=window.worldviewDesktop?.readPhotoPlaces
  const scan=useCallback(async (explicit: boolean, includeLabels: boolean) => {
    if (!read || running.current || !writer || !isRepoReady()) return
    const life=lifetime.current, store=getStore(), generation=getWorldGeneration()
    const valid=()=>life===lifetime.current && isRepoReady() && getStore()===store && getWorldGeneration()===generation
    running.current=true; lastAttempt.current=Date.now(); setScanning(true); setStatus('Opening Apple Photos…')
    try {
      const rows:NativePhotoRecord[]=[]
      let offset=0, snapshotToken:string|undefined
      for (;;) {
        const page=await read({offset, requestAccess:explicit && offset===0, includeLabels, snapshotToken})
        if(!valid()) return
        snapshotToken=page.snapshotToken
        for(const row of page.records)rows.push(row)
        if (page.nextOffset===null) {
          const report=await replacePhotoLibraryRecords(rows,'Apple Photos on this Mac')
          if (!valid()) return
          await setPhotoAutoRefresh(preferences?.automatic ?? true, Date.now())
          if (valid()) setStatus(rows.length+' geotagged photos · '+report.added+' added · '+report.updated+' updated'+(report.removed?' · '+report.removed+' removed':'')+(page.limited?' · Limited Photos access':''))
          break
        }
        if (!snapshotToken || page.nextOffset<=offset) throw new Error('Photos returned an incomplete page. Refresh to try again.')
        offset=page.nextOffset
        setStatus((includeLabels?'Indexing photo subjects':'Checking Photos')+' · '+offset+' of '+page.total)
      }
    } catch(e) { if(valid()) setStatus(e instanceof Error?e.message:String(e)) }
    finally { if(valid()){running.current=false;setScanning(false)} }
  },[read,writer,preferences?.automatic])
  useEffect(()=>{
    if(!preferences?.automatic || !writer) return
    const refresh=()=>{ if(Date.now()-Math.max(preferences.lastRead,lastAttempt.current)>3600000)void scan(false,false) }
    refresh();const timer=window.setInterval(refresh,3600000)
    return()=>clearInterval(timer)
  },[preferences,scan,writer])
  return <section><h3><Images/>Apple Photos</h3><p>Search dates, filenames and albums. On-device subject indexing also finds pictures by what’s in them.</p>
    {read ? <><label className="atlas-account-toggle"><input type="checkbox" checked={labels} disabled={scanning} onChange={e=>setLabels(e.target.checked)}/>Index visual subjects on this Mac</label>
    <button type="button" disabled={!writer || scanning} onClick={()=>void scan(true,labels)}>{scanning?'Reading Photos…':preferences?.lastRead?'Refresh Apple Photos':'Connect Apple Photos'}</button>
    {preferences?.lastRead ? <label className="atlas-account-toggle"><input type="checkbox" disabled={!writer || scanning} checked={preferences.automatic} onChange={e=>void setPhotoAutoRefresh(e.target.checked,preferences.lastRead).catch(err=>setStatus(String(err)))}/>Refresh automatically in Maps</label>:null}</> :
    <small>Open the Mac app to connect Photos. You can also import geotagged JPEGs.</small>}
    {status && <p role="status">{status}</p>}
  </section>
}
