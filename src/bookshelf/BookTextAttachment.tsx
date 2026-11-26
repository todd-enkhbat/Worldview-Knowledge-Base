import { useEffect, useState } from 'react'
import { refreshKnowledge, useKnowledge } from '../knowledge/index.ts'
import type { SourceVersion } from '../knowledge/types.ts'
import { attachBookText } from './store.ts'
import type { ShelfBook } from './types.ts'

const versionLabel = (version: SourceVersion) => [
  version.originalName, new Date(version.createdAt).toLocaleString(), version.contentHash.slice(0, 10),
].filter(Boolean).join(' · ')

export function BookTextAttachment({ book, disabled, onSaved, onBusyChange }: { book: ShelfBook; disabled: boolean; onSaved: (saved: ShelfBook) => void; onBusyChange: (busy: boolean) => void }) {
  const sources = useKnowledge((state) => state.sources), versions = useKnowledge((state) => state.versions)
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [sourceId, setSourceId] = useState(''), [versionId, setVersionId] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    let active = true
    void refreshKnowledge().catch(() => { if (active) setError('Could not load retained Library texts.') })
    return () => { active = false }
  }, [open])
  const source = sources.find((entry) => entry.id === book.sourceId)
  const versionOptions = versions.filter((entry) => entry.sourceId === sourceId && entry.text.trim()).sort((a,b) => b.createdAt - a.createdAt)
  const version = versionOptions.find((entry) => entry.id === versionId)
  const pinned = versions.find((entry) => entry.id === book.sourceVersionId && entry.sourceId === book.sourceId)
  const link = new URLSearchParams()
  if (book.sourceId) link.set('source', book.sourceId)
  if (book.sourceVersionId) link.set('version', book.sourceVersionId)
  const findSource = (id: string) => {
    setSourceId(id); setError('')
    const current = sources.find((entry) => entry.id === id)?.currentVersionId
    const readable = versions.filter((entry) => entry.sourceId === id && entry.text.trim())
    setVersionId(readable.find((entry) => entry.id === current)?.id ?? readable.at(-1)?.id ?? '')
  }
  async function attach() {
    if (!version || disabled || busy) return
    setError(''); setBusy(true); onBusyChange(true)
    try { const saved = await attachBookText(book.id, sourceId, version.id, book.updatedAt); onSaved(saved); setOpen(false) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not attach this text.') }
    finally { setBusy(false); onBusyChange(false) }
  }
  return <section className="book-text-attachment" aria-label="Retained edition text">
    <h3>Reading text</h3>
    {book.sourceId ? <p><a href={'#/library?' + link}>{source?.title || 'Open attached Library text'}</a>{pinned ? ' · ' + versionLabel(pinned) : book.sourceVersionId ? ' · Saved version ' + book.sourceVersionId : ' · Version unpinned'}</p>
      : <p>Attach your copy from Library to check quotations against the text of this edition.</p>}
    <button type="button" aria-expanded={open} disabled={disabled || busy} onClick={() => { setOpen(!open); setError(''); setQuery(''); setSourceId(book.sourceId ?? ''); setVersionId(book.sourceVersionId ?? '') }}>{open ? 'Close text picker' : book.sourceId ? 'Choose retained version' : 'Attach Library text'}</button>
    {open && <div className="book-text-picker">
      <label>Find a Library source<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search retained titles" /></label>
      <label>Library source<select value={sourceId} onChange={(event) => findSource(event.target.value)}><option value="">Choose a retained source</option>{sources.filter((entry) => !entry.deleted && !entry.excluded && (entry.id === sourceId || entry.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))).map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></label>
      {sourceId && (versionOptions.length ? <label>Text version<select value={versionId} onChange={(event) => setVersionId(event.target.value)}><option value="">Choose a version</option>{versionOptions.map((entry) => <option key={entry.id} value={entry.id}>{versionLabel(entry)}</option>)}</select></label> : <p>This source has no readable retained text.</p>)}
      {version && <blockquote>{version.text.slice(0, 400)}{version.text.length > 400 ? '…' : ''}</blockquote>}
      <button type="button" disabled={disabled || busy || !version} onClick={() => void attach()}>{busy ? 'Attaching…' : 'Attach this version'}</button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>
}
