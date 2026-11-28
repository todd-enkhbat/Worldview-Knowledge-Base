import {CopyEvidence} from './CopyEvidence'
import {deskPref} from './DeskActions.tsx'
import { editionCover, catalogLink } from './catalog.ts'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { Archive, ArrowCounterClockwise, ArrowSquareOut, CaretDown, Check, ClockCounterClockwise, FileText, MagnifyingGlass, Plus, Star, UploadSimple, X } from '@phosphor-icons/react'
import { getStore, getWorldGeneration, isRepoReady, useRepoStatus } from '../data/repo.ts'
import { useAuth } from '../data/auth.ts'
import { useKnowledge } from '../knowledge/index.ts'
import { LocalTextIndex } from '../reading/search.ts'
import { archiveBook, archiveBookCollection, BOOK_PALETTES, bookValue, createBook, createBookCollection, createBookFromSource, createShelfBook, initializeBookshelf, matchesEdition, renameBookCollection, restoreBookRevision, saveBookSnapshot, updateBook, useBookshelf } from './store.ts'
import type { BookPatch, BookshelfSnapshot, ShelfBook, ShelfKind, ShelfStatus } from './types.ts'
import { uploadBookshelfCover } from './media.ts'
import { useBookshelfCover } from './useCover.ts'
import { bookshelfImportColumns, exportBookshelfJSON, importBookshelfFile } from './portability.ts'
import { RecommenderDialog } from './Recommenders.tsx'
import { attributionIndex, identifies, publicSourcesFor, type BookSubject } from './recommendations.ts'
import { ReadingStage, shelfStages, stageOf } from './ReadingStage.tsx'
import { CatalogPicker } from './CatalogPicker.tsx'
import { authorNameKey, catalogEditionLabel, type CatalogWork, type CatalogEdition } from './catalog.ts'
import { BookTextAttachment } from './BookTextAttachment.tsx'
import { BookWriting } from './BookWriting.tsx'
import { BookQuotes } from '../quotes/QuoteCollection.tsx'
import { QuoteCapture } from '../quotes/QuoteCapture.tsx'
import './bookshelf.css'

