import {DeskAction,deskPref,putDeskPref} from './DeskActions.tsx'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowSquareOut, BookOpen, CaretDown, Check, Notebook, Plus, Quotes } from '@phosphor-icons/react'
import type { Editor } from '@tiptap/core'
import { useKnowledge } from '../knowledge/index.ts'
import { createTopic, initializeReading, useReading } from '../reading/store.ts'
import { resolveTopics, topicHref } from '../reading/topics.ts'
import { QuoteCapture } from '../quotes/QuoteCapture.tsx'
import { RichEditor } from '../writing/RichEditor.tsx'
import { writingPassages, type ConceptTerm } from '../writing/concepts.ts'
import { selectWritingPassage } from '../writing/passageNavigation.ts'
import { linkSavedQuote, type QuoteSelection } from '../writing/quoteLink.ts'
import { createWritingDocument, initializeWriting, newWritingDraft, useWriting, plainTextFromWriting, writingPublicationValue } from '../writing/store.ts'
import type { WritingDocument, WritingNode } from '../writing/types.ts'
import { useWritingDraft } from '../writing/useWritingDraft.ts'
import { bookHref } from './model.ts'
import type { ShelfBook } from './types.ts'

const BookReadingPane = lazy(() => import('./BookReadingPane.tsx').then(module => ({ default: module.BookReadingPane })))

function titleFromWords(content: WritingNode) {
  return plainTextFromWriting(content).trim().split('\n')[0].slice(0, 80).trim()
}

function freshNote(book: ShelfBook,chapter=deskPref(book.id,'chapter','')) {
  return newWritingDraft({ title: '', format: 'note', bookEditionId: book.id, chapter })
}

interface NotebookProps {
  book: ShelfBook
  hash: string
  disabled: boolean
  onCapture: () => void
}

export function BookWriting(props: NotebookProps) {
  const loaded = useWriting(state => state.loaded), error = useWriting(state => state.error)
  const [loadError, setLoadError] = useState('')
  useEffect(() => {
    let live = true
    void Promise.all([initializeWriting(), initializeReading()]).catch(cause => {
      if (live) setLoadError(cause instanceof Error ? cause.message : 'Could not open this notebook.')
    })
    return () => { live = false }
  }, [])
  if (loadError || !loaded && error) return <p role="alert">{loadError || error}</p>
  if (!loaded) return <p role="status">Opening your notebook…</p>
  return <NotebookSession {...props} />
}

