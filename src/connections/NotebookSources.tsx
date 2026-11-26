import { useEffect, useRef, useState } from 'react'
import { ArrowSquareOut, ArrowLeft, DownloadSimple } from '@phosphor-icons/react'
import { useRepoStatus } from '../data/repo.ts'
import { keepNotebookNote, notebookLabel, notePreview, noteResults, type NoteItem, type NoteKind, type NotePreview, type Notebook, type NotebookReply } from './notebookNotes.ts'
import './notebookSources.css'

const base = '/api/connections/notebooks'
const names = ['granola','wispr'] as const
type Connections = Record<Notebook, boolean>
async function request<T>(path = '', body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'x-wv-client':'worldview-notebooks', ...(body ? { 'content-type':'application/json' } : {}) }, credentials: 'same-origin', ...(body ? { body: JSON.stringify(body) } : {}) })
  const value = await res.json()
  if (!res.ok) throw new Error(value.error || 'The provider could not complete the request.')
  return value as T
}
function dateLabel(date: string) { return Number.isFinite(Date.parse(date)) ? new Date(date).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' }) : '' }

export default function NotebookSources({ onChange }: { onChange: () => void }) {
  const [connected, setConnected] = useState<Connections | null>(null), [key, setKey] = useState<Notebook>('granola')
  const [kind, setKind] = useState<NoteKind>('meeting'), [query, setQuery] = useState(''), [busy, setBusy] = useState(false)
  const [results, setResults] = useState<NoteItem[] | null>(null), [cursor,setCursor] = useState(''), [preview,setPreview] = useState<NotePreview | null>(null)
  const [error,setError] = useState(''), [url,setUrl] = useState(''), [saved,setSaved] = useState('')
  const version = useRef(0), callback = useRef(onChange), writer = useRepoStatus(s=>s.writer)
  callback.current = onChange
  useEffect(() => {
    let active = true
    async function refresh() {
      try { const status = await request<Connections>(); if (active) { setConnected(status); if (url && status[key]) { setUrl(''); callback.current() } } }
      catch (e) { if (active) setError(e instanceof Error ? e.message : 'Connection status unavailable.') }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    const timer = url ? window.setInterval(refresh, 3500) : undefined
    return () => { active = false; window.removeEventListener('focus',refresh); clearInterval(timer) }
  }, [key,url])
  useEffect(() => () => { version.current++ }, [])
  function reset() { version.current++; setResults(null); setCursor(''); setError(''); setBusy(false); setPreview(null); setSaved(''); setUrl(''); setQuery('') }
  async function run(operation: (valid: () => boolean) => Promise<void>) {
    const id = ++version.current, valid = () => version.current === id
    setBusy(true); setError('')
    try { await operation(valid) }
    catch (e) { if (valid()) setError(e instanceof Error ? e.message : 'The request failed.') }
    finally { if (valid()) setBusy(false) }
  }
  function search(more = false) {
    void run(async valid => {
      const raw = await request<NotebookReply>('/' + key + '/search', { kind, ...(more ? { cursor } : { query: query.trim() }) })
      const page = noteResults(key, kind, raw)
      if (valid()) { setResults(old => more ? [...new Map([...(old ?? []), ...page.rows].map(r=>[r.id,r])).values()] : page.rows); setCursor(page.next); setPreview(null); setSaved('') }
    })
  }
  const label = notebookLabel[key]
  return <div className="notebook-source-panel">
    <div className="notebook-tabs" aria-label="Notes provider">{names.map(id=><button type="button" key={id} aria-pressed={id===key} onClick={()=>{ if (key!==id) { reset(); setKey(id); setKind('meeting') } }}>{notebookLabel[id]}</button>)}</div>
    {key === 'wispr' && <p>To dictate into a draft, place the cursor in Writing studio and use your Wispr Flow shortcut. Connect below to import saved notes.</p>}
    {connected && !connected[key] && <div><p>{key==='wispr'?'Choose scratchpad entries or meeting notes from Flow.':'Choose notes and summaries from your Granola meetings.'}</p>
      {url ? <a className="knowledge-button is-primary" href={url} target="_blank" rel="noreferrer">Continue to {label} <ArrowSquareOut size={15}/></a> : <button className="knowledge-button is-primary" disabled={busy} onClick={()=>void run(async valid=>{const value=await request<{authorizationUrl?:string;connected?:boolean}>('/'+key+'/connect',{}); if(valid()){if(value.authorizationUrl) setUrl(value.authorizationUrl); else if(value.connected){setConnected({...connected,[key]:true});callback.current()}}})}>Connect {label}</button>}
      {url && <p role="status">After signing in, return here to choose a note.</p>}
    </div>}
    {connected?.[key] && <>
      <div className="notebook-account"><span>Connected to {label}</span><button className="knowledge-text-button" disabled={busy} onClick={()=>void run(async valid=>{const status=await request<Connections>('/'+key+'/disconnect',{});if(valid()){reset();setConnected(status);callback.current()}})}>Disconnect</button></div>
      {!preview ? <>
        <form onSubmit={e=>{e.preventDefault(); search()}}>
          {key==='wispr' && <label>Source<select value={kind} onChange={e=>{reset();setKind(e.target.value as NoteKind)}}><option value="meeting">Meetings</option><option value="scratchpad">Scratchpad</option></select></label>}
          <label>Find notes<input type="search" maxLength={300} value={query} onChange={e=>setQuery(e.target.value)} placeholder="Title or keyword"/></label><button className="knowledge-button" disabled={busy}>{query.trim()?'Search':'Browse recent'}</button>
        </form>
        {!!results?.length && <ul>{results.map(r=><li key={r.id}><button type="button" disabled={busy} onClick={()=>void run(async valid=>{const raw=await request<NotebookReply>('/'+key+'/read',{id:r.id,kind}); const value=notePreview(key,kind,r,raw);if(valid()){setSaved('');setPreview(value)}})}><strong>{r.title}</strong><time>{dateLabel(r.date)}</time></button></li>)}</ul>}
        {results?.length===0 && <p>No matching notes.</p>}
        {cursor && <button className="knowledge-text-button" disabled={busy} onClick={()=>search(true)}>More notes</button>}
      </> : <section className="notebook-preview"><button className="knowledge-text-button" onClick={()=>{setPreview(null);setSaved('')}} disabled={busy}><ArrowLeft size={14}/>Results</button>
        <h3>{preview.title}</h3><time>{dateLabel(preview.date)}</time>
        <div className="notebook-preview-body">{preview.parts.map(p=><section key={p.label}><h4>{p.label}</h4><p>{p.text}</p></section>)}</div>
        {saved ? <a className="knowledge-button" href={'#/library?source='+encodeURIComponent(saved)}>Open in Library</a> : <button className="knowledge-button is-primary" disabled={!writer||busy} onClick={()=>void run(async valid=>{const record=await keepNotebookNote(key,kind,preview,valid);if(valid())setSaved(record.id)})}><DownloadSimple size={15}/>Save to Library</button>}
      </section>}
    </>}
    {busy && <p role="status">Working with {label}…</p>}{error && <p role="alert" className="knowledge-error">{error}</p>}
  </div>
}
