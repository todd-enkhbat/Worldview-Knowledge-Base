import { lazy, Suspense, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ArrowUpRight, Check, DownloadSimple, Highlighter, NotePencil, Plus, Star, Tag, TreeStructure, X } from '@phosphor-icons/react'
import { getStore, getWorldGeneration, isRepoReady, useRepoStatus } from '../data/repo.ts'
import { useAuth } from '../data/auth.ts'
import type { KnowledgeSource, SourceVersion } from '../knowledge/types.ts'
import { addHighlight, addPdfHighlight, addReadingNote, assignTopics, createTopic, recordReadingProgress, removeHighlight, removePdfHighlight, removeReadingNote, updateHighlight, updatePdfHighlight, updateReadingItem, useReading } from './store.ts'
import type { ReadingHighlight, ReadingPdfHighlight } from './types.ts'
import { isPdfVersion, type PdfSelection } from './pdfModel.ts'
import { normalizeTopicName, resolveTopics, topicHref } from './topics.ts'
import { articleUrl } from './ReadingArchive.tsx'
import './reading.css'
import './pdf.css'
const PdfReader = lazy(() => import('./PdfReader.tsx'))

export type TextSelection = { start: number; end: number; quote: string; prefix: string; suffix: string }
const failureText = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Offsets are UTF-16 positions in our immutable source text, including whitespace. */
export function selectionInSource(element: HTMLElement, text: string, selection: Selection | null): TextSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null
  const before = document.createRange()
  before.selectNodeContents(element)
  before.setEnd(range.startContainer, range.startOffset)
  const start = before.toString().length, end = start + range.toString().length
  const quote = text.slice(start, end)
  if (!quote.trim() || quote !== range.toString() || end > text.length) return null
  return { start, end, quote, prefix: text.slice(Math.max(0, start - 48), start), suffix: text.slice(end, end + 48) }
}

export function HighlightedText({ text, highlights, onHighlight }: { text: string; highlights: ReadingHighlight[]; onHighlight: (id: string) => void }) {
  const segments = useMemo(() => {
    const valid = highlights.filter((entry) => entry.start >= 0 && entry.end <= text.length && text.slice(entry.start, entry.end) === entry.quote)
    const points = [...new Set([0, text.length, ...valid.flatMap((entry) => [entry.start, entry.end])])].sort((a, b) => a - b)
    return points.slice(0, -1).map((start, index) => { const end = points[index + 1]; return { start, end, covering: valid.filter((entry) => entry.start <= start && entry.end >= end) } })
  }, [text, highlights])
  return <>{segments.map(({ start, end, covering }) => covering.length ? <mark key={start} role="button" tabIndex={0} aria-label={`Show saved highlight: ${text.slice(start, end).slice(0, 100)}`} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onHighlight(covering[0].id) } }} data-highlight-id={covering[0].id} data-highlight-ids={covering.map((entry) => entry.id).join(' ')} className={`reading-mark reading-mark--${covering[0].color}`} title={covering[0].note || 'Saved highlight'} onClick={() => onHighlight(covering[0].id)}>{text.slice(start, end)}</mark> : <span key={start}>{text.slice(start, end)}</span>)}</>
}

