import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { ArrowDown, ArrowElbowDownLeft, ArrowUp, BookOpen, Books, CheckSquare, FileText, FolderOpen, MagnifyingGlass, PencilSimple, Planet, Plus, Stack, Sun, TreeStructure, Users, X } from '@phosphor-icons/react'
import { useApp, useWorld } from '../app/store.ts'
import { useAuth } from '../data/auth.ts'
import { useKnowledge } from '../knowledge/index.ts'
import { isArtifactProjection } from '../knowledge/derived.ts'
import { parseAppRoute } from './routes.ts'
import { openWorkspaceRecord, useWorkspace, WORKSPACE_SECTIONS } from './state.ts'
import './commandMenu.css'

const COMMAND_EVENT = 'worldview:commands'
const CAPTURE_EVENT = 'worldview:capture'
const RECORD_LIMIT = 8
const QUERY_LIMIT = 96

/** Mount CommandMenu once in the workspace shell; the 3D world's palette stays independent. */
export function openCommandMenu(): void {
  window.dispatchEvent(new CustomEvent(COMMAND_EVENT))
}

type MenuRecord = {
  id: string
  kind: 'source' | 'node'
  title: string
  detail: string
  titleKey: string
  searchKey: string
  updatedAt: number
}
type MenuEntry = {
  id: string
  title: string
  detail: string
  icon: typeof Sun
  href?: string
  record?: MenuRecord
  keywords?: string
}

const commands: MenuEntry[] = [
  { id: 'capture', title: 'Capture a thought', detail: 'Write something down', icon: Plus, keywords: 'new note idea create' },
  { id: 'today', title: 'Today', detail: 'Capture and recent records', icon: Sun, href: '#/today', keywords: 'home recent' },
  { id: 'write', title: 'Writing studio', detail: 'Documents, formatting and your own design', icon: PencilSimple, href: '#/write', keywords: 'write editor essay newsletter journal poem rich text' },
  { id: 'search', title: 'Search & ask', detail: 'Find words and passages', icon: MagnifyingGlass, href: '#/search', keywords: 'find evidence question' },
  { id: 'library', title: 'Library', detail: 'Read your original sources', icon: BookOpen, href: '#/library', keywords: 'records notes documents files' },
  { id: 'people', title: 'People', detail: 'Contacts, groups, follow-ups and your network', icon: Users, href: '#/people', keywords: 'folk crm contacts calendar comments network relationships' },
  { id: 'graph', title: 'Knowledge graph', detail: 'Connect sources, ideas and topics', icon: TreeStructure, href: '#/graph', keywords: 'network connections links topics map' },
  { id: 'topics', title: 'Projects & topics', detail: 'Follow a subject or investigation', icon: FolderOpen, href: '#/topics', keywords: 'subjects investigations' },
  { id: 'knowledge', title: 'Knowledge pages', detail: 'Your connected understanding', icon: FileText, href: '#/knowledge', keywords: 'wiki pages' },
  { id: 'review', title: 'Review', detail: 'Inspect suggested connections', icon: CheckSquare, href: '#/review', keywords: 'proposals suggestions' },
  { id: 'sources', title: 'Sources & activity', detail: 'Imports, capture, and connections', icon: Stack, href: '#/sources', keywords: 'import telegram voice qmd integrations settings' },
  { id: 'bookshelf', title: 'Bookshelf', detail: 'Books, articles, ratings and reading lists', icon: Books, href: '#/bookshelf', keywords: 'books shelves want buy unread read reading recommendation author ranking' },
  { id: 'explore', title: 'Explore in 3D', detail: 'Open your spatial world', icon: Planet, href: '#/explore', keywords: 'world map spatial' },
]

const fold = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().trim().replace(/\s+/g, ' ')
const workspaceActive = () => (WORKSPACE_SECTIONS as readonly string[]).includes(parseAppRoute(location.hash, import.meta.env.DEV))

