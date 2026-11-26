import { FolderEditor, FolderIcon, FolderPageHeader } from './FolderPage.tsx'
import { folderHref, folderTrail } from './hierarchy.ts'
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, ArrowUpRight, CaretDown, BookOpen, Books, Browser, Check, FileText, FolderSimple, FolderSimplePlus, Highlighter, List, MagnifyingGlass, NotePencil, Plus, SquaresFour, Star, Tag } from '@phosphor-icons/react'
import { usePersonalLibrary } from './personalLibrary.ts'
import { bookHref } from '../bookshelf/model.ts'
import { writingPassages } from '../writing/concepts.ts'
import { useBookshelfCover } from '../bookshelf/useCover.ts'
import { useBookshelf } from '../bookshelf/store.ts'
import type { ShelfBook } from '../bookshelf/types.ts'
import { getStore, getWorldGeneration, isRepoReady, useRepoStatus } from '../data/repo.ts'
import { useAuth } from '../data/auth.ts'
import { useKnowledge } from '../knowledge/index.ts'
import type { KnowledgeSource, SourceVersion } from '../knowledge/types.ts'
import { createFolder, deleteFolder, renameFolder, updateReadingItem, useReading, bulkUpdateReadingItems, saveReadingView, removeReadingView } from './store.ts'
import { captureArticle } from './captureArticle.ts'
import { ReadingDialog } from './ReadingDialog.tsx'
import type { ReadingItem } from './types.ts'
import { createWritingDocument } from '../writing/store.ts'
import { plainTextFromWriting } from '../writing/model.ts'
import { LocalTextIndex } from './search.ts'
import { normalizeTopicName, resolveTopics, topicHref, topicMatches } from './topics.ts'
import './reading.css'
import './personalLibrary.css'

type Filter = 'all' | 'reading' | 'read' | 'highlights' | 'favorites' | 'articles' | 'notes' | 'books' | 'obsidian' | 'documents'
type FileEntry = { id: string; book?: ShelfBook; source?: KnowledgeSource; recordId?: string; writingId?: string; edition?: ShelfBook; conceptIds?: string[]; title: string; text: string; annotations?: string; kind: string; updatedAt: number; version?: SourceVersion; item?: ReadingItem; highlights: number; notes: number }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const plainPreview = (text: string) => text.replace(/^#{1,6}\s+/gm, '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').slice(0, 1600)
export function articleUrl(version?: SourceVersion): string | null {
  const value = version?.metadata?.url ?? version?.metadata?.sourceUrl
  if (typeof value !== 'string') return null
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null } catch { return null }
}
export function openReadingSource(id: string, folderId?: string | null) { location.hash = `#/library?source=${encodeURIComponent(id)}${folderId ? `&folder=${encodeURIComponent(folderId)}` : ''}` }

const isVaultFile = (source?: KnowledgeSource) => source?.kind === 'obsidian' || source?.externalId.startsWith('obsidian-vault:')
function fileKind(entry: FileEntry) {
  if (entry.book) return entry.book.kind === 'book' ? 'Book' : 'Article'
  if (entry.edition) return 'Reading note'
  if (entry.writingId) return 'Draft'
  if (articleUrl(entry.version)) return 'Article'
  if (entry.source?.kind === 'obsidian') return 'Obsidian note'
  return ['thought','legacy'].includes(entry.kind) ? 'Note' : 'Document'
}
function fileOrigin(entry: FileEntry) {
  if (entry.edition) return entry.edition.title
  if (entry.book || entry.writingId) return ''
  if (isVaultFile(entry.source)) return entry.version?.originalName?.split('/').slice(0,-1).join('/') || (entry.kind === 'obsidian' ? '' : 'Obsidian vault')
  if (entry.source?.externalId.startsWith('google-drive:')) return 'Google Drive'
  return entry.version?.origin === 'import' ? entry.version.originalName : ''
}
function EditionCover({asset}: {asset:string}) {
  const {url} = useBookshelfCover(asset)
  return url ? <img className="library-book-cover" src={url} alt="" loading="lazy"/> : <BookOpen aria-hidden="true" size={21}/>
}
function FileArtwork({entry, kind, list}: {entry: FileEntry; kind: string; list: boolean}) {
  if (entry.book?.coverAssetId) return <EditionCover asset={entry.book.coverAssetId}/>
  const Icon = kind === 'Book' ? BookOpen : kind === 'Article' ? Browser : kind === 'Note' || kind === 'Reading note' || kind === 'Draft' || kind === 'Obsidian note' ? NotePencil : FileText
  return <><span className="reading-cover-kind"><Icon size={list ? 21 : 16} aria-hidden="true"/>{!list && <span>{kind}</span>}</span>{!list && <div className="reading-cover-text" aria-hidden="true"><h3>{entry.title}</h3><p>{plainPreview(entry.text)}</p></div>}</>
}