function NotebookSession({ book, hash, disabled, onCapture }: NotebookProps) {
  const docs = useWriting(state => state.docs), reading = useReading(), sources = useKnowledge(state => state.sources)
  const versions = useKnowledge(state => state.versions)
  const linked = useMemo(() => docs.filter(doc => !doc.archivedAt && doc.bookEditionId === book.id).sort((a,b) => b.updatedAt - a.updatedAt), [docs, book.id])
  const [scratch, setScratch] = useState(() => freshNote(book))
  const [chosenId, setChosenId] = useState(() => deskPref(book.id,'note',linked[0]?.id ?? scratch.id))
  const [listOpen, setListOpen] = useState(false), [read, setRead] = useState(false)
  const [chapter,setChapter]=useState(()=>deskPref(book.id,'chapter','')), [naming,setNaming]=useState(false),[name,setName]=useState('')
  const [expanded,setExpanded]=useState(false),[pane,setPane]=useState<'read'|'write'>('write'),[split,setSplit]=useState(()=>deskPref(book.id,'split',45))
  const flushActive = useRef<(() => Promise<void>) | null>(null)
  const [switching, setSwitching] = useState(false)
  const params = new URLSearchParams(hash.split('?')[1])
  const requested = params.get('note')
  const desiredId = requested || chosenId
  const current = linked.find(doc => doc.id === desiredId)
  const missing = !!requested && !current && requested !== scratch.id
  const active = current ?? (desiredId === scratch.id ? scratch : linked[0] ?? scratch)
  const terms = useMemo(() => resolveTopics(sources, reading.topics, reading.items).map(topic => ({ id: topic.id, label: topic.name, aliases: topic.terms })), [sources, reading.topics, reading.items])
  const source = sources.find(item => item.id === book.sourceId && !item.deleted && !item.excluded)
  const version = source && versions.find(item => item.sourceId === source.id && item.id === (book.sourceVersionId || source.currentVersionId) && item.text.trim())
  async function choose(note?: WritingDocument,nextChapter=chapter) {
    if (switching) return
    setSwitching(true)
    try {
      await flushActive.current?.()
      const next = note ?? freshNote(book,nextChapter)
      if (!note) setScratch(next)
      setChapter(next.chapter??'');putDeskPref(book.id,'chapter',next.chapter??'');putDeskPref(book.id,'note',next.id);
      setChosenId(next.id); setListOpen(false)
      const nextHash = bookHref(book.id, note?.id)
      if (location.hash !== nextHash) location.hash = nextHash
    } catch { /* The active editor displays the save error and keeps the wording. */ }
    finally { setSwitching(false) }
  }
  const shownChapter=active.chapter??''
  useEffect(()=>{putDeskPref(book.id,'note',active.id);putDeskPref(book.id,'chapter',shownChapter)},[book.id,active.id,shownChapter])
  const chapters=[...new Set([...linked.map(doc=>doc.chapter??''),chapter,shownChapter])].filter(Boolean)
  return <section data-expanded={expanded} data-pane={pane} className="book-notebook book-linked-writing" aria-label="Reading notebook">
    <header className="book-notebook-bar">
      <div className="book-notebook-label"><Notebook size={18} aria-hidden="true" /><h3>Notebook</h3></div>
      <div className="book-notebook-actions">
        <button type="button" aria-pressed={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'Exit expanded view':'Expand notebook'}</button>
        {version && <button type="button" aria-pressed={read} onClick={() => {setRead(!read);setPane('read')}}><BookOpen size={15} />{read ? 'Hide text' : 'Read alongside'}</button>}
        <button type="button" disabled={disabled} onClick={onCapture}><Quotes size={15} />Capture a quote</button>
        <button type="button" disabled={disabled || switching} onClick={() => void choose()}><Plus size={15} />New note</button>
      </div>
    </header>
    <div className="desk-chapter"><label>Chapter <select aria-label="Active chapter" value={shownChapter} disabled={switching} onChange={e=>{const value=e.target.value;if(value==='__new'){setNaming(true);return}void choose(linked.find(d=>(d.chapter??'')===value),value)}}><option value="">Book notes</option>{chapters.map(c=><option key={c}>{c}</option>)}<option value="__new">New chapter…</option></select></label>
      {naming&&<form onSubmit={e=>{e.preventDefault();if(name.trim()){void choose(linked.find(d=>d.chapter===name.trim()),name.trim());setNaming(false);setName('')}}}><input autoFocus aria-label="Chapter name" maxLength={500} value={name} onChange={e=>setName(e.target.value)} placeholder="Book I, Chapter 3"/><button>Add chapter</button></form>}
      {read&&version&&<><label className="desk-split">Text width <input type="range" min={25} max={70} value={split} onChange={e=>{setSplit(+e.target.value);putDeskPref(book.id,'split',+e.target.value)}}/></label><button className="desk-mobile-switch" onClick={()=>setPane(pane==='read'?'write':'read')}>{pane==='read'?'Write':'Read'}</button></>}
    </div>
    {missing && <p role="status">The linked note is unavailable in this edition.</p>}
    <div style={{'--desk-split':split+'%'} as React.CSSProperties} className={'book-notebook-spread' + (read && version ? ' is-reading' : '')}>
      {read && version && <Suspense fallback={<p role="status">Opening edition text…</p>}><BookReadingPane key={version.id} book={book} chapter={shownChapter} title={source.title} version={version} disabled={disabled} /></Suspense>}
      <NoteEditor key={active.id} document={active} saved={linked.some(doc => doc.id === active.id)} book={book} disabled={disabled}
        chapters={chapters} terms={terms} hash={hash} flushActive={flushActive} onCopy={copy => { setChosenId(copy.id); location.hash = bookHref(book.id, copy.id) }} />
    </div>
    {linked.length > 0 && <div className="book-notebook-index">
      <button type="button" className="book-notebook-index-toggle" aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>
        Notes in this {book.kind}<span>{linked.length}</span><CaretDown size={14} />
      </button>
      {listOpen && <ul>{linked.map(note => <li key={note.id}>
        <a href={bookHref(book.id, note.id)} aria-current={active.id === note.id ? 'page' : undefined}
          onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); void choose(note) }}>
          <strong>{note.title || titleFromWords(note.content) || 'Untitled note'}</strong>
          <time dateTime={new Date(note.updatedAt).toISOString()}>{new Date(note.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>
        </a>
      </li>)}</ul>}
    </div>}
  </section>
}

interface NoteEditorProps {
  chapters:string[]
  document: WritingDocument
  saved: boolean
  book: ShelfBook
  disabled: boolean
  terms: ConceptTerm[]
  hash: string
  flushActive: React.RefObject<(() => Promise<void>) | null>
  onCopy: (copy: WritingDocument) => void
}

