import {DeskAction,deskPref,putDeskPref} from './DeskActions.tsx'
import { useEffect,useRef, useState } from 'react'
import { BookOpen } from '@phosphor-icons/react'
import type { SourceVersion } from '../knowledge/types.ts'
import { QuoteCapture } from '../quotes/QuoteCapture.tsx'
import { HighlightedText, selectionInSource, type TextSelection } from '../reading/AnnotatedReader.tsx'
import { linkHighlightedTerm, useReading } from '../reading/store.ts'
import { topicHref } from '../reading/topics.ts'
import type { ShelfBook } from './types.ts'

export function BookReadingPane({ book, title, version, disabled,chapter }: { book: ShelfBook; title: string; chapter?:string; version: SourceVersion; disabled: boolean }) {
  const body = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<TextSelection | null>(null), [quote, setQuote] = useState<TextSelection | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [linked, setLinked] = useState<{ id: string; name: string } | null>(null)
  const [action,setAction]=useState<'ai'|'word'|null>(null)
  useEffect(()=>{if(body.current)body.current.scrollTop=deskPref(book.id,'read:'+version.id,0)},[book.id,version.id])
  const allHighlights = useReading(state => state.highlights)
  const highlights = allHighlights.filter(h => h.sourceId === version.sourceId && h.versionId === version.id)
  function select() {
    if (body.current) setSelection(selectionInSource(body.current, version.text, window.getSelection()))
  }
  async function link() {
    if (!selection || busy) return
    setBusy(true); setError('')
    try {
      const topic = await linkHighlightedTerm({ ...selection, sourceId: version.sourceId, versionId: version.id })
      setLinked(topic)
      setSelection(null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this concept.') }
    finally { setBusy(false) }
  }
  return <section className="book-notebook-original" aria-label="Attached reading text">
    <header><BookOpen size={15} /><strong>{title}</strong></header>
    <div ref={body} className="book-notebook-text" onScroll={e=>putDeskPref(book.id,'read:'+version.id,e.currentTarget.scrollTop)} onContextMenu={e=>{if(window.getSelection()?.toString()){e.preventDefault();select()}}} tabIndex={0} aria-label="Scrollable edition text" onMouseUp={select} onTouchEnd={select} onKeyUp={select}>
      <HighlightedText text={version.text} highlights={highlights} onHighlight={id => {
        if (body.current && selectionInSource(body.current, version.text, window.getSelection())) return
        const highlight = highlights.find(h => h.id === id)
        if (highlight?.topicId) location.hash = topicHref(highlight.topicId)
        else location.hash = '#/library?' + new URLSearchParams({ source: version.sourceId, version: version.id, highlight: id })
      }} />
    </div>
    {selection && !disabled && <div className="book-notebook-source-actions" role="group" aria-label="Selected edition text">
      {selection.quote.trim().length <= 160 && !selection.quote.includes('\n') && <button type="button" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => void link()}>Make concept</button>}
      <button type="button" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => setQuote(selection)}>Save quote</button>
      <button onMouseDown={e=>e.preventDefault()} onClick={()=>setAction('word')}>Look up word</button><button onMouseDown={e=>e.preventDefault()} onClick={()=>setAction('ai')}>Explain with AI</button>
    </div>}
    {action&&selection&&<DeskAction kind={action} text={selection.quote} sentence={version.text.slice(Math.max(0,selection.start-100),selection.end+100)} book={book} chapter={chapter??''} close={()=>setAction(null)}/>}
    {error && <p role="alert">{error}</p>}
    {linked && !selection && <p role="status">Linked to <a href={topicHref(linked.id)}>{linked.name}</a></p>}
    {quote && <QuoteCapture selection={quote.quote} anchor={quote} origin={{ kind: 'book', id: book.id, title: book.title }}
      initialSource={{ locator:chapter??'', bookId: book.id, sourceId: version.sourceId, versionId: version.id }} onClose={() => { setQuote(null); setSelection(null) }} />}
  </section>
}