export default function ReadingArchive({ importAction, onOpenSource = openReadingSource, onOpenRecord }: { importAction?: ReactNode; onOpenSource?: (id: string, folderId?: string | null) => void; onOpenRecord: (id: string) => void }) {
  const { sources, nodes, writings } = usePersonalLibrary()
  const versions = useKnowledge(state => state.versions), books = useBookshelf(state => state.books)
  const reading = useReading(), writer = useRepoStatus((state) => state.writer)
  const account = useAuth((state) => state.user?.id ?? 'local')
  const locationOwner = typeof history === 'undefined' ? undefined : history.state?.worldviewLibraryAccount
  const initial = new URLSearchParams(typeof location === 'undefined' || typeof locationOwner === 'string' && locationOwner !== account ? '' : location.hash.split('?')[1] ?? '')
  const filters: Filter[] = ['all', 'reading', 'read', 'highlights', 'favorites', 'articles', 'notes', 'books', 'obsidian', 'documents']
  const [query, setQuery] = useState(initial.get('q') ?? ''), [filter, setFilter] = useState<Filter>(filters.includes(initial.get('filter') as Filter) ? initial.get('filter') as Filter : 'all')
  const [folder, setFolderState] = useState<string | null>(initial.get('folder')), [topic, setTopic] = useState(initial.get('topic') ?? '')
  const setFolder = (id: string | null) => { setFolderState(id); location.hash = folderHref(id) }
  const [view, setView] = useState<'grid' | 'list'>(initial.get('view') === 'grid' ? 'grid' : 'list'), [sort, setSort] = useState(initial.get('sort') ?? 'modified'), [limit, setLimit] = useState(48)
  const [selection, setSelection] = useState<Set<string>>(new Set()), [bulkFolder, setBulkFolder] = useState(''), [bulkTopic, setBulkTopic] = useState('')
  const [selecting, setSelecting] = useState(false)
  const addMenu = useRef<HTMLDetailsElement>(null)
  const searchIndex = useRef(new LocalTextIndex())
  const [modal, setModal] = useState<'article' | 'folder' | 'rename' | 'view' | null>(null), [folderName, setFolderName] = useState('')
  const [title, setTitle] = useState(''), [url, setUrl] = useState(''), [text, setText] = useState(''), [remark, setRemark] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const currentFolder = reading.folders.find((entry) => entry.id === folder && !entry.deletedAt)
  useEffect(() => { setLimit(48) }, [query, filter, folder, topic])
  useEffect(() => { if (typeof location === 'undefined' || !location.hash.startsWith('#/library')) return; const route = new URLSearchParams(location.hash.split('?')[1]); if (['source','record','passage'].some(key => route.has(key))) return; const params = new URLSearchParams(); if (query) params.set('q', query); if (filter !== 'all') params.set('filter', filter); if (folder) params.set('folder', folder); if (topic) params.set('topic', topic); if (view !== 'list') params.set('view', view); if (sort !== 'modified') params.set('sort', sort); history.replaceState({ ...(history.state && typeof history.state === 'object' ? history.state : {}), worldviewLibraryAccount: account }, '', `#/library${params.size ? `?${params}` : ''}`) }, [query, filter, folder, topic, view, sort, account])
  const files = useMemo(() => {
    const bySource = new Map(reading.items.map((item) => [item.sourceId, item]))
    const currentVersions = new Map(versions.map((version) => [version.id, version]))
    const highlightCounts = new Map<string, number>(), noteCounts = new Map<string, number>(), annotations = new Map<string, string[]>()
    for (const entry of [...reading.highlights, ...(reading.pdfHighlights ?? [])]) { highlightCounts.set(entry.sourceId, (highlightCounts.get(entry.sourceId) ?? 0) + 1); annotations.set(entry.sourceId, [...(annotations.get(entry.sourceId) ?? []), entry.quote, entry.note]) }
    for (const entry of reading.notes) { noteCounts.set(entry.sourceId, (noteCounts.get(entry.sourceId) ?? 0) + 1); annotations.set(entry.sourceId, [...(annotations.get(entry.sourceId) ?? []), entry.text]) }
    const topicNames = new Map(reading.topics.map((entry) => [entry.id, entry.name]))
    const result: FileEntry[] = sources.filter((source) => !source.deleted && !source.excluded).map((source) => ({ id: source.id, source, title: source.title, text: currentVersions.get(source.currentVersionId)?.text ?? '', annotations: [...(annotations.get(source.id) ?? []), ...(bySource.get(source.id)?.topicIds.map((id) => topicNames.get(id) ?? '') ?? [])].join('\n'), kind: source.kind, version: currentVersions.get(source.currentVersionId), updatedAt: source.updatedAt, item: bySource.get(source.id), highlights: highlightCounts.get(source.id) ?? 0, notes: noteCounts.get(source.id) ?? 0 }))
    const sourceNodes = new Set(sources.map((source) => source.nodeId))
    for (const node of nodes.values()) if (!sourceNodes.has(node.id)) result.push({ id: node.id, recordId: node.id, title: node.title, text: node.contentMd, kind: 'thought', updatedAt: node.updatedAt, highlights: 0, notes: 0 })
    const editions = new Map(books.filter(book => !book.archivedAt && bySource.get('book:' + book.id)?.libraryVisible !== false).map(book => [book.id, book]))
    const sourceRows = new Map(result.map(entry => [entry.id, entry]))
    const bookNoteCounts = new Map<string, number>()
    for (const writing of writings) {
      const linkedSourceId = writing.basedOnSourceId ?? writing.sourceId
      const sourceRow = linkedSourceId ? sourceRows.get(linkedSourceId) : undefined
      const id = sourceRow?.id ?? 'writing:' + writing.id
      const item = bySource.get(id)
      const edition = writing.bookEditionId ? editions.get(writing.bookEditionId) : undefined
      if (edition) bookNoteCounts.set(edition.id, (bookNoteCounts.get(edition.id) ?? 0) + 1)
      const conceptIds = [...new Set([...(writing.topicIds ?? []), ...writingPassages(writing.content).map(passage => passage.topicId)])]
      const labels = [...conceptIds, ...(item?.topicIds ?? [])].map(topic => topicNames.get(topic) ?? topic.replace(/^tag:/, ''))
      const entry: FileEntry = {
        ...sourceRow, id, item, edition, conceptIds, writingId: writing.id, kind: 'writing',
        title: writing.title || 'Untitled document', text: plainTextFromWriting(writing.content),
        annotations: [sourceRow?.annotations, edition?.title, ...(edition?.authors ?? []), ...labels].filter(Boolean).join(' '),
        updatedAt: writing.updatedAt, highlights: sourceRow?.highlights ?? 0, notes: sourceRow?.notes ?? 0,
      }
      if (sourceRow) Object.assign(sourceRow, entry)
      else result.push(entry)
    }
    const linkedSources = new Map(result.filter(entry => entry.source && !entry.writingId).map(entry => [entry.id, entry]))
    const attached = new Set<string>()
    for (const book of books) {
      if (book.archivedAt) continue
      const original = book.sourceId ? linkedSources.get(book.sourceId) : undefined
      const bookKey = 'book:' + book.id
      if (bySource.get(bookKey)?.libraryVisible === false) continue
      if (original) attached.add(original.id)
      result.push({
        ...original, id: bookKey, book, title: book.title, kind: book.kind,
        text: [book.authors.join(', '), book.subtitle, book.notes, book.isbn, original?.text].filter(Boolean).join('\n'),
        updatedAt: Math.max(book.updatedAt, original?.updatedAt ?? 0), item: bySource.get(bookKey) ?? original?.item,
        highlights: original?.highlights ?? 0, notes: (original?.notes ?? 0) + (bookNoteCounts.get(book.id) ?? 0),
      })
    }
    return result.filter(entry => !attached.has(entry.id))
  }, [sources, versions, nodes, reading.items, reading.highlights, reading.pdfHighlights, reading.notes, reading.topics, writings, books])
  const canonicalTopics = useMemo(() => resolveTopics(sources, reading.topics, reading.items), [sources, reading.topics, reading.items])
  const topics = canonicalTopics.map((entry) => entry.name)
  const selectedTopic = canonicalTopics.find((entry) => normalizeTopicName(entry.name) === normalizeTopicName(topic) || entry.id === topic || entry.aliases.includes(topic))
  const indexed = useMemo(() => ({ index: searchIndex.current.update(files.map((entry) => ({ id: entry.id, text: `${entry.title} ${entry.source?.tags.join(' ') ?? ''} ${entry.text} ${entry.annotations ?? ''}` }))) }), [files])
  const matching = useMemo(() => indexed.index.search(query), [indexed, query])
  const shown = useMemo(() => files.filter((entry) => {
    if (folder && entry.item?.folderId !== folder) return false
    if (topic && (!selectedTopic || !selectedTopic.sourceIds.includes(entry.source?.id ?? '') && !topicMatches(selectedTopic, entry.item?.topicIds) && !topicMatches(selectedTopic, entry.conceptIds))) return false
    const status = entry.item?.status ?? entry.book?.status
    if (filter === 'books' && entry.book?.kind !== 'book') return false
    if (filter === 'obsidian' && !isVaultFile(entry.source)) return false
    if (filter === 'reading' && status !== 'reading') return false
    if (filter === 'read' && status !== 'read') return false
    if (filter === 'favorites' && !entry.item?.favorite) return false
    if (filter === 'highlights' && !entry.highlights) return false
    if (filter === 'articles' && fileKind(entry) !== 'Article') return false
    if (filter === 'notes' && !['Note','Reading note','Draft','Obsidian note'].includes(fileKind(entry))) return false
    if (filter === 'documents' && fileKind(entry) !== 'Document') return false
    return matching.has(entry.id)
  }).sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'opened' ? (b.item?.lastOpenedAt ?? 0) - (a.item?.lastOpenedAt ?? 0) : b.updatedAt - a.updatedAt), [files, folder, topic, filter, sort, selectedTopic, matching])
  const folders = reading.folders.filter((entry) => !entry.deletedAt && entry.parentId === folder)
  async function perform(action: () => Promise<unknown>) { setError(''); setBusy(true); try { await action() } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) } }
  async function saveFolder(event: FormEvent) { event.preventDefault(); await perform(async () => { if (modal === 'view') await saveReadingView({ name: folderName, query, filter, folderId: folder, topic, view, sort: sort === 'title' || sort === 'opened' ? sort : 'modified' }); else if (modal === 'rename' && currentFolder) await renameFolder(currentFolder.id, folderName); else await createFolder(folderName, folder); setFolderName(''); setModal(null) }) }
  async function saveArticle(event: FormEvent) {
    event.preventDefault()
    const store = getStore(), generation = getWorldGeneration()
    const current = () => isRepoReady() && getStore() === store && getWorldGeneration() === generation
    await perform(async () => {
      const saved = await captureArticle({ title, url, text, remark })
      if (!current()) return
      if (folder) await updateReadingItem(saved.sourceId, { folderId: folder })
      if (!current()) return
      setTitle(''); setUrl(''); setText(''); setRemark(''); setModal(null); onOpenSource(saved.sourceId)
    })
  }
  function chooseFilter(next: Filter) { setFilter(next); setFolder(null); setTopic(''); setSelection(new Set()); setSelecting(false) }
  async function newNote() {
    const store = getStore(), generation = getWorldGeneration()
    const doc = await createWritingDocument({ format: 'note' })
    if (!isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) return
    if (folder) await bulkUpdateReadingItems(['writing:' + doc.id], { folderId: folder })
    if (isRepoReady() && getStore() === store && getWorldGeneration() === generation) location.hash = '#/write?doc=' + encodeURIComponent(doc.id)
  }
  const eligible = (entry: FileEntry) => entry.book ? entry.id : entry.source?.id ?? (entry.writingId ? `writing:${entry.writingId}` : null)
  function toggleSelected(id: string) { setSelection((prior) => { const next = new Set(prior); if (next.has(id)) next.delete(id); else if (next.size < 500) next.add(id); return next }) }
  async function bulk(patch: Parameters<typeof bulkUpdateReadingItems>[1]) { await perform(async () => { await bulkUpdateReadingItems([...selection], patch); setSelection(new Set()) }) }
  if (folder && reading.loaded && !currentFolder) return <section className="reading-empty"><FolderSimple size={30} /><h2>This page is unavailable</h2><p>It may have been removed or belong to another workspace.</p><a className="knowledge-button" href="#/library">Open your library</a></section>
  return <section className={`reading-archive hierarchy-library ${currentFolder ? 'has-folder-page' : ''}`} aria-label="Reading archive">
    {currentFolder && <FolderPageHeader key={currentFolder.id} folder={currentFolder} />}
    <header className="reading-archive-top">
      <div><h2>{currentFolder ? 'Inside this page' : 'My library'}</h2><p>{currentFolder ? 'Pages, notes, and files at this level.' : 'Your notes, saved books, and imported files.'}</p></div>
      <div className="reading-archive-actions">
        <details className="personal-library-add" ref={addMenu} onKeyDown={e => { if (e.key === 'Escape') { addMenu.current!.open = false; addMenu.current!.querySelector('summary')?.focus() } }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false }}>
          <summary className="knowledge-button">Add to library <CaretDown size={14} /></summary>
          <div onClick={() => { if (addMenu.current) addMenu.current.open = false }}>
            <a className="knowledge-button" href="#/bookshelf?new=1"><Books size={16}/>Book</a>
            <button className="knowledge-button" disabled={!writer} onClick={() => { setError(''); setModal('article') }}><Browser size={16}/>Save article</button>
            {importAction}
            <button className="knowledge-button" disabled={!writer} onClick={() => { setFolderName(''); setError(''); setModal('folder') }}><FolderSimplePlus size={16}/>Folder</button>
          </div>
        </details>
        <button className="knowledge-button is-primary" disabled={!writer || busy} onClick={() => void perform(newNote)}><NotePencil size={16}/>New note</button>
      </div>
    </header>
    <div className="reading-archive-body"><aside className="reading-filters" aria-label="Archive filters">
      {([{id:'all',name:'All files',icon:Books},{id:'books',name:'Books',icon:BookOpen},{id:'notes',name:'Notes',icon:NotePencil},{id:'articles',name:'Articles',icon:Browser},{id:'obsidian',name:'Obsidian vault',icon:FolderSimple},{id:'documents',name:'Documents',icon:FileText}] as const).map(({id,name,icon:Icon}) =>
        <button key={id} type="button" aria-pressed={filter===id && !folder} onClick={()=>chooseFilter(id)}><Icon size={17}/><span>{name}</span>{id==='all' && <small>{files.length}</small>}</button>)}
      <details className="personal-library-refine"><summary>More filters</summary>
        {([{id:'reading',name:'Continue reading',icon:BookOpen},{id:'read',name:'Finished',icon:Check},{id:'favorites',name:'Favorites',icon:Star},{id:'highlights',name:'Highlighted',icon:Highlighter}] as const).map(({id,name,icon:Icon}) =>
          <button key={id} type="button" aria-pressed={filter===id && !folder} onClick={()=>chooseFilter(id)}><Icon size={15}/><span>{name}</span></button>)}