const stages: { id: 'all' | ShelfStatus; label: string }[] = [{ id: 'all', label: 'All' }, ...shelfStages]
const statusLabel = (status: ShelfStatus) => stageOf(status).label
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
const destination = (id: string) => `#/bookshelf?book=${encodeURIComponent(id)}`
const authorsOf = (book: ShelfBook) => book.authors.join(' · ') || 'Author not added'
function authorId(book: ShelfBook, name: string) {
  return book.catalog?.authors.find((author) => authorNameKey(author.name) === authorNameKey(name))?.id ?? ''
}
function AuthorLinks({ book, compact = false }: { book: ShelfBook; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  if (!book.authors.length) return <>Author not added</>
  const authors = compact && !expanded ? book.authors.slice(0, 1) : book.authors
  return <>{authors.map((name, i) => {
    const id = authorId(book, name), params = new URLSearchParams({ author: name })
    if (id) params.set('authorId', id)
    return <span key={name + i}>{i > 0 && ' · '}<a href={'#/bookshelf?' + params}>{name}</a></span>
  })}{compact && book.authors.length > 1 && <button type="button" className="book-notes-contributors" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show fewer' : '+' + (book.authors.length - 1) + ' more'}</button>}</>
}
const dateLabel = (value: number) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export default function Bookshelf({ hash = typeof location === 'undefined' ? '' : location.hash }: { hash?: string }) {
  const snapshot = useBookshelf(), writer = useRepoStatus((state) => state.writer), account = useAuth((state) => state.user?.id ?? 'local')
  const retainedSources = useKnowledge((state) => state.sources)
  const params = new URLSearchParams(hash.split('?')[1] ?? ''), selected = params.get('book'), creating = params.get('new') === '1'
  const author = params.get('author'), selectedAuthorId = params.get('authorId')
  const linkedTrash = params.get('view') === 'trash'
  const linkedKind = params.get('kind') === 'article' ? 'article' : 'book'
  const [kind, setKind] = useState<ShelfKind>(linkedTrash ? linkedKind : 'book'), [stage, setStage] = useState<'all' | ShelfStatus>('all'), [query, setQuery] = useState(''), [collectionId, setCollectionId] = useState(''), [trash, setTrash] = useState(linkedTrash), [sort, setSort] = useState('recent')
  const [limit, setLimit] = useState(36), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [collectionName, setCollectionName] = useState('')
  const [goodreadsOpen, setGoodreadsOpen] = useState(false)
  const [collectionsOpen, setCollectionsOpen] = useState(false), [sourcePicker, setSourcePicker] = useState(false), [sourceQuery, setSourceQuery] = useState(''), importInput = useRef<HTMLInputElement>(null)
  const shelfActions = useRef<HTMLDetailsElement>(null)
  const shelfActionsTrigger = useRef<HTMLElement>(null)
  useEffect(() => { void initializeBookshelf().catch((cause) => setError(errorText(cause))) }, [])
  useEffect(() => {
    if (!linkedTrash) return
    setTrash(true); setKind(linkedKind); setStage('all'); setQuery(''); setCollectionId('')
  }, [linkedKind, linkedTrash])
  useEffect(() => setLimit(36), [kind, stage, query, collectionId, trash, sort])
  const attributionNames = useMemo(() => attributionIndex(snapshot.attributions), [snapshot.attributions])
  const index = useMemo(() => new LocalTextIndex().update(snapshot.books.map((book) => ({ id: book.id, text: `${book.title} ${book.subtitle} ${book.authors.join(' ')} ${book.recommendedBy} ${attributionNames(shelfSubject(book))} ${publicSourcesFor(shelfSubject(book)).map(r => r.by + ' ' + r.context).join(' ')} ${book.notes} ${book.isbn} ${book.fields.map((field) => `${field.label} ${field.value}`).join(' ')}` }))), [snapshot.books, attributionNames])
  const matches = useMemo(() => index.search(query), [index, query])
  const books = snapshot.books.filter((book) => author ? !book.archivedAt && book.authors.some((name) => {
    const id = authorId(book, name)
    return id && selectedAuthorId ? id === selectedAuthorId : authorNameKey(name) === authorNameKey(author)
  }) : !!book.archivedAt === trash && book.kind === kind && (stage === 'all' || book.status === stage) && (!collectionId || book.shelfIds.includes(collectionId)) && matches.has(book.id)).sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'author' ? authorsOf(a).localeCompare(authorsOf(b)) : sort === 'rating' ? b.rating - a.rating || a.title.localeCompare(b.title) : b.updatedAt - a.updatedAt)
  const book = snapshot.books.find((entry) => entry.id === selected)
  useEffect(() => { if (book) setKind(book.kind) }, [book])
  function changeTrash(next: boolean) {
    setTrash(next)
    if (!next && linkedTrash) location.hash = '#/bookshelf'
  }
  function closeShelfActions() {
    if (!shelfActions.current?.open) return
    shelfActions.current.open = false
    shelfActionsTrigger.current?.focus()
  }
  function toggleTrash() {
    changeTrash(!trash); setStage('all'); setCollectionId(''); setQuery('')
  }
  async function run(task: () => Promise<void>) {
    const store = getStore(), generation = getWorldGeneration(), current = () => isRepoReady() && getStore() === store && getWorldGeneration() === generation
    setBusy(true); setError(''); setNotice('')
    try { await task() } catch (cause) { if (current()) setError(errorText(cause)) } finally { if (current()) setBusy(false) }
  }
  async function exportData() { await run(async () => { const store = getStore(), generation = getWorldGeneration(), blob = await exportBookshelfJSON(); if (!isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) return; const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `Worldview-bookshelf-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice('Your books, full detail history, and original covers were exported.') }) }
  async function importFile(file: File) { await run(async () => { const store = getStore(), generation = getWorldGeneration(), result = await importBookshelfFile(file); if (!isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) return; setNotice(`${result.receipt.added} added · ${result.receipt.skipped} existing books kept${result.receipt.errors.length ? ` · ${result.receipt.errors.length} rows need attention` : ''}. Your existing edits were preserved.`) }) }
  async function newCollection(event: FormEvent) { event.preventDefault(); await run(async () => { const store = getStore(), generation = getWorldGeneration(), shelf = await createBookCollection(collectionName); if (!isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) return; setCollectionId(shelf.id); setCollectionName(''); setNotice('Collection created. Add books from their detail page.') }) }
  const libraryEmpty = !snapshot.books.some((book) => !book.archivedAt)
  const addLabel = kind === 'book' ? 'Add a book' : 'Add an article'
  const count = books.length
  const listing = author ? count === 1 ? 'title' : 'titles' : kind === 'book' ? count === 1 ? 'book' : 'books' : count === 1 ? 'article' : 'articles'
  return <section className="bookshelf" aria-label="Personal bookshelf">
    <div className="bookshelf-content">
      <header className="bookshelf-heading">
        {author ? <div className="bookshelf-author-heading"><a href="#/bookshelf">All shelves</a><h2>Saved works by {author}</h2></div>
          : <div className="bookshelf-kind" role="group" aria-label="Shelf content">
            <button type="button" aria-pressed={kind === 'book'} onClick={() => setKind('book')}>Books</button>
            <button type="button" aria-pressed={kind === 'article'} onClick={() => setKind('article')}>Articles</button>
          </div>}
        {trash && !author ? <button type="button" className="bookshelf-tool" onClick={toggleTrash}>Return to shelves</button>
          : <button type="button" className="bookshelf-add" disabled={!writer || busy} onClick={() => { location.hash = `#/bookshelf?new=1&kind=${kind}` }}><Plus size={16} aria-hidden="true" />{addLabel}</button>}
      </header>
      {!author && !trash && <div className="bookshelf-stage-bar" role="group" aria-label="Reading stages">{stages.map((entry) =>
        <button type="button" key={entry.id} aria-pressed={stage === entry.id} onClick={() => setStage(entry.id)}>
          {entry.label}<span>{snapshot.books.filter((book) => !book.archivedAt && book.kind === kind && (entry.id === 'all' || book.status === entry.id)).length}</span>
        </button>
      )}</div>}
      {!author && <div className="bookshelf-tools">
        <label className="bookshelf-search">
          <MagnifyingGlass size={16} aria-hidden="true" /><span className="knowledge-sr-only">Search your bookshelf</span>
          <input type="search" name="shelf-search" value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" placeholder="Title or author…" />
        </label>
        <div className="bookshelf-filters">
          <select aria-label="Filter by collection" value={collectionId} onChange={(event) => setCollectionId(event.target.value)}>
            <option value="">All collections</option>{snapshot.shelves.filter((shelf) => !shelf.archivedAt).map((shelf) => <option key={shelf.id} value={shelf.id}>{shelf.name}</option>)}
          </select>
          <select aria-label="Sort your bookshelf" value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="recent">Recent</option><option value="title">Title</option><option value="author">Author</option><option value="rating">Highest rated</option>
          </select>
          <details className="bookshelf-more" ref={shelfActions} onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false
          }} onKeyDown={(event) => {
            if (event.key === 'Escape' && event.currentTarget.open) { event.preventDefault(); event.stopPropagation(); closeShelfActions() }
          }}>
            <summary ref={shelfActionsTrigger} aria-label="Shelf actions"><span><span className="bookshelf-action-prefix">Shelf </span>actions</span><CaretDown size={14} aria-hidden="true" /></summary>
            <div>
              <button type="button" aria-expanded={sourcePicker} onClick={() => { closeShelfActions(); setSourcePicker((open) => !open) }}>Add from Library</button>
              <button type="button" aria-expanded={collectionsOpen} onClick={() => { closeShelfActions(); setCollectionsOpen((open) => !open) }}>Manage collections</button>
              <button type="button" disabled={!writer || busy} onClick={() => { closeShelfActions(); importInput.current?.click() }}>Import CSV / JSON</button>
              <button type="button" disabled={!writer || busy} aria-expanded={goodreadsOpen} onClick={() => { closeShelfActions(); setGoodreadsOpen((value) => !value) }}>Import from Goodreads</button>
              <button type="button" disabled={busy} onClick={() => { closeShelfActions(); void exportData() }}>Export bookshelf</button>
              {!trash && <button type="button" onClick={() => { closeShelfActions(); toggleTrash() }}>Trash</button>}
            </div>
          </details>
        </div>
        <input ref={importInput} hidden type="file" accept=".csv,.json,text/csv,application/json" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void importFile(file) }} />
      </div>}
      {!author && goodreadsOpen && <section className="bookshelf-goodreads"><h3>Import your Goodreads library</h3><p>In Goodreads, select Export Library, then choose the downloaded CSV here. Ratings, reviews, reading dates, and shelves come with it.</p><a href="https://www.goodreads.com/review/import" target="_blank" rel="noopener noreferrer">Open Goodreads export</a><button type="button" disabled={!writer || busy} onClick={() => importInput.current?.click()}>Choose Goodreads CSV</button></section>}
      {(error || snapshot.error) && <p className="bookshelf-alert" role="alert">{error || snapshot.error}</p>}{notice && <p className="bookshelf-notice" role="status"><Check size={15} />{notice}</p>}
      {sourcePicker && <section className="bookshelf-source-picker" aria-label="Add retained source to bookshelf"><header><div><h3>Add a retained {kind === 'article' ? 'article' : 'book'}</h3><p>Keep the retained original and its reading history connected.</p></div><button type="button" aria-label="Close retained source picker" onClick={() => setSourcePicker(false)}><X size={17} /></button></header><label><span className="knowledge-sr-only">Find a retained source</span><input type="search" aria-label="Find a retained source" value={sourceQuery} onChange={(event) => setSourceQuery(event.target.value)} placeholder="A saved article or document…" /></label><div>{retainedSources.filter((source) => !source.deleted && !source.excluded && source.title.toLocaleLowerCase().includes(sourceQuery.toLocaleLowerCase())).slice(0, 60).map((source) => <button type="button" key={source.id} disabled={!writer || busy} onClick={() => void run(async () => { const store = getStore(), generation = getWorldGeneration(), book = await createBookFromSource(source.id, kind); if (!isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) return; setSourcePicker(false); setKind(book.kind); setStage('all'); setTrash(!!book.archivedAt); location.hash = destination(book.id) })}><FileText size={17} /><span>{source.title}<small>{snapshot.books.some((book) => book.sourceId === source.id) ? 'Already on your shelf · open details' : 'Retained original stays in Library'}</small></span><Plus size={15} /></button>)}</div>{!retainedSources.some((source) => !source.deleted && !source.excluded) && <p>Save an article or import a document in Library first.</p>}</section>}
      {collectionsOpen && <section className="bookshelf-collections" aria-label="Manage bookshelf collections"><header><div><h3>Collections</h3><p>Group books and articles without changing their reading stage.</p></div><button type="button" onClick={() => { setCollectionsOpen(false); shelfActionsTrigger.current?.focus() }}>Done</button></header><form onSubmit={(event) => void newCollection(event)}><label className="knowledge-sr-only" htmlFor="new-book-collection">Collection name</label><input id="new-book-collection" placeholder="Name a collection…" value={collectionName} maxLength={160} onChange={(event) => setCollectionName(event.target.value)} autoComplete="off" /><button type="submit" disabled={!writer || busy || !collectionName.trim()}><Plus size={16} />Create collection</button></form><ul>{snapshot.shelves.map((shelf) => <li key={shelf.id}><CollectionName name={shelf.name} disabled={!writer || busy || !!shelf.archivedAt} onSave={(name) => void run(async () => { await renameBookCollection(shelf.id, name) })} /><span>{snapshot.books.filter((book) => !book.archivedAt && book.shelfIds.includes(shelf.id)).length} items</span><button type="button" disabled={!writer || busy} onClick={() => void run(async () => { await archiveBookCollection(shelf.id, !shelf.archivedAt); if (!shelf.archivedAt && collectionId === shelf.id) setCollectionId('') })}>{shelf.archivedAt ? 'Restore collection' : 'Archive collection'}</button></li>)}</ul></section>}
      <p className="bookshelf-results" aria-live="polite">{busy ? 'Saving…' : snapshot.loaded ? `${count} ${listing}${trash ? ' in Trash' : ''}` : ''}</p>
      {!snapshot.loaded ? <div className="bookshelf-empty" role="status">Opening your bookshelf…</div>
        : count > 0 ? <div className="bookshelf-grid">{books.slice(0, limit).map((entry) =>
          <article key={entry.id} className="bookshelf-volume">
            <div className="bookshelf-cover" aria-hidden="true"><BookVisual book={entry} /></div>
            <div className="bookshelf-volume-details">
              <button type="button" aria-label={`Open details for ${entry.title}`} onClick={() => { location.hash = destination(entry.id) }}><span>{entry.title}</span></button>
              {entry.authors.length > 0 && <p><AuthorLinks book={entry} /></p>}
              <div className="bookshelf-volume-state">
                <span className={`bookshelf-reading-status is-${entry.status}`}><i />{statusLabel(entry.status)}{entry.format === 'digital' ? ' · Digital' : ''}</span>
                {entry.rating > 0 && <span className="bookshelf-volume-rating" aria-label={`${entry.rating} out of 5 stars`}><Star size={12} weight="fill" aria-hidden="true" />{entry.rating}</span>}
              </div>
              {entry.recommendedBy && <small>Recommended by {entry.recommendedBy}</small>}
            </div>
          </article>
        )}</div>
        : <div className="bookshelf-empty">
          <h2>{query || collectionId ? 'No matching titles' : trash ? 'Nothing in Trash' : libraryEmpty ? `No ${listing} yet` : 'This shelf is empty'}</h2>
          {query || collectionId ? <button type="button" className="bookshelf-tool" onClick={() => { setQuery(''); setCollectionId('') }}>Clear filters</button>
            : trash ? <p>Books and articles you move to Trash appear here.</p>
              : stage !== 'all' ? <button type="button" className="bookshelf-tool" onClick={() => setStage('all')}>Show all {listing}</button>
                : <p>{addLabel} or choose Add from Library under Shelf actions.</p>}
        </div>}
      {books.length > limit && <button type="button" className="bookshelf-load-more" onClick={() => setLimit((limit) => limit + 36)}>Show 36 more titles</button>}
      {snapshot.imports.at(-1)?.errors.length ? <details className="bookshelf-import-errors"><summary>Rows needing attention from your last import · {snapshot.imports.at(-1)!.errors.length}</summary><ul>{snapshot.imports.at(-1)!.errors.map((entry, index) => <li key={index}>Row {entry.row}: {entry.message}</li>)}</ul><p>CSV columns: {bookshelfImportColumns}</p></details> : null}
    </div>
    {(creating || book) && <BookDetails key={`${account}:${getWorldGeneration()}:${book?.id ?? 'new'}`} book={book} hash={hash} initialStage={stage === 'all' ? 'wish' : stage} initialKind={params.get('kind') === 'article' ? 'article' : params.get('kind') === 'book' ? 'book' : kind} snapshot={snapshot} onClose={() => { location.hash = '#/bookshelf' }} onCreated={(book) => { setKind(book.kind); setStage(book.status); setQuery(''); setCollectionId(''); setTrash(false); location.hash = destination(book.id) }} />}
    {selected && !book && snapshot.loaded && <div className="bookshelf-alert" role="alert">This title is unavailable in this workspace. <a href="#/bookshelf">Return to your bookshelf</a>.</div>}
  </section>
}

