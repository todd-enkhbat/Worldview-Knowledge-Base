import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { useApp, useWorld } from '../app/store.ts'
import { formatByPrecision } from '../domain/time.ts'
import { ARCHETYPES } from '../domain/types.ts'
import type { NodeRecord } from '../domain/types.ts'
import { fuzzyRank, highlightSegments } from './fuzzy.ts'
import { NodeGlyph } from './Inspector.tsx'
import { openPicker, selectAndFly } from './shortcuts.ts'

// Left-hand list of every live node, grouped by archetype or by year, with fuzzy search.
// Not a modal: the world stays interactive while it is open.

type GroupBy = 'archetype' | 'year'

interface Group {
  key: string
  label: string
  nodes: NodeRecord[]
}

// Survives closing and reopening the panel within a session.
let lastGroupBy: GroupBy = 'archetype'
let lastCollapsed = new Set<string>()

const yearOf = (n: NodeRecord) => new Date(n.temporalOrigin).getUTCFullYear()

function groupNodes(sorted: readonly NodeRecord[], by: GroupBy): Group[] {
  if (by === 'archetype') {
    return ARCHETYPES.map((a) => ({ key: `a:${a}`, label: a, nodes: sorted.filter((n) => n.archetype === a) })).filter((g) => g.nodes.length > 0)
  }
  const byYear = new Map<number, NodeRecord[]>()
  for (const n of sorted) {
    const y = yearOf(n)
    const list = byYear.get(y)
    if (list) list.push(n)
    else byYear.set(y, [n])
  }
  return [...byYear.entries()].sort((a, b) => b[0] - a[0]).map(([y, nodes]) => ({ key: `y:${y}`, label: String(y), nodes }))
}

export function Library() {
  const open = useApp((s) => s.panels.library)
  if (!open) return null
  return <LibraryPanel />
}

