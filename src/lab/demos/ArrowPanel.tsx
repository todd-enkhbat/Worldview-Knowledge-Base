import { useState } from 'react'
import { cancelJobs, runJob, useLabJobs } from './labClient.ts'
import type { ArrowResult, Series } from './labSim.ts'
import { SeriesPlot, type PlotSeries } from './SeriesPlot.tsx'

// Demo 4, the arrow of time (criterion S): run forward ≥ 300 s, nudge one particle by 1 LSB,
// flip, run the same time again. Without the nudge this would retrace the past exactly
// (the control does, bit for bit); with it, chaos amplifies the nudge and S keeps rising.
// Pass: (S_ret − S₀)/(S_fwd − S₀) ≥ 0.5 and the control returns the initial hash.

const DURATIONS = [300, 600] as const

/** Return branches are drawn after the forward branch (t ∈ [T, 2T]). */
function shift(series: Series, dt: number): [number, number][] {
  return series.map(([t, s]) => [t + dt, s])
}

function plotSeries(r: ArrowResult): PlotSeries[] {
  return [
    { id: 'fwd', points: r.forward, color: 'var(--color-ember)', label: 'forward' },
    { id: 'ret', points: shift(r.perturbed, r.seconds), color: 'var(--color-signal)', label: 'flip + 1 LSB: would-be return' },
    { id: 'ctl', points: shift(r.control, r.seconds), color: 'var(--color-glass)', label: 'control: flip, no nudge', dashed: true },
  ]
}

export function ArrowPanel() {
  const job = useLabJobs((s) => s.arrow)
  const [seconds, setSeconds] = useState<number>(300)

  const r = job.result
  const p = job.progress
  const frac = p && p.total > 0 ? p.done / p.total : 0
  const offset = p ? (p.phase === 'forward' ? 0 : p.phase === 'build' ? 0 : seconds) : 0
  const preview: PlotSeries[] = job.running
    ? [{ id: 'live', points: shift(job.preview, offset), color: p?.phase === 'forward' ? 'var(--color-ember)' : p?.phase === 'perturbed' ? 'var(--color-signal)' : 'var(--color-glass)', label: p?.phase }]
    : []

  return (
    <section className="hud-panel mb-6 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="hud-label text-bone">Arrow of time</h2>
        <span className={`font-mono text-[11px] uppercase tracking-wider ${r ? (r.pass ? 'text-glass' : 'text-signal') : 'text-concrete'}`}>
          {job.running ? `${p?.phase ?? 'starting'} · ${(frac * 100).toFixed(0)}%` : r ? (r.pass ? 'pass' : 'fail') : job.error ? 'error' : 'idle'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <select
            className="border border-bone/30 bg-void px-1 py-1 font-mono text-[11px] text-bone"
            value={seconds}
            onChange={(e) => setSeconds(Number(e.target.value))}
            disabled={job.running}
          >
            {DURATIONS.map((v) => (
              <option key={v} value={v}>
                {v} s forward
              </option>
            ))}
          </select>
          {job.running ? (
            <button className="hud-btn" onClick={() => cancelJobs()}>
              cancel
            </button>
          ) : (
            <button className="hud-btn" onClick={() => void runJob('arrow', { steps: seconds * 60 })}>
              run
            </button>
          )}
        </div>
      </div>
      <p className="mb-3 max-w-[80ch] text-[11px] leading-relaxed text-concrete">
        Forward {seconds} s of sim time, then the Loschmidt flip with particle 0 moved by one LSB (2⁻¹⁹ u), then forward{' '}
        {seconds} s again. Exact dynamics would bring S back to S₀; chaos turns the nudge into a different future and S keeps
        rising. The unperturbed control runs the same flip and returns bit for bit. Runs in a worker (≈ 3 × {seconds * 60}{' '}
        steps plus entropy samples).
      </p>
      <div className="mb-2 h-[3px] w-full bg-bone/10">
        <div className="h-full bg-ember" style={{ width: `${(job.running ? frac : r ? 1 : 0) * 100}%` }} />
      </div>
      <SeriesPlot
        height={240}
        series={r ? plotSeries(r) : preview}
        hLines={r ? [{ at: r.s0, color: 'var(--color-concrete)', label: 'S₀' }] : []}
        vLines={r ? [{ at: r.seconds, color: 'var(--color-bone)', label: 'flip' }] : []}
        xDomain={r || job.running ? [0, 2 * (r?.seconds ?? seconds)] : undefined}
        xLabel="sim time (s)"
        yLabel="S (nats)"
      />
      {r && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[11px]">
          <dt className="text-concrete">S₀ → S_fwd → S_ret</dt>
          <dd className="text-bone">
            {r.s0.toFixed(3)} → {r.sFwd.toFixed(3)} → {r.sRet.toFixed(3)}
          </dd>
          <dt className="text-concrete">(S_ret − S₀)/(S_fwd − S₀)</dt>
          <dd className={r.ratio >= r.threshold ? 'text-glass' : 'text-signal'}>
            {r.ratio.toFixed(3)} {r.ratio >= r.threshold ? '≥' : '<'} {r.threshold}
          </dd>
          <dt className="text-concrete">did not come home</dt>
          <dd className="text-bone">
            {r.strayed} / {r.n} particles (&gt; 0.1 u from their start)
          </dd>
          <dt className="text-concrete">control return</dt>
          <dd className={r.controlReturn ? 'text-glass' : 'text-signal'}>
            {r.controlReturn ? 'bit-identical' : 'MISMATCH'} ({r.controlHash} vs {r.h0}); S at return {r.sControlEnd.toFixed(3)}
          </dd>
          <dt className="text-concrete">forward growth</dt>
          <dd className="text-bone">
            {r.growth ? `τ = ${r.growth.tau.toFixed(3)} s · t₉₅ = ${r.growth.t95?.toFixed(2) ?? '—'} s` : '—'}
          </dd>
          <dt className="text-concrete">wall time</dt>
          <dd className="text-bone">{(r.ms / 1000).toFixed(1)} s</dd>
        </dl>
      )}
      {job.error && <p className="mt-2 font-mono text-[11px] text-signal">{job.error}</p>}
    </section>
  )
}
