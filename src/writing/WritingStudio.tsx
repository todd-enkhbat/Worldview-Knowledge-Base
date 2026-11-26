import { SubstackShelf } from './SubstackShelf.tsx'
import { linkSavedQuote, type QuoteSelection } from './quoteLink.ts'
import { QuoteCapture } from '../quotes/QuoteCapture.tsx'
import { selectWritingPassage } from './passageNavigation.ts'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Editor } from '@tiptap/core'
import { ArrowLeft, ArrowSquareOut, ArrowsOutSimple, BookOpen, Check, ClockCounterClockwise, Copy, DotsThree, Eye, FileText, ListBullets, Palette, PencilSimple, Plus, Printer, SidebarSimple, Trash, X } from '@phosphor-icons/react'
import { useAuth } from '../data/auth.ts'
import { getStore, getWorldGeneration, isRepoReady, useRepoStatus } from '../data/repo.ts'
import { archiveWritingDocument, conceptNoteId, createWritingDocument, publishWritingDocument, useWriting } from './store.ts'
import { sourceWritingDocument } from './sourceMarkdown.ts'
import { plainTextFromWriting, writingPublicationValue } from './model.ts'
import type { WritingDocument, WritingFormat } from './types.ts'
import RichEditor from './RichEditor.tsx'
import { uploadWritingBackground, insertWritingMedia } from './media.ts'
import { useWritingAssetUrl } from './WritingMediaView.tsx'
import { exportWritingDocument } from './export.ts'
import { useWritingDraft } from './useWritingDraft.ts'
import { WritingDesign } from './WritingDesign.tsx'
import { WRITING_FORMS, writingTemplate } from './templates.ts'
import { WritingHistoryPanel } from './WritingHistory.tsx'
import { WritingResearch } from './WritingResearch.tsx'
import { createTopic, useReading } from '../reading/store.ts'
import { useKnowledge } from '../knowledge/index.ts'
import { resolveTopics, topicHref } from '../reading/topics.ts'
import { usePersonalLibrary } from '../reading/personalLibrary.ts'
import { LocalTextIndex } from '../reading/search.ts'
import './writing.css'
import './writing-workflows.css'

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const destination = (id: string) => `#/write?doc=${encodeURIComponent(id)}`
const nameOf = (document: WritingDocument) => document.title.trim() || 'Untitled document'
const wordsOf = (text: string) => text.trim().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0

