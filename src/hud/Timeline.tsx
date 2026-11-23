import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { ArrowCounterClockwise, Pause, Play } from '@phosphor-icons/react'
import { useApp, useWorld } from '../app/store.ts'
import { epochAtStep, formatByPrecision, stepAtEpoch } from '../domain/time.ts'
import { isEditableTarget } from '../world/camera/keyboard.ts'
import { getPlayhead, seekPlayhead, stepOfEpoch } from '../world/time/clock.ts'
import { axisAt, fractionOfStep, stepAtFraction, yearTicks } from '../world/time/timeScale.ts'
import { isModalOpen } from './shortcuts.ts'
import './Timeline.css'

export function togglePlayback() { const s = useApp.getState(); s.setClock({ playing: !s.clock.playing }) }

function countBorn(births: readonly number[], step: number): number {
  let lo = 0, hi = births.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (births[mid] <= step) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** A separate leaf keeps date context from rerendering the transport while time plays. */
function TimelineContext({ births }: { births: readonly number[] }) {
  const [count, setCount] = useState(() => {
    const ph = getPlayhead()
    return countBorn(births, ph.step + ph.acc)
  })
  useEffect(() => {
    const update = () => {
      const ph = getPlayhead()
      const next = countBorn(births, ph.step + ph.acc)
      setCount((previous) => previous === next ? previous : next)
    }
    update()
    const timer = setInterval(update, 250)
    // Paused seeks update immediately; playback publishes are sampled at four Hz.
    const unsubscribe = useApp.subscribe((s, previous) => {
      if (!s.clock.playing && s.clock.step !== previous.clock.step) update()
    })
    return () => { clearInterval(timer); unsubscribe() }
  }, [births])
  // The field uses exact record dates; rounding down can stop just before a birth.
  return <div className="timeline-context"><span aria-live="polite">{count} {count === 1 ? 'thought' : 'thoughts'} at this date</span>{count === 0 && births.length > 0 && <button type="button" onClick={() => seekPlayhead(Math.ceil(births[0]))}>Jump to first thought</button>}</div>
}

export function Timeline() {
  const settings = useWorld((s) => s.settings)
  const nodes = useWorld((s) => s.nodes)
  const playing = useApp((s) => s.clock.playing)
  const speed = useApp((s) => s.clock.speed)
  const settling = useApp((s) => s.clock.settling)
  const [now] = useState(() => Date.now())
  const [trackWidth, setTrackWidth] = useState(600)
  const track = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const date = useRef<HTMLSpanElement>(null)
  const dragging = useRef(false)
  const axis = useMemo(() => settings ? axisAt(settings, now) : null, [settings, now])
  const ticks = useMemo(() => settings ? yearTicks(settings, now, Math.max(2, Math.floor(trackWidth / 56))).filter((t) => t.label) : [], [settings, now, trackWidth])
  const births = useMemo(() => settings ? [...nodes.values()].map((n) => stepAtEpoch(n.temporalOrigin, settings.T0, settings.stepsPerYear)).sort((a, b) => a - b) : [], [nodes, settings])
  useEffect(() => {
    const element = track.current
    if (!element) return
    const measure = () => {
      const width = element.getBoundingClientRect().width
      if (width > 0) setTrackWidth(width)
    }
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure)
      observer.observe(element)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [settings])
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.code !== 'Space' || e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target) || isModalOpen()) return
      if (e.target instanceof Element && e.target.closest('button,a,summary,[role="button"]')) return
      e.preventDefault(); togglePlayback()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    if (!settings || !axis) return
    let raf = 0
    const update = () => {
      const ph = getPlayhead()
      const label = formatByPrecision(epochAtStep(ph.step + ph.acc, settings.T0, settings.stepsPerYear), 'day')
      if (head.current) head.current.style.left = `${fractionOfStep(ph.step + ph.acc, axis.maxStep) * 100}%`
      if (date.current) date.current.textContent = label
      track.current?.setAttribute('aria-valuenow', String(ph.step))
      track.current?.setAttribute('aria-valuetext', label)
      raf = requestAnimationFrame(update)
    }
    update(); return () => cancelAnimationFrame(raf)
  }, [settings, axis])
  if (!settings || !axis) return null
  const seekAt = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect()
    if (rect && rect.width > 0) seekPlayhead(stepAtFraction((clientX - rect.left) / rect.width, axis.maxStep))
  }
  const down = (e: PointerEvent<HTMLDivElement>) => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); dragging.current = true; seekAt(e.clientX) }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = getPlayhead().step
    const delta = e.shiftKey ? 600 : 50
    const next = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? step + delta : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? step - delta : e.key === 'Home' ? 0 : e.key === 'End' ? axis.maxStep : null
    if (next !== null) { e.preventDefault(); seekPlayhead(Math.min(axis.maxStep, Math.max(0, next))) }
  }
  return <section className="timeline-panel" aria-label="Timeline">
    <div className="timeline-top"><span className="timeline-heading">Your world, through time</span><span ref={date} className="timeline-date" /><span className="timeline-settling" role="status">{settling ? 'Updating…' : ''}</span><button className="timeline-present" onClick={() => seekPlayhead(stepOfEpoch(settings, Date.now()))}>Back to today</button></div>
    <div className="timeline-bottom"><button className="timeline-play" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlayback}>{playing ? <Pause size={17} weight="fill" /> : <Play size={17} weight="fill" />}</button><button className="timeline-reverse" aria-label="Reverse playback" aria-pressed={speed < 0} title="Reverse time" onClick={() => useApp.getState().setClock({ speed: -speed })}><ArrowCounterClockwise size={17} /></button>
      <div className="timeline-track" ref={track} role="slider" aria-label="Playhead" aria-valuemin={0} aria-valuemax={axis.maxStep} tabIndex={0} onPointerDown={down} onPointerMove={(e) => { if (dragging.current) seekAt(e.clientX) }} onPointerUp={() => { dragging.current = false }} onPointerCancel={() => { dragging.current = false }} onLostPointerCapture={() => { dragging.current = false }} onKeyDown={key}>
        <div className="timeline-line" />
        {ticks.map((t) => <span className="timeline-year" key={t.year} style={{ left: `${fractionOfStep(t.step, axis.maxStep) * 100}%` }}><i />{t.year}</span>)}
        {[...nodes.values()].map((n) => <span key={n.id} className="timeline-birth" title={n.title} style={{ left: `${fractionOfStep(stepAtEpoch(n.temporalOrigin, settings.T0, settings.stepsPerYear), axis.maxStep) * 100}%` }} />)}
        <span className="timeline-now" style={{ left: `${fractionOfStep(axis.presentStep, axis.maxStep) * 100}%` }} />
        <div className="timeline-head" ref={head}><span /></div>
      </div>
      <select className="timeline-speed" aria-label="Playback speed" value={Math.abs(speed)} onChange={(e) => useApp.getState().setClock({ speed: Math.sign(speed) * Number(e.target.value) })}>{[0.1,0.5,1,2,5,10].map((s) => <option key={s} value={s}>{s}×</option>)}</select>
    </div>
    <TimelineContext births={births} />
  </section>
}
