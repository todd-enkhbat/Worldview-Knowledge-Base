import { useMemo, useState } from 'react'
import type { Link, LinkKind, NodeRecord } from '../../domain/types.ts'
import { LINK_KINDS, LINK_KIND_HINT, addLink, searchNodes, setLinkKind } from './helpers.ts'
import { ERROR_TEXT, FOCUS, INPUT, SELECT } from './ui.ts'

export interface LinkPickerProps {
  id: string
  /** The node being edited (excluded from results). */
  selfId: string
  links: Link[]
  onChange: (links: Link[]) => void
  /** Live nodes, searchable. */
  nodes: ReadonlyMap<string, NodeRecord>
  /** Trashed nodes, only to name dangling targets. */
  trash?: ReadonlyMap<string, NodeRecord>
  /** Validation messages keyed by link index. */
  errors?: ReadonlyMap<number, string>
}

/** Existing links (kind editable, removable) plus a search-by-title combobox to add one. */
export function LinkPicker({ id, selfId, links, onChange, nodes, trash, errors }: LinkPickerProps) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<LinkKind>('relates')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  const results = useMemo(() => {
    const exclude = new Set([selfId, ...links.filter((l) => l.kind === kind).map((l) => l.targetId)])
    return searchNodes(nodes.values(), query, { exclude, limit: 8 })
  }, [nodes, query, selfId, links, kind])

  const hasCandidates = useMemo(() => {
    for (const k of nodes.keys()) if (k !== selfId) return true
    return false
  }, [nodes, selfId])

  const listId = `${id}-results`
  const showList = open && results.length > 0
  const activeIdx = Math.min(active, results.length - 1)

  const choose = (n: NodeRecord) => {
    onChange(addLink(links, n.id, kind, Date.now()))
    setQuery('')
    setActive(0)
  }

  return (
    <div>
      <span className="hud-label mb-1.5 block" id={`${id}-label`}>
        Links
      </span>

      {links.length > 0 && (
        <ul className="mb-2 flex flex-col gap-1" aria-labelledby={`${id}-label`}>
          {links.map((l, i) => {
            const target = nodes.get(l.targetId) ?? trash?.get(l.targetId)
            const name = target ? target.title : 'missing node'
            const state = !target ? 'missing' : target.deletedAt !== null ? 'in trash' : null
            const err = errors?.get(i)
            return (
              <li key={`${l.targetId}:${l.kind}`} className="flex flex-col">
                <div className="flex items-center gap-1">
                  <label className="sr-only" htmlFor={`${id}-kind-${i}`}>
                    Link kind for {name}
                  </label>
                  <select
                    id={`${id}-kind-${i}`}
                    className={`${SELECT} w-[9.5rem] shrink-0 py-1 text-[11px]`}
                    value={l.kind}
                    onChange={(e) => onChange(setLinkKind(links, i, e.target.value as LinkKind))}
                  >
                    {LINK_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                  <span className={`min-w-0 flex-1 truncate font-mono text-[12px] ${state ? 'text-concrete line-through' : 'text-bone'}`}>
                    {name}
                  </span>
                  {state && <span className="font-mono text-[10px] uppercase text-signal">{state}</span>}
                  <button
                    type="button"
                    className={`border border-bone/30 px-1.5 py-0.5 font-mono text-[11px] text-concrete hover:border-signal hover:bg-signal hover:text-void ${FOCUS}`}
                    aria-label={`Remove link to ${name}`}
                    onClick={() => onChange(links.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
                {err && <p className={ERROR_TEXT}>{err}</p>}
              </li>
            )
          })}
        </ul>
      )}

      <div className="flex items-start gap-1">
        <div className="shrink-0">
          <label className="sr-only" htmlFor={`${id}-newkind`}>
            Kind of the new link
          </label>
          <select
            id={`${id}-newkind`}
            className={`${SELECT} w-[9.5rem] text-[11px]`}
            value={kind}
            onChange={(e) => setKind(e.target.value as LinkKind)}
          >
            {LINK_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div className="relative min-w-0 flex-1">
          <label className="sr-only" htmlFor={`${id}-search`}>
            Find a node to link ({LINK_KIND_HINT[kind]})
          </label>
          <input
            id={`${id}-search`}
            className={INPUT}
            placeholder={hasCandidates ? 'Search titles to link…' : 'No other nodes yet'}
            disabled={!hasCandidates}
            value={query}
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showList ? `${listId}-${activeIdx}` : undefined}
            autoComplete="off"
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
              setOpen(true)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setOpen(true)
                setActive((a) => Math.min(a + 1, results.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(a - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (showList) choose(results[activeIdx])
              } else if (e.key === 'Escape' && showList) {
                // Close the list first; a second Esc reaches the editor.
                e.preventDefault()
                e.stopPropagation()
                setOpen(false)
              }
            }}
          />
          {showList && (
            <ul
              id={listId}
              role="listbox"
              aria-label="Matching nodes"
              className="absolute top-full right-0 left-0 z-10 max-h-56 overflow-y-auto border border-t-0 border-bone/40 bg-void"
            >
              {results.map((n, i) => (
                <li
                  key={n.id}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === activeIdx}
                  className={`flex cursor-pointer items-baseline justify-between gap-2 px-2 py-1 font-mono text-[12px] ${
                    i === activeIdx ? 'bg-bone text-void' : 'text-bone hover:bg-bone/10'
                  }`}
                  // mousedown, not click: the input's blur would close the list first.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    choose(n)
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <span className="truncate">{n.title}</span>
                  <span className={`shrink-0 text-[10px] uppercase ${i === activeIdx ? 'text-void/70' : 'text-concrete'}`}>{n.archetype}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
