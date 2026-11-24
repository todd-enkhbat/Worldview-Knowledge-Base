import { Activity, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode, type RefObject } from 'react'
import { ArrowUp, ArrowUpRight, CaretDown, FunnelSimple, Microphone, List, Moon, ShieldCheck, SidebarSimple, BookOpen, Books, CaretLeft, ChatCircle, Check, CheckSquare, ClockCounterClockwise, DownloadSimple, FileText, FolderOpen, GearSix, MagnifyingGlass, PencilSimple, Planet, Plus, Stack, Sun, TreeStructure, UploadSimple, X } from '@phosphor-icons/react'
import { useApp, useWorld } from '../app/store.ts'
import { useChat } from '../ai/chat/session.ts'
import { trapKeys } from '../hud/DurabilityKit.tsx'
import { CommandMenu, openCommandMenu } from './CommandMenu.tsx'
import { useAppearance, useCompactViewport } from './appearance.ts'
import { useAuth } from '../data/auth.ts'
import { getStore, getWorldGeneration, isRepoReady, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import { FirstRun } from '../hud/FirstRun.tsx'
import { Settings } from '../hud/Settings.tsx'
import { NodeEditor } from '../hud/NodeEditor.tsx'
import { Trash } from '../hud/Trash.tsx'
import { UndoToast } from '../hud/UndoToast.tsx'
import { Banners } from '../hud/Banners.tsx'
import { Chat } from '../hud/Chat.tsx'
import { Markdown } from '../hud/markdown.ts'
import { FileRow, EmbedsSection } from '../hud/NoteMedia.tsx'
import { editNode } from '../hud/shortcuts.ts'
import { recordDigest } from '../ai/chat/apply.ts'
import { cancelKnowledgeJob, captureThought, getSourceOriginal, importKnowledgeFiles, initializeKnowledge, readKnowledgePassage, resumeKnowledgeJob, reviewProposal, retryImport, searchKnowledge, setSourcePolicy, useKnowledge } from '../knowledge/index.ts'
import { exploreWorkspaceRecord, openWorkspaceRecord, rememberReaderPosition, rememberWorkspaceSection, selectWorkspaceRecord, setWorkspaceQuery, setWorkspaceSources, useWorkspace, workspaceHomeHash, workspaceScopeForAccount, type WorkspaceSection } from './state.ts'
import { flushWorkspacePersistence, initializeWorkspacePersistence, useWorkspacePersistence } from './persistence.ts'
import { libraryDestination } from './routes.ts'
import type { RetrievalEngine, SourceKind } from '../knowledge/types.ts'
import { VoiceEvidencePlayer } from '../capture/SourcesVoiceInbox.tsx'
import KnowledgePages from './KnowledgePages.tsx'
import { useRetrievalTrace } from '../knowledge/retrievalTrace.ts'
import { SourcesHub } from './SourcesHub.tsx'
import { Investigations, SaveInvestigation } from './Investigations.tsx'
import { passageLocator } from './evidence.ts'
import ReadingArchive from '../reading/ReadingArchive.tsx'
import AnnotatedReader from '../reading/AnnotatedReader.tsx'
import { isPdfVersion } from '../reading/pdfModel.ts'
import KnowledgeGraph from '../reading/KnowledgeGraph.tsx'
import TopicHome from '../reading/TopicHome.tsx'
import { initializeReading } from '../reading/store.ts'
import { createWritingFromSource, initializeWriting, useWriting } from '../writing/store.ts'
import { createBookFromSource, initializeBookshelf } from '../bookshelf/store.ts'
import { WorldviewMark } from './WorldviewMark.tsx'
import { AsciiOrbit } from './AsciiOrbit.tsx'
import './worldviewVisuals.css'
import './workbench.css'
import './workspace-polish.css'

const Bookshelf = lazy(() => import('../bookshelf/Bookshelf.tsx'))
const WritingStudio = lazy(() => import('../writing/WritingStudio.tsx'))

type Source = ReturnType<typeof useKnowledge.getState>['sources'][number]
type SearchHit = NonNullable<Awaited<ReturnType<typeof readKnowledgePassage>>>
type Receipt = Awaited<ReturnType<typeof importKnowledgeFiles>>
const date = (ms: number | null | undefined) => ms === null || ms === undefined ? 'Date unknown' : new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
const localDate = (ms: number | null | undefined) => ms === null || ms === undefined ? 'Date unknown' : new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

function openSettings() {
  const reader = document.querySelector<HTMLDivElement>('.knowledge-reader-content[data-reader-id]')
  if (reader?.dataset.readerId) rememberReaderPosition(reader.dataset.readerId, reader.scrollTop)
  void flushWorkspacePersistence()
  useApp.getState().togglePanel('settings', true)
}

const SECTIONS: { id: WorkspaceSection; label: string; icon: typeof Sun; description: string }[] = [
  { id: 'today', label: 'Today', icon: Sun, description: 'Capture a thought. Pick up a thread.' },
  { id: 'write', label: 'Writing studio', icon: PencilSimple, description: 'A page for your own words, in your own style.' },
  { id: 'search', label: 'Search & ask', icon: MagnifyingGlass, description: 'Find the passage. Follow the evidence.' },
  { id: 'library', label: 'Library', icon: BookOpen, description: 'Your original words and sources, in context.' },
  { id: 'bookshelf', label: 'Bookshelf', icon: Books, description: 'Books, articles, recommendations, and your reading life.' },
  { id: 'graph', label: 'Knowledge graph', icon: TreeStructure, description: 'Follow a connection. Build your own understanding.' },
  { id: 'topics', label: 'Projects & topics', icon: FolderOpen, description: 'Resume an investigation and follow the subjects that connect your record.' },
  { id: 'knowledge', label: 'Knowledge pages', icon: FileText, description: 'Review and maintain the understanding built from your sources.' },
  { id: 'review', label: 'Review', icon: CheckSquare, description: 'Inspect suggested connections before you keep them.' },
  { id: 'sources', label: 'Sources & activity', icon: Stack, description: 'Bring material in and see what happened to it.' },
]

function openSource(source: Source) {
  useWorkspace.setState({ selectedSourceId: source.id, selectedRecordId: source.nodeId ?? null, selectedPassageId: null })
  location.hash = `#/library?source=${encodeURIComponent(source.id)}`
}

function openPassage(hit: SearchHit) {
  useWorkspace.setState({ selectedRecordId: hit.nodeId ?? null, selectedSourceId: hit.sourceId, selectedPassageId: hit.id })
  location.hash = `#/library?passage=${encodeURIComponent(hit.id)}`
}

export default function Workbench({ section, hash }: { section: WorkspaceSection; hash: string }) {
  const ready = useWorld((s) => s.loaded && s.settings?.firstRunComplete === true)
  const repoReady = useRepoStatus((s) => s.ready)
  const writer = useRepoStatus((s) => s.writer)
  const fallback = useRepoStatus((s) => s.fallback)
  const error = useKnowledge((s) => s.error)
  const contextError = useWorkspacePersistence((s) => s.error)
  const authUser = useAuth((s) => s.user?.id)
  const chat = useApp((s) => s.panels.chat)
  const { appearance, theme, setAppearance } = useAppearance()
  const compact = useCompactViewport()
  const [visited, setVisited] = useState<WorkspaceSection[]>([section])
  const [worldGeneration, setWorldGeneration] = useState(getWorldGeneration)
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('worldview.sidebar.v1') === 'collapsed' } catch { return false } })
  const navigation = useRef<HTMLElement>(null)
  const quickCapture = useRef<HTMLElement>(null)
  const quickCaptureTrigger = useRef<HTMLButtonElement>(null)
  const pendingCapture = useRef(false)
  const navigationOpener = useRef<HTMLElement | null>(null)
  const panelPositions = useRef<Partial<Record<WorkspaceSection, number>>>({})
  const panelElements = useRef<Partial<Record<WorkspaceSection, HTMLDivElement>>>({})
  const allNodes = useWorld((state) => state.nodes)
  const allSources = useKnowledge((state) => state.sources)
  const recentNodes = useMemo(() => { const excluded = new Set(allSources.filter((source) => source.excluded || source.deleted).map((source) => source.nodeId)); return [...allNodes.values()].filter((node) => !excluded.has(node.id)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3) }, [allNodes, allSources])
  const proposals = useKnowledge((s) => s.proposals)
  const scope = useRef<string | null>(null)
  const capture = useRef<HTMLTextAreaElement>(null)
  const waitingForSetup = useRef(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (repoReady && !ready) waitingForSetup.current = true
    if (!ready || !waitingForSetup.current) return
    waitingForSetup.current = false
    // The shared onboarding's legacy world action opens chat. Daily capture has its own
    // local form, so the first ready frame should land there rather than in an AI prompt.
    const frame = requestAnimationFrame(() => {
      useApp.getState().togglePanel('chat', false)
      if (section !== 'today') location.hash = '#/today'
      pendingCapture.current = true
      capture.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [repoReady, ready, section])

  useEffect(() => {
    if (!repoReady) return
    const nextScope = workspaceScopeForAccount(authUser, location.search, import.meta.env.DEV)
    if (scope.current === nextScope) return
    scope.current = nextScope
    void initializeWorkspacePersistence(nextScope).then(() => {
      if (!location.hash || location.hash === '#/' || location.hash === '#') location.replace(workspaceHomeHash())
    })
    void initializeKnowledge().catch((e) => setNotice(message(e)))
    void initializeReading().catch((e) => setNotice(message(e)))
    void initializeWriting().catch((e) => setNotice(message(e)))
    void initializeBookshelf().catch((e) => setNotice(message(e)))
  }, [repoReady, authUser])
  useEffect(() => { if (repoReady) rememberWorkspaceSection(section); setVisited((previous) => previous.includes(section) ? previous : [...previous, section]) }, [section, repoReady])
  useEffect(() => subscribeRepo((change) => {
    if (change.type !== 'wipe' && change.type !== 'import') return
    setWorldGeneration(getWorldGeneration())
    setVisited([section])
    panelPositions.current = {}
    setNavigationOpen(false)
  }), [section])
  useEffect(() => {
    if (section !== 'library') return
    const destination = libraryDestination(hash)
    if (destination.passageId) useWorkspace.setState({ selectedPassageId: destination.passageId, selectedSourceId: null, selectedRecordId: null })
    else if (destination.sourceId) useWorkspace.setState({ selectedSourceId: destination.sourceId, selectedPassageId: null, selectedRecordId: null })
    else if (destination.recordId) selectWorkspaceRecord(destination.recordId)
    else selectWorkspaceRecord(null)
  }, [hash, section])
  function focusCapture() {
    pendingCapture.current = true
    setNavigationOpen(false)
    if (section === 'today' && !navigationOpen) { capture.current?.focus(); pendingCapture.current = false }
    else location.hash = '#/today'
  }
  useEffect(() => {
    const captureIntent = () => { pendingCapture.current = true; setNavigationOpen(false); if (location.hash.split('?')[0] === '#/today') { if (!navigationOpen) { capture.current?.focus(); pendingCapture.current = false } } else location.hash = '#/today' }
    const commands = () => { setNavigationOpen(false); if (compact && chat) useApp.getState().togglePanel('chat', false) }
    const key = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open], [aria-modal="true"]')) return
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'n') { event.preventDefault(); captureIntent() }
      if (event.key === 'Escape' && chat && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) useApp.getState().togglePanel('chat', false)
    }
    window.addEventListener('keydown', key)
    window.addEventListener('worldview:capture', captureIntent)
    window.addEventListener('worldview:commands', commands)
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('worldview:capture', captureIntent); window.removeEventListener('worldview:commands', commands) }
  }, [chat, navigationOpen, compact])
  useLayoutEffect(() => {
    const panel = panelElements.current[section]
    if (panel) panel.scrollTop = panelPositions.current[section] ?? 0
    if (section !== 'today' || !ready || !pendingCapture.current || compact && navigationOpen) return
    const frame = requestAnimationFrame(() => { capture.current?.focus(); pendingCapture.current = false })
    return () => cancelAnimationFrame(frame)
  }, [section, ready, navigationOpen, compact])
  useEffect(() => {
    if (!navigationOpen || !compact) return
    navigationOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    navigation.current?.querySelector<HTMLButtonElement>('.knowledge-close-navigation')?.focus()
    return () => { if (navigationOpener.current?.isConnected) navigationOpener.current.focus() }
  }, [navigationOpen, compact])
  useEffect(() => { if (!compact) setNavigationOpen(false) }, [compact])
  useEffect(() => {
    if (!chat) return
    if (compact) setNavigationOpen(false)
    const trigger = quickCaptureTrigger.current
    return () => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }) }
  }, [chat, compact])
  function toggleNavigation() {
    if (compact) setNavigationOpen((open) => !open)
    else setCollapsed((old) => { const next = !old; try { localStorage.setItem('worldview.sidebar.v1', next ? 'collapsed' : 'expanded') } catch { /* Device preference is optional. */ }; return next })
  }
  const active = SECTIONS.find((item) => item.id === section)!
  const panel = (id: WorkspaceSection, children: ReactNode, preserve = false) => preserve && visited.includes(id) || section === id ? <Activity key={`${id}:${worldGeneration}`} mode={section === id ? 'visible' : 'hidden'}><div id={`knowledge-section-${id}`} data-section={id} className={`knowledge-page ${id === 'library' ? 'is-reader' : ''}`} ref={(element) => { if (element) panelElements.current[id] = element; else delete panelElements.current[id] }} onScroll={(event) => { panelPositions.current[id] = event.currentTarget.scrollTop }}>{children}</div></Activity> : null
  return <div data-theme={theme} className={`knowledge-workbench ${chat ? 'with-companion' : ''} ${collapsed && !compact ? 'is-nav-collapsed' : ''} ${navigationOpen ? 'is-nav-open' : ''}`}>
    <a className="knowledge-skip" href="#knowledge-main" onClick={(event) => { event.preventDefault(); document.getElementById('knowledge-main')?.focus() }}>Skip to workspace</a>
    {compact && navigationOpen && <button className="knowledge-nav-scrim" type="button" aria-label="Close navigation" tabIndex={-1} onClick={() => setNavigationOpen(false)} />}
    <aside ref={navigation} className="knowledge-nav" aria-label="Workspace navigation" role={compact && navigationOpen && !chat ? 'dialog' : undefined} aria-modal={compact && navigationOpen && !chat ? true : undefined} inert={compact && (!navigationOpen || chat) ? true : undefined} onKeyDown={(event) => { if (compact && navigationOpen) trapKeys(event, navigation.current, () => setNavigationOpen(false)) }}>
      <div className="knowledge-brand-row"><a className="knowledge-brand" href="#/today" aria-label="Worldview home" onClick={() => setNavigationOpen(false)}><WorldviewMark /><span>Worldview</span></a><button type="button" className="knowledge-icon-button knowledge-close-navigation" aria-label="Close navigation" onClick={() => setNavigationOpen(false)}><X size={20} /></button></div>
      <button type="button" className="knowledge-capture-shortcut" aria-label="Capture a thought" title="New thought (⌘/Ctrl+Shift+N)" onClick={focusCapture}><Plus size={18} /><span>New thought</span><kbd>⇧⌘ N</kbd></button>
      <button type="button" className="knowledge-command-shortcut" aria-label="Search and commands" title="Search and commands (⌘/Ctrl+K)" onClick={openCommandMenu}><MagnifyingGlass size={17} /><span>Search anything</span><kbd>⌘ K</kbd></button>
      <nav aria-label="Workspace sections">{SECTIONS.map(({ id, label, icon: Icon }) => <a key={id} href={`#/${id}`} title={collapsed ? label : undefined} onClick={() => setNavigationOpen(false)} aria-label={label} aria-current={section === id ? 'page' : undefined}><Icon size={19} weight={section === id ? 'fill' : 'regular'} /><span>{label}</span>{id === 'review' && proposals.some((proposal) => proposal.status === 'proposed') && <small>{proposals.filter((proposal) => proposal.status === 'proposed').length}</small>}</a>)}</nav>
      {recentNodes.length > 0 && <div className="knowledge-nav-recents"><h2>Recent</h2>{recentNodes.map((node) => <button key={node.id} type="button" onClick={() => { openWorkspaceRecord(node.id); setNavigationOpen(false) }} title={node.title}><FileText size={15} /><span>{node.title}</span></button>)}</div>}
      <div className="knowledge-nav-bottom"><AsciiOrbit /><a className="knowledge-explore-link" href="#/explore" aria-label="Explore in 3D" title="Explore in 3D"><Planet size={19} /><span>Explore in 3D</span><ArrowUpRight size={14} /></a><button type="button" onClick={openSettings} aria-label="Settings and backups" title="Settings and backups"><GearSix size={18} /><span>Settings & backups</span></button><label className="knowledge-theme-control" title="Appearance">{theme === 'dark' ? <Moon size={17} /> : <Sun size={17} />}<span className="knowledge-sr-only">Appearance</span><select aria-label="Appearance" value={appearance} onChange={(event) => setAppearance(event.target.value as typeof appearance)}><option value="system">System theme</option><option value="dark">Dark theme</option><option value="light">Light theme</option></select></label><span className="knowledge-storage"><ShieldCheck size={13} />{fallback ? 'Session only' : writer ? 'Local workspace' : 'Read only'}</span></div>
    </aside>
    <div className="knowledge-center" inert={compact && (navigationOpen || chat) ? true : undefined}>
      <header className="knowledge-top"><div className="knowledge-top-location"><button type="button" className="knowledge-icon-button" aria-label={compact ? 'Open navigation' : collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={compact ? navigationOpen : !collapsed} onClick={toggleNavigation}>{compact ? <List size={21} /> : <SidebarSimple size={20} />}</button><h1>{active.label}</h1><span className="knowledge-top-description knowledge-sr-only">{active.description}</span></div><div className="knowledge-top-actions"><span className="knowledge-local-label"><ShieldCheck size={14} />Local</span><button ref={quickCaptureTrigger} type="button" className={`knowledge-button knowledge-quick-capture ${chat ? 'is-active' : ''}`} aria-label={chat ? 'Close quick capture' : 'Open quick capture'} aria-pressed={chat} onClick={() => useApp.getState().togglePanel('chat')}><ChatCircle size={18} /><span>Quick capture</span></button></div></header>
      <div className="knowledge-banners"><Banners />{(notice || error || contextError) && <div className={`knowledge-notice ${error || contextError ? 'is-error' : ''}`} role={error || contextError ? 'alert' : 'status'}><span>{error || contextError || notice}</span>{notice && !error && !contextError && <button type="button" aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={16} /></button>}</div>}</div>
      <main id="knowledge-main" className="knowledge-main" tabIndex={-1}>
        {!ready ? <div className="knowledge-loading" role="status">{repoReady ? 'Set up your workspace to begin.' : 'Opening your saved record…'}</div> : <>
          {panel('today', <Today captureRef={capture} />, true)}
          {panel('write', <Suspense fallback={<div className="knowledge-empty" role="status">Opening your writing desk…</div>}><WritingStudio hash={hash} /></Suspense>, true)}
          {panel('search', <Search />, true)}
          {panel('library', <Library hash={hash} />, true)}
          {panel('bookshelf', <Suspense fallback={<div className="knowledge-empty" role="status">Opening your bookshelf…</div>}><Bookshelf hash={hash} /></Suspense>, true)}
          {panel('graph', <KnowledgeGraph initialSourceId={new URLSearchParams(hash.split('?')[1] ?? '').get('source') ?? undefined} initialTopicId={new URLSearchParams(hash.split('?')[1] ?? '').get('topic') ?? undefined} />, true)}
          {panel('topics', new URLSearchParams(hash.split('?')[1] ?? '').get('view') === 'projects' ? <Topics /> : <TopicHome hash={hash} />)}
          {panel('knowledge', <KnowledgePages hash={hash} />)}
          {panel('review', <Review />)}
          {panel('sources', <Sources key={authUser ?? 'local'} hash={hash} />)}
        </>}
      </main>
    </div>
    {chat && <aside ref={quickCapture} className="knowledge-companion" aria-label="Quick capture" role={compact ? 'dialog' : undefined} aria-modal={compact ? true : undefined} onClick={(event) => { if (compact && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0 && event.target instanceof Element && event.target.closest('a[href^="#/"]')) useApp.getState().togglePanel('chat', false) }} onKeyDown={(event) => { if (compact) trapKeys(event, quickCapture.current, () => useApp.getState().togglePanel('chat', false)) }}><Chat key={worldGeneration} embedded /></aside>}
    <CommandMenu /><FirstRun /><Settings /><NodeEditor /><Trash /><UndoToast />
  </div>
}

