import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { SPEEDS, useApp, useWorld } from '../app/store.ts'
import { epochAtStep, formatByPrecision } from '../domain/time.ts'
import type { Archetype, WorldSettings } from '../domain/types.ts'
import { isEditableTarget } from '../world/camera/keyboard.ts'
import { getPlayhead, seekPlayhead, stepOfEpoch } from '../world/time/clock.ts'
import { useSimStats } from '../world/time/physicsClient.ts'
import { axisAt, fractionOfStep, stepAtFraction, yearTicks } from '../world/time/timeScale.ts'
import { isModalOpen } from './shortcuts.ts'

// The time bar along the bottom of the HUD: T0 on the left, the present, then five years
// of future. Year ticks, one birth tick per node (coloured by archetype), a draggable
// playhead, transport (Space toggles play), speeds and the physics readouts. The playhead
// and the date/step readouts move in a rAF loop straight from getPlayhead(), so playback
// never re-renders React; the stats come from useSimStats, which changes ≤ 1 Hz.

const MAGNITUDES = SPEEDS.filter((s) => s > 0)

const BIRTH_COLOR: Readonly<Record<Archetype, string>> = {
  idea: 'var(--color-glass)',
  entity: 'var(--color-bone)',
  lens: 'var(--color-brass)',
  document: 'var(--color-concrete)',
  memory: 'var(--color-ember)',
  demon: 'var(--color-signal)',
}

/** Arrow keys on the playhead: a month (Shift: a year). */
const MONTH_STEPS = 50

const COLLAPSE_KEY = 'hud.timeline.collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(v: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0')
  } catch {
    // Storage blocked (private window): the bar just forgets.
  }
}

const groupDigits = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

function formatLedger(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  const s = v < 0 ? '−' : '+'
  if (a === 0) return '0'
  return a < 1e-3 || a >= 1e4 ? `${s}${a.toExponential(1)}` : `${s}${a.toFixed(3)}`
}

/** Wall clock that re-renders once a minute (the present marker and the horizon creep). */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  return now
}

export function togglePlayback(): void {
  const app = useApp.getState()
  app.setClock({ playing: !app.clock.playing })
}

/** Space plays/pauses unless focus is in a field or on a control (where Space activates it). */
function useSpaceToggle(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.defaultPrevented || e.repeat) return
      if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target)) return
      if (e.target instanceof Element && e.target.closest('button, a, summary, [role="button"]')) return
      if (isModalOpen()) return
      e.preventDefault()
      togglePlayback()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export function Timeline() {
  const settings = useWorld((s) => s.settings)
  useSpaceToggle()
  if (!settings) return null
  return <TimelineBar settings={settings} />
}

