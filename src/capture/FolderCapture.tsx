import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { FolderPlus, Pause, Play, ArrowsClockwise, X } from '@phosphor-icons/react'
import { getStore, useRepoStatus } from '../data/repo.ts'
import { CLIENT_ID } from '../data/serverSync.ts'
import './FolderCapture.css'

interface Folder {
  id: string
  path: string
  paused: boolean
  status: string
  lastScanAt: number | null
  files: number
  indexed: number
  excluded: number
  missing: number
  error?: string
  errors: string[]
  exclusions: string[]
}
interface CaptureResponse { available: boolean; folders?: Folder[]; error?: string }
const API = '/api/capture/folders'

/** Registration is an explicit local action; no folder is watched by default. */
export function FolderCapture() {
  const writer = useRepoStatus((s) => s.writer)
  const [folders, setFolders] = useState<Folder[]>([])
  const [available, setAvailable] = useState<boolean | null>(null)
  const [unavailableReason, setUnavailableReason] = useState('')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const pending = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    try {
      if (getStore().info.kind !== 'sqlite') { if (mounted.current) setAvailable(false); return }
      const result = await fetch(API, { headers: { 'x-wv-client': CLIENT_ID }, signal: pending.current?.signal })
      const data = await result.json() as CaptureResponse
      if (!mounted.current) return
      setAvailable(result.ok && data.available === true)
      setUnavailableReason(result.ok ? '' : data.error ?? '')
      if (result.ok && Array.isArray(data.folders)) setFolders(data.folders)
    } catch { if (mounted.current) { setAvailable(false); setUnavailableReason('The local app service could not be reached.') } }
  }, [])

  useEffect(() => {
    mounted.current = true
    pending.current = new AbortController()
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => { mounted.current = false; pending.current?.abort(); clearInterval(timer) }
  }, [refresh])

  const change = async (method: string, suffix = '', body?: unknown) => {
    if (busy || !writer || available !== true) return
    setBusy(suffix || 'add')
    setError('')
    try {
      const result = await fetch(`${API}${suffix}`, { method, headers: { 'content-type': 'application/json', 'x-wv-client': CLIENT_ID }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
      const data = await result.json() as CaptureResponse
      if (!result.ok) throw new Error(data.error || 'The folder could not be updated.')
      if (!mounted.current) return
      if (Array.isArray(data.folders)) setFolders(data.folders)
      if (!suffix) setPath('')
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (mounted.current) setBusy(null) }
  }

  const submit = (event: FormEvent) => { event.preventDefault(); if (path.trim()) void change('POST', '', { path: path.trim() }) }

  return <section className="folder-capture" aria-labelledby="folder-capture-heading">
    <div className="folder-capture-heading"><FolderPlus size={21} aria-hidden="true" /><h2 id="folder-capture-heading">Watch a local folder</h2></div>
    <p>Capture new and edited notes while the local app service is running, even when this window is closed. Periodic rescans check nested folders too.</p>
    {available === null ? <p role="status">Checking local capture…</p> : available === false ? <div className="folder-capture-unavailable"><p>Folder watching is available in the local app with its SQLite workspace. Manual file imports remain available here.</p>{unavailableReason && <p>{unavailableReason}</p>}</div> : <>
      <form onSubmit={submit} className="folder-capture-add">
        <label htmlFor="capture-folder-path">Absolute folder path</label>
        <div><input id="capture-folder-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/Users/you/Documents/Notes" autoComplete="off" spellCheck={false} disabled={!!busy || !writer} /><button type="submit" disabled={!path.trim() || !!busy || !writer}>{busy === 'add' ? 'Adding…' : 'Watch folder'}</button></div>
      </form>
      <p className="folder-capture-note">Text, Markdown, chat JSON exports, PDFs and Word documents up to 16 MiB. Hidden files, symlinks and dependency folders are excluded. Sources controls determine AI access.</p>
      {folders.length === 0 ? <p>No folders are watched. Add one to begin automatic capture.</p> : <ul className="folder-capture-list">{folders.map((folder) => <li key={folder.id}>
        <div className="folder-capture-folder"><strong>{folder.path}</strong><span>{folder.paused ? 'Paused' : folder.status === 'watching' ? 'Watching' : folder.status === 'scanning' ? 'Scanning…' : folder.status === 'deferred' ? 'Waiting for restore' : folder.status === 'limited' ? 'Partial coverage' : 'Needs attention'}</span></div>
        <p>{folder.indexed} captured · {folder.excluded} excluded · {folder.missing} missing{folder.lastScanAt ? ` · Checked ${new Date(folder.lastScanAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</p>
        {folder.error && <p className="folder-capture-error">{folder.error}</p>}
        <div className="folder-capture-actions">
          <button type="button" disabled={!!busy || !writer} onClick={() => void change('PATCH', `/${encodeURIComponent(folder.id)}`, { paused: !folder.paused })}>{folder.paused ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}{folder.paused ? 'Resume' : 'Pause'}</button>
          <button type="button" disabled={!!busy || !writer || folder.paused} onClick={() => void change('POST', `/${encodeURIComponent(folder.id)}/scan`, {})}><ArrowsClockwise size={15} aria-hidden="true" />Rescan</button>
          <button type="button" disabled={!!busy || !writer} onClick={() => void change('DELETE', `/${encodeURIComponent(folder.id)}`)} title="Stop watching; captured records and originals stay in the library"><X size={15} aria-hidden="true" />Stop watching</button>
        </div>
        {(folder.errors.length > 0 || folder.exclusions.length > 0) && <details><summary>Coverage details</summary><ul>{[...folder.errors, ...folder.exclusions].map((line, index) => <li key={index}>{line}</li>)}</ul></details>}
      </li>)}</ul>}
    </>}
    {error && <p role="alert" className="folder-capture-error">{error}</p>}
  </section>
}