function HighlightCard({ highlight, currentVersion, onLocate, onFailure }: { highlight: ReadingHighlight | ReadingPdfHighlight; currentVersion: string; onLocate: () => void; onFailure: (message: string) => void }) {
  const [draft, setDraft] = useState(highlight.note), [editing, setEditing] = useState(false), [saving, setSaving] = useState(false)
  const writer = useRepoStatus((state) => state.writer)
  async function save() { setSaving(true); try { await ('page' in highlight ? updatePdfHighlight(highlight.id, { note: draft }) : updateHighlight(highlight.id, { note: draft })); setEditing(false) } catch (error) { onFailure(failureText(error)) } finally { setSaving(false) } }
  return <article className="reading-highlight-card" id={`annotation-${highlight.id}`} tabIndex={-1}><button type="button" className={`reading-quote reading-quote--${highlight.color}`} onClick={onLocate}><blockquote>{highlight.quote}</blockquote><span>{'page' in highlight ? `Page ${highlight.page}${highlight.versionId !== currentVersion ? ' · earlier version' : ''} · show context` : highlight.versionId !== currentVersion ? 'Earlier version · show context' : 'Show in article'} <ArrowUpRight size={12} /></span></button>{editing ? <div className="reading-highlight-edit"><label className="knowledge-sr-only" htmlFor={`remark-${highlight.id}`}>Comment on highlight</label><textarea id={`remark-${highlight.id}`} autoFocus rows={3} value={draft} maxLength={20000} onChange={(event) => setDraft(event.target.value)} /><div><button className="knowledge-text-button" disabled={saving} onClick={() => { setDraft(highlight.note); setEditing(false) }}>Cancel</button><button className="knowledge-button" disabled={!writer || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save comment'}</button></div></div> : <>{highlight.note && <p className="reading-remark">{highlight.note}</p>}<div className="reading-highlight-actions"><time>{new Date(highlight.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time><button disabled={!writer} onClick={() => { setDraft(highlight.note); setEditing(true) }}>{highlight.note ? 'Edit comment' : 'Add comment'}</button><button disabled={!writer || saving} aria-label="Remove highlight" onClick={() => { setSaving(true); void ('page' in highlight ? removePdfHighlight(highlight.id) : removeHighlight(highlight.id)).catch((error) => { onFailure(failureText(error)); setSaving(false) }) }}><X size={13} /></button></div></>}</article>
}

type AnnotatedReaderProps = { source: KnowledgeSource; version: SourceVersion; scrollRef: RefObject<HTMLDivElement | null>; onReadVersion: (id: string) => void }
export default function AnnotatedReader(props: AnnotatedReaderProps) {
  const account = useAuth((state) => state.user?.id ?? 'local')
  return <ReaderSession key={`${account}:${getWorldGeneration()}:${props.source.id}`} {...props} />
}

function ReaderSession({ source, version, scrollRef, onReadVersion }: AnnotatedReaderProps) {
  const reading = useReading(), writer = useRepoStatus((state) => state.writer)
  const item = reading.items.find((entry) => entry.sourceId === source.id)
  const textHighlights = useMemo(() => reading.highlights.filter((entry) => entry.sourceId === source.id), [reading.highlights, source.id])
  const pdfHighlights = useMemo(() => (reading.pdfHighlights ?? []).filter((entry) => entry.sourceId === source.id), [reading.pdfHighlights, source.id])
  const highlights = useMemo(() => [...textHighlights, ...pdfHighlights].sort((a, b) => a.createdAt - b.createdAt), [textHighlights, pdfHighlights])
  const notes = reading.notes.filter((entry) => entry.sourceId === source.id)
  const canonicalTopics = useMemo(() => resolveTopics([source], reading.topics, reading.items), [source, reading.topics, reading.items])
  const versionHighlights = useMemo(() => textHighlights.filter((entry) => entry.versionId === version.id), [textHighlights, version.id])
  const textElement = useRef<HTMLDivElement>(null), pendingLocate = useRef<string | null>(null)
  const [selection, setSelection] = useState<TextSelection | PdfSelection | null>(null), [comment, setComment] = useState(''), [color, setColor] = useState<ReadingHighlight['color']>('yellow')
  const [tab, setTab] = useState<'highlights' | 'notes' | 'organize'>('highlights'), [note, setNote] = useState(''), [topic, setTopic] = useState('')
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [notice, setNotice] = useState('')
  const sourceUrl = articleUrl(version)
  const [format, setFormat] = useState<'pdf' | 'text'>(isPdfVersion(version) ? 'pdf' : 'text'), [pdfTarget, setPdfTarget] = useState<{ id: string; request: number } | null>(null)
  const originalPdf = isPdfVersion(version) && format === 'pdf'
  const pdfProgress = useRef({ fraction: 0, position: 1 })
  const formatRef = useRef(originalPdf)
  useEffect(() => { formatRef.current = originalPdf }, [originalPdf])
  useEffect(() => {
    setSelection(null); setComment('')
  }, [source.id, version.id, version.text])
  useEffect(() => {
    if (!writer || !reading.loaded) return
    let activeMs = 0, last = performance.now(), lastProgress = -1
    const sourceId = source.id
    void updateReadingItem(sourceId, { lastOpenedAt: Date.now(), ...(item?.status === 'read' ? {} : { status: 'reading' as const }) }).catch((error) => setError(failureText(error)))
    function flush() {
      const now = performance.now(), elapsed = now - last; last = now
      if (document.visibilityState === 'hidden') return
      activeMs += Math.min(elapsed, 6000)
      const element = scrollRef.current
      if (!element || activeMs < 15000) return
      const remaining = element.scrollHeight - element.clientHeight
      const progress = formatRef.current ? pdfProgress.current.fraction : remaining <= 4 ? 1 : Math.min(1, Math.max(0, (element.scrollTop + element.clientHeight) / element.scrollHeight))
      if (Math.abs(progress - lastProgress) < .025) return
      lastProgress = progress
      void recordReadingProgress(sourceId, { progress, position: formatRef.current ? pdfProgress.current.position : element.scrollTop }).catch((error) => setError(failureText(error)))
    }
    const timer = setInterval(flush, 5000)
    return () => clearInterval(timer)
    // Opening once records an interaction; progress needs visible reading time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id, writer, reading.loaded, scrollRef])
  useEffect(() => {
    const id = pendingLocate.current
    if (!id) return
    const mark = textElement.current?.querySelector<HTMLElement>(`[data-highlight-ids~="${CSS.escape(id)}"]`)
    mark?.scrollIntoView?.({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    pendingLocate.current = null
  }, [version.id, versionHighlights])
  async function perform(action: () => Promise<unknown>) { setSaving(true); setError(''); try { await action() } catch (failure) { setError(failureText(failure)) } finally { setSaving(false) } }
  async function saveHighlight() {
    if (!selection) return
    const savedSelection = selection, savedComment = comment
    await perform(async () => { await ('page' in savedSelection ? addPdfHighlight({ ...savedSelection, sourceId: source.id, versionId: version.id, note: savedComment, color }) : addHighlight({ ...savedSelection, sourceId: source.id, versionId: version.id, note: savedComment, color })); setSelection(null); setComment(''); window.getSelection()?.removeAllRanges(); setTab('highlights'); setNotice('Highlight saved with this source version.') })
  }
  function locate(entry: ReadingHighlight | ReadingPdfHighlight) {
    if ('page' in entry) { setFormat('pdf'); setPdfTarget((current) => ({ id: entry.id, request: (current?.request ?? 0) + 1 })); if (entry.versionId !== version.id) onReadVersion(entry.versionId); return }
    setFormat('text')
    pendingLocate.current = entry.id
    if (entry.versionId !== version.id) onReadVersion(entry.versionId)
    else { textElement.current?.querySelector<HTMLElement>(`[data-highlight-ids~="${CSS.escape(entry.id)}"]`)?.scrollIntoView?.({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); pendingLocate.current = null }
  }
  function exportNotes() {
    const heading = `# ${source.title}\n\n${sourceUrl ? `Source: ${sourceUrl}\n\n` : ''}`
    const text = heading + highlights.map((entry) => `> ${entry.quote.replace(/\n/g, '\n> ')}\n\n${entry.note ? `${entry.note}\n\n` : ''}Source version: ${entry.versionId} · ${'page' in entry ? `PDF page ${entry.page}` : `characters ${entry.start + 1}–${entry.end}`}\n`).join('\n---\n\n') + (notes.length ? '\n## My notes\n\n' + notes.map((entry) => entry.text).join('\n\n---\n\n') : '')
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' })), anchor = document.createElement('a')
    anchor.href = url; anchor.download = `${source.title.replace(/[^\p{L}\p{N}\s_-]/gu, '').slice(0, 80) || 'reading'}-annotations.md`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <section className="reading-reader" aria-label="Reading and annotations">
    <div className="reading-reader-toolbar"><label><span className="knowledge-sr-only">Reading status</span><select aria-label="Reading status" value={item?.status ?? 'unread'} disabled={!writer || saving} onChange={(event) => void perform(() => updateReadingItem(source.id, { status: event.target.value as ReadingItemStatus }))}><option value="unread">To read</option><option value="reading">In progress</option><option value="read">Finished</option></select></label><span className="reading-progress-label">{Math.round((item?.progress ?? 0) * 100)}% read</span><span className="reading-reader-toolbar-spacer" /><button type="button" className="knowledge-icon-button" disabled={!writer || saving} aria-label="Favorite source" aria-pressed={item?.favorite ?? false} onClick={() => void perform(() => updateReadingItem(source.id, { favorite: !item?.favorite }))}><Star size={17} weight={item?.favorite ? 'fill' : 'regular'} /></button><button className="knowledge-icon-button" title="Export highlights and notes" aria-label="Export highlights and notes" onClick={exportNotes}><DownloadSimple size={17} /></button><a className="knowledge-button" href={`#/graph?source=${encodeURIComponent(source.id)}`}><TreeStructure size={16} />Connections</a></div>
    {isPdfVersion(version) && <div className="reading-format-switch" aria-label="Document reading format"><button type="button" aria-pressed={originalPdf} onClick={() => { setSelection(null); setFormat('pdf') }}>Original PDF</button><button type="button" aria-pressed={!originalPdf} onClick={() => { setSelection(null); setFormat('text') }}>Extracted text</button></div>}
    {sourceUrl && <a className="reading-source-url" href={sourceUrl} target="_blank" rel="noopener noreferrer">{new URL(sourceUrl).hostname.replace(/^www\./, '')}<ArrowUpRight size={13} /><span>Original article</span></a>}
    {error && <p className="knowledge-error" role="alert">{error}</p>}
    <div className="reading-reader-columns"><div className="reading-document">
      <div className="reading-selection-help"><Highlighter size={15} /><span>Select text to highlight it or leave a comment.</span></div>
      {selection && <div className="reading-selection-toolbar" role="region" aria-label="Save selected passage"><div><Highlighter size={17} /><span>{selection.quote.length > 100 ? `${selection.quote.slice(0, 100)}…` : selection.quote}</span><button className="knowledge-icon-button" aria-label="Cancel selection" onClick={() => { setSelection(null); setComment('') }}><X size={15} /></button></div><label className="knowledge-sr-only" htmlFor="reading-selection-comment">Comment on selected text</label><textarea id="reading-selection-comment" rows={2} maxLength={20000} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="What do you think about this? (optional)" /><footer><div className="reading-highlight-colors" aria-label="Highlight color">{(['yellow', 'blue', 'rose'] as const).map((value) => <button key={value} className={`reading-color reading-color--${value}`} aria-label={`${value} highlight`} aria-pressed={color === value} onClick={() => setColor(value)}>{color === value && <Check size={12} />}</button>)}</div><button type="button" className="knowledge-button is-primary" disabled={!writer || saving} onClick={() => void saveHighlight()}><Highlighter size={14} />{saving ? 'Saving…' : 'Save highlight'}</button></footer></div>}
      {originalPdf ? <Suspense fallback={<p role="status">Opening PDF reader…</p>}><PdfReader version={version} highlights={pdfHighlights.filter((entry) => entry.versionId === version.id)} onSelect={setSelection} onHighlight={(id) => { setTab('highlights'); document.getElementById(`annotation-${id}`)?.focus({ preventScroll: true }) }} locateId={pdfTarget?.id} locateRequest={pdfTarget?.request} onProgress={(value) => { pdfProgress.current = value }} /></Suspense> : <div ref={textElement} className="reading-article-text knowledge-prose" data-source-version={version.id} onTouchEnd={() => { if (textElement.current) { const next = selectionInSource(textElement.current, version.text, window.getSelection()); if (next) setSelection(next) } }} onMouseUp={() => { if (textElement.current) { const next = selectionInSource(textElement.current, version.text, window.getSelection()); if (next) setSelection(next) } }} onKeyUp={() => { if (textElement.current) { const next = selectionInSource(textElement.current, version.text, window.getSelection()); if (next) setSelection(next) } }}><HighlightedText text={version.text} highlights={versionHighlights} onHighlight={(id) => { setTab('highlights'); document.getElementById(`annotation-${id}`)?.focus({ preventScroll: true }) }} /></div>}
      <p className="reading-retention-note">Highlights reference this exact version. Your remarks are saved separately from the original.</p>
    </div><aside className="reading-annotations" aria-label="Highlights, notes and organization"><div className="reading-annotation-tabs" role="tablist" aria-label="Reading details" onKeyDown={(event) => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const tabs = ["highlights", "notes", "organize"] as const; const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[2] : tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : 2)) % 3]; setTab(next); requestAnimationFrame(() => document.getElementById(`reading-tab-${next}`)?.focus()) }}>{([{ id: 'highlights', label: `Highlights ${highlights.length}`, icon: Highlighter }, { id: 'notes', label: `Notes ${notes.length}`, icon: NotePencil }, { id: 'organize', label: 'Organize', icon: Tag }] as const).map(({ id, label, icon: Icon }) => <button key={id} id={`reading-tab-${id}`} type="button" role="tab" tabIndex={tab === id ? 0 : -1} aria-selected={tab === id} aria-controls={`reading-detail-${id}`} onClick={() => setTab(id)}><Icon size={15} />{label}</button>)}</div>
      <div id={`reading-detail-${tab}`} role="tabpanel" aria-labelledby={`reading-tab-${tab}`}>
      {tab === 'highlights' && <>{highlights.length ? highlights.map((entry) => <HighlightCard key={entry.id} highlight={entry} currentVersion={version.id} onLocate={() => locate(entry)} onFailure={setError} />) : <div className="reading-aside-empty"><Highlighter size={24} weight="thin" /><h3>Keep what stands out.</h3><p>Select a passage in the article, then save a highlight. Add your thoughts alongside it.</p></div>}</>}
      {tab === 'notes' && <><form className="reading-note-form" onSubmit={(event) => { event.preventDefault(); const submitted = note; if (!submitted.trim()) return; void perform(async () => { await addReadingNote(source.id, submitted); setNote((current) => current === submitted ? '' : current); setNotice('Your note is saved with this source.') }) }}><label htmlFor="reading-note">Your thoughts on this source</label><textarea id="reading-note" value={note} rows={5} maxLength={20000} placeholder="What changed your mind? What would you connect this to?" onChange={(event) => setNote(event.target.value)} /><button className="knowledge-button" disabled={!writer || saving || !note.trim()}><Plus size={14} />Save note</button></form>{notes.map((entry) => <article className="reading-note" key={entry.id}><p>{entry.text}</p><footer><time>{new Date(entry.createdAt).toLocaleDateString()}</time><button type="button" disabled={!writer || saving} aria-label="Remove note" onClick={() => void perform(() => removeReadingNote(entry.id))}><X size={13} /></button></footer></article>)}</>}
      {tab === 'organize' && <div className="reading-organize"><label>Folder<select aria-label="File in folder" value={item?.folderId ?? ''} disabled={!writer || saving} onChange={(event) => void perform(() => updateReadingItem(source.id, { folderId: event.target.value || null }))}><option value="">Unfiled</option>{reading.folders.filter((entry) => !entry.deletedAt).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label><h3>Connect to topics</h3><p>A source can belong to several topics. These links appear in your graph.</p>{canonicalTopics.filter((entry) => entry.readingTopicIds.length).map((entry) => <label key={entry.id} className="reading-topic-checkbox"><input type="checkbox" checked={entry.readingTopicIds.some((id) => item?.topicIds.includes(id))} disabled={!writer || saving} onChange={(event) => { const assigned = (item?.topicIds ?? []).filter((id) => !entry.readingTopicIds.includes(id)); void perform(() => assignTopics(source.id, event.target.checked ? [...assigned, entry.readingTopicIds[0]] : assigned)) }} /><span>{entry.name}</span><a href={topicHref(entry.id)} aria-label={`Open ${entry.name} topic`}><ArrowUpRight size={12} /></a></label>)}<form onSubmit={(event) => { event.preventDefault(); if (!topic.trim()) return; void perform(async () => { const store = getStore(), generation = getWorldGeneration(); const saved = await createTopic(topic); if (!isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) return; await assignTopics(source.id, [...new Set([...(useReading.getState().items.find((entry) => entry.sourceId === source.id)?.topicIds ?? []), saved.id])]); setTopic('') }) }}><label className="knowledge-sr-only" htmlFor="reading-new-topic">New topic</label><input id="reading-new-topic" value={topic} maxLength={100} onChange={(event) => setTopic(event.target.value)} placeholder="Create a topic…" /><button className="knowledge-icon-button" disabled={!writer || saving || !topic.trim()} aria-label="Create and connect topic"><Plus size={17} /></button></form>{source.tags.length > 0 && <><h3>From the source</h3><div className="reading-source-tags">{source.tags.map((tag) => <a key={tag} href={topicHref(canonicalTopics.find((entry) => normalizeTopicName(entry.name) === normalizeTopicName(tag))?.id ?? `tag:${normalizeTopicName(tag)}`)}>#{tag}</a>)}</div></>}<a className="knowledge-button" href={`#/graph?source=${encodeURIComponent(source.id)}`}><TreeStructure size={16} />Open this source’s graph</a></div>}
      </div><p className="reading-save-status" role="status">{notice}</p>
    </aside></div>
  </section>
}
type ReadingItemStatus = 'unread' | 'reading' | 'read'