function TimelineBar({ settings }: { settings: WorldSettings }) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const now = useMinuteClock()
  const { maxStep, presentStep } = useMemo(() => axisAt(settings, now), [settings, now])
  const ticks = useMemo(() => yearTicks(settings, now), [settings, now])
  const nodes = useWorld((s) => s.nodes)
  const births = useMemo(() => {
    const out: { id: string; x: number; color: string }[] = []
    for (const n of nodes.values()) {
      out.push({ id: n.id, x: fractionOfStep(stepOfEpoch(settings, n.temporalOrigin), maxStep) * 1000, color: BIRTH_COLOR[n.archetype] })
    }
    return out
  }, [nodes, settings, maxStep])

  const trackRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const dateRef = useRef<HTMLSpanElement>(null)
  const stepRef = useRef<HTMLSpanElement>(null)
  const dragging = useRef(false)

  // The playhead and its readouts follow the clock every frame without React.
  useEffect(() => {
    let raf = 0
    let last = Number.NaN
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const ph = getPlayhead()
      const s = ph.step + ph.acc
      if (s === last) return
      last = s
      const pct = `${fractionOfStep(s, maxStep) * 100}%`
      if (headRef.current) headRef.current.style.left = pct
      const date = formatByPrecision(epochAtStep(s, settings.T0, settings.stepsPerYear), 'day')
      if (dateRef.current) dateRef.current.textContent = date
      if (stepRef.current) stepRef.current.textContent = groupDigits(ph.step)
      const track = trackRef.current
      if (track) {
        track.setAttribute('aria-valuenow', String(ph.step))
        track.setAttribute('aria-valuetext', date)
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [settings, maxStep, collapsed])

  const seekAt = (clientX: number) => {
    const el = trackRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width <= 0) return
    seekPlayhead(stepAtFraction((clientX - r.left) / r.width, maxStep))
  }
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragging.current = true
    seekAt(e.clientX)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging.current) seekAt(e.clientX)
  }
  const endDrag = () => {
    dragging.current = false
  }
  const onTrackKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = getPlayhead().step
    const big = e.shiftKey ? 12 : 1
    let next: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = step + MONTH_STEPS * big
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = step - MONTH_STEPS * big
    else if (e.key === 'PageUp') next = step + 12 * MONTH_STEPS
    else if (e.key === 'PageDown') next = step - 12 * MONTH_STEPS
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = maxStep
    if (next === null) return
    e.preventDefault()
    seekPlayhead(Math.min(maxStep, Math.max(0, next)))
  }
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      writeCollapsed(!c)
      return !c
    })
  }

  const presentPct = `${fractionOfStep(presentStep, maxStep) * 100}%`
  const track = (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label="Playhead"
      aria-valuemin={0}
      aria-valuemax={maxStep}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onTrackKey}
      className={`relative cursor-ew-resize touch-none outline-none focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-signal ${collapsed ? 'h-2' : 'mt-2 h-10'}`}
    >
      {/* The future: from the present to the horizon. */}
      <div aria-hidden className="absolute inset-y-0 right-0 bg-bone/[0.06]" style={{ left: presentPct }} />
      <div aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-bone/25" />
      {!collapsed &&
        ticks.map((t) => {
          const left = `${fractionOfStep(t.step, maxStep) * 100}%`
          return (
            <div key={t.year} aria-hidden className="absolute top-0" style={{ left }}>
              <div className={`w-px ${t.label ? 'h-3 bg-bone/50' : 'h-1.5 bg-bone/25'}`} />
              {t.label && <span className="absolute left-1 top-0 text-[9px] leading-none text-concrete tabular-nums">{t.year}</span>}
            </div>
          )
        })}
      {!collapsed && (
        <svg aria-hidden className="absolute inset-x-0 bottom-0 h-3 w-full" viewBox="0 0 1000 10" preserveAspectRatio="none">
          {births.map((b) => (
            <line key={b.id} x1={b.x} x2={b.x} y1={0} y2={10} stroke={b.color} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
      )}
      <div aria-hidden className="absolute inset-y-0 w-px bg-glass" style={{ left: presentPct }}>
        {!collapsed && <span className="absolute -top-0.5 left-1 text-[9px] leading-none text-glass">NOW</span>}
      </div>
      <div ref={headRef} aria-hidden className="pointer-events-none absolute -inset-y-1 w-px bg-signal" style={{ left: 0 }}>
        <div className="absolute -left-[3px] -top-0 h-[7px] w-[7px] bg-signal" />
      </div>
    </div>
  )

  if (collapsed) {
    return (
      <section aria-label="Timeline" className="hud-panel mx-3 mb-3 flex shrink-0 select-none items-center gap-3 px-3 py-1.5">
        <PlayButton />
        <div className="min-w-0 flex-1">{track}</div>
        <span ref={dateRef} className="tabular-nums text-[11px] text-bone" />
        <span ref={stepRef} className="sr-only" />
        <SettlingFlag />
        <button type="button" className="hud-btn px-1.5 py-0" onClick={toggleCollapsed} aria-label="Expand the timeline" title="Expand">
          ▴
        </button>
      </section>
    )
  }

  return (
    <section aria-label="Timeline" className="hud-panel mx-3 mb-3 shrink-0 select-none px-3 pb-2 pt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Transport />
        <div className="flex items-baseline gap-3 tabular-nums">
          <span ref={dateRef} className="text-[13px] text-bone" title="Playhead date (UTC)" />
          <span className="hud-label">
            step <span ref={stepRef} className="text-[11px] normal-case tracking-normal text-bone" />
          </span>
        </div>
        <Readouts />
        <button
          type="button"
          className="hud-btn ml-auto px-1.5 py-0"
          onClick={toggleCollapsed}
          aria-label="Collapse the timeline"
          title="Collapse"
        >
          ▾
        </button>
      </div>
      {track}
    </section>
  )
}

function PlayButton() {
  const playing = useApp((s) => s.clock.playing)
  return (
    <button
      type="button"
      className="hud-btn w-8 px-0 py-0.5 text-center"
      onClick={togglePlayback}
      aria-label={playing ? 'Pause' : 'Play'}
      aria-keyshortcuts="Space"
      title={`${playing ? 'Pause' : 'Play'} (Space)`}
    >
      {playing ? '❚❚' : '▶'}
    </button>
  )
}

function Transport() {
  const speed = useApp((s) => s.clock.speed)
  const setClock = useApp((s) => s.setClock)
  const dir = speed < 0 ? -1 : 1
  const mag = Math.abs(speed)
  const present = () => {
    const settings = useWorld.getState().settings
    if (settings) seekPlayhead(stepOfEpoch(settings, Date.now()))
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <PlayButton />
      <button
        type="button"
        className={`hud-btn px-1.5 py-0.5 ${dir < 0 ? 'bg-bone text-void' : ''}`}
        aria-pressed={dir < 0}
        onClick={() => setClock({ speed: -speed })}
        title={dir < 0 ? 'Playing backwards: switch to forwards' : 'Play backwards'}
        aria-label="Reverse"
      >
        {dir < 0 ? '◀◀' : '▶▶'}
      </button>
      <div role="group" aria-label="Speed" className="flex">
        {MAGNITUDES.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mag === m}
            onClick={() => setClock({ speed: dir * m })}
            className={`hud-btn -ml-px px-1.5 py-0.5 normal-case tracking-normal first:ml-0 ${mag === m ? 'bg-bone text-void' : ''}`}
            title={`${m}×: ${m / 10} years per second`}
          >
            {m}×
          </button>
        ))}
      </div>
      <button type="button" className="hud-btn px-1.5 py-0.5" onClick={present} title="Playhead to the present">
        Present
      </button>
    </div>
  )
}