function Today({ captureRef }: { captureRef: RefObject<HTMLTextAreaElement | null> }) {
  const draft = useWorkspace((s) => s.draft)
  const writer = useRepoStatus((s) => s.writer)
  const nodes = useWorld((s) => s.nodes)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState<string | null>(null)
  const sources = useKnowledge((s) => s.sources)
  const recent = useMemo(() => { const excluded = new Set(sources.filter((s) => s.excluded || s.deleted).map((s) => s.nodeId)); return [...nodes.values()].filter((n) => !excluded.has(n.id)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5) }, [nodes, sources])
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!draft.trim() || saving || !writer || !isRepoReady()) return
    const submitted = draft, store = getStore(), generation = getWorldGeneration()
    const current = () => isRepoReady() && getStore() === store && getWorldGeneration() === generation
    setSaving(true); setError('')
    try {
      const note = await captureThought(submitted)
      if (!current()) return
      useWorkspace.setState((state) => ({ draft: state.draft === submitted ? '' : state.draft }))
      setSaved(note.id)
      if (location.hash.split('?')[0] === '#/today') captureRef.current?.focus()
    } catch (failure) { if (current()) setError(message(failure)) }
    finally { setSaving(false) }
  }
  const shortcut = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl'
  return <div className="knowledge-today">
    <section className="knowledge-capture"><div className="knowledge-today-heading"><span className="knowledge-eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span><h2>What’s on your mind?</h2><p>A thought, a question, something worth keeping.</p></div><div className="knowledge-writing-modes" aria-label="Writing mode"><span><ChatCircle size={14} />Quick thought</span><a href="#/write"><PencilSimple size={14} />Writing studio <ArrowUpRight size={12} /></a></div><form onSubmit={(event) => void save(event)}><label className="knowledge-sr-only" htmlFor="knowledge-thought">Capture a thought</label><textarea id="knowledge-thought" ref={captureRef} value={draft} onChange={(event) => useWorkspace.setState({ draft: event.target.value })} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder="Start writing. Your words belong here…" rows={4} /><div className="knowledge-capture-footer"><div className="knowledge-capture-add"><ImportButton compact /><a className="knowledge-capture-voice" href="#/sources?connection=voice"><Microphone size={17} /><span>Voice note</span></a></div><button className="knowledge-button is-primary knowledge-save-thought" disabled={!writer || saving || !draft.trim()} type="submit"><span>{saving ? 'Saving…' : 'Save thought'}</span><ArrowUp size={16} /></button></div></form><div className="knowledge-composer-caption"><span><ShieldCheck size={13} />Saved in your words. No cloud AI needed.</span><span><kbd>{shortcut}</kbd><kbd>↵</kbd> to save</span></div>{error && <p className="knowledge-error" role="alert">{error}</p>}{saved && <p className="knowledge-saved" role="status"><Check size={16} />Saved to your record. <button type="button" onClick={() => openWorkspaceRecord(saved)}>Read it</button></p>}</section>
    <section className="knowledge-section knowledge-recent-section"><div className="knowledge-section-title"><h2>Pick up a thread</h2><a href="#/library">Open library <ArrowUpRight size={13} /></a></div>{recent.length ? <div className="knowledge-record-list">{recent.map((node) => <button type="button" key={node.id} onClick={() => openWorkspaceRecord(node.id)}><span className="knowledge-record-glyph"><FileText size={18} /></span><span><strong>{node.title}</strong><small>{node.contentMd.replace(/[#*_`]/g, '').slice(0, 135) || node.archetype}</small></span><time>{localDate(node.updatedAt)}</time><ArrowUpRight className="knowledge-record-arrow" size={16} /></button>)}</div> : <Empty icon={<BookOpen size={27} />} title="Your record starts with one thought" text="Write something above, or bring in files and conversations. Everything you keep stays readable without an AI service." />}</section>
    <div className="knowledge-today-bottom"><span>Your words. Your sources. Your own point of view.</span><a href="#/explore"><Planet size={16} />Explore your world <ArrowUpRight size={13} /></a></div>
  </div>
}

function ImportButton({ compact = false, folder = false, onReceipt }: { compact?: boolean; folder?: boolean; onReceipt?: (r: Receipt) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const writer = useRepoStatus((s) => s.writer)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (folder) input.current?.setAttribute('webkitdirectory', '') }, [folder])
  async function picked(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    if (!files.length || busy) return
    setBusy(true); setError('')
    try { const receipt = await importKnowledgeFiles(files); onReceipt?.(receipt) } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  return <div className="knowledge-import-control"><button type="button" className={`knowledge-button ${compact ? '' : 'is-primary'}`} disabled={!writer || busy} onClick={() => input.current?.click()}><UploadSimple size={17} />{busy ? 'Importing…' : folder ? 'Import folder' : 'Import files'}</button><input type="file" multiple hidden ref={input} aria-label={folder ? 'Choose folder to import' : 'Choose files to import'} onChange={(e) => void picked(e)} />{error && <p className="knowledge-error" role="alert">{error}</p>}</div>
}

function SourceScope() {
  const sources = useKnowledge((s) => s.sources)
  const ids = useWorkspace((s) => s.sourceIds)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState(''), [visible, setVisible] = useState(100)
  const available = sources.filter((s) => !s.excluded && !s.deleted && s.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
  return <div className="knowledge-scope"><button className="knowledge-button" aria-expanded={open} onClick={() => setOpen(!open)}><Stack size={17} />{ids.length ? `${ids.length} selected ${ids.length === 1 ? 'source' : 'sources'}` : 'All sources'}</button>{open && <fieldset className="knowledge-scope-options"><legend>Search source scope</legend><label>Find sources<input value={filter} onChange={(e) => { setFilter(e.target.value); setVisible(100) }} /></label><button className="knowledge-text-button" onClick={() => setWorkspaceSources([])}>Use all sources</button>{available.length ? available.slice(0, visible).map((source) => <label key={source.id}><input type="checkbox" checked={ids.includes(source.id)} onChange={(e) => setWorkspaceSources(e.target.checked ? [...ids, source.id] : ids.filter((id) => id !== source.id))} /><span>{source.title}</span></label>) : <p>No matching sources.</p>}{available.length > visible && <button type="button" className="knowledge-text-button" onClick={() => setVisible((n) => n + 100)}>Show more sources</button>}</fieldset>}</div>
}

function Search() {
  const cloudEnabled = useChat((state) => state.cloudAi === 'enabled')
  const trace = useRetrievalTrace((s) => s.run)
  const engine = useWorkspace((s) => s.retrievalEngine)
  const query = useWorkspace((s) => s.query)
  const scope = useWorkspace((s) => s.sourceIds)
  const role = useWorkspace((s) => s.role)
  const sourceKind = useWorkspace((s) => s.sourceKind)
  const authoredAfter = useWorkspace((s) => s.authoredAfter)
  const authoredBefore = useWorkspace((s) => s.authoredBefore)
  const revision = useKnowledge((s) => s.revision)
  const sources = useKnowledge((s) => s.sources)
  const input = useRef<HTMLInputElement>(null)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => {
    let current = true
    if (authoredAfter && authoredBefore && authoredAfter > authoredBefore) { setHits([]); setBusy(false); setError('Choose a start date on or before the end date.'); return }
    if (!query.trim()) { setHits([]); setBusy(false); return }
    setBusy(true); setError('')
    const timer = window.setTimeout(() => {
      void searchKnowledge(query, { engine, sourceIds: scope.length ? scope : undefined, role: role === 'all' ? undefined : role, kinds: sourceKind === 'all' ? undefined : [sourceKind as SourceKind], authoredAfter: authoredAfter ? new Date(`${authoredAfter}T00:00:00Z`).getTime() : undefined, authoredBefore: authoredBefore ? new Date(`${authoredBefore}T23:59:59.999Z`).getTime() : undefined, limit: 50 }).then((results) => { if (current) setHits(results) }).catch((e) => { if (current) { setHits([]); setError(message(e)) } }).finally(() => { if (current) setBusy(false) })
    }, 140)
    return () => { current = false; clearTimeout(timer) }
  }, [query, scope, role, sourceKind, authoredAfter, authoredBefore, revision, engine])
  const eligible = new Set(sources.filter((s) => !s.excluded && !s.deleted).map((s) => s.id))
  const displayedHits = hits.filter((hit) => eligible.has(hit.sourceId))
  return <div className="knowledge-search-view"><form className="knowledge-search-form" onSubmit={(e) => { e.preventDefault(); input.current?.blur() }}><MagnifyingGlass size={23} /><label className="knowledge-sr-only" htmlFor="knowledge-search">Search your record</label><input id="knowledge-search" ref={input} value={query} placeholder="Find an idea, an exact phrase, or a past decision…" onChange={(e) => setWorkspaceQuery(e.target.value)} autoComplete="off" />{query && <button type="button" aria-label="Clear search" onClick={() => setWorkspaceQuery('')}><X size={18} /></button>}</form><div className="knowledge-search-toolbar"><SourceScope /><div className="knowledge-search-investigation-actions"><SaveInvestigation />{cloudEnabled && <button className="knowledge-button" onClick={() => useApp.getState().togglePanel('chat', true)}><ChatCircle size={17} />Ask about these sources</button>}</div></div><details className="knowledge-search-filter-panel"><summary><FunnelSimple size={15} /><span>Filters & search engine</span><CaretDown size={14} /></summary><div className="knowledge-search-filters"><label>Search engine<select aria-label="Search engine" value={engine} onChange={(e) => useWorkspace.setState({ retrievalEngine: e.target.value as RetrievalEngine })}><option value="local">App search</option><option value="qmd-lexical">QMD · lexical</option><option value="qmd-hybrid">QMD · hybrid</option></select></label><label>Authorship<select aria-label="Filter by authorship" value={role} onChange={(e) => useWorkspace.setState({ role: e.target.value as typeof role })}><option value="all">All authors</option><option value="human">Human</option><option value="assistant">Assistant</option><option value="third-party">Third party</option><option value="unknown">Unknown</option></select></label><label>Source type<select aria-label="Filter by source type" value={sourceKind} onChange={(e) => useWorkspace.setState({ sourceKind: e.target.value })}><option value="all">All types</option>{['thought', 'document', 'chatgpt', 'claude', 'obsidian', 'legacy', 'conversation'].map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label><label>From<input type="date" aria-label="Source date from" value={authoredAfter} max={authoredBefore || undefined} onChange={(e) => useWorkspace.setState({ authoredAfter: e.target.value })} /></label><label>Through<input type="date" aria-label="Source date through" value={authoredBefore} min={authoredAfter || undefined} onChange={(e) => useWorkspace.setState({ authoredBefore: e.target.value })} /></label></div></details><p className="knowledge-search-caption">{engine === 'local' ? 'Search saved words and original passages. Use quotes for an exact phrase.' : 'QMD runs locally over the sources enabled in Sources & activity. Only included sources with AI access are indexed; relevance does not establish evidence support.'}{cloudEnabled ? ' The companion follows the same search scope.' : ''}</p>{error && <p className="knowledge-error" role="alert">{error}</p>}{trace && trace.query === query && <details className="knowledge-retrieval-trace"><summary>How these results were found · {trace.mode} · {Math.round(trace.timingsMs.total)} ms</summary><p>Relevance ranks matches; evidence support has not been assessed. {trace.coverage.indexedSources}/{trace.coverage.includedSources} included sources have indexed text. {trace.coverage.unindexedSourceIds.length} sources have no searchable text.</p><pre>{JSON.stringify({ scope: trace.filters, revision: trace.revision, model: trace.model, timingsMs: trace.timingsMs, normalizedQuery: trace.normalizedQuery, results: displayedHits.map((h) => ({ passageId: h.id, version: h.versionId, trace: h.trace })) }, null, 2)}</pre></details>}<div aria-live="polite" className="knowledge-search-count">{busy ? 'Searching your record…' : query.trim() ? `${displayedHits.length}${displayedHits.length === 50 ? '+' : ''} ${displayedHits.length === 1 ? 'passage' : 'passages'} found` : ''}</div>{!query.trim() ? <Empty icon={<MagnifyingGlass size={29} />} title="Find the words behind an idea" text="Search by subject or exact wording. Open any result to inspect the original passage, its author, and source history." /> : !busy && !displayedHits.length ? <Empty icon={<FileText size={27} />} title="No matching evidence found" text="Try fewer words, a quoted phrase, or a wider source selection. Sources that have not been indexed are listed in Sources & activity." /> : <div className="knowledge-search-results">{displayedHits.map((hit) => <button key={hit.id} className="knowledge-search-result" onClick={() => openPassage(hit)}><div><span className="knowledge-kind">{hit.role === 'human' ? 'Human' : hit.role === 'assistant' ? 'Assistant' : hit.role === 'third-party' ? 'Third party' : 'Authorship unknown'}</span><span>{hit.authoredAt ? date(hit.authoredAt) : ''}</span></div><h2>{hit.title}</h2><p>{hit.text}</p><span className="knowledge-result-open">Read passage in context</span></button>)}</div>}</div>
}

function Library({ hash }: { hash: string }) {
  const selected = useWorkspace((s) => s.selectedRecordId)
  const passageId = useWorkspace((s) => s.selectedPassageId)
  const sourceId = useWorkspace((s) => s.selectedSourceId)
  const hasSelection = Boolean(selected || passageId || sourceId)
  return <div className={`knowledge-library reading-library ${hasSelection ? 'has-selection' : ''}`}>
    <Activity mode={hasSelection ? 'hidden' : 'visible'}><ReadingArchive importAction={<ImportButton compact />} onOpenSource={(id) => { useWorkspace.setState({ selectedSourceId: id, selectedRecordId: null, selectedPassageId: null }); location.hash = `#/library?source=${encodeURIComponent(id)}` }} onOpenRecord={openWorkspaceRecord} /></Activity>
    <Activity mode={hasSelection ? 'visible' : 'hidden'}><Reader hash={hash} /></Activity>
  </div>
}

function Reader({ hash }: { hash: string }) {
  const sources = useKnowledge((s) => s.sources)
  const versions = useKnowledge((s) => s.versions)
  const passages = useKnowledge((s) => s.passages)
  const revision = useKnowledge((s) => s.revision)
  const proposals = useKnowledge((s) => s.proposals)
  const nodes = useWorld((s) => s.nodes)
  const selectedRecord = useWorkspace((s) => s.selectedRecordId)
  const selectedSource = useWorkspace((s) => s.selectedSourceId)
  const selectedPassage = useWorkspace((s) => s.selectedPassageId)
  const writer = useRepoStatus((s) => s.writer)
  const writingDocs = useWriting((s) => s.docs)
  const content = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const lastScrollSave = useRef(0)
  const trailingScrollSave = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [evidence, setEvidence] = useState<SearchHit | null>(null)
  const [error, setError] = useState('')
  const [stale, setStale] = useState(false)
  const [versionId, setVersionId] = useState<string | null>(null)
  const priorSelection = useRef<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [openingWriting, setOpeningWriting] = useState(false)
  const selectedEvidence = passages.find((p) => p.id === selectedPassage)
  const source = sources.find((s) => s.id === (selectedEvidence?.sourceId ?? selectedSource) || selectedRecord !== null && s.nodeId === selectedRecord)
  const nodeId = selectedRecord ?? source?.nodeId ?? selectedEvidence?.nodeId
  const node = nodeId ? nodes.get(nodeId) : undefined
  const sourceVersions = versions.filter((v) => v.sourceId === source?.id).sort((a, b) => b.createdAt - a.createdAt)
  const requestedVersionId = new URLSearchParams(hash.split('?')[1] ?? '').get('version')
  const requestedVersion = versions.find((entry) => entry.id === requestedVersionId && entry.sourceId === source?.id)
  const version = versions.find((v) => v.id === (versionId ?? requestedVersion?.id ?? selectedEvidence?.versionId ?? source?.currentVersionId) && v.sourceId === source?.id)
  const readingId = versionId ?? selectedPassage ?? version?.id ?? node?.id ?? source?.id ?? ''
  const title = source?.title ?? node?.title
  const text = version?.text ?? node?.contentMd ?? ''
  const hasTitle = Boolean(title)
  const ownWriting = source ? writingDocs.find((entry) => !entry.archivedAt && entry.sourceId === source.id) : undefined
  useEffect(() => { if (hasTitle) heading.current?.focus({ preventScroll: true }) }, [selectedRecord, selectedSource, selectedPassage, hasTitle])
  useLayoutEffect(() => { const identity = JSON.stringify([selectedRecord, selectedSource, selectedPassage, requestedVersionId]); if (priorSelection.current === identity) return; priorSelection.current = identity; setVersionId(null); setError(''); setStale(false); setEvidence(null) }, [selectedRecord, selectedSource, selectedPassage, requestedVersionId])
  useEffect(() => {
    let current = true
    if (!selectedPassage) return
    void readKnowledgePassage(selectedPassage, { includeHistory: true }).then((hit) => { if (current) { setEvidence(hit); if (!hit) setError('This passage is no longer available under the current source policy.') } }).catch((e) => { if (current) setError(message(e)) })
    return () => { current = false }
  }, [selectedPassage, revision])
  useEffect(() => {
    const digest = libraryDestination(hash).digest
    let current = true
    if (digest && node) void recordDigest(node).then((actual) => { if (current) setStale(actual !== digest) }).catch((e) => { if (current) setError(message(e)) })
    return () => { current = false }
  }, [hash, node])
  useEffect(() => {
    const el = content.current
    if (!el) return
    if (selectedPassage && evidence) el.querySelector('[data-evidence]')?.scrollIntoView?.({ block: 'center' })
    else el.scrollTop = useWorkspace.getState().readerPositions[readingId] ?? 0
    return () => { if (trailingScrollSave.current) clearTimeout(trailingScrollSave.current); if (readingId) rememberReaderPosition(readingId, el.scrollTop) }
  }, [readingId, evidence, selectedPassage])
  const related = node ? proposals.filter((p) => p.status !== 'rejected' && (p.sourceNodeId === node.id || p.targetNodeId === node.id)) : []
  async function download() {
    if (!source) return
    setDownloading(true); setError('')
    try {
      const original = await getSourceOriginal(source.id, version?.id)
      if (!original) throw new Error('The original file is unavailable.')
      const url = URL.createObjectURL(original.blob)
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = original.name; anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) { setError(message(e)) } finally { setDownloading(false) }
  }
  async function addToBookshelf() {
    if (!source) return
    const store = getStore(), generation = getWorldGeneration()
    setOpeningWriting(true); setError('')
    try { const book = await createBookFromSource(source.id); if (isRepoReady() && getStore() === store && getWorldGeneration() === generation) location.hash = `#/bookshelf?book=${encodeURIComponent(book.id)}` }
    catch (cause) { setError(message(cause)) } finally { setOpeningWriting(false) }
  }
  async function openWriting() {
    if (!source) return
    if (ownWriting) { location.hash = `#/write?doc=${encodeURIComponent(ownWriting.id)}`; return }
    const store = getStore(), generation = getWorldGeneration()
    setOpeningWriting(true); setError('')
    try { const saved = await createWritingFromSource(source.id); if (isRepoReady() && getStore() === store && getWorldGeneration() === generation) location.hash = `#/write?doc=${encodeURIComponent(saved.id)}` }
    catch (cause) { setError(message(cause)) } finally { setOpeningWriting(false) }
  }
  if (!title && !selectedPassage) return <section className="knowledge-reader"><Empty icon={<BookOpen size={30} />} title="Read the things themselves" text="Choose a record to read its original text, follow supporting evidence, or explore where it belongs in your world." /></section>
  if (source?.excluded || source?.deleted) return <section className="knowledge-reader"><Empty icon={<FileText size={28} />} title="This source is excluded" text="It is not available in your library or search. Change its policy in Sources & activity to include it again." /></section>
  return <article className="knowledge-reader" aria-label="Record reader"><header className="knowledge-reader-header"><button className="knowledge-reader-back knowledge-text-button" onClick={() => { selectWorkspaceRecord(null); location.hash = '#/library'; requestAnimationFrame(() => document.getElementById('library-filter')?.focus()) }}><CaretLeft size={16} />Library</button><div className="knowledge-reader-kicker"><span>{source?.kind ?? node?.archetype ?? 'Source passage'}</span><span>{version ? version.authoredAt !== null ? `Source date (UTC): ${date(version.authoredAt)}` : `Recorded ${localDate(version.createdAt)} · authored date unknown` : `History date (UTC): ${date(node?.temporalOrigin)}`}</span></div><h2 ref={heading} tabIndex={-1}>{title ?? 'Source passage'}</h2><div className="knowledge-reader-actions">{node && <button className="knowledge-button" onClick={() => { useApp.getState().select(node.id); exploreWorkspaceRecord(node.id) }}><Planet size={17} />Explore this record</button>}{node && <button className="knowledge-button" disabled={!writer} onClick={() => editNode(node.id)}>Edit note</button>}{source && <button className="knowledge-button" disabled={!writer || openingWriting} onClick={() => void addToBookshelf()}><Books size={17} />Add to bookshelf</button>}{source && <button className="knowledge-button" disabled={!writer || openingWriting} onClick={() => void openWriting()}><PencilSimple size={16} />{openingWriting ? 'Opening…' : ownWriting ? 'Edit document' : 'Edit a copy'}</button>}{source && <button className="knowledge-button" disabled={downloading} onClick={() => void download()}><DownloadSimple size={17} />{downloading ? 'Opening…' : 'Original file'}</button>}</div>{sourceVersions.length > 0 && <label className="knowledge-version"><ClockCounterClockwise size={15} /><span>Version</span><select aria-label="Source version" value={version?.id ?? ''} onChange={(e) => setVersionId(e.target.value)}>{sourceVersions.map((v, i) => <option key={v.id} value={v.id}>{localDate(v.createdAt)} · {v.origin}{i === 0 ? ' · current' : ''}</option>)}</select></label>}</header><div ref={content} className="knowledge-reader-content" data-reader-id={readingId} onScroll={(e) => { const now = performance.now(); const top = e.currentTarget.scrollTop; if (trailingScrollSave.current) clearTimeout(trailingScrollSave.current); if (now - lastScrollSave.current >= 200) { lastScrollSave.current = now; rememberReaderPosition(readingId, top) } trailingScrollSave.current = setTimeout(() => rememberReaderPosition(readingId, top), 180) }}>{version && source && version.id !== source.currentVersionId && <p className="knowledge-notice" role="status">You are reading an earlier retained source version.</p>}{stale && <p className="knowledge-notice" role="status">This note has changed since that reference was created. You are reading its current wording.</p>}{error && <p className="knowledge-error" role="alert">{error}</p>}{evidence && evidence.versionId === version?.id && <section className="knowledge-evidence" data-evidence><span className="knowledge-eyebrow">Cited passage · {evidence.role} · {date(evidence.authoredAt)}</span><blockquote>{evidence.text}</blockquote><small>{passageLocator(evidence, version)} · characters {evidence.start + 1}–{evidence.end} of this retained source version</small></section>}{source && <VoiceEvidencePlayer sourceId={source.id} passageId={evidence?.id} />}<div className="knowledge-reader-provenance"><FileText size={15} /><span>{version ? 'Retained source text. Generated connections are shown separately below.' : 'Saved note text. Earlier original provenance may be unavailable.'}</span></div>{text || version && isPdfVersion(version) ? <>{source && version ? <AnnotatedReader key={source.id} source={source} version={version} scrollRef={content} onReadVersion={setVersionId} /> : <Markdown source={text} className="knowledge-prose" />}</> : <p className="knowledge-list-empty">This file is retained as an original. Its contents have not been indexed as readable text.</p>}{node?.attachments.map((attachment) => <FileRow key={attachment.id} attachment={attachment} nodeId={node.id} canWrite={writer} />)}{node?.embeds?.length ? <EmbedsSection embeds={node.embeds} nodeId={node.id} canWrite={writer} /> : null}{related.length > 0 && <section className="knowledge-related"><h3>Connections and their evidence</h3>{related.slice(0, 12).map((p) => <div key={p.id}><span className="knowledge-kind">{p.status === 'accepted' ? 'Accepted relationship' : 'Suggested relationship'}</span><strong>{p.title}</strong><p>{p.explanation}</p><div className="knowledge-inline-actions"><button className="knowledge-text-button" onClick={() => openWorkspaceRecord(p.sourceNodeId === node?.id ? p.targetNodeId : p.sourceNodeId)}>Read related record</button>{p.evidencePassageIds.map((id, index) => <button key={id} className="knowledge-text-button" onClick={() => { useWorkspace.setState({ selectedPassageId: id }); location.hash = `#/library?passage=${encodeURIComponent(id)}` }}>Evidence {index + 1}</button>)}</div></div>)}</section>}</div></article>
}

function Topics() {
  const sources = useKnowledge((s) => s.sources)
  const topics = new Map<string, Source[]>()
  for (const source of sources.filter((s) => !s.excluded && !s.deleted)) for (const tag of source.tags) topics.set(tag, [...(topics.get(tag) ?? []), source])
  const groups = [...topics].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  return <div className="knowledge-topics-workspace"><Investigations /><div className="knowledge-section-title"><h2>Topics from your sources</h2></div><div className="knowledge-topics">{groups.length ? groups.map(([tag, records]) => <section key={tag}><div className="knowledge-section-title"><h2>{tag.replace(/-/g, ' ')}</h2><span>{records.length} {records.length === 1 ? 'source' : 'sources'}</span></div>{records.slice(0, 6).map((source) => <button key={source.id} className="knowledge-topic-source" onClick={() => openSource(source)}><FileText size={17} /><span>{source.title}</span></button>)}<button className="knowledge-text-button" onClick={() => { setWorkspaceSources(records.map((r) => r.id)); setWorkspaceQuery(tag.replace(/-/g, ' ')); location.hash = '#/search' }}>Search this topic</button></section>) : <Empty icon={<FolderOpen size={29} />} title="Topics emerge from your record" text="Capture a thought or import some material. Local organization uses the words in your sources; suggested connections remain reviewable." />}</div></div>
}

function Review() {
  const proposals = useKnowledge((s) => s.proposals)
  const writer = useRepoStatus((s) => s.writer)
  const [filter, setFilter] = useState<'proposed' | 'accepted' | 'rejected'>('proposed')
  const [error, setError] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const displayed = proposals.filter((p) => p.status === filter)
  async function decide(id: string, action: 'accept' | 'reject' | 'undo') {
    setPending(id); setError('')
    try { await reviewProposal(id, action) } catch (e) { setError(message(e)) } finally { setPending(null) }
  }
  return <div className="knowledge-review"><div className="knowledge-tabs" aria-label="Proposal status">{(['proposed', 'accepted', 'rejected'] as const).map((status) => <button key={status} aria-pressed={filter === status} onClick={() => setFilter(status)}>{status === 'proposed' ? 'To review' : status === 'accepted' ? 'Accepted' : 'Rejected'} <span>{proposals.filter((p) => p.status === status).length}</span></button>)}</div><p className="knowledge-search-caption">These are suggested relationships with source evidence. Your original words are preserved.</p>{error && <p role="alert" className="knowledge-error">{error}</p>}{displayed.length ? displayed.map((proposal) => <article key={proposal.id} className="knowledge-proposal"><span className="knowledge-kind">{proposal.status === 'proposed' ? 'Suggested connection' : proposal.status}</span><h2>{proposal.title}</h2><p>{proposal.explanation}</p><div className="knowledge-inline-actions"><button className="knowledge-text-button" onClick={() => openWorkspaceRecord(proposal.sourceNodeId)}>First record</button><button className="knowledge-text-button" onClick={() => openWorkspaceRecord(proposal.targetNodeId)}>Related record</button>{proposal.evidencePassageIds.map((id, i) => <button className="knowledge-text-button" key={id} onClick={() => { useWorkspace.setState({ selectedPassageId: id }); location.hash = `#/library?passage=${encodeURIComponent(id)}` }}>Evidence {i + 1}</button>)}</div><div className="knowledge-inline-actions">{filter === 'proposed' ? <><button className="knowledge-button is-primary" disabled={!writer || pending !== null} onClick={() => void decide(proposal.id, 'accept')}><Check size={16} />Keep connection</button><button className="knowledge-button" disabled={!writer || pending !== null} onClick={() => void decide(proposal.id, 'reject')}>Reject</button></> : <button className="knowledge-button" disabled={!writer || pending !== null} onClick={() => void decide(proposal.id, 'undo')}>Undo {filter === 'accepted' ? 'acceptance' : 'rejection'}</button>}</div></article>) : <Empty icon={<CheckSquare size={29} />} title={filter === 'proposed' ? 'Nothing waiting for review' : `No ${filter} connections`} text="When related sources suggest a connection, you can inspect both sides here and choose whether to keep it." />}</div>
}

function Sources({ hash }: { hash: string }) {
  const sources = useKnowledge((s) => s.sources)
  const [filter, setFilter] = useState(''), [visible, setVisible] = useState(50)
  const [receiptLimit, setReceiptLimit] = useState(10)
  const sourceRows = sources.filter((source) => !source.deleted && source.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
  const imports = useKnowledge((s) => s.imports)
  const jobs = useKnowledge((s) => s.jobs)
  const writer = useRepoStatus((s) => s.writer)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  async function policy(source: Source, patch: { excluded?: boolean; aiAllowed?: boolean }) {
    setBusy(source.id); setError('')
    try { await setSourcePolicy(source.id, patch) } catch (e) { setError(message(e)) } finally { setBusy(null) }
  }
  async function retry(id: string) {
    setBusy(id); setError('')
    try { await retryImport(id) } catch (e) { setError(message(e)) } finally { setBusy(null) }
  }
  async function jobAction(id: string, resume: boolean) {
    setBusy(id); setError('')
    try { if (resume) await resumeKnowledgeJob(id); else await cancelKnowledgeJob(id) } catch (e) { setError(message(e)) } finally { setBusy(null) }
  }
  async function original(blobId: string, name: string) {
    setError('')
    try {
      const blob = await getStore().getBlob(blobId)
      if (!blob) throw new Error('The retained original is unavailable. Restore a backup or import the file again.')
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = name.split('/').at(-1) || name; anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) { setError(message(e)) }
  }
  return <div className="knowledge-sources"><SourcesHub hash={hash} importActions={<><ImportButton compact /><ImportButton compact folder /></>} />{error && <p className="knowledge-error" role="alert">{error}</p>}<details className="knowledge-section knowledge-admin-section"><summary><span>Source access</span><small>{sourceRows.length} sources</small><CaretDown size={15} /></summary><div className="knowledge-admin-content"><label className="knowledge-source-filter">Find a source<input value={filter} onChange={(e) => { setFilter(e.target.value); setVisible(50) }} placeholder="Filter source titles…" /></label><p className="knowledge-search-caption">Included sources are available to local search. AI access separately controls whether the companion can read their contents.</p>{sources.length ? <div className="knowledge-source-list">{sourceRows.slice(0, visible).map((source) => <div className="knowledge-source-row" key={source.id}><button className="knowledge-source-name" onClick={() => openSource(source)}><FileText size={18} /><span><strong>{source.title}</strong><small>{source.kind} · {localDate(source.updatedAt)}</small></span></button><label><input type="checkbox" checked={!source.excluded} disabled={!writer || busy !== null} onChange={(e) => void policy(source, { excluded: !e.target.checked })} />Include in record</label><label><input type="checkbox" checked={source.aiAllowed} disabled={!writer || busy !== null || source.excluded} onChange={(e) => void policy(source, { aiAllowed: e.target.checked })} />Allow AI access</label></div>)}</div> : <p className="knowledge-list-empty">No sources yet. Import files or save your first thought.</p>}{sourceRows.length > visible && <button type="button" className="knowledge-button" onClick={() => setVisible((n) => n + 50)}>Show more sources ({sourceRows.length - visible} remaining)</button>}</div></details><details className="knowledge-section knowledge-admin-section"><summary><span>Import receipts</span><small>{imports.length} imports</small><CaretDown size={15} /></summary><div className="knowledge-admin-content">{imports.length ? [...imports].reverse().slice(0, receiptLimit).map((receipt) => <article className="knowledge-receipt" key={receipt.id}><div className="knowledge-section-title"><h3>{receipt.title}</h3><span className={`knowledge-kind ${receipt.failed ? 'is-warning' : ''}`}>{receipt.status}</span></div><p>{receipt.saved} saved · {receipt.unchanged} unchanged · {receipt.failed} failed · {receipt.total} input items</p><small>{localDate(receipt.createdAt)} · {receipt.checkpoint} processed</small>{receipt.items.length > 0 && <details className="knowledge-receipt-originals"><summary>Original input files</summary>{receipt.items.map((item) => <button key={item.blobId + item.path} className="knowledge-text-button" onClick={() => void original(item.blobId, item.path)}><DownloadSimple size={14} />{item.path}</button>)}</details>}{receipt.errors.length > 0 && <><ul>{receipt.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>{'telegram' in receipt ? <p className="knowledge-secondary">Use Retry retained capture in the Telegram inbox to retry this source.</p> : !('watchedFolderId' in receipt) && !receipt.title.startsWith('Folder:') ? <button className="knowledge-button" disabled={!writer || busy !== null} onClick={() => void retry(receipt.id)}>Retry failed import</button> : <p className="knowledge-secondary">Use Rescan in the watched folder controls to retry this source.</p>}</>}</article>) : <p className="knowledge-list-empty">Every import receives a durable receipt here.</p>}{imports.length > receiptLimit && <button type="button" className="knowledge-button" onClick={() => setReceiptLimit((value) => value + 10)}>Show more receipts</button>}</div></details><details className="knowledge-section knowledge-admin-section"><summary><span>Processing activity</span><small>{jobs.filter((job) => job.status === 'running' || job.status === 'queued').length} active jobs</small><CaretDown size={15} /></summary><div className="knowledge-admin-content">{jobs.length ? <div className="knowledge-job-list">{[...jobs].reverse().slice(0, 30).map((job) => <div key={job.id}><span><strong>{job.title}</strong><small>{job.kind}{job.error ? ` · ${job.error}` : ''}</small></span><span>{job.status === 'cancelled' ? 'Paused' : job.status} · {job.completed}/{job.total}</span>{job.kind === 'import' && (job.status === 'running' || job.status === 'queued' || job.status === 'cancelled') && <button className="knowledge-button" disabled={!writer || busy !== null} onClick={() => void jobAction(job.id, job.status === 'cancelled')}>{job.status === 'cancelled' ? 'Resume' : 'Pause'}</button>}</div>)}</div> : <p className="knowledge-list-empty">Importing and organizing activity appears here when work runs.</p>}</div></details></div>
}

function Empty({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return <div className="knowledge-empty"><span>{icon}</span><h2>{title}</h2><p>{text}</p></div>
}