export default function WritingStudio({ hash }: { hash: string }) {
  const docs = useWriting((state) => state.docs), loaded = useWriting((state) => state.loaded), failure = useWriting((state) => state.error)
  const writer = useRepoStatus((state) => state.writer), account = useAuth((state) => state.user?.id ?? 'local')
  const [query, setQuery] = useState(''), [trash, setTrash] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const selected = new URLSearchParams(hash.split('?')[1] ?? '').get('doc')
  const entry = docs.find(doc => doc.id === selected && !doc.archivedAt)
  const sources = useKnowledge(state => state.sources), versions = useKnowledge(state => state.versions)
  const knowledgeLoaded = useKnowledge(state => state.loaded), knowledgeError = useKnowledge(state => state.error)
  const document = useMemo(() => entry && sourceWritingDocument(entry, sources, versions), [entry, sources, versions])
  const { writings } = usePersonalLibrary()
  const listing = trash ? docs : writings
  const search = useMemo(() => new LocalTextIndex().update(listing.map((entry) => ({ id: entry.id, text: `${entry.title} ${entry.subtitle} ${plainTextFromWriting(entry.content)}` }))), [listing])
  const matches = useMemo(() => search.search(query), [search, query])
  const files = [...listing].filter((entry) => !!entry.archivedAt === trash && matches.has(entry.id)).sort((a, b) => b.updatedAt - a.updatedAt)
  async function create(format: WritingFormat) {
    const store = getStore(), generation = getWorldGeneration()
    setBusy(true); setError('')
    try { const saved = await createWritingDocument({ format, content: writingTemplate(format), ...(format === 'poem' ? { appearance: { lineHeight: 2 } } : {}) }); if (isRepoReady() && getStore() === store && getWorldGeneration() === generation) location.hash = destination(saved.id) }
    catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  if (!loaded) return <div className="writing-loading" role="status">Opening your writing desk…{failure && <p role="alert">{failure}</p>}</div>
  if (document?.basedOnSourceId && !knowledgeLoaded && !knowledgeError) return <div className="writing-loading" role="status">Opening document…</div>
  if (selected && !document) return <div className="writing-loading"><FileText size={30} /><h2>This document is unavailable</h2><p>It may have been archived or belong to another workspace.</p><a className="knowledge-button" href="#/write">Your writing</a></div>
  if (document) return <WritingSession hash={hash} key={`${account}:${getWorldGeneration()}:${document.id}`} document={document} />
  const recent = !trash && !query.trim() ? files[0] : undefined
  const otherFiles = recent ? files.slice(1) : files
  return <section className="writing-desk" aria-label="Writing desk"><header><h2>Your writing</h2><div className="writing-start-actions">
    <button type="button" className="knowledge-button is-primary" disabled={!writer || busy} onClick={() => void create('note')}><Plus size={16} />New draft</button>
    <details className="writing-export-menu writing-templates"><summary className="knowledge-button">Templates</summary><div>{WRITING_FORMS.filter(form => form.id !== 'note').map(form => <button key={form.id} disabled={!writer || busy} onClick={() => void create(form.id)}>{form.name}</button>)}</div></details>
  </div></header>{(error || failure) && <p className="knowledge-error" role="alert">{error || failure}</p>}
    <SubstackShelf key={`${account}:${getWorldGeneration()}`} />
    {recent && <a className="writing-resume" href={destination(recent.id)}><div><small>Continue writing</small><h3>{nameOf(recent)}</h3>
      {plainTextFromWriting(recent.content).trim() && <p>{plainTextFromWriting(recent.content).slice(0, 160)}</p>}</div><ArrowSquareOut size={19} /></a>}
    <section className="writing-files"><div className="writing-desk-tabs" role="group" aria-label="Writing collection"><button type="button" aria-pressed={!trash} onClick={() => setTrash(false)}>On your desk</button><button type="button" aria-pressed={trash} onClick={() => setTrash(true)}><Trash size={14} />Trash <span>{docs.filter((entry) => entry.archivedAt).length}</span></button></div><header><h3>{trash ? 'Archived drafts' : query ? 'Search results' : recent ? 'Other drafts' : 'Drafts'} <span>{otherFiles.length}</span></h3><label><span className="knowledge-sr-only">Find a writing document</span><input type="search" value={query} placeholder="Find a document…" onChange={(event) => setQuery(event.target.value)} /></label></header>{otherFiles.length ? otherFiles.map((entry) => <div className="writing-file-entry" key={entry.id}><a href={destination(entry.id)} className="writing-file-row"><FileText size={21} /><span><strong>{nameOf(entry)}</strong><small>{entry.subtitle || plainTextFromWriting(entry.content).slice(0, 120) || 'Empty draft'}</small></span><span>{WRITING_FORMS.find((form) => form.id === entry.format)?.name}</span><time>{new Date(entry.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time><ArrowSquareOut size={15} /></a>{trash && <button type="button" className="knowledge-button" disabled={!writer || busy} onClick={() => { setBusy(true); setError(''); void archiveWritingDocument(entry.id, false).catch((cause) => setError(message(cause))).finally(() => setBusy(false)) }}>Restore</button>}</div>) : recent ? null : <div className="writing-desk-empty"><BookOpen size={26} weight="thin" /><p>{query ? 'No matching documents.' : trash ? 'Nothing in Trash. Restored documents return to your desk.' : 'Create a draft to start writing.'}</p></div>}</section>
  </section>
}

function WritingSession({ document, hash }: { document: WritingDocument; hash: string }) {
  const { draft, update, flush, status, error, reload } = useWritingDraft(document)
  const writer = useRepoStatus((state) => state.writer)
  const [panel, setPanel] = useState<'design' | 'outline' | 'research' | 'history' | null>(null), [preview, setPreview] = useState(false), [focus, setFocus] = useState(false)
  const [showCredits, setShowCredits] = useState(false)
  const [historyBusy, setHistoryBusy] = useState(false), [editorEpoch, setEditorEpoch] = useState(0)
  const reading = useReading(), sources = useKnowledge((state) => state.sources)
  const topicOptions = useMemo(() => resolveTopics(sources, reading.topics, reading.items).map((topic) => ({ id: topic.id, label: topic.name, aliases: topic.terms })), [sources, reading.topics, reading.items])
  const homeTopic = topicOptions.find(topic => document.id === conceptNoteId(topic.id))
  const [editor, setEditor] = useState<Editor | null>(null), [working, setWorking] = useState(''), [notice, setNotice] = useState(''), [failure, setFailure] = useState('')
  const [quote, setQuote] = useState<QuoteSelection | null>(null)
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    if (selectWritingPassage(editor, new URLSearchParams(hash.split('?')[1])) === 'changed') setNotice('This passage has changed since the link was opened.')
  }, [editor, hash])
  const sourceScope = useRef({ store: getStore(), generation: getWorldGeneration(), documentId: document.id })
  const current = () => isRepoReady() && getStore() === sourceScope.current.store && getWorldGeneration() === sourceScope.current.generation
  const background = useWritingAssetUrl(draft.appearance.background === 'image' ? draft.appearance.backgroundAssetId : null)
  const plain = useMemo(() => plainTextFromWriting(draft.content), [draft.content]), words = wordsOf(plain)
  const outline: { text: string; level: number; position: number }[] = []
  if (panel === 'outline' && editor && !editor.isDestroyed) editor.state.doc.descendants((node, position) => { if (node.type.name === 'heading') outline.push({ text: node.textContent || 'Untitled section', level: node.attrs.level as number, position: position + 1 }) })
  const font = draft.appearance.fontFamily === 'serif' ? 'Georgia, "Times New Roman", serif' : draft.appearance.fontFamily === 'mono' ? '"JetBrains Mono", monospace' : 'Inter, system-ui, sans-serif'
  const style = { '--write-font': font, '--write-size': `${draft.appearance.fontSize}px`, '--write-leading': draft.appearance.lineHeight, '--write-width': `${draft.appearance.pageWidth}px`, '--write-paper': draft.appearance.pageColor, '--write-ink': draft.appearance.textColor, '--write-accent': draft.appearance.accentColor, '--write-bg': draft.appearance.backgroundColor, '--write-wave': draft.appearance.waveColor, '--write-pattern-alpha': `${draft.appearance.waveIntensity}%`, '--write-background-image': background.url ? `url("${background.url}")` : 'none' } as CSSProperties
  async function perform(name: string, action: () => Promise<void>) { setWorking(name); setFailure(''); setNotice(''); try { await action() } catch (cause) { if (current()) setFailure(message(cause)) } finally { if (current()) setWorking('') } }
  function upload(files: File[], target: Editor) { return insertWritingMedia(files, target, sourceScope.current) }
  async function backgroundFile(file: File) { const assetId = await uploadWritingBackground(file, { store: sourceScope.current.store, generation: sourceScope.current.generation }); if (!current()) throw new Error('The workspace changed. Your original was retained, but this page was not changed.'); update({ appearance: { backgroundAssetId: assetId, background: 'image' } }) }
  async function publish() { await perform('publish', async () => { await flush(); if (!current()) return; await publishWritingDocument(document.id); if (current()) setNotice('Saved to your library. Source history and earlier highlights are retained.') }) }
  async function download(format: 'html' | 'markdown' | 'bundle') { await perform('export', async () => { await flush(); if (!current()) return; const saved = useWriting.getState().docs.find((entry) => entry.id === document.id); if (!saved) throw new Error('Reopen this document before exporting.'); const result = await exportWritingDocument(saved, format); if (!current()) return; const url = URL.createObjectURL(result.blob), link = globalThis.document.createElement('a'); link.href = url; link.download = result.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice('Your document has been exported with its saved formatting.') }) }
  async function copy() { await perform('copy', async () => { const saved = await createWritingDocument({ ...writingPublicationValue(draft), title: `${nameOf(draft)} (copy)` }); if (current()) location.hash = destination(saved.id) }) }
  async function trashDocument() { await perform('trash', async () => { await flush(); if (!current()) return; await archiveWritingDocument(document.id); if (current()) location.hash = '#/write' }) }
  const ariaStatus = status === 'saving' ? 'Saving locally…' : status === 'dirty' ? 'Unsaved changes' : status === 'error' ? 'Save needs attention' : 'Saved locally'
  return <section className={`writing-studio ${panel ? 'has-design-panel' : ''} ${preview ? 'is-preview' : ''} ${focus ? 'is-focus' : ''}`} aria-label="Writing studio" style={style}>
    {draft.applicationId&&<a href={'#/applications?application='+encodeURIComponent(draft.applicationId)}>Original application answers</a>}
    <header className="writing-studio-header"><div className="writing-studio-location"><a href="#/write" aria-label="Your writing" title="Your writing"><ArrowLeft size={17} /></a><div><strong>{nameOf(draft)}</strong><span role="status" className={status === 'error' ? 'is-error' : ''}>{status === 'saved' && <Check size={11} />}{ariaStatus}</span></div></div><div className="writing-studio-actions"><SubstackShelf compact /><button className="knowledge-button" type="button" aria-label={preview ? 'Edit' : 'Preview'} title={preview ? 'Edit' : 'Preview'} aria-pressed={preview} onClick={() => setPreview((value) => !value)}>{preview ? <PencilSimple size={15} /> : <Eye size={15} />}<span>{preview ? 'Edit' : 'Preview'}</span></button><button className="knowledge-button" type="button" aria-label="Research" title="Research" aria-pressed={panel === 'research'} onClick={() => setPanel((value) => value === 'research' ? null : 'research')}><BookOpen size={16} /><span>Research</span></button><details className="writing-export-menu"><summary className="knowledge-button" aria-label="Document tools" title="Document tools"><DotsThree size={19} /><span>Document tools</span></summary><div onClick={(event) => { if (!(event.target instanceof Element) || !event.target.closest('button')) return; const menu = event.currentTarget.closest('details'); if (menu) { menu.open = false; menu.querySelector('summary')?.focus() } }}><button className="knowledge-button" type="button" aria-label="Version history" aria-expanded={panel === 'history'} onClick={() => setPanel((value) => value === 'history' ? null : 'history')}><ClockCounterClockwise size={16} /><span>History</span></button><button className="knowledge-button" type="button" aria-label="Customize document design" aria-expanded={panel === 'design'} onClick={() => setPanel((value) => value === 'design' ? null : 'design')}><Palette size={16} /><span>Design</span></button><button className="knowledge-icon-button" type="button" title="Focus mode" aria-label="Focus mode" aria-pressed={focus} onClick={() => setFocus((value) => !value)}><ArrowsOutSimple size={17} />Focus mode</button><hr /><button type="button" disabled={!!working} onClick={() => void download('html')}>Formatted HTML</button><button type="button" disabled={!!working} onClick={() => void download('markdown')}>Markdown</button><button type="button" disabled={!!working} onClick={() => void download('bundle')}>Document + original media (ZIP)</button><button type="button" onClick={() => window.print()}><Printer size={14} />Print / save PDF</button><button type="button" disabled={!writer || !!working || historyBusy} onClick={() => void copy()}><Copy size={14} />Make a copy</button><button type="button" disabled={!writer || !!working || historyBusy} onClick={() => void trashDocument()}><Trash size={14} />Move to Trash</button></div></details><button className="knowledge-button is-primary" type="button" disabled={!writer || !!working || historyBusy} onClick={() => void publish()}><span>{working === 'publish' ? 'Saving…' : draft.sourceId ? 'Save revision' : 'Save to Library'}</span></button></div></header>
    {(failure || error) && <div className="writing-status-bar is-error" role="alert"><span>{failure || error}</span>{error && <><button type="button" disabled={!!working || !writer} onClick={() => reload(document)}>Reload saved version</button><button type="button" disabled={!!working || !writer} onClick={() => void copy()}>Save my edits as a copy</button><button type="button" disabled={!!working || !writer} onClick={() => void perform('retry', flush)}>Retry save</button></>}</div>}
    {notice && <div className="writing-status-bar" role="status"><Check size={14} /><span>{notice}</span>{document.sourceId && <a href={`#/library?source=${encodeURIComponent(document.sourceId)}`}>Read published version <ArrowSquareOut size={12} /></a>}<button className="knowledge-icon-button" type="button" aria-label="Dismiss writing notice" onClick={() => setNotice('')}><X size={14} /></button></div>}
    {!writer && <p className="writing-status-bar">This tab is read only. Open the writing tab to make changes.</p>}
    <div className="writing-studio-layout"><div className="writing-canvas" data-background={draft.appearance.background} data-page-style={draft.appearance.pageStyle}>
      {quote && <QuoteCapture selection={quote.text} initialSource={draft.bookEditionId ? { bookId: draft.bookEditionId, locator:draft.chapter??'' } : undefined} origin={{ kind: 'writing', id: document.id, title: draft.title, authorship: 'unknown' }} onSaved={(id, text) => {
        const attached = editor && linkSavedQuote(editor, quote, id, text)
        setNotice(attached ? 'Quote saved and linked to this passage.' : 'Quote saved to your collection. The selected wording changed.')
      }} onClose={() => setQuote(null)} />}
      <RichEditor conceptActions={{ terms: topicOptions, resolve: createTopic, onQuote: setQuote }} key={editorEpoch} documentId={document.id} topics={topicOptions} content={draft.content} editable={writer && !preview && !historyBusy && !working} preview={preview} onChange={(content) => update({ content })} onReady={setEditor} onUpload={upload} header={<div className="writing-document-heading"><div className="writing-document-format"><select aria-label="Form of writing" value={draft.format} disabled={!writer || preview || historyBusy || !!working} onChange={(event) => update({ format: event.target.value as WritingFormat })}>{WRITING_FORMS.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select>{homeTopic && <a href={topicHref(homeTopic.id)}>Back to {homeTopic.label} <ArrowSquareOut size={11} /></a>}{draft.bookEditionId && <a href={`#/bookshelf?book=${encodeURIComponent(draft.bookEditionId)}`}>Linked bookshelf edition <ArrowSquareOut size={11} /></a>}{draft.basedOnSourceId && <a href={`#/library?source=${encodeURIComponent(draft.basedOnSourceId)}`}>Based on a retained source <ArrowSquareOut size={11} /></a>}{!preview && <button type="button" className="writing-credits-toggle" aria-expanded={showCredits} onClick={() => setShowCredits(!showCredits)}>{showCredits ? 'Close details' : 'Subtitle & byline'}</button>}</div><label className="knowledge-sr-only" htmlFor="writing-title">Document title</label><textarea id="writing-title" className="writing-document-title" rows={1} value={draft.title} placeholder="Title" readOnly={!writer || preview || historyBusy || !!working} maxLength={300} onChange={(event) => update({ title: event.target.value })} />{(showCredits || draft.subtitle) && <><label className="knowledge-sr-only" htmlFor="writing-subtitle">Document subtitle</label><textarea id="writing-subtitle" className="writing-document-subtitle" rows={1} value={draft.subtitle} placeholder={preview ? '' : 'Add a subtitle…'} readOnly={!writer || preview || historyBusy || !!working} maxLength={2000} onChange={(event) => update({ subtitle: event.target.value })} /></>}{(showCredits || draft.byline) && <label className="writing-document-byline"><span>By</span><input aria-label="Document author" value={draft.byline} placeholder={preview ? 'You' : 'Your name'} readOnly={!writer || preview || historyBusy || !!working} maxLength={300} onChange={(event) => update({ byline: event.target.value })} /></label>}</div>} footer={<div className="writing-document-end" aria-hidden="true"><span /></div>} />
    </div>{panel === 'research' ? <WritingResearch document={draft} editor={editor} update={update} onClose={() => setPanel(null)} disabled={!writer || preview || !!working || historyBusy} /> : panel === 'history' ? <WritingHistoryPanel document={draft} flush={flush} onBusyChange={setHistoryBusy} onRestored={(saved) => { reload(saved); setEditor(null); setEditorEpoch((value) => value + 1) }} onClose={() => setPanel(null)} /> : panel === 'design' ? <WritingDesign appearance={draft.appearance} update={(appearance) => update({ appearance })} onClose={() => setPanel(null)} onUploadBackground={backgroundFile} disabled={!writer || !!working || historyBusy} /> : panel === 'outline' ? <aside className="writing-design writing-outline" aria-label="Document outline"><header><h3><ListBullets size={17} />In this document</h3><button className="knowledge-icon-button" aria-label="Close document outline" onClick={() => setPanel(null)}><X size={18} /></button></header><p>Your headings become sections you can return to.</p>{outline.length ? outline.map((heading, index) => <button key={`${index}:${heading.text}`} style={{ paddingLeft: `${12 + Math.max(0, heading.level - 1) * 10}px` }} onClick={() => { if (editor && !editor.isDestroyed) editor.chain().focus().setTextSelection(heading.position).scrollIntoView().run() }}>{heading.text}</button>) : <p>Add a heading from the style menu to start an outline.</p>}</aside> : null}</div>
    <footer className="writing-studio-footer"><button type="button" aria-label="Toggle document outline" aria-pressed={panel === 'outline'} onClick={() => setPanel((value) => value === 'outline' ? null : 'outline')}><SidebarSimple size={15} />Outline</button><span>{words.toLocaleString()} {words === 1 ? 'word' : 'words'}<i />{Math.max(1, Math.ceil(words / 220))} min read</span>{document.sourceId && <a href={`#/library?source=${encodeURIComponent(document.sourceId)}`}>Published version <ArrowSquareOut size={12} /></a>}</footer>
  </section>
}
