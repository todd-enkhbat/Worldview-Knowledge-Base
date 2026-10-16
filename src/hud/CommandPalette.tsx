import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { useApp, useWorld } from '../app/store.ts'
import type { CameraMode } from '../app/store.ts'
import { importWorld, link, useRepoStatus } from '../data/repo.ts'
import { formatByPrecision } from '../domain/time.ts'
import { ARCHETYPES } from '../domain/types.ts'
import type { Archetype, LinkKind, NodeRecord } from '../domain/types.ts'
import { fuzzyMatchFields, fuzzyRank, highlightSegments } from './fuzzy.ts'
import { NodeGlyph } from './Inspector.tsx'
import {
  closePalette,
  deleteNode,
  editNode,
  exportBackup,
  goToPresent,
  newNode,
  selectAndFly,
  usePaletteIntent,
} from './shortcuts.ts'
import { flyTo } from '../world/camera/flyTo.ts'

// Cmd+K palette: fuzzy search over nodes and actions. A combobox: focus stays in the input,
// arrows move the active option, Enter runs it, Esc closes. In link mode (opened from the
// Inspector's "Link to…") choosing a node links the source node to it.

const NODE_LIMIT = 50
const LINK_KINDS: readonly LinkKind[] = ['relates', 'supports', 'contradicts', 'derives', 'influenced-by']

interface PaletteAction {
  id: string
  label: string
  /** Extra words to match on (not displayed). */
  keywords?: string
  /** Right-aligned hint: a key, "current", "read-only". */
  hint?: string
  glyph?: Archetype
  disabled?: boolean
  /** Keep the palette open and show this while run() is pending; close when it resolves (unless 'stay'). */
  busy?: string
  run: () => unknown
}

type Entry =
  | { kind: 'action'; action: PaletteAction; positions: number[]; score: number }
  | { kind: 'node'; node: NodeRecord; positions: number[]; score: number; linked: boolean }

type View = { type: 'list' } | { type: 'confirm-import'; file: File } | { type: 'busy'; message: string }

const MODE_ACTIONS: readonly { mode: CameraMode; label: string; key: string }[] = [
  { mode: 'orbit', label: 'Orbit camera', key: 'O' },
  { mode: 'third_person', label: 'Third person', key: 'T' },
  { mode: 'first_person', label: 'First person', key: 'F' },
]

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message
  return typeof e === 'string' ? e : 'Something went wrong.'
}

const optionId = (i: number) => `hud-palette-opt-${i}`

export function CommandPalette() {
  const open = useApp((s) => s.panels.palette)
  if (!open) return null
  return <PaletteDialog />
}

