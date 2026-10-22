import { useMemo, useState } from 'react'
import { useWorld } from '../app/store.ts'
import { KIND_PRECEDENCE, LINK_STYLE, buildTypedLinks } from '../world/links/style.ts'

// Link key, bottom-left over the stage. Open on a first visit, then remembered per device.
// Kinds with no links in this world are listed dimmed, so the key never changes shape.

const KEY = 'hyperspace.linkLegend'

function readOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) !== 'closed'
  } catch {
    return true
  }
}

function Swatch({ kind }: { kind: keyof typeof LINK_STYLE }) {
  const s = LINK_STYLE[kind]
  const dash = s.dash ? `${Math.round(s.dash[0] * 6)} ${Math.round(s.dash[1] * 6)}` : undefined
  return (
    <svg width="34" height="10" viewBox="0 0 34 10" aria-hidden="true" className="shrink-0">
      {s.gap > 0 ? (
        <>
          <line x1="1" y1="5" x2="14" y2="5" stroke={s.color} strokeWidth={s.width} />
          <line x1="20" y1="5" x2="33" y2="5" stroke={s.color} strokeWidth={s.width} />
        </>
      ) : (
        <line x1="1" y1="5" x2={s.arrow ? 30 : 33} y2="5" stroke={s.color} strokeWidth={s.width} strokeDasharray={dash} />
      )}
      {s.arrow && <polyline points="25,1.5 31,5 25,8.5" fill="none" stroke={s.color} strokeWidth={1.4} />}
    </svg>
  )
}

export function LinkLegend() {
  const nodes = useWorld((s) => s.nodes)
  const counts = useMemo(() => {
    const c = new Map<string, number>()
    for (const l of buildTypedLinks(nodes)) c.set(l.kind, (c.get(l.kind) ?? 0) + 1)
    return c
  }, [nodes])
  const [open, setOpen] = useState(readOpen)
  const toggle = () => {
    const next = !open
    setOpen(next)
    try {
      globalThis.localStorage?.setItem(KEY, next ? 'open' : 'closed')
    } catch {
      // Storage blocked: the choice lasts for this session.
    }
  }
  if (nodes.size === 0) return null
  return (
    <div data-label-avoid className="hud-panel pointer-events-auto absolute bottom-3 left-3 z-10 px-2 py-1.5">
      <button type="button" className="hud-label flex w-full items-center justify-between gap-3" aria-expanded={open} onClick={toggle}>
        <span>Links</span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
          {KIND_PRECEDENCE.map((k) => {
            const n = counts.get(k) ?? 0
            return (
              <li key={k} className={`flex items-center gap-2 text-[11px] ${n ? '' : 'opacity-40'}`}>
                <Swatch kind={k} />
                <span>{LINK_STYLE[k].verb}</span>
                <span className="ml-auto pl-2 text-concrete">{n}</span>
              </li>
            )
          })}
          <li className="text-[10px] text-concrete">Arrows point from the source idea.</li>
        </ul>
      )}
    </div>
  )
}