function scoreMetadata(title: string, searchable: string, query: string, terms: string[]): number {
  if (!terms.every((term) => searchable.includes(term))) return -1
  if (title === query) return 1000
  if (title.startsWith(query)) return 800
  if (title.includes(query)) return 600
  return terms.every((term) => title.includes(term)) ? 400 : 200
}

function recordHref(record: MenuRecord): string {
  return `#/library?${record.kind === 'source' ? 'source' : 'record'}=${encodeURIComponent(record.id)}`
}

/** Search only metadata; do not scan source text or call a retrieval/model endpoint. */
function matchingRecords(records: readonly MenuRecord[], query: string): MenuRecord[] {
  const terms = query.split(' ').filter(Boolean)
  const best: { record: MenuRecord; score: number }[] = []
  for (const record of records) {
    const score = query ? scoreMetadata(record.titleKey, record.searchKey, query, terms) : 0
    if (score < 0) continue
    let at = best.findIndex((entry) => score > entry.score || score === entry.score && record.updatedAt > entry.record.updatedAt)
    if (at < 0) at = best.length
    if (at >= RECORD_LIMIT) continue
    best.splice(at, 0, { record, score })
    if (best.length > RECORD_LIMIT) best.pop()
  }
  return best.map((entry) => entry.record)
}

function anotherModalOpen(): boolean {
  const state = useApp.getState()
  const { settings, trash, picker, omnibox, palette } = state.panels
  return settings || trash || picker || omnibox || palette || state.editor.open || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]') !== null
}