<div className="reading-taxonomy"><label htmlFor="reading-topic"><Tag size={15} />Topics</label><select id="reading-topic" value={topic} onChange={(event) => setTopic(event.target.value)}><option value="">All topics</option>{topics.map((entry) => <option key={entry} value={entry}>{entry.replace(/-/g, ' ')}</option>)}</select><a href={selectedTopic ? topicHref(selectedTopic.id) : "#/topics"}>Open topic home <ArrowUpRight size={13} /></a></div><div className="reading-saved-views"><span className="reading-overline">Saved views</span>{(reading.savedViews ?? []).map((saved) => <div key={saved.id}><button type="button" onClick={() => { setQuery(saved.query); setFilter(saved.filter as Filter); setFolder(saved.folderId); setTopic(saved.topic); setView(saved.view); setSort(saved.sort) }}>{saved.name}</button><button type="button" aria-label={`Remove saved view ${saved.name}`} disabled={!writer || busy} onClick={() => void perform(() => removeReadingView(saved.id))}>×</button></div>)}<button type="button" disabled={!writer} onClick={() => { setFolderName(''); setError(''); setModal('view') }}><Plus size={13} />Save this view</button></div></details></aside>
    <div className="reading-files-main"><div className="reading-file-toolbar"><div className="reading-file-search"><MagnifyingGlass size={18} /><label htmlFor="library-filter" className="knowledge-sr-only">Filter library</label><input id="library-filter" value={query} placeholder="Search your files…" onChange={(event) => setQuery(event.target.value)} /></div><label className="reading-sort"><span className="knowledge-sr-only">Sort files</span><select aria-label="Sort files" value={sort} onChange={(event) => setSort(event.target.value)}><option value="modified">Last modified</option><option value="opened">Last opened</option><option value="title">Name</option></select></label><div className="reading-view-toggle" aria-label="File view"><button className="knowledge-icon-button" aria-label="Grid view" aria-pressed={view === 'grid'} onClick={() => setView('grid')}><SquaresFour size={18} /></button><button className="knowledge-icon-button" aria-label="List view" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={19} /></button></div></div>
    {currentFolder && <div className="reading-folder-breadcrumb"><button type="button" onClick={() => setFolder(currentFolder.parentId)}><ArrowLeft size={15} />{currentFolder.parentId ? 'Parent folder' : 'My files'}</button><span>/ {currentFolder.name}</span><button disabled={!writer} onClick={() => { setFolderName(currentFolder.name); setError(''); setModal('rename') }}>Rename</button><button disabled={!writer || busy} onClick={() => void perform(async () => { await deleteFolder(currentFolder.id); setFolder(currentFolder.parentId) })}>Remove folder</button></div>}
    {error && !modal && <p role="alert" className="knowledge-error">{error}</p>}
    {!!folders.length && !query && <div className="reading-folders" aria-label="Folders">{folders.map((entry) => <button key={entry.id} onClick={() => { setFolder(entry.id); setFilter('all'); setTopic('') }}><FolderIcon folder={entry} size={22} /><span>{entry.name}<small>{entry.typeLabel || entry.kind || 'Folder'}</small></span><small>{files.filter((file) => file.item?.folderId === entry.id).length}</small></button>)}</div>}
    {shown.some((entry) => !!eligible(entry)) && <div className="reading-select-tools"><button aria-pressed={selecting} onClick={() => { setSelecting(!selecting); setSelection(new Set()) }}>{selecting ? 'Done selecting' : 'Select files'}</button>{selecting && <label><input type="checkbox" aria-label="Select visible files" checked={shown.slice(0, limit).filter((entry) => !!eligible(entry)).length > 0 && shown.slice(0, limit).filter((entry) => !!eligible(entry)).every((entry) => selection.has(eligible(entry)!))} onChange={(event) => { const visible = shown.slice(0, limit).map(eligible).filter((id): id is string => !!id); setSelection((prior) => event.target.checked ? new Set([...prior, ...visible].slice(0, 500)) : new Set([...prior].filter((id) => !visible.includes(id)))) }} />Select visible files</label>}{selection.size > 0 && <button type="button" onClick={() => setSelection(new Set())}>Clear selection</button>}</div>}
    {selection.size > 0 && <div className="reading-bulk-bar" aria-label="File selected items"><strong>{selection.size} selected</strong><label><span className="knowledge-sr-only">Move selected files to folder</span><select value={bulkFolder} aria-label="Move selected files to folder" onChange={(event) => setBulkFolder(event.target.value)}><option value="">Unfiled</option>{reading.folders.filter((entry) => !entry.deletedAt).map((entry) => <option key={entry.id} value={entry.id}>{folderTrail(reading.folders, entry.id).map(folder => folder.name).join(' / ')}</option>)}</select></label><button className="knowledge-button" disabled={!writer || busy} onClick={() => void bulk({ folderId: bulkFolder || null })}>Move files</button><label><span className="knowledge-sr-only">Topic for selected files</span><select value={bulkTopic} aria-label="Topic for selected files" onChange={(event) => setBulkTopic(event.target.value)}><option value="">Choose a topic</option>{reading.topics.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label><button className="knowledge-button" disabled={!writer || busy || !bulkTopic} onClick={() => void perform(async () => { await bulkUpdateReadingItems([...selection], {}, { addTopicId: bulkTopic }); setSelection(new Set()) })}>Add topic</button><button className="knowledge-button" disabled={!writer || busy} onClick={() => void bulk({ favorite: true })}>Favorite</button><button className="knowledge-button" disabled={!writer || busy} onClick={() => void bulk({ status: 'read' })}>Mark finished</button><button className="knowledge-button" disabled={!writer || busy} onClick={() => void bulk({ libraryVisible: false })}>Hide from Library</button></div>}
    <div className="reading-results-label" aria-live="polite"><span>{shown.length} {shown.length === 1 ? 'file' : 'files'}{filter === 'all' ? '' : ` · ${filter === 'reading' ? 'in progress' : filter === 'read' ? 'finished' : filter}`}</span></div>
    {shown.length ? <div className={`reading-files reading-files--${view}`}>{shown.slice(0, limit).map((entry) => {
      const href = articleUrl(entry.version), kind = fileKind(entry)
      const status = entry.item?.status ?? entry.book?.status ?? 'unread', progress = Math.round((entry.item?.progress ?? 0) * 100)
      const open = () => { if (entry.book) location.hash = bookHref(entry.book.id); else if (entry.edition && entry.writingId) location.hash = bookHref(entry.edition.id, entry.writingId); else if (entry.writingId && entry.source && writings.find(doc => doc.id === entry.writingId)?.basedOnSourceId) onOpenSource(entry.source.id, folder ?? undefined); else if (entry.writingId) location.hash = `#/write?doc=${encodeURIComponent(entry.writingId)}`; else if (entry.source) { if (folder) onOpenSource(entry.source.id, folder); else onOpenSource(entry.source.id) } else onOpenRecord(entry.recordId!) }
      return <article key={entry.id} className="reading-file knowledge-library-item">{selecting && eligible(entry) && <label className="reading-file-select"><input type="checkbox" aria-label={`Select ${entry.title}`} checked={selection.has(eligible(entry)!)} onChange={() => toggleSelected(eligible(entry)!)} /><span className="knowledge-sr-only">Select {entry.title}</span></label>}<button type="button" className="reading-document-cover" aria-label={`Read ${entry.title}`} onClick={open}><FileArtwork entry={entry} kind={kind} list={view === 'list'}/></button><div className="reading-file-caption"><button type="button" className="reading-file-title" onClick={open} title={entry.title}>{entry.title}</button>{eligible(entry) && <button className="knowledge-icon-button reading-favorite" disabled={!writer || busy} aria-label={`${entry.item?.favorite ? 'Unfavorite' : 'Favorite'} ${entry.title}`} aria-pressed={entry.item?.favorite ?? false} onClick={() => void perform(() => bulkUpdateReadingItems([eligible(entry)!], { favorite: !entry.item?.favorite }))}><Star size={16} weight={entry.item?.favorite ? 'fill' : 'regular'} /></button>}<span className="reading-file-meta">{[kind, entry.book?.authors.join(', ') || (href && !entry.book && !entry.edition ? new URL(href).hostname.replace(/^www\./, '') : fileOrigin(entry)), status === 'read' ? 'Finished' : status === 'reading' ? (progress ? progress + '% read' : 'Reading') : null, entry.notes ? entry.notes + (entry.notes === 1 ? ' note' : ' notes') : null].filter(Boolean).join(' · ')}</span><time className="library-row-date" dateTime={new Date(entry.updatedAt).toISOString()}>{new Date(entry.updatedAt).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})}</time></div></article>
    })}</div> : <div className="reading-empty"><Books size={36} weight="thin" /><h3>{query ? 'No files found' : filter === 'all' ? 'A place for everything you read' : 'Nothing here yet'}</h3><p>{query ? 'Try another word or clear your filters.' : filter === 'all' ? 'Save an article, import your documents, or capture a thought. Your highlights and remarks will stay with their source.' : 'Your reading activity will appear here as you use the reader.'}</p>{!query && filter === 'all' && <button className="knowledge-button" disabled={!writer} onClick={() => setModal('article')}><Plus size={16} />Save your first article</button>}</div>}
    {shown.length > limit && <button className="knowledge-button reading-more" onClick={() => setLimit((previous) => previous + 48)}>Show more files</button>}
    </div></div>
    {modal === 'folder' ? <FolderEditor parentId={folder} onClose={() => setModal(null)} onSaved={entry => setFolder(entry.id)} /> : modal && <ReadingDialog title={modal === 'article' ? 'Save an article' : modal === 'rename' ? 'Rename folder' : modal === 'view' ? 'Save this view' : 'New folder'} onClose={() => { if (!busy) setModal(null) }}>{modal === 'article' ? <form onSubmit={(event) => void saveArticle(event)}><p>Keep the article text, its original URL, and your first impression together. Browser capture can do this from the page you’re reading.</p><label>Title<input required maxLength={300} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What are you reading?" /></label><label>Article URL<input type="url" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" /></label><label>Article text<textarea required rows={8} value={text} maxLength={2_000_000} onChange={(event) => setText(event.target.value)} placeholder="Paste the article here. Your original wording is retained." /></label><label>Your first impression <span>(optional)</span><textarea rows={3} maxLength={20000} value={remark} onChange={(event) => setRemark(event.target.value)} placeholder="What caught your attention?" /></label>{error && <p className="knowledge-error" role="alert">{error}</p>}<footer><a href="#/sources?connection=browser" onClick={() => setModal(null)}>Set up browser capture</a><button className="knowledge-button is-primary" disabled={!writer || busy}>{busy ? 'Saving…' : 'Save to my files'}</button></footer></form> : <form onSubmit={(event) => void saveFolder(event)}><label>{modal === 'view' ? 'View name' : 'Folder name'}<input required maxLength={100} value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="A subject, a project, a collection…" /></label>{error && <p className="knowledge-error" role="alert">{error}</p>}<footer><span>{modal === 'view' ? 'Keeps your current search, filters, and layout.' : 'Files keep their original text when moved.'}</span><button className="knowledge-button is-primary" disabled={!writer || busy}>{busy ? 'Saving…' : modal === 'rename' ? 'Save name' : modal === 'view' ? 'Save view' : 'Create folder'}</button></footer></form>}</ReadingDialog>}
  </section>
}
