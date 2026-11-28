import { DotsSixVertical } from '@phosphor-icons/react'
import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'

const orderKey = 'worldview.sidebar-order.v1'

function readOrder<T extends string>(defaults: readonly T[]): T[] {
  let saved: unknown
  try { saved = JSON.parse(localStorage.getItem(orderKey) ?? 'null') } catch { /* Use the default order. */ }
  if (!Array.isArray(saved)) return [...defaults]
  return [...new Set([...saved.filter((id): id is T => typeof id === 'string' && defaults.some(section => section === id)), ...defaults])]
}

export function SidebarSections<T extends string>({ defaults, collapsed, renderLink, label }: {
  defaults: readonly T[]
  collapsed: boolean
  renderLink: (id: T) => ReactNode
  label: (id: T) => string
}) {
  const [order, setOrder] = useState(() => readOrder(defaults))
  const [selected, setSelected] = useState<T | null>(null)
  const [target, setTarget] = useState<T | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const drag = useRef<{ id: T; pointerId: number; startY: number } | null>(null)
  const didDrag = useRef(false)
  const list = useRef<HTMLDivElement>(null)
  const focusAfterMove = useRef<T | null>(null)

  useLayoutEffect(() => {
    if (focusAfterMove.current) {
      list.current?.querySelector<HTMLButtonElement>(`[data-section-id="${focusAfterMove.current}"] > button`)?.focus()
      focusAfterMove.current = null
    }
  }, [order])

  function move(id: T, position: number, restoreFocus = false) {
    const previous = order.indexOf(id)
    if (previous === position || position < 0 || position >= order.length) return
    const next = [...order]
    next.splice(previous, 1)
    next.splice(position, 0, id)
    if (restoreFocus) focusAfterMove.current = id
    setOrder(next)
    setAnnouncement(`${label(id)} moved to position ${position + 1} of ${order.length}.`)
    try { localStorage.setItem(orderKey, JSON.stringify(next)) } catch { /* Keep the current session's order. */ }
  }

  function rowUnderPointer(event: PointerEvent<HTMLButtonElement>): T | null {
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-section-id]')
    if (!row || row.parentElement !== list.current) return null
    return order.find(id => id === row.dataset.sectionId) ?? null
  }

  function clearDrag() {
    drag.current = null
    setTarget(null)
  }

  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const destination = rowUnderPointer(event)
    didDrag.current ||= Math.abs(event.clientY - current.startY) >= 4
    if (destination && didDrag.current) move(current.id, order.indexOf(destination), true)
    clearDrag()
  }

  function dismissActions() {
    if (drag.current) didDrag.current = true
    clearDrag()
    if (selected) list.current?.querySelector<HTMLButtonElement>(`[data-section-id="${selected}"] > button`)?.focus()
    setSelected(null)
  }

  const selectedIndex = selected === null ? -1 : order.indexOf(selected)
  return <>
    <div ref={list} className="knowledge-nav-primary" onKeyDown={(event) => {
      if ((!drag.current && selected === null) || event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      dismissActions()
    }}>
      {order.map((id, position) => <div key={id} className="knowledge-nav-primary-row" data-section-id={id} data-drop-target={target === id || undefined} data-selected={!collapsed && selected === id || undefined}>
        {renderLink(id)}
        {!collapsed && <button type="button" className="knowledge-nav-drag-handle" aria-label={`Reorder ${label(id)}`} aria-expanded={selected === id} title="Drag or use the arrow keys"
          onClick={(event) => { if (event.detail === 0 || !didDrag.current) setSelected(selected === id ? null : id) }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            move(id, position + (event.key === 'ArrowUp' ? -1 : 1), true)
          }}
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
            didDrag.current = false
            drag.current = { id, pointerId: event.pointerId, startY: event.clientY }
          }}
          onPointerMove={(event) => {
            const current = drag.current
            if (!current || current.pointerId !== event.pointerId) return
            if (Math.abs(event.clientY - current.startY) < 4) { setTarget(null); return }
            didDrag.current = true
            setSelected(null)
            const destination = rowUnderPointer(event)
            setTarget(destination === current.id ? null : destination)
          }}
          onPointerUp={endDrag} onPointerCancel={clearDrag} onLostPointerCapture={clearDrag}>
          <DotsSixVertical size={18} aria-hidden="true" />
        </button>}
      </div>)}
    </div>
    {!collapsed && selected !== null && <div className="knowledge-nav-order-actions" onKeyDown={(event) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      dismissActions()
    }}>
      <button type="button" disabled={selectedIndex <= 0} onClick={() => move(selected, selectedIndex - 1, true)}>Move up</button>
      <button type="button" disabled={selectedIndex >= order.length - 1} onClick={() => move(selected, selectedIndex + 1, true)}>Move down</button>
      <button type="button" onClick={dismissActions}>Done</button>
    </div>}
    <span className="knowledge-sr-only" role="status">{announcement}</span>
  </>
}