function CollectionName({ name, disabled, onSave }: { name: string; disabled: boolean; onSave: (name: string) => void }) {
  const [value, setValue] = useState(name)
  useEffect(() => setValue(name), [name])
  return <form onSubmit={(event) => { event.preventDefault(); if (value.trim() && value !== name) onSave(value) }}><label className="knowledge-sr-only">Collection name</label><input aria-label={`Collection name ${name}`} value={value} maxLength={160} readOnly={disabled} onChange={(event) => setValue(event.target.value)} /><button type="submit" disabled={disabled || !value.trim() || value === name}>Rename</button></form>
}
function Rating({ value }: { value: number }) { return <span className="bookshelf-rating" aria-label={value ? `${value} out of 5 stars` : 'Not rated'}>{Array.from({ length: 5 }, (_, index) => <Star key={index} size={14} weight={value >= index + 1 ? 'fill' : 'regular'} aria-hidden="true" style={{ opacity: value > index && value < index + 1 ? .65 : 1 }} />)}</span> }
function shelfSubject(book: ShelfBook): BookSubject {
  return { title: book.title, author: book.authors.join(', '), isbn: book.isbn, editionId: book.catalog?.editionId ?? '' }
}
function BookVisual({ book }: { book: ShelfBook }) {
  const cover = useBookshelfCover(book.coverAssetId)
  const style = { '--book-color': book.design.color, '--book-ink': book.design.ink } as CSSProperties
  return <span className={`book-object-scene is-${book.kind}`} style={style}><span className="book-object-pages" /><span className="book-object-spine"><span>{book.title || 'Your next book'}</span><small>{book.authors[0] ?? ''}</small></span><span className={`book-object-front is-${book.design.style} has-${book.design.pattern}`}>{cover.url ? <img src={cover.url} alt="" width={152} height={228} draggable={false} loading="lazy" /> : <><small>{book.kind === 'article' ? 'Collected writing' : book.year ? String(book.year) : 'A personal collection'}</small><strong>{book.title || 'Your next book'}</strong>{book.subtitle && <span className="book-object-subtitle">{book.subtitle}</span>}<span className="book-object-art" aria-hidden="true" /><em>{book.authors.join(' · ') || 'Your bookshelf'}</em></>}<i className="book-object-hinge" /></span>{cover.error && <span className="book-cover-warning" title={cover.error}>Cover unavailable</span>}</span>
}