function PaletteDialog() {
  const nodes = useWorld((s) => s.nodes)
  const hasSettings = useWorld((s) => s.settings !== null)
  const selectedId = useApp((s) => s.selectedId)
  const mode = useApp((s) => s.mode)
  const writer = useRepoStatus((s) => s.writer)
  const linkFrom = usePaletteIntent((s) => s.linkFrom)
  const source = linkFrom ? (nodes.get(linkFrom) ?? null) : null

  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [view, setView] = useState<View>({ type: 'list' })
  const [error, setError] = useState<string | null>(null)
  const [linkKind, setLinkKind] = useState<LinkKind>('relates')

  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  // Focus the input on open; on close, give focus back unless something else (a modal the
  // chosen action opened) already took it.
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null
    inputRef.current?.focus()
    return () => {
      // The link intent is reset when the palette panel closes (shortcuts.ts), not here:
      // StrictMode's mount → cleanup → mount would clear it right after openPalette set it.
      const now = document.activeElement
      if (prev && prev.isConnected && (!now || now === document.body)) prev.focus()
    }
  }, [])

  useEffect(() => {
    if (view.type === 'confirm-import') cancelRef.current?.focus()
    else if (view.type === 'list') inputRef.current?.focus()
  }, [view.type])

  const actions = useMemo<PaletteAction[]>(() => {
    const ro = !writer
    const app = () => useApp.getState()
    const list: PaletteAction[] = []
    if (selectedId && nodes.has(selectedId)) {
      const title = nodes.get(selectedId)!.title
      list.push(
        { id: 'sel-fly', label: `Fly to ${title}`, keywords: 'selected go', run: () => flyTo(selectedId) },
        { id: 'sel-edit', label: `Edit ${title}`, keywords: 'selected', hint: ro ? 'read-only' : 'E', disabled: ro, run: () => editNode(selectedId) },
        {
          id: 'sel-link',
          label: `Link ${title} to…`,
          keywords: 'selected connect',
          hint: ro ? 'read-only' : undefined,
          disabled: ro || nodes.size < 2,
          // Handled in choose(): switches this palette into link mode instead of closing.
          run: () => {},
        },
        { id: 'sel-delete', label: `Delete ${title}`, keywords: 'selected trash remove', hint: ro ? 'read-only' : 'Del', disabled: ro, run: () => deleteNode(selectedId) },
      )
    }
    for (const a of ARCHETYPES) {
      list.push({ id: `new-${a}`, label: `New ${a}`, keywords: 'create add node', glyph: a, hint: ro ? 'read-only' : undefined, disabled: ro, run: () => newNode(a) })
    }
    list.push({ id: 'present', label: 'Go to present', keywords: 'now today playhead time', disabled: !hasSettings, run: () => goToPresent() })
    for (const m of MODE_ACTIONS) {
      list.push({
        id: `mode-${m.mode}`,
        label: m.label,
        keywords: 'camera mode view',
        hint: mode === m.mode ? 'current' : m.key,
        run: () => app().setMode(m.mode),
      })
    }
    {
      // Autonav rides the worldline through the memories in date order; it needs two.
      let memories = 0
      for (const n of nodes.values()) if (n.archetype === 'memory') memories++
      list.push({
        id: 'mode-autonav',
        label: 'Ride the worldline',
        keywords: 'camera autonav tour memories timeline',
        hint: mode === 'autonav' ? 'current' : memories < 2 ? 'needs 2 memories' : undefined,
        disabled: memories < 2,
        run: () => app().setMode('autonav'),
      })
    }
    list.push(
      { id: 'library', label: 'Library', keywords: 'list browse nodes', hint: 'L', run: () => app().togglePanel('library', true) },
      { id: 'settings', label: 'Settings', keywords: 'preferences storage', hint: ',', run: () => app().togglePanel('settings', true) },
      { id: 'trash', label: 'Trash', keywords: 'deleted restore', run: () => app().togglePanel('trash', true) },
      { id: 'demons', label: 'Demons and Landauer ledger', keywords: 'demon maxwell sort query ledger landauer compact log plasticity', run: () => app().togglePanel('demons', true) },
      { id: 'export', label: 'Export backup', keywords: 'save archive zip download', busy: 'Exporting…', run: () => exportBackup() },
      { id: 'import', label: 'Import archive', keywords: 'restore load zip replace', hint: ro ? 'read-only' : undefined, disabled: ro, run: () => fileRef.current?.click() },
      { id: 'stats', label: 'Toggle stats', keywords: 'fps performance renderer', hint: '`', run: () => app().togglePanel('stats') },
    )
    return list
  }, [writer, selectedId, nodes, hasSettings, mode])

  const sortedNodes = useMemo(
    () => [...nodes.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title)),
    [nodes],
  )

  const entries = useMemo<Entry[]>(() => {
    const nodeFields = (n: NodeRecord) => [n.title, { text: n.tags.join(' '), bias: -2 }, { text: n.archetype, bias: -4 }]
    if (source) {
      const linked = new Set(source.links.filter((l) => l.kind === linkKind).map((l) => l.targetId))
      const candidates = sortedNodes.filter((n) => n.id !== source.id)
      return fuzzyRank(candidates, query, nodeFields, NODE_LIMIT).map((r) => ({
        kind: 'node',
        node: r.item,
        positions: r.positions[0] ?? [],
        score: r.score,
        linked: linked.has(r.item.id),
      }))
    }
    const nodeEntries: Entry[] = fuzzyRank(sortedNodes, query, nodeFields, NODE_LIMIT).map((r) => ({
      kind: 'node',
      node: r.item,
      positions: r.positions[0] ?? [],
      score: r.score,
      linked: false,
    }))
    const actionEntries: Entry[] = []
    if (query.trim() === '') {
      for (const a of actions) actionEntries.push({ kind: 'action', action: a, positions: [], score: 0 })
      return [...actionEntries, ...nodeEntries]
    }
    actions.forEach((a) => {
      const r = fuzzyMatchFields(query, [a.label, { text: a.keywords ?? '', bias: -6 }])
      if (r) actionEntries.push({ kind: 'action', action: a, positions: r.positions[0], score: r.score })
    })
    actionEntries.sort((a, b) => b.score - a.score)
    const actionsFirst = actionEntries.length > 0 && (nodeEntries.length === 0 || actionEntries[0].score >= nodeEntries[0].score)
    return actionsFirst ? [...actionEntries, ...nodeEntries] : [...nodeEntries, ...actionEntries]
  }, [source, sortedNodes, query, actions, linkKind])

  const activeIndex = entries.length === 0 ? -1 : Math.min(active, entries.length - 1)

  useEffect(() => {
    if (activeIndex >= 0) document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const runBusy = async (message: string, work: () => unknown) => {
    setError(null)
    setView({ type: 'busy', message })
    try {
      const result = await work()
      if (result === 'cancelled') setView({ type: 'list' })
      else closePalette()
    } catch (e) {
      setError(errorText(e))
      setView({ type: 'list' })
    }
  }

  const choose = (entry: Entry | undefined) => {
    if (!entry) return
    if (entry.kind === 'node') {
      if (source) {
        if (entry.linked) return
        const from = source.id
        const to = entry.node.id
        void runBusy('Linking…', () => link(from, to, linkKind))
        return
      }
      closePalette()
      selectAndFly(entry.node.id)
      return
    }
    const a = entry.action
    if (a.disabled) return
    if (a.id === 'sel-link' && selectedId) {
      usePaletteIntent.setState({ linkFrom: selectedId })
      setQuery('')
      setActive(0)
      setError(null)
      return
    }
    if (a.id === 'import') {
      // Opening the file chooser needs the user gesture we are still inside of.
      setError(null)
      a.run()
      return
    }
    if (a.busy) {
      void runBusy(a.busy, a.run)
      return
    }
    // Close first: the action may open another modal (editor, settings) that takes focus.
    closePalette()
    a.run()
  }

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) setView({ type: 'confirm-import', file })
  }

  const confirmImport = (file: File) => void runBusy(`Importing ${file.name}…`, () => importWorld(file))

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // Claim it so the camera rig's window handler does not run escape() a second time.
      e.preventDefault()
      e.stopPropagation()
      if (view.type === 'confirm-import') setView({ type: 'list' })
      else useApp.getState().escape()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      closePalette()
      return
    }
    if (e.key === 'Tab') {
      trapFocus(e, dialogRef.current)
      return
    }
    if (view.type !== 'list' || e.target !== inputRef.current) return
    const n = entries.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (n === 0) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((((activeIndex < 0 ? -1 : activeIndex) + step) % n + n) % n)
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault()
      if (n === 0) return
      setActive(Math.max(0, Math.min(n - 1, activeIndex + (e.key === 'PageDown' ? 8 : -8))))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(entries[activeIndex])
    }
  }

  const firstNode = entries.findIndex((x) => x.kind === 'node')
  const firstAction = entries.findIndex((x) => x.kind === 'action')

  return (
    <>
      <div aria-hidden="true" className="pointer-events-auto fixed inset-0 z-40 bg-void/60" onMouseDown={() => closePalette()} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={source ? `Link ${source.title} to a node` : 'Command palette'}
        onKeyDown={onKeyDown}
        className="hud-panel pointer-events-auto fixed left-1/2 top-[12vh] z-50 flex max-h-[72vh] w-[min(40rem,calc(100%-1.5rem))] -translate-x-1/2 flex-col"
      >
        {source && (
          <div className="flex flex-wrap items-center gap-2 border-b border-bone/20 px-3 py-2">
            <span className="hud-label">Link</span>
            <NodeGlyph archetype={source.archetype} />
            <span className="min-w-0 max-w-[16rem] truncate">{source.title}</span>
            <label className="ml-auto flex items-center gap-2">
              <span className="hud-label">As</span>
              <select
                value={linkKind}
                onChange={(e) => setLinkKind(e.target.value as LinkKind)}
                className="border border-bone/30 bg-void px-1.5 py-1 font-mono text-[11px] uppercase text-bone focus-visible:outline-2 focus-visible:outline-signal"
              >
                {LINK_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <div className="flex items-center gap-2 border-b border-bone/20 px-3">
          <span aria-hidden="true" className="text-concrete">
            {source ? '→' : '›'}
          </span>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={view.type === 'list'}
            aria-controls="hud-palette-list"
            aria-autocomplete="list"
            aria-activedescendant={view.type === 'list' && activeIndex >= 0 ? optionId(activeIndex) : undefined}
            aria-label={source ? 'Search node to link' : 'Search nodes and actions'}
            value={query}
            disabled={view.type !== 'list'}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            placeholder={source ? 'LINK TO…' : 'SEARCH NODES / ACTIONS'}
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent py-3 font-mono text-[14px] text-bone placeholder:text-concrete focus:outline-none"
          />
          <kbd className="hud-label">esc</kbd>
        </div>

        {error && (
          <p role="alert" className="m-0 border-b border-signal/60 px-3 py-2 text-signal">
            {error}
          </p>
        )}

        {view.type === 'busy' && (
          <p role="status" className="m-0 px-3 py-6 text-center uppercase tracking-wider text-bone">
            {view.message}
          </p>
        )}

        {view.type === 'confirm-import' && (
          <section aria-labelledby="hud-palette-import-title" className="space-y-3 px-3 py-4">
            <h2 id="hud-palette-import-title" className="m-0 text-[12px] font-normal uppercase tracking-wider text-signal">
              Replace this world?
            </h2>
            <p className="m-0 leading-relaxed">
              Importing <span className="text-bone">{view.file.name}</span> replaces every node, link and attachment in this browser.
              A backup of the current world is taken first.
            </p>
            <div className="flex justify-end gap-2">
              <button ref={cancelRef} type="button" className="hud-btn focus-visible:outline-2 focus-visible:outline-signal" onClick={() => setView({ type: 'list' })}>
                Cancel
              </button>
              <button
                type="button"
                className="border border-signal px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-signal hover:bg-signal hover:text-void focus-visible:outline-2 focus-visible:outline-signal"
                onClick={() => confirmImport(view.file)}
              >
                Replace world
              </button>
            </div>
          </section>
        )}

        {view.type === 'list' && (
          <div id="hud-palette-list" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto py-1">
            {entries.length === 0 && <p className="m-0 px-3 py-4 text-concrete">{source ? 'No other nodes match.' : 'No matches.'}</p>}
            {entries.map((entry, i) => (
              <PaletteOption
                key={entry.kind === 'node' ? `n-${entry.node.id}` : `a-${entry.action.id}`}
                entry={entry}
                index={i}
                active={i === activeIndex}
                heading={i === firstAction ? 'Actions' : i === firstNode ? (source ? 'Link to' : 'Nodes') : null}
                onHover={() => setActive(i)}
                onChoose={() => choose(entry)}
              />
            ))}
          </div>
        )}

        <footer className="flex gap-4 border-t border-bone/20 px-3 py-1.5" aria-hidden="true">
          <span className="hud-label">↑↓ move</span>
          <span className="hud-label">enter {source ? 'link' : 'run'}</span>
          <span className="hud-label">esc close</span>
        </footer>

        <input ref={fileRef} type="file" accept=".zip,application/zip" className="hidden" tabIndex={-1} aria-hidden="true" onChange={onFile} />
      </div>
    </>
  )
}

function PaletteOption({
  entry,
  index,
  active,
  heading,
  onHover,
  onChoose,
}: {
  entry: Entry
  index: number
  active: boolean
  heading: string | null
  onHover: () => void
  onChoose: () => void
}) {
  const disabled = entry.kind === 'action' ? entry.action.disabled === true : entry.linked
  let glyph: ReactNode
  let label: string
  let hint: string | undefined
  if (entry.kind === 'action') {
    glyph = entry.action.glyph ? <NodeGlyph archetype={entry.action.glyph} /> : <span aria-hidden="true" className="inline-block w-[1.25em] text-center text-concrete">→</span>
    label = entry.action.label
    hint = entry.action.hint
  } else {
    glyph = <NodeGlyph archetype={entry.node.archetype} />
    label = entry.node.title
    hint = entry.linked ? 'linked' : formatByPrecision(entry.node.temporalOrigin, entry.node.temporalPrecision)
  }
  return (
    <>
      {heading && (
        <div role="presentation" className="hud-label px-3 pb-1 pt-2">
          {heading}
        </div>
      )}
      <div
        id={optionId(index)}
        role="option"
        aria-selected={active}
        aria-disabled={disabled || undefined}
        // Keep focus in the input; the click still fires.
        onMouseDown={(e) => e.preventDefault()}
        onMouseMove={active ? undefined : onHover}
        onClick={onChoose}
        className={`flex cursor-pointer items-baseline gap-2 border-l-2 px-3 py-1.5 ${active ? 'border-signal bg-bone/10' : 'border-transparent'} ${
          disabled ? 'cursor-default opacity-45' : ''
        }`}
      >
        {glyph}
        <span className="min-w-0 flex-1 truncate">
          {highlightSegments(label, entry.positions).map((s, i) =>
            s.hit ? (
              <mark key={i} className="bg-transparent text-signal">
                {s.text}
              </mark>
            ) : (
              <span key={i}>{s.text}</span>
            ),
          )}
          {entry.kind === 'node' && <span className="ml-2 text-[10px] uppercase tracking-wider text-concrete">{entry.node.archetype}</span>}
        </span>
        {hint && <span className="shrink-0 text-[11px] uppercase text-concrete">{hint}</span>}
      </div>
    </>
  )
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]):not([type="file"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function trapFocus(e: ReactKeyboardEvent, root: HTMLElement | null): void {
  if (!root) return
  const els = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
  if (els.length === 0) return
  const first = els[0]
  const last = els[els.length - 1]
  const at = document.activeElement
  if (e.shiftKey && (at === first || !root.contains(at))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (at === last || !root.contains(at))) {
    e.preventDefault()
    first.focus()
  }
}