function SettlingFlag() {
  const settling = useApp((s) => s.clock.settling)
  if (!settling) return null
  return (
    <span role="status" className="hud-label animate-pulse text-ember" title="Recomputing the world after an edit or a seek">
      settling
    </span>
  )
}

function Readouts() {
  const sim = useSimStats(useShallow((s) => ({ mode: s.mode, stats: s.stats, error: s.error })))
  const st = sim.stats
  const e = st?.energy ?? null
  const energyTitle = e
    ? `Birth-compensated energy ledger E − E₀ − ΣΔE_births − ramp work, since step ${e.origin}.\nE − E₀ = ${e.raw.toPrecision(4)} · births ${e.births.toPrecision(4)} · ramp ${e.rampWork.toPrecision(4)}`
    : 'Energy ledger (pending)'
  return (
    <dl className="m-0 flex flex-wrap items-baseline gap-x-3 gap-y-1 tabular-nums">
      <Readout label="|A|" value={st ? String(st.activeCount) : '—'} title="Nodes born at the playhead" />
      <Readout label="S" value={st?.S == null ? '—' : st.S.toFixed(2)} title="Entropy −D_KL of the born nodes (nats); — below 5 nodes" />
      <Readout label="ΔE" value={e ? formatLedger(e.ledger) : '—'} title={energyTitle} />
      <Readout label="ckpt" value={st ? String(st.checkpoints) : '—'} title="Physics checkpoints held in memory" />
      {st !== null && st.overflowSentinel > 0 && (
        <Readout label="ovf" value={String(st.overflowSentinel)} title="Integer overflow sentinel (should stay 0)" tone="text-signal" />
      )}
      {sim.mode === 'static' && (
        <div className="hud-label text-signal" title={sim.error ?? 'Physics worker unavailable'}>
          static
        </div>
      )}
      <div>
        <SettlingFlag />
      </div>
    </dl>
  )
}

function Readout({ label, value, title, tone = 'text-bone' }: { label: string; value: string; title: string; tone?: string }) {
  return (
    <div className="flex items-baseline gap-1" title={title}>
      <dt className="hud-label">{label}</dt>
      <dd className={`m-0 text-[11px] ${tone}`}>{value}</dd>
    </div>
  )
}