export function CommandMenu() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const nodes = useWorld((state) => state.nodes)
  const sources = useKnowledge((state) => state.sources)
  const account = useAuth((state) => state.user?.id)
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const invoker = useRef<HTMLElement | null>(null)
  const restoreFocus = useRef(true)
  const afterClose = useRef<(() => void) | null>(null)
  const backdropDown = useRef(false)
  const id = useId()
  const titleId = `${id}-title`
  const listId = `${id}-results`
  const hintId = `${id}-hint`
  const keyboardHintId = `${id}-keyboard-hint`

  const close = useCallback((restore = true) => {
    restoreFocus.current = restore
    setOpen(false)
  }, [])

  useEffect(() => {
    function show() {
      if (!workspaceActive() || anotherModalOpen()) return
      invoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      restoreFocus.current = true
      setQuery('')
      setActiveId(null)
      setOpen(true)
    }
    function key(event: KeyboardEvent) {
      if (event.isComposing || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k' || !workspaceActive()) return
      if (!open && anotherModalOpen()) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.repeat) return
      if (open) close()
      else show()
    }
    const routeChanged = () => close(false)
    window.addEventListener('keydown', key, true)
    window.addEventListener(COMMAND_EVENT, show)
    window.addEventListener('hashchange', routeChanged)
    return () => {
      window.removeEventListener('keydown', key, true)
      window.removeEventListener(COMMAND_EVENT, show)
      window.removeEventListener('hashchange', routeChanged)
    }
  }, [open, close])

  useEffect(() => { close(false) }, [account, close])

  useEffect(() => {
    if (!open) return
    const element = dialog.current!
    // Native modality keeps the underlying app inert and escapes clipping ancestors.
    element.showModal()
    input.current?.focus({ preventScroll: true })
    return () => {
      element.close()
      if (restoreFocus.current && invoker.current?.isConnected) invoker.current.focus({ preventScroll: true })
      const intent = afterClose.current
      afterClose.current = null
      intent?.()
    }
  }, [open])

  const records = useMemo(() => {
    if (!open) return []
    const indexed: MenuRecord[] = []
    const sourceNodes = new Set(sources.map((source) => source.nodeId))
    for (const source of sources) {
      if (source.excluded || source.deleted) continue
      const title = source.title || 'Untitled source'
      const detail = [source.kind, ...source.tags.slice(0, 2)].join(' · ')
      indexed.push({ id: source.id, kind: 'source', title, detail, titleKey: fold(title.slice(0, 256)), searchKey: fold(`${title.slice(0, 256)} ${source.kind} ${source.tags.join(' ').slice(0, 512)}`), updatedAt: source.updatedAt })
    }
    for (const node of nodes.values()) {
      if (sourceNodes.has(node.id) || node.deletedAt !== null || node.corpusExcluded || isArtifactProjection(node)) continue
      const title = node.title || 'Untitled record'
      const detail = [node.archetype, ...node.tags.slice(0, 2)].join(' · ')
      indexed.push({ id: node.id, kind: 'node', title, detail, titleKey: fold(title.slice(0, 256)), searchKey: fold(`${title.slice(0, 256)} ${node.archetype} ${node.tags.join(' ').slice(0, 512)}`), updatedAt: node.updatedAt })
    }
    return indexed
  }, [nodes, sources, open])

  const normalizedQuery = fold(query)
  const navigation = useMemo(() => {
    if (!normalizedQuery) return commands
    const terms = normalizedQuery.split(' ')
    return commands.map((command) => ({ command, score: scoreMetadata(fold(command.title), fold(`${command.title} ${command.detail} ${command.keywords ?? ''}`), normalizedQuery, terms) })).filter((entry) => entry.score >= 0).sort((a, b) => b.score - a.score).map((entry) => entry.command)
  }, [normalizedQuery])
  const recordEntries = useMemo(() => matchingRecords(records, normalizedQuery).map((record): MenuEntry => ({ id: `${record.kind}:${record.id}`, title: record.title, detail: record.detail, icon: FileText, href: recordHref(record), record })), [records, normalizedQuery])
  const entries = [...navigation, ...recordEntries]
  const activeIndex = Math.max(0, entries.findIndex((entry) => entry.id === activeId))
  const selected = entries[activeIndex]
  const optionId = (entry: MenuEntry) => `${id}-option-${entry.id}`

  useEffect(() => {
    if (open && selected) document.getElementById(`${id}-option-${selected.id}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [id, open, selected])

  function run(entry: MenuEntry) {
    if (entry.record) {
      // Selection rechecks current policy even if a key arrived before a store rerender.
      const record = entry.record
      if (record.kind === 'source') {
        const source = useKnowledge.getState().sources.find((item) => item.id === record.id)
        if (!source || source.excluded || source.deleted) return
        close(false)
        useWorkspace.setState({ selectedSourceId: source.id, selectedRecordId: source.nodeId ?? null, selectedPassageId: null })
        location.hash = recordHref(record)
      } else {
        const node = useWorld.getState().nodes.get(record.id)
        if (!node || node.deletedAt !== null || node.corpusExcluded || isArtifactProjection(node) || useKnowledge.getState().sources.some((source) => source.nodeId === node.id && (source.excluded || source.deleted))) return
        close(false)
        openWorkspaceRecord(record.id)
      }
      return
    }
    if (entry.id === 'capture') afterClose.current = () => window.dispatchEvent(new CustomEvent(CAPTURE_EVENT))
    close(false)
    if (entry.href) location.hash = entry.href
  }

  function keyboard(event: ReactKeyboardEvent<HTMLDialogElement>) {
    // Keep IME composition and text editing keys in the input's native editing model.
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
      event.preventDefault()
      event.stopPropagation()
      run(commands[0])
      return
    }
    if (event.key === 'Tab') {
      const tabbable = [...dialog.current!.querySelectorAll<HTMLElement>('input, button:not([tabindex="-1"])')].filter((element) => !element.hasAttribute('disabled'))
      const first = tabbable[0], last = tabbable.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      return
    }
    if (event.target !== input.current) return
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && entries.length) {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setActiveId(entries[(activeIndex + direction + entries.length) % entries.length].id)
    } else if (event.key === 'Enter' && selected) {
      event.preventDefault()
      run(selected)
    }
  }

  function option(entry: MenuEntry) {
    const Icon = entry.icon
    const props = {
      id: optionId(entry), role: 'option', 'aria-selected': selected?.id === entry.id, tabIndex: -1,
      className: 'workspace-command-option',
      onPointerMove: () => setActiveId(entry.id),
      onMouseDown: (event: ReactMouseEvent) => { if (!event.metaKey && !event.ctrlKey && event.button === 0) event.preventDefault() },
    } as const
    const content = <><Icon size={19} aria-hidden="true" /><span className="workspace-command-option-text"><strong>{entry.title}</strong><small>{entry.detail}</small></span><ArrowElbowDownLeft className="workspace-command-return" size={16} aria-hidden="true" /></>
    return entry.href
      ? <a key={entry.id} {...props} href={entry.href} onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); run(entry) }}>{content}</a>
      : <button key={entry.id} {...props} type="button" onClick={() => run(entry)}>{content}</button>
  }

  if (!open) return null
  return <dialog ref={dialog} className="workspace-command-menu" aria-modal="true" aria-labelledby={titleId} aria-describedby={`${hintId} ${keyboardHintId}`}
    onCancel={(event) => { event.preventDefault(); close() }} onClose={() => close()} onKeyDown={keyboard}
    onPointerDown={(event) => { backdropDown.current = event.target === event.currentTarget }}
    onClick={(event) => { if (backdropDown.current && event.target === event.currentTarget) close(); backdropDown.current = false }}>
    <div className="workspace-command-surface">
      <h2 id={titleId} className="workspace-command-sr-only">Go anywhere in Worldview</h2>
      <p id={keyboardHintId} className="workspace-command-sr-only">Use the up and down arrow keys to choose a result, Enter to open, and Escape to close.</p>
      <div className="workspace-command-search"><MagnifyingGlass size={22} aria-hidden="true" /><input ref={input} role="combobox" aria-label="Search commands and records" aria-expanded="true" aria-autocomplete="list" aria-controls={listId} aria-activedescendant={selected ? optionId(selected) : undefined} aria-describedby={hintId} placeholder="Search records or jump to…" name="workspace-command" autoComplete="off" spellCheck={false} maxLength={QUERY_LIMIT} value={query} onChange={(event) => { setQuery(event.target.value.slice(0, QUERY_LIMIT)); setActiveId(null) }} />{query && <button type="button" className="workspace-command-icon" aria-label="Clear command search" onClick={() => { setQuery(''); setActiveId(null); input.current?.focus() }}><X size={17} aria-hidden="true" /></button>}<button type="button" className="workspace-command-close" aria-label="Close command menu" onClick={() => close()}><span>Esc</span><X size={18} aria-hidden="true" /></button></div>
      <div id={listId} className="workspace-command-results" role="listbox" aria-label="Commands and records">
        {navigation.length > 0 && <div role="group" aria-label="Workspace"><div className="workspace-command-group" aria-hidden="true">Workspace</div>{navigation.map(option)}</div>}
        {recordEntries.length > 0 && <div role="group" aria-label={normalizedQuery ? 'Matching records' : 'Recently updated'}><div className="workspace-command-group" aria-hidden="true">{normalizedQuery ? 'Matching records' : 'Recently updated'}</div>{recordEntries.map(option)}</div>}
      </div>
      {entries.length === 0 && <div className="workspace-command-empty"><FileText size={25} aria-hidden="true" /><strong>No matching commands or records</strong><p>Try a record title, a tag, or a workspace section.</p><button type="button" onClick={() => { setQuery(''); setActiveId(null); input.current?.focus() }}>Clear search</button></div>}
      {!normalizedQuery && !recordEntries.length && <p className="workspace-command-start">Your saved thoughts and sources will appear here.</p>}
      <span className="workspace-command-sr-only" role="status" aria-live="polite">{entries.length ? `${navigation.length} commands and ${recordEntries.length}${recordEntries.length === RECORD_LIMIT ? ' top' : ''} records available.` : 'No matches.'}</span>
      <footer className="workspace-command-footer"><span className="workspace-command-key-help" aria-hidden="true"><kbd><ArrowUp size={12} /><ArrowDown size={12} /></kbd> move <kbd><ArrowElbowDownLeft size={12} /></kbd> open</span><span id={hintId}>Titles and tags · on this device</span></footer>
    </div>
  </dialog>
}
