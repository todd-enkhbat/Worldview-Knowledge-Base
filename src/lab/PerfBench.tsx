import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useApp } from '../app/store.ts'
import { TIER_PRESETS } from '../world/quality.ts'
import { type FixtureWorld, enterFixtureWorld, exitFixtureWorld } from './perf/fixtureWorld.ts'
import { PERF_DPR, PerfScene } from './perf/PerfScene.tsx'
import { type PerfReport, PERF_SCRIPT, PerfRun } from './perf/runner.ts'

// #/lab/perf — criterion P. A fixed fixture scene (the demo world at a fixed T0 and now,
// plus the four CC-BY fixture memories when public/fixtures has them) in a fixed
// 1920 × 1080 CSS canvas at DPR 1.5, a scripted 30 s camera path at 1× and a 10× scrub.
// Records rAF intervals, main-thread frame work, GPU time (timer query where available),
// the share of frames > 1.5× vsync and renderer.info; the JSON comes from window.__perf()
// or the copy button. The user's world is swapped out for the run and back afterwards.

export const PERF_CSS = { width: 1920, height: 1080 } as const

declare global {
  interface Window {
    /** Resolves with the #/lab/perf report when the run finishes (at once if it has). */
    __perf?: () => Promise<PerfReport>
    /** Current phase and status of the #/lab/perf run. */
    __perfState?: () => { phase: string; status: string; error: string | null }
  }
}

function useRunState(run: PerfRun) {
  const subscribe = useMemo(() => (cb: () => void) => run.subscribe(cb), [run])
  // A string snapshot keeps useSyncExternalStore stable between emits.
  const key = useSyncExternalStore(subscribe, () => `${run.phase}|${run.status}|${run.report ? 1 : 0}`)
  return { key, phase: run.phase, status: run.status, report: run.report, error: run.error }
}

export default function PerfBench() {
  const [runKey, setRunKey] = useState(0)
  const run = useMemo(() => {
    void runKey
    return new PerfRun()
  }, [runKey])
  const [world, setWorld] = useState<FixtureWorld | null>(null)
  const [swapError, setSwapError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)
  const state = useRunState(run)

  // Swap in the fixture world for the page's lifetime; restore the user's world after.
  useEffect(() => {
    let cancelled = false
    const app = useApp.getState()
    const prevQuality = app.quality
    const prevClock = app.clock
    useApp.setState({ mode: 'orbit', prevMode: 'orbit', selectedId: null, hoveredId: null, focusedId: null })
    app.setQuality({ ...TIER_PRESETS.high, dpr: PERF_DPR, tier: 'high' })
    enterFixtureWorld()
      .then((w) => {
        if (!cancelled) setWorld(w)
      })
      .catch((e: unknown) => {
        if (!cancelled) setSwapError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
      useApp.getState().setQuality(prevQuality)
      useApp.getState().setClock({ speed: prevClock.speed, playing: false })
      void exitFixtureWorld()
    }
  }, [])

  useEffect(() => {
    window.__perf = () => run.done()
    window.__perfState = () => ({ phase: run.phase, status: run.status, error: run.error })
    return () => {
      if (window.__perf) delete window.__perf
      if (window.__perfState) delete window.__perfState
    }
  }, [run])

  const report = state.report
  const json = useMemo(() => (report ? JSON.stringify(report, null, 2) : ''), [report])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked: select the text for a manual copy.
      const pre = preRef.current
      if (pre) {
        const range = document.createRange()
        range.selectNodeContents(pre)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
    }
  }

  const v = report?.verdict
  return (
    <div className="relative h-full w-full overflow-auto bg-void font-mono text-bone">
      <header className="sticky left-0 top-0 z-10 flex flex-wrap items-center gap-4 border-b border-bone/10 bg-void px-4 py-2 text-[11px]">
        <a className="uppercase tracking-[0.2em] text-concrete hover:text-bone" href="#/lab">
          lab
        </a>
        <span className="uppercase tracking-[0.2em]">perf · criterion P</span>
        <span className={state.phase === 'error' || swapError ? 'text-signal' : state.phase === 'done' ? (v?.pass ? 'text-glass' : 'text-signal') : 'text-concrete'}>
          {swapError ? `world swap failed: ${swapError}` : `${state.phase} · ${state.status}`}
        </span>
        {v && (
          <span className="text-concrete">
            slow frames {(v.slowShare * 100).toFixed(2)} % (≤ {v.slowShareLimit * 100} %) · median main {v.medianMainMs.toFixed(2)} ms (&lt; {v.medianMainLimitMs} ms) ·{' '}
            {report?.refresh.hz.toFixed(0)} Hz
          </span>
        )}
        <span className="ml-auto flex gap-2">
          <button className="hud-btn" disabled={!report} onClick={() => void copy()}>
            {copied ? 'copied' : 'copy JSON'}
          </button>
          <button className="hud-btn" disabled={state.phase !== 'done' && state.phase !== 'error'} onClick={() => setRunKey((k) => k + 1)}>
            run again
          </button>
        </span>
      </header>
      <div className="relative" style={{ width: PERF_CSS.width, height: PERF_CSS.height }}>
        {world && <PerfScene key={runKey} run={run} world={world} />}
        {report && (
          <div className="hud-panel absolute left-4 top-4 max-h-[calc(100%-2rem)] w-[560px] overflow-auto p-3">
            <div className="hud-label mb-2">report · window.__perf()</div>
            <pre ref={preRef} className="whitespace-pre-wrap break-all text-[10px] leading-snug text-bone">
              {json}
            </pre>
          </div>
        )}
      </div>
      <p className="px-4 py-2 text-[10px] text-concrete">
        {PERF_CSS.width}×{PERF_CSS.height} CSS at DPR {PERF_DPR}. Warm-up ≥ {PERF_SCRIPT.warmup} s, camera path {PERF_SCRIPT.path} s at 1×, scrub{' '}
        {PERF_SCRIPT.scrub} s at {PERF_SCRIPT.scrubSpeed}×. Keep the window visible and at native refresh; Safari is the gate.
      </p>
    </div>
  )
}
