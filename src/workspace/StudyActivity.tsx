import { useEffect, useRef, useState } from 'react'
import { ClockCounterClockwise, CaretDown } from '@phosphor-icons/react'
import { getStore, getWorldGeneration, isRepoReady, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import { BOOKSHELF_KV } from '../bookshelf/types.ts'
import { decodeBookshelf } from '../bookshelf/model.ts'
import { decodeWriting } from '../writing/model.ts'
import { WRITING_KV } from '../writing/types.ts'
import { decodeWritingHistory, WRITING_HISTORY_KV } from '../writing/history.ts'
import { decodeQuotes, QUOTES_KV } from '../quotes/model.ts'

type Category = 'Writing' | 'Reading' | 'Quotes'
interface Entry { kind: Category; time: number; title: string; action: string; href: string }
const keys = [WRITING_KV,WRITING_HISTORY_KV,BOOKSHELF_KV,QUOTES_KV]
const fields: Record<string,string> = {content:'text',topicIds:'topics',appearance:'design',bookEditionId:'edition'}
function entries([docs, snapshots, books, quotes]: unknown[]): Entry[] {
  const writing = decodeWriting(docs), rows: Entry[] = []
  const titles = new Map(writing.docs.map(d=>[d.id,d]))
  const draftLink = (id:string) => '#/write?doc=' + encodeURIComponent(id)
  for (const d of writing.docs) rows.push({ kind:'Writing', time:d.createdAt, title:d.title, action:'Created draft', href:draftLink(d.id) })
  const recorded = new Map<string,number>()
  for (const e of writing.edits ?? []) {
    const doc=titles.get(e.documentId)
    if (doc) rows.push({ kind:'Writing', time:e.at, title:doc.title, action:'Edited ' + e.fields.map(f=>fields[f]??f).join(', '), href:draftLink(doc.id) })
    recorded.set(e.documentId,Math.max(e.at,recorded.get(e.documentId)??0))
  }
  for (const d of writing.docs) {
    if (d.updatedAt>d.createdAt && d.updatedAt>(recorded.get(d.id)??0)) rows.push({kind:'Writing',time:d.updatedAt,title:d.title,action:'Updated draft',href:draftLink(d.id)})
    if (d.lastPublishedAt) rows.push({kind:'Writing',time:d.lastPublishedAt,title:d.title,action:'Published to Library',href:draftLink(d.id)})
  }
  for (const s of decodeWritingHistory(snapshots).entries) rows.push({kind:'Writing',time:s.createdAt,title:s.document.title,action:s.label,href:draftLink(s.documentId)})
  const shelf=decodeBookshelf(books)
  for (const r of shelf.history) rows.push({ kind:'Reading',time:r.recordedAt,title:r.book.title,action:r.label,href:'#/bookshelf?book='+encodeURIComponent(r.bookId) })
  const logged=new Set(shelf.history.filter(r=>r.kind==='created').map(r=>r.bookId))
  for (const b of shelf.books) if (!logged.has(b.id)) rows.push({kind:'Reading',time:b.createdAt,title:b.title,action:'Added to Bookshelf',href:'#/bookshelf?book='+encodeURIComponent(b.id)})
  for (const q of decodeQuotes(quotes).quotes) for (const r of q.history) rows.push({ kind:'Quotes',time:r.at,title:r.source.title,action:r.action==='captured'?'Captured quote':r.action==='amended'?'Edited citation':'Rechecked source',href:'#/quotes?quote='+encodeURIComponent(q.id) })
  return rows.sort((a,b)=>b.time-a.time)
}
export default function StudyActivity({hash}:{hash:string}) {
  const requested = new URLSearchParams(hash.split('?')[1]??'').get('view') === 'study-activity'
  const [open,setOpen]=useState(requested), [data,setData]=useState<Entry[]>([]), [filter,setFilter]=useState('All'), [limit,setLimit]=useState(25), [error,setError]=useState(''), [loaded,setLoaded]=useState(false)
  const ready=useRepoStatus(s=>s.ready), panel=useRef<HTMLDetailsElement>(null)
  useEffect(()=>{if(requested){setOpen(true);panel.current?.scrollIntoView?.({block:'start'})}},[requested])
  useEffect(()=>{
    if(!ready||!open||!isRepoReady())return
    const store=getStore(), generation=getWorldGeneration()
    let active=true, seq=0
    async function load(){const id=++seq;try{const values=await Promise.all(keys.map(k=>store.getKv(k)));if(active&&id===seq&&getWorldGeneration()===generation){setData(entries(values));setError('');setLoaded(true)}}catch(e){if(active&&id===seq){setError(e instanceof Error?e.message:'Could not load activity.');setLoaded(true)}}}
    void load()
    const stop=subscribeRepo(change=>{if(change.type==='kv'&&change.keys.some(k=>keys.includes(k)))void load()})
    return ()=>{active=false;stop()}
  },[ready,open])
  const visible=filter==='All'?data:data.filter(e=>e.kind===filter)
  return <details open={open} ref={panel} onToggle={e=>setOpen(e.currentTarget.open)} className="study-activity"><summary><ClockCounterClockwise size={18}/>Reading &amp; writing activity<CaretDown size={15}/></summary>
    {open&&<div className="study-activity-body"><label>Show <select value={filter} onChange={e=>{setFilter(e.target.value);setLimit(25)}}>{['All','Writing','Reading','Quotes'].map(v=><option key={v}>{v}</option>)}</select></label>
      {error&&<p role="alert">{error}</p>}{!loaded&&<p role="status">Loading activity…</p>}{loaded&&!visible.length&&!error&&<p>Your saved work will appear here.</p>}
      <ol>{visible.slice(0,limit).map((e,i)=><li key={e.kind+e.time+e.href+i}><a href={e.href}><span><strong>{e.title || 'Untitled'}</strong><small>{e.action}</small></span><time dateTime={new Date(e.time).toISOString()}>{new Date(e.time).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'})}</time></a></li>)}</ol>
      {visible.length>limit&&<button type="button" className="knowledge-text-button" onClick={()=>setLimit(limit+25)}>Show more activity</button>}</div>}
  </details>
}
