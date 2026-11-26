import { useState } from 'react'
import { CaretDown } from '@phosphor-icons/react'
import { useRepoStatus } from '../data/repo.ts'
import { useBookshelf } from '../bookshelf/store.ts'
import { bulkUpdateReadingItems, useReading } from './store.ts'
import { usePersonalLibrary } from './personalLibrary.ts'

export function LibraryReview() {
  const { earlierSources, hiddenWritings } = usePersonalLibrary()
  const books = useBookshelf(s => s.books), items = useReading(s => s.items)
  const writer = useRepoStatus(s => s.writer)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const hidden = new Set(items.filter(item => item.libraryVisible === false).map(item => item.sourceId))
  const entries = [
    ...earlierSources.map(s => ({ id:s.id, title:s.title, origin:hidden.has(s.id) ? 'Hidden' : 'Earlier workspace', href:'#/library?source=' + encodeURIComponent(s.id) })),
    ...hiddenWritings.map(d => ({ id:'writing:'+d.id, title:d.title, origin:'Hidden draft', href:'#/write?doc=' + encodeURIComponent(d.id) })),
    ...books.filter(b => !b.archivedAt && hidden.has('book:'+b.id)).map(b => ({id:'book:'+b.id, title:b.title, origin:'Hidden edition', href:'#/bookshelf?book='+encodeURIComponent(b.id)})),
  ].sort((a,b)=>a.title.localeCompare(b.title))
  async function include(id: string) {
    setBusy(true); setError('')
    try { await bulkUpdateReadingItems([id], {libraryVisible:true}) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not add this item to your library.') }
    finally { setBusy(false) }
  }
  if (!entries.length) return null
  return <details className="knowledge-section knowledge-admin-section"><summary><span>Outside your library</span><small>{entries.length} items</small><CaretDown size={15}/></summary>
    <div className="knowledge-admin-content"><p>These records were hidden or come from an earlier workspace without a confirmed source. Open any item to review it.</p>
      {error && <p role="alert">{error}</p>}
      {entries.map(entry => <div className="knowledge-source-row" key={entry.id}><a className="knowledge-source-name" href={entry.href}><span><strong>{entry.title}</strong><small>{entry.origin}</small></span></a>
        <button className="knowledge-button" disabled={!writer || busy} aria-label={'Add to Library: '+entry.title} onClick={()=>void include(entry.id)}>Add to Library</button></div>)}
    </div>
  </details>
}