function NoteEditor({ document: note, chapters, saved, book, disabled, terms, hash, flushActive, onCopy }: NoteEditorProps) {
  const { draft, update, status, error, flush } = useWritingDraft(note, !saved)
  const [editor, setEditor] = useState<Editor | null>(null), [quote, setQuote] = useState<QuoteSelection | null>(null)
  const [notice, setNotice] = useState(''), [copying, setCopying] = useState(false)
  const [desk,setDesk]=useState<{kind:'ai'|'word';text:string;sentence:string}|null>(null)
  const [editingTitle, setEditingTitle] = useState<string | null>(null)
  useEffect(() => { flushActive.current = flush; return () => { flushActive.current = null } }, [flush, flushActive])
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const params = new URLSearchParams(hash.split('?')[1])
    if (params.get('note') !== note.id) return
    if (selectWritingPassage(editor, params) === 'changed') setNotice('This passage has changed since it was linked.')
  }, [editor, hash, note.id])
  const linked = useMemo(() => {
    const ids = new Set(writingPassages(draft.content).map(passage => passage.topicId))
    return terms.filter(term => ids.has(term.id))
  }, [draft.content, terms])
  const inferredTitle = titleFromWords(draft.content)
  const autoTitle = !draft.title.trim() || draft.title === inferredTitle
  const displayedTitle = autoTitle ? '' : draft.title
  function write(content: WritingNode) {
    update({ content, ...(autoTitle ? { title: titleFromWords(content) } : {}) })
  }
  async function openQuote(selected: QuoteSelection) {
    try { await flush(); if (editor && !editor.isDestroyed) setQuote(selected) } catch { /* Save error is visible below. */ }
  }
  async function copy() {
    setCopying(true)
    try {
      const copy = await createWritingDocument({ ...writingPublicationValue(draft), title: ((draft.title || 'Reading note') + ' (copy)').slice(0, 300) })
      if (editor && !editor.isDestroyed) onCopy(copy)
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'Could not save the copy.') }
    finally { setCopying(false) }
  }
  const statusText = status === 'error' ? 'Save needs attention' : status === 'saved' ? saved ? 'Saved locally' : 'Saves as you write' : 'Saving…'
  const appearance=draft.appearance
  return <div className="book-notebook-sheet" style={{'--write-font':appearance.fontFamily==='serif'?'Georgia, serif':appearance.fontFamily==='mono'?'monospace':'"Alte Haas", sans-serif','--write-size':appearance.fontSize+'px','--write-leading':appearance.lineHeight,'--write-width':appearance.pageWidth+'px'} as React.CSSProperties}>
    <input className="book-notebook-title" aria-label="Note title" placeholder="Add a title…" value={editingTitle ?? displayedTitle} readOnly={disabled} maxLength={300}
      onFocus={() => setEditingTitle(displayedTitle)} onBlur={() => setEditingTitle(null)}
      onChange={event => { setEditingTitle(event.target.value); update({ title: event.target.value.trim() ? event.target.value : inferredTitle }) }} />
    <RichEditor variant="notebook" documentId={note.id} content={draft.content} editable={!disabled}
      topics={terms} conceptActions={{ terms, resolve: createTopic, onDesk:(kind,text,sentence)=>setDesk({kind,text,sentence}), onQuote: selection => void openQuote(selection) }}
      onChange={write} onReady={ready => {
        setEditor(ready)
        const pos=deskPref(book.id,'caret:'+note.id,0)
        if(pos>0&&!new URLSearchParams(hash.split('?')[1]).has('passage'))ready.commands.setTextSelection(Math.min(ready.state.doc.content.size,pos))
        ready.on('selectionUpdate',()=>putDeskPref(book.id,'caret:'+note.id,ready.state.selection.head))
        const active = globalThis.document.activeElement
        if (!disabled && !new URLSearchParams(hash.split('?')[1]).has('legacyNote') && !window.matchMedia?.('(pointer: coarse)').matches &&
          (active === globalThis.document.body || active?.getAttribute('aria-label') === 'Close book details' || active?.textContent === 'New note')) {
          ready.view.dom.focus({ preventScroll: true })
        }
      }} />
    {error && <div className="book-notebook-error" role="alert"><p>{error}</p><button type="button" disabled={disabled} onClick={() => void flush().catch(() => {})}>Retry save</button>
      <button type="button" disabled={disabled || copying} onClick={() => void copy()}>Save my edits as a copy</button></div>}
    {notice && <p role="status">{notice}</p>}
    {linked.length > 0 && <div className="book-notebook-concepts" aria-label="Concepts in this note">{linked.map(term => <a key={term.id} href={topicHref(term.id)}>{term.label}</a>)}</div>}
    {saved&&<details><summary>Move note to chapter</summary><form onSubmit={e=>{e.preventDefault();const value=String(new FormData(e.currentTarget).get('chapter')??'').trim();update({chapter:value});putDeskPref(book.id,'chapter',value)}}><input name="chapter" aria-label="Destination chapter" list="note-chapter-list" defaultValue={draft.chapter??''} maxLength={500}/><datalist id="note-chapter-list">{chapters.map(c=><option key={c}>{c}</option>)}</datalist><button disabled={disabled}>Move note</button></form></details>}
    <footer className="book-notebook-footer"><span role="status">{saved && status === 'saved' && <Check size={13} />}{statusText}</span>
      {saved && <a href={'#/write?doc=' + encodeURIComponent(note.id)}>Writing Studio <ArrowSquareOut size={13} /></a>}
    </footer>
    {desk && <DeskAction {...desk} book={book} chapter={draft.chapter??''} noteId={note.id} close={()=>setDesk(null)}/>}
    {quote && <QuoteCapture selection={quote.text} initialSource={{ bookId: book.id, locator:draft.chapter??'' }} origin={{ kind: 'writing', id: note.id, title: draft.title, authorship: 'unknown' }}
      onSaved={(id, text) => { const attached = editor && linkSavedQuote(editor, quote, id, text); setNotice(attached ? 'Quote saved and linked to your note.' : 'Quote saved to this edition.') }}
      onClose={() => setQuote(null)} />}
  </div>
}