function BookDetails({ book, hash, initialKind, initialStage, snapshot, onClose, onCreated }: { book?: ShelfBook; hash: string; initialKind: ShelfKind; initialStage: ShelfStatus; snapshot: BookshelfSnapshot; onClose: () => void; onCreated: (book: ShelfBook) => void }) {
  const initial = () => book ?? { ...createShelfBook({ title: 'Your next book', kind: initialKind, format: initialKind === 'article' ? 'digital' : 'print', status: initialStage }), title: '' }
  const publishedSources = useMemo(() => book ? publicSourcesFor(shelfSubject(book)) : [], [book])
  const [recommendersOpen, setRecommendersOpen] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(!book && initialKind === 'book')
  const [quote, setQuote] = useState<string | null>(null)
  const legacyNote = useRef<HTMLDetailsElement>(null)
  const [form, setForm] = useState<ShelfBook>(initial), [authors, setAuthors] = useState(book?.authors.join('; ') ?? ''), baseline = useRef(book), dialog = useRef<HTMLDialogElement>(null), coverInput = useRef<HTMLInputElement>(null)
  const [tab, setTab] = useState<'notes' | 'details' | 'history'>(book ? 'notes' : 'details'), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [snapshotName, setSnapshotName] = useState(''), [comparedId, setComparedId] = useState(''), [askClose, setAskClose] = useState(false), [pendingHash, setPendingHash] = useState<string | null>(null)
  const writer = useRepoStatus((state) => state.writer), scope = useRef({ store: getStore(), generation: getWorldGeneration() }), alive = useRef(true), navigationAllowed = useRef(false)
  const current = () => alive.current && isRepoReady() && getStore() === scope.current.store && getWorldGeneration() === scope.current.generation
  const dirty = JSON.stringify(bookValue(form)) !== JSON.stringify(bookValue(baseline.current ?? initial()))
  const entries = snapshot.history.filter((entry) => entry.bookId === book?.id).sort((a, b) => b.recordedAt - a.recordedAt), compared = entries.find((entry) => entry.id === comparedId)
  function accept(saved: ShelfBook) { baseline.current = saved; setForm(saved); setAuthors(saved.authors.join('; ')); setError(''); setNotice('Saved to your bookshelf.') }
  const latest = useRef(form); useLayoutEffect(() => { latest.current = form }, [form])
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useLayoutEffect(() => { const element = dialog.current; if (!element) return; if (typeof element.showModal === 'function') element.showModal(); else element.setAttribute('open', ''); return () => { if (element.open && typeof element.close === 'function') element.close() } }, [])
  useEffect(() => {
    if (tab !== 'notes' || !new URLSearchParams(hash.split('?')[1]).has('legacyNote') || !legacyNote.current) return
    legacyNote.current.open = true
    legacyNote.current.querySelector('summary')?.focus()
    legacyNote.current.scrollIntoView?.({ block: 'center' })
  }, [hash, tab])
  useEffect(() => { if (!book || busy || book.updatedAt === baseline.current?.updatedAt) return; if (!dirty) accept(book) }, [book, busy, dirty])
  useEffect(() => {
    const ownHash = location.hash
    const unload = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = '' } }
    const guard = (event: HashChangeEvent) => { if (navigationAllowed.current || (!dirty && !busy) || location.hash === ownHash) return; const target = location.hash; event.stopImmediatePropagation(); history.replaceState(history.state, '', ownHash); setPendingHash(target); setAskClose(true) }
    window.addEventListener('beforeunload', unload); window.addEventListener('hashchange', guard, { capture: true })
    return () => { window.removeEventListener('beforeunload', unload); window.removeEventListener('hashchange', guard, { capture: true }) }
  }, [dirty, busy])
  const patch = (value: BookPatch) => setForm((prior) => ({ ...prior, ...value }))
  function requestClose() { if (busy) return; if (dirty) setAskClose(true); else onClose() }
  async function perform(action: () => Promise<void>) { if (!current()) return; setBusy(true); setError(''); setNotice(''); try { await action() } catch (cause) { if (current()) setError(errorText(cause)) } finally { if (current()) setBusy(false) } }
  async function save(copy = false) { await perform(async () => { const value = bookValue(latest.current); if (!current()) return; const saved = !book || copy ? await createBook({ ...value, ...(copy ? { catalog: undefined, goodreadsId: undefined } : {}), title: copy ? `${form.title} (copy)` : form.title } as Parameters<typeof createBook>[0]) : await updateBook(book.id, value, baseline.current!.updatedAt); if (!current()) return; accept(saved); if (!book || copy) { navigationAllowed.current = true; onCreated(saved) } }) }
  async function uploadCover(file: File) { await perform(async () => { const id = await uploadBookshelfCover(file, scope.current); if (current()) { patch({ coverAssetId: id }); setNotice('Original cover retained. Save the details to keep this cover with the book.') } }) }
  async function chooseEdition(work: CatalogWork, edition: CatalogEdition) {
    await perform(async () => {
      const savedCopy = !book && snapshot.books.find(entry => !entry.archivedAt && entry.catalog && matchesEdition(entry, 'book', edition.id, edition.isbn))
      if (savedCopy) {
        navigationAllowed.current = true
        onCreated(savedCopy)
        return
      }
      let coverAssetId: string | null = null, coverMessage = ''
      if (editionCover(edition)) {
        try {
          const response = await fetch(editionCover(edition))
          if (!response.ok) throw new Error('Cover unavailable')
          const file = new File([await response.blob()], edition.id + '.jpg', { type: 'image/jpeg' })
          if (!current()) return
          coverAssetId = await uploadBookshelfCover(file, scope.current)
        } catch { coverMessage = ' The catalog cover could not be retained.' }
      }
      if (!current()) return
      const names = work.authors.map((a) => a.name)
      const editionFields = { title: edition.title, subtitle: edition.subtitle, authors: names, isbn: edition.isbn, year: edition.year,
        pages: edition.pages, url: catalogLink(edition.id), coverAssetId,
        catalog: { providerIds:edition.providerIds,representative:edition.representative,workId: work.id, editionId: edition.id, authors: work.authors, editionLabel: catalogEditionLabel(edition), publisher: edition.publisher, language: edition.language, coverId: edition.coverId } }
      if (!book) {
        const saved = await createBook({ ...latest.current, ...editionFields })
        if (!current()) return
        accept(saved)
        navigationAllowed.current = true
        onCreated(saved)
        return
      }
      setAuthors(names.join('; '))
      patch(editionFields)
      setCatalogOpen(false); setNotice('Edition selected. Save changes to update this book.' + coverMessage)
    })
  }
  const existingEdition = !book && form.catalog && snapshot.books.find((entry) => !entry.archivedAt && entry.catalog?.editionId === form.catalog?.editionId)
  const editable = writer && !busy, conflict = !!book && book.updatedAt !== baseline.current?.updatedAt && dirty
  return <dialog ref={dialog} className="bookshelf-dialog" data-new={!book || undefined} data-stage={form.status} data-view={tab} aria-labelledby="book-detail-title"
    onCancel={(event) => { event.preventDefault(); requestClose() }}
    onKeyDown={(event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing || !event.currentTarget.contains(event.target as Node)) return
      event.preventDefault(); event.stopPropagation(); requestClose()
    }}><div className="book-detail-top">{book ? <span>{book.archivedAt ? 'In your Trash · details retained' : form.kind === 'book' ? 'On your bookshelf' : 'In your article collection'}</span> : <h2 id="book-detail-title">{form.kind === 'book' ? 'Add to your bookshelf' : 'Keep an article'}</h2>}<button type="button" aria-label="Close book details" disabled={busy} onClick={requestClose}><X size={20} /></button></div><div className="book-detail-layout"><aside className="book-detail-cover"><div aria-hidden="true"><BookVisual book={form} /></div>{tab === 'details' && <><button type="button" disabled={!editable} onClick={() => coverInput.current?.click()}><UploadSimple size={15} />{form.coverAssetId ? 'Change cover' : 'Upload cover'}</button>{form.coverAssetId && <button type="button" disabled={!editable} onClick={() => patch({ coverAssetId: null })}>Use designed cover</button>}<input ref={coverInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" hidden onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void uploadCover(file) }} /><p>{form.catalog?.representative?'Representative catalog cover.':'Cover images are stored in this workspace.'}</p></>}<Rating value={form.rating} /><span className={`bookshelf-reading-status is-${form.status}`}><i />{statusLabel(form.status)}</span></aside>
    <div className="book-detail-content">{book && <h2 id="book-detail-title">{book.title}</h2>}{book && <div className="book-detail-tabs">{book && <button type="button" aria-pressed={tab === 'notes'} onClick={() => setTab('notes')}>Reading notes</button>}<button type="button" aria-pressed={tab === 'details'} onClick={() => setTab('details')}>{book ? form.kind === 'book' ? 'Edition details' : 'Article details' : 'Details'}</button>{book && <button type="button" aria-pressed={tab === 'history'} onClick={() => setTab('history')}><ClockCounterClockwise size={14} />History <span>{entries.length}</span></button>}</div>}
    {error && <p className="bookshelf-alert" role="alert">{error}</p>}{notice && <p className="bookshelf-notice" role="status">{notice}</p>}{conflict && <div className="bookshelf-conflict" role="alert"><p>A newer version was saved. Your edits are still here.</p><button type="button" onClick={() => accept(book!)} disabled={busy}>Reload saved details</button><button type="button" onClick={() => void save(true)} disabled={!editable}>Save my edits as a copy</button></div>}
    {askClose && <div className="bookshelf-conflict" role="alert"><p>Keep your changes before leaving?</p><button type="button" disabled={busy} onClick={() => { setAskClose(false); setPendingHash(null) }}>Keep editing</button><button type="button" disabled={busy} onClick={() => { navigationAllowed.current = true; baseline.current = latest.current; setAskClose(false); if (pendingHash) { const target = pendingHash; setPendingHash(null); history.replaceState(history.state, '', target); window.dispatchEvent(new HashChangeEvent('hashchange')) } else onClose() }}>Discard changes</button></div>}
    {book && tab === 'notes' && <div className="book-notes-view">
      {(book.authors.length > 0 || book.year || book.catalog?.editionLabel) && <p className="book-notes-edition"><AuthorLinks book={book} compact />{(book.catalog?.editionLabel || book.year) && <span> · {book.catalog?.editionLabel || book.year}</span>}</p>}
      <BookWriting book={book} hash={hash} disabled={!editable || dirty || !!book.archivedAt} onCapture={() => setQuote(window.getSelection()?.toString() ?? '')} />
      <BookQuotes bookId={book.id} />
      {book.notes.trim() && <details ref={legacyNote} className="book-edition-note"><summary>Edition note</summary><p>{book.notes}</p><button type="button" onClick={() => setTab('details')}>Edit in edition details</button></details>}
      <BookTextAttachment book={book} disabled={!editable || dirty} onBusyChange={setBusy} onSaved={saved => { if (current()) { accept(saved); setNotice('This text version is attached for quote verification.') } }} />
    </div>}
    {tab === 'details' && <div className="book-capture-tools">
      <div className="bookshelf-kind" role="group" aria-label="Capture type">{(['book','article'] as const).map((choice) => <button type="button" key={choice} disabled={!editable} aria-pressed={form.kind === choice} onClick={() => { patch({ kind: choice, ...(choice === 'article' ? { catalog: undefined, goodreadsId: undefined } : {}), ...(!book ? { format: choice === 'article' ? 'digital' : 'print' } : {}) }); setCatalogOpen(choice === 'book') }}>{choice === 'book' ? 'Book' : 'Article'}</button>)}</div>
      <ReadingStage value={form.status} disabled={!editable} onChange={status => {
        const today = new Date().toLocaleDateString('en-CA')
        patch({ status, ...(book && status === 'reading' && !form.startedAt ? { startedAt: today } : {}),
          ...(book && status === 'read' && !form.finishedAt ? { finishedAt: today } : {}) })
      }} />
      {form.kind === 'book' && !catalogOpen && <button type="button" disabled={!editable} onClick={() => setCatalogOpen(true)}>{form.catalog ? 'Choose another edition' : 'Find a catalog edition'}</button>}
      {form.kind === 'book' && catalogOpen && <CatalogPicker initialQuery={form.isbn || form.title} disabled={!editable} onChoose={chooseEdition} adding={!book} stage={form.status} />}
      {book && <div className="saved-recommenders"><button type="button" disabled={!editable} onClick={() => setRecommendersOpen(true)}>Add recommender</button>
        {snapshot.attributions?.filter(r => identifies(r, shelfSubject(book))).map(r => <span key={r.id}>{r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer">{r.name}</a> : r.name} · {r.relation}</span>)}
      </div>}
      {publishedSources.length > 0 && <details className="saved-reading-lists"><summary>Reading lists for this work ({publishedSources.length})</summary>
        {publishedSources.map(r => <p key={r.url}><strong>{r.by}</strong> · {r.relation}{r.version && ' · ' + r.version}<br/><a href={r.url} target="_blank" rel="noopener noreferrer">{r.context}</a></p>)}
      </details>}
      {book && recommendersOpen && <RecommenderDialog subject={shelfSubject(book)} onClose={() => setRecommendersOpen(false)} />}
      {form.kind === 'book' && form.catalog && <p>Edition · <a href={catalogLink(form.catalog.editionId)} target="_blank" rel="noopener noreferrer">{form.catalog.editionLabel}</a></p>}
      {existingEdition && <p>This edition is already on your shelf. <a href={destination(existingEdition.id)}>Open saved details</a></p>}
      {book && book.authors.length > 0 && <p>Saved works by <AuthorLinks book={book} /></p>}

    </div>}
    {book && quote !== null && <QuoteCapture selection={quote} origin={{ kind: 'book', id: book.id, title: book.title }} initialSource={{ locator:deskPref(book.id,'chapter',''),title: book.title, author: book.authors.join(', '), edition: book.catalog?.editionLabel ?? '', bookId: book.id, catalogEditionId: book.catalog?.editionId, isbn: book.isbn || undefined, sourceId: book.sourceId, versionId: book.sourceVersionId }} onClose={() => setQuote(null)} />}
    {!book && form.kind === 'book' && catalogOpen && <button type="button" className="book-enter-manually" disabled={!editable} onClick={() => setCatalogOpen(false)}>Identify my copy · enter details or add a cover</button>}
    {tab === 'details' && form.kind==='book' && (book||!catalogOpen) && <CopyEvidence book={form} disabled={!editable} apply={value=>{patch(value);if(value.authors)setAuthors(value.authors.join('; '))}} photo={file=>perform(async()=>{if((form.evidencePhotos?.length??0)>=12)throw Error('This copy already has twelve evidence photographs.');const id=await uploadBookshelfCover(file,scope.current);if(current())patch({evidencePhotos:[...new Set([...(latest.current.evidencePhotos??[]),id])]})})}/>}
    {tab === 'details' && (book || form.kind === 'article' || !catalogOpen) ? <form className="book-details-form" onSubmit={(event) => { event.preventDefault(); void save() }}><label>Title<input autoComplete="off" value={form.title} maxLength={500} required readOnly={!editable} onChange={(event) => patch({ title: event.target.value })} placeholder="The title you want to keep" /></label><label>{form.kind === 'article' ? 'Author or publication' : 'Authors'}<input autoComplete="off" value={authors} maxLength={5000} readOnly={!editable} onChange={(event) => { setAuthors(event.target.value); patch({ authors: event.target.value.split(';').map((author) => author.trim()).filter(Boolean) }) }} placeholder="Separate multiple authors with a semicolon" /></label><label>{form.kind === 'article' ? 'Article URL' : 'Book or publisher URL'}<input type="url" inputMode="url" autoComplete="off" value={form.url} maxLength={4000} readOnly={!editable} onChange={(event) => patch({ url: event.target.value })} placeholder="https://…" /></label><details className="book-field-section"><summary>Publication details</summary><div><label>Subtitle<input autoComplete="off" value={form.subtitle} maxLength={2000} readOnly={!editable} onChange={(event) => patch({ subtitle: event.target.value })} placeholder="Optional" /></label><div className="book-form-row"><label>Format<select disabled={!editable} value={form.format} onChange={(event) => patch({ format: event.target.value as ShelfBook['format'] })}><option value="print">Print</option><option value="digital">Digital</option><option value="both">Print & digital</option></select></label></div><div className="book-form-row"><label>ISBN<input value={form.isbn} maxLength={100} autoComplete="off" readOnly={!editable} onChange={(event) => patch({ isbn: event.target.value })} /></label><label>Publication year<input type="number" min={1} max={9999} value={form.year ?? ''} readOnly={!editable} onChange={(event) => patch({ year: event.target.value ? Number(event.target.value) : null })} /></label><label>Pages<input type="number" min={1} max={1000000} value={form.pages ?? ''} readOnly={!editable} onChange={(event) => patch({ pages: event.target.value ? Number(event.target.value) : null })} /></label></div>
</div></details>
      <details className="book-field-section"><summary>Rating, notes &amp; reading dates</summary><div><label className="book-rating-field"><span>Your rating <strong>{form.rating ? `${form.rating} / 5` : 'Not rated'}</strong></span><input type="range" min={0} max={5} step={.5} aria-label="Your book rating" value={form.rating} disabled={!editable} onChange={(event) => patch({ rating: Number(event.target.value) })} /></label><label>Recommended by<input autoComplete="off" value={form.recommendedBy} maxLength={2000} readOnly={!editable} onChange={(event) => patch({ recommendedBy: event.target.value })} placeholder="A person, a conversation, a place you found it" /></label><label>Your notes<textarea value={form.notes} rows={5} maxLength={100000} readOnly={!editable} onChange={(event) => patch({ notes: event.target.value })} placeholder="What stayed with you? What would you return to?" /></label><div className="book-form-row"><label>Started reading<input type="date" value={form.startedAt ?? ''} readOnly={!editable} onChange={(event) => patch({ startedAt: event.target.value || null })} /></label><label>Finished reading<input type="date" value={form.finishedAt ?? ''} readOnly={!editable} onChange={(event) => patch({ finishedAt: event.target.value || null })} /></label></div></div></details>
      {snapshot.shelves.some(shelf => !shelf.archivedAt) && <fieldset className="book-collection-choices"><legend>Your collections</legend>{snapshot.shelves.filter((shelf) => !shelf.archivedAt).map((shelf) => <label key={shelf.id}><input type="checkbox" checked={form.shelfIds.includes(shelf.id)} disabled={!editable} onChange={(event) => patch({ shelfIds: event.target.checked ? [...new Set([...form.shelfIds, shelf.id])] : form.shelfIds.filter((id) => id !== shelf.id) })} />{shelf.name}</label>)}</fieldset>}
      <details className="book-cover-design"><summary>Make the cover yours</summary><div className="book-palette-choices">{BOOK_PALETTES.map((design, index) => <button type="button" key={design.color} style={{ background: design.color, color: design.ink }} aria-label={`Cover palette ${index + 1}`} disabled={!editable} onClick={() => patch({ design, coverAssetId: null })}>Aa</button>)}</div><div className="book-form-row"><label>Cover color<input type="color" aria-label="Book cover color" value={form.design.color} disabled={!editable} onChange={(event) => patch({ design: { ...form.design, color: event.target.value } })} /></label><label>Cover text<input type="color" aria-label="Book cover text color" value={form.design.ink} disabled={!editable} onChange={(event) => patch({ design: { ...form.design, ink: event.target.value } })} /></label><label>Typography<select disabled={!editable} value={form.design.style} onChange={(event) => patch({ design: { ...form.design, style: event.target.value as ShelfBook['design']['style'] } })}><option value="classic">Literary</option><option value="modern">Modern</option><option value="type">Typeset</option></select></label><label>Motif<select disabled={!editable} value={form.design.pattern} onChange={(event) => patch({ design: { ...form.design, pattern: event.target.value as ShelfBook['design']['pattern'] } })}><option value="none">Quiet</option><option value="lines">Contour</option><option value="grid">Grid</option><option value="arch">Arch</option></select></label></div></details>
      <section className="book-custom-fields"><header><h3>Your own details</h3><button type="button" disabled={!editable || form.fields.length >= 100} onClick={() => patch({ fields: [...form.fields, { id: crypto.randomUUID(), label: 'A detail to keep', value: '' }] })}><Plus size={14} />Add a field</button></header>{form.fields.map((field) => <div className="book-custom-field" key={field.id}><label><span className="knowledge-sr-only">Custom detail name</span><input aria-label={`Custom detail name ${field.label}`} value={field.label} maxLength={160} readOnly={!editable} onChange={(event) => patch({ fields: form.fields.map((entry) => entry.id === field.id ? { ...entry, label: event.target.value } : entry) })} /></label><label><span className="knowledge-sr-only">{field.label} value</span><textarea aria-label={`${field.label} value`} rows={2} value={field.value} maxLength={20000} readOnly={!editable} onChange={(event) => patch({ fields: form.fields.map((entry) => entry.id === field.id ? { ...entry, value: event.target.value } : entry) })} /></label><button type="button" aria-label={`Remove custom detail ${field.label}`} disabled={!editable} onClick={() => patch({ fields: form.fields.filter((entry) => entry.id !== field.id) })}><X size={16} /></button></div>)}</section>
      <footer className="book-detail-save"><span>{busy ? 'Keeping your changes…' : dirty ? 'Changes waiting to be saved' : book ? 'Details saved · full history retained' : 'Add this title when you’re ready'}</span><button type="submit" className="bookshelf-add" disabled={!editable || !form.title.trim() || !!book && !dirty || conflict || !!existingEdition}>{busy ? 'Saving…' : book ? 'Save changes' : stageOf(form.status).action}</button></footer>
    </form> : tab === 'history' && <section className="book-history"><p>Every saved edit keeps the preceding details and original cover. Restoring also keeps your current version.</p><form onSubmit={(event) => { event.preventDefault(); void perform(async () => { if (!current() || !book) return; await saveBookSnapshot(book.id, snapshotName); if (current()) { setSnapshotName(''); setNotice('Milestone saved.') } }) }}><label>Name a milestone<input value={snapshotName} maxLength={160} readOnly={!editable} onChange={(event) => setSnapshotName(event.target.value)} placeholder="After the last chapter…" /></label><button type="submit" disabled={!editable || dirty || !snapshotName.trim()}><Plus size={16} />Keep milestone</button></form>{dirty && <p>Save your edited details before keeping or restoring a milestone.</p>}<div className="book-history-list">{entries.map((entry) => <button type="button" key={entry.id} aria-pressed={comparedId === entry.id} onClick={() => setComparedId(entry.id)}><strong>{entry.label}</strong><span>{dateLabel(entry.recordedAt)}</span><small>{entry.book.title}</small></button>)}</div>{compared && <div className="book-history-compare"><h3>{compared.label}</h3><dl><div><dt>Title</dt><dd>{compared.book.title}</dd></div><div><dt>Author</dt><dd>{authorsOf(compared.book)}</dd></div><div><dt>Stage</dt><dd>{statusLabel(compared.book.status)}</dd></div><div><dt>Rating</dt><dd>{compared.book.rating || 'Not rated'}</dd></div><div><dt>Recommended by</dt><dd>{compared.book.recommendedBy || 'Not added'}</dd></div><div><dt>Edition</dt><dd>{compared.book.format}</dd></div><div><dt>Publication</dt><dd>{compared.book.year ?? 'Not added'}{compared.book.pages ? ` · ${compared.book.pages} pages` : ''}</dd></div><div><dt>ISBN</dt><dd>{compared.book.isbn || 'Not added'}</dd></div><div><dt>Started</dt><dd>{compared.book.startedAt || 'Not added'}</dd></div><div><dt>Finished</dt><dd>{compared.book.finishedAt || 'Not added'}</dd></div><div><dt>Collections</dt><dd>{snapshot.shelves.filter((shelf) => compared.book.shelfIds.includes(shelf.id)).map((shelf) => shelf.name).join(' · ') || 'Unfiled'}</dd></div><div><dt>Source URL</dt><dd>{compared.book.url || 'Not added'}</dd></div>{compared.book.fields.map((field) => <div key={field.id}><dt>{field.label}</dt><dd>{field.value || 'No value'}</dd></div>)}</dl><div className="book-history-cover" aria-label="Cover in this version"><BookVisual book={compared.book} /></div><p>{compared.book.notes || 'No personal notes in this version.'}</p><button type="button" disabled={!editable || dirty || !book} onClick={() => void perform(async () => { if (!book || !current()) return; const saved = await restoreBookRevision(book.id, compared.id, baseline.current!.updatedAt); if (current()) { accept(saved); setNotice('Earlier details restored. Your previous version is kept in history.') } })}><ArrowCounterClockwise size={16} />Restore these details</button></div>}</section>}

    {book && <div className="book-detail-retention"><span>Added {new Date(book.createdAt).toLocaleDateString()}</span><button type="button" disabled={!editable || dirty} onClick={() => void perform(async () => { if (!current()) return; const saved = await archiveBook(book.id, !book.archivedAt, baseline.current!.updatedAt); if (current()) { accept(saved); navigationAllowed.current = true; onClose() } })}>{book.archivedAt ? <ArrowCounterClockwise size={14} /> : <Archive size={14} />}{book.archivedAt ? 'Restore to bookshelf' : 'Move to Trash'}</button>{book.goodreadsId && <a href={'https://www.goodreads.com/book/show/' + book.goodreadsId} target="_blank" rel="noopener noreferrer">Goodreads edition</a>}{book.url && <a href={book.url} target="_blank" rel="noreferrer noopener">Open original <ArrowSquareOut size={13} /></a>}</div>}
    </div></div></dialog>
}