function LibraryPanel() {
  const nodes = useWorld((s) => s.nodes)
  const selectedId = useApp((s) => s.selectedId)
  const [query, setQuery] = useState('')
  const [groupBy, setGroupByState] = useState<GroupBy>(lastGroupBy)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(lastCollapsed)
  const panelRef = useRef<HTMLElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Newest first: the top of the list is the top of the tower.
  const sorted = useMemo(
    () => [...nodes.values()].sort((a, b) => b.temporalOrigin - a.temporalOrigin || a.title.localeCompare(b.title)),
    [nodes],
  )
  const groups = useMemo(() => groupNodes(sorted, groupBy), [sorted, groupBy])
  const ranked = useMemo(
    () => (query.trim() ? fuzzyRank(sorted, query, (n) => [n.title, { text: n.tags.join(' '), bias: -2 }]) : null),
    [sorted, query],
  )

  const setGroupBy = (g: GroupBy) => {
    lastGroupBy = g
    setGroupByState(g)
  }
  const toggleGroup = (key: string) => {
    const next = new Set(collapsed)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    lastCollapsed = next
    setCollapsed(next)
  }

  const close = () => {
    useApp.getState().togglePanel('library', false)
    // Hand the keyboard back to the world (camera keys ignore focused inputs).
    if (panelRef.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
  }

  const items = () => [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('button[data-lib-item]') ?? [])]

  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      // Claim Esc so the camera rig does not also deselect.
      e.preventDefault()
      if (query && e.target === inputRef.current) setQuery('')
      else close()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const list = items()
    if (list.length === 0) return
    e.preventDefault()
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) {
      list[e.key === 'ArrowDown' ? 0 : list.length - 1].focus()
      return
    }
    const next = at + (e.key === 'ArrowDown' ? 1 : -1)
    if (next < 0) inputRef.current?.focus()
    else list[Math.min(next, list.length - 1)].focus()
  }

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && ranked && ranked.length > 0) {
      e.preventDefault()
      selectAndFly(ranked[0].item.id)
    }
  }

  return (
    <aside
      ref={panelRef}
      aria-labelledby="hud-library-title"
      onKeyDown={onPanelKeyDown}
      className="hud-panel absolute left-3 top-0 flex max-h-[calc(100%-0.75rem)] w-[min(20rem,calc(100%-1.5rem))] flex-col"
    >
      <header className="flex items-center gap-2 border-b border-bone/20 px-3 py-2">
        <h2 id="hud-library-title" className="m-0 flex-1 text-[10px] font-normal uppercase tracking-[0.14em] text-bone">
          Library <span className="text-concrete">{nodes.size}</span>
        </h2>
        <button type="button" className="hud-btn focus-visible:outline-2 focus-visible:outline-signal" aria-label="Close library" onClick={close}>
          ×
        </button>
      </header>

      <div className="space-y-2 border-b border-bone/20 px-3 py-2">
        <label className="block">
          <span className="sr-only">Search nodes</span>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="SEARCH TITLE / TAG"
            spellCheck={false}
            autoComplete="off"
            className="w-full border border-bone/30 bg-transparent px-2 py-1.5 font-mono text-[12px] text-bone placeholder:text-concrete focus:border-bone focus:outline-none focus-visible:outline-2 focus-visible:outline-signal"
          />
        </label>
        <div role="radiogroup" aria-label="Group by" className="flex items-center gap-2">
          <span className="hud-label mr-1">Group</span>
          {(['archetype', 'year'] as const).map((g) => (
            <button
              key={g}
              type="button"
              role="radio"
              aria-checked={groupBy === g}
              disabled={ranked !== null}
              onClick={() => setGroupBy(g)}
              // Not .hud-btn: its unlayered colours would beat the checked-state utilities.
              className={`border px-2 py-1 font-mono text-[11px] uppercase tracking-wider focus-visible:outline-2 focus-visible:outline-signal disabled:opacity-40 ${
                groupBy === g ? 'border-bone bg-bone text-void' : 'border-bone/30 text-bone hover:bg-bone/15'
              }`}
            >
              {g}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {nodes.size === 0 ? (
          <div className="space-y-3 px-3 py-4">
            <p className="m-0 text-concrete">No nodes yet.</p>
            <button type="button" className="hud-btn focus-visible:outline-2 focus-visible:outline-signal" onClick={openPicker}>
              + New node
            </button>
          </div>
        ) : ranked ? (
          <section aria-label="Search results">
            <p role="status" className="hud-label m-0 px-3 py-1">
              {ranked.length} {ranked.length === 1 ? 'match' : 'matches'}
            </p>
            <ul className="m-0 list-none p-0">
              {ranked.map((r) => (
                <li key={r.item.id}>
                  <NodeRow node={r.item} positions={r.positions[0]} selected={r.item.id === selectedId} />
                </li>
              ))}
            </ul>
          </section>
        ) : (
          groups.map((g) => {
            const isCollapsed = collapsed.has(g.key)
            const listId = `hud-lib-${g.key.replace(':', '-')}`
            return (
              <section key={g.key} aria-label={g.label}>
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  aria-controls={listId}
                  onClick={() => toggleGroup(g.key)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-bone/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal"
                >
                  <span aria-hidden="true" className="w-3 text-concrete">
                    {isCollapsed ? '+' : '−'}
                  </span>
                  <span className="flex-1 text-[10px] uppercase tracking-[0.14em] text-bone">{g.label}</span>
                  <span className="text-concrete">{g.nodes.length}</span>
                </button>
                {!isCollapsed && (
                  <ul id={listId} className="m-0 list-none p-0 pb-1">
                    {g.nodes.map((n) => (
                      <li key={n.id}>
                        <NodeRow node={n} selected={n.id === selectedId} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          })
        )}
      </div>
    </aside>
  )
}

function Highlighted({ text, positions }: { text: string; positions?: readonly number[] }): ReactNode {
  return highlightSegments(text, positions).map((s, i) =>
    s.hit ? (
      <mark key={i} className="bg-transparent text-signal">
        {s.text}
      </mark>
    ) : (
      <span key={i}>{s.text}</span>
    ),
  )
}

function NodeRow({ node, positions, selected }: { node: NodeRecord; positions?: readonly number[]; selected: boolean }) {
  return (
    <button
      type="button"
      data-lib-item=""
      aria-current={selected ? 'true' : undefined}
      onClick={() => selectAndFly(node.id)}
      className={`flex w-full items-baseline gap-2 border-l-2 px-3 py-1 text-left hover:bg-bone/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal ${
        selected ? 'border-signal bg-bone/10' : 'border-transparent'
      }`}
    >
      <NodeGlyph archetype={node.archetype} />
      <span className="min-w-0 flex-1 truncate">
        <Highlighted text={node.title} positions={positions} />
      </span>
      <span className="shrink-0 text-[11px] text-concrete">{formatByPrecision(node.temporalOrigin, node.temporalPrecision)}</span>
    </button>
  )
}
