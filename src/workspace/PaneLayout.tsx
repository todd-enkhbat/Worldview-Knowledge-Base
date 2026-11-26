import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { SlidersHorizontal } from '@phosphor-icons/react'

type Side = 'left' | 'right'
type Pane = 'navigation' | 'files'
type Placement = { side: Side; width: number }
export type PaneLayout = Record<Pane, Placement>
const key = 'worldview.pane-layout.v1'
const limits = { navigation: { min: 168, max: 320 }, files: { min: 180, max: 400 } }
const defaults: PaneLayout = { navigation: { side: 'left', width: 204 }, files: { side: 'right', width: 232 } }
const clamp = (pane: Pane, width: number) => Math.max(limits[pane].min, Math.min(limits[pane].max, Math.round(width)))

export function usePaneLayout() {
  const [layout, setLayout] = useState<PaneLayout>(() => {
    const result = { ...defaults }
    try {
      const value = JSON.parse(localStorage.getItem(key) || '{}')
      for (const pane of ['navigation', 'files'] as const) {
        const stored = value?.[pane]
        if (stored && ['left','right'].includes(stored.side) && Number.isFinite(stored.width)) {
          result[pane] = { side: stored.side, width: clamp(pane, stored.width) }
        }
      }
    } catch { /* Use device defaults. */ }
    return result
  })
  function change(pane: Pane, patch: Partial<Placement>) {
    setLayout(old => ({ ...old, [pane]: { ...old[pane], ...patch } }))
  }
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(layout)) } catch { /* Optional device preference. */ } }, [layout])
  const style = { '--navigation-width': layout.navigation.width + 'px', '--files-width': layout.files.width + 'px' } as CSSProperties
  return { layout, style, change }
}

type LayoutProps = Pick<ReturnType<typeof usePaneLayout>, 'layout' | 'change'>

export function LayoutMenu({ layout, change, library }: LayoutProps & { library: boolean }) {
  return <div className="workspace-layout-menu">
    <button type="button" className="knowledge-icon-button" popoverTarget="workspace-layout-options" aria-label="Panel layout" title="Panel layout"><SlidersHorizontal size={17} /></button>
    <div popover="auto" id="workspace-layout-options" aria-label="Panel layout">
      {(library ? ['navigation','files'] as const : ['navigation'] as const).map(pane => <fieldset key={pane}>
        <legend>{pane === 'navigation' ? 'Main sections' : 'Files'}</legend>
        <div className="pane-dock-choices">{(['left','right'] as const).map(side =>
          <button type="button" key={side} aria-label={`Dock ${pane} on the ${side}`} aria-pressed={layout[pane].side === side} onClick={() => change(pane, { side })}>{side === 'left' ? 'Left' : 'Right'}</button>
        )}</div>
        <label>Width<input type="range" aria-label={pane + ' width'} min={limits[pane].min} max={limits[pane].max} value={layout[pane].width}
          onChange={event => change(pane, { width: event.currentTarget.valueAsNumber })} /><output>{layout[pane].width} px</output></label>
      </fieldset>)}
    </div>
  </div>
}

export function PaneDivider({ pane, layout, change }: LayoutProps & { pane: Pane }) {
  const drag = useRef<{ x: number; width: number; value: number; root: HTMLElement; handle: HTMLElement } | null>(null)
  const { width, side } = layout[pane]
  const direction = side === 'left' ? 1 : -1
  const { min, max } = limits[pane]
  function finish(commit: boolean) {
    const state = drag.current
    if (!state) return
    drag.current = null
    state.root.removeAttribute('data-resizing')
    state.root.style.setProperty('--' + pane + '-width', (commit ? state.value : width) + 'px')
    state.handle.setAttribute('aria-valuenow', String(commit ? state.value : width))
    if (commit) change(pane, { width: state.value })
  }
  useEffect(() => () => { if (drag.current) drag.current.root.removeAttribute('data-resizing') }, [])
  return <div role="separator" aria-label={'Resize ' + pane} aria-orientation="vertical" aria-controls={'workspace-' + pane}
    tabIndex={0} aria-valuenow={width} aria-valuemin={min} aria-valuemax={max}
    data-edge={side === 'left' ? 'right' : 'left'} className="pane-divider"
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return
      const root = event.currentTarget.closest<HTMLElement>('.knowledge-workbench')!
      const panel = document.getElementById('workspace-' + pane)!
      drag.current = { x: event.clientX, width: panel.getBoundingClientRect().width, value: width, root, handle: event.currentTarget }
      root.dataset.resizing = pane
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
    }}
    onPointerMove={event => {
      const state = drag.current
      if (!state || !event.currentTarget.hasPointerCapture(event.pointerId)) return
      state.value = clamp(pane, state.width + direction * (event.clientX - state.x))
      state.root.style.setProperty('--' + pane + '-width', state.value + 'px')
      event.currentTarget.setAttribute('aria-valuenow', String(state.value))
    }}
    onPointerUp={() => finish(true)} onPointerCancel={() => finish(false)} onLostPointerCapture={() => finish(false)}
    onKeyDown={event => {
      const step = event.shiftKey ? 32 : 8
      const target = { ArrowLeft: width - direction * step, ArrowRight: width + direction * step, Home: min, End: max }[event.key]
      if (target !== undefined) { event.preventDefault(); change(pane, { width: clamp(pane, target) }) }
    }} />
}
