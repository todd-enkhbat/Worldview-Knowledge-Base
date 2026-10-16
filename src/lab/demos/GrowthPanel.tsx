import { useMemo } from 'react'
import { cancelJobs, runJob, useLabJobs } from './labClient.ts'
import { SeriesPlot } from './SeriesPlot.tsx'

// Demo 5: the measured growth rate. S(t) from the Past-Hypothesis start at fine resolution,
// fitted by S_plat − (S_plat − S₀)e^{−t/τ} (growthFit.ts). The reference value is recorded
// in docs/PHYSICS.md "Measured growth rate".

/** docs/PHYSICS.md, "Measured growth rate" (3 seeds, 60 s at every step). */
const DOCUMENTED_TAU = 0.75

export function GrowthPanel() {
  const job = useLabJobs((s) => s.growth)
  const r = job.result
  const fitted = useMemo(() => {
    if (!r) return []
    const { plateau, s0Fit, tau } = r.fit
    const end = r.series[r.series.length - 1][0]
    const out: [number, number][] = []
    for (let i = 0; i <= 300; i++) {
      const t = (end * i) / 300
      out.push([t, plateau - (plateau - s0Fit) * Math.exp(-t / tau)])
    }
    return out
  }, [r])
  const p = job.progress
  const frac = p && p.total > 0 ? p.done / p.total : 0

  return (
    <section className="hud-panel mb-6 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="hud-label text-bone">Growth rate</h2>
        <span className="font-mono text-[11px] uppercase tracking-wider text-concrete">
          {job.running ? `${(frac * 100).toFixed(0)}%` : r ? `τ = ${r.fit.tau.toFixed(3)} s` : job.error ? 'error' : 'idle'}
        </span>
        <div className="ml-auto">
          {job.running ? (
            <button className="hud-btn" onClick={() => cancelJobs()}>
              cancel
            </button>
          ) : (
            <button className="hud-btn" onClick={() => void runJob('growth')}>
              measure
            </button>
          )}
        </div>
      </div>
      <p className="mb-3 max-w-[80ch] text-[11px] leading-relaxed text-concrete">
        30 s of S(t) at every second step, fitted by S_plat − (S_plat − S₀)·e^(−t/τ). Documented: τ ≈ {DOCUMENTED_TAU} s
        (docs/PHYSICS.md, "Measured growth rate").
      </p>
      <SeriesPlot
        height={200}
        series={
          r
            ? [
                { id: 'S', points: r.series, color: 'var(--color-ember)', label: 'S(t)' },
                { id: 'fit', points: fitted, color: 'var(--color-glass)', label: 'fit', dashed: true },
              ]
            : [{ id: 'live', points: job.preview, color: 'var(--color-ember)' }]
        }
        hLines={r ? [{ at: r.fit.plateauEmpirical, color: 'var(--color-concrete)', label: 'plateau' }] : []}
        vLines={r ? [{ at: r.fit.tau, color: 'var(--color-glass)', label: 'τ' }, ...(r.fit.t95 !== null ? [{ at: r.fit.t95, color: 'var(--color-brass)', label: 't₉₅' }] : [])] : []}
        xLabel="sim time (s)"
        yLabel="S (nats)"
      />
      {r && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[11px]">
          <dt className="text-concrete">τ · rate</dt>
          <dd className="text-bone">
            {r.fit.tau.toFixed(3)} s · {r.fit.rate.toFixed(3)} s⁻¹ ({Math.round(r.fit.tau * 60)} steps)
          </dd>
          <dt className="text-concrete">t₅₀ · t₉₅</dt>
          <dd className="text-bone">
            {r.fit.t50?.toFixed(2) ?? '—'} s · {r.fit.t95?.toFixed(2) ?? '—'} s
          </dd>
          <dt className="text-concrete">S₀ → plateau</dt>
          <dd className="text-bone">
            {r.fit.s0.toFixed(3)} → {r.fit.plateauEmpirical.toFixed(3)} ± {r.fit.plateauSd.toFixed(3)} (fit {r.fit.plateau.toFixed(3)})
          </dd>
          <dt className="text-concrete">fit quality</dt>
          <dd className="text-bone">
            R² {r.fit.r2.toFixed(4)} · rmse {r.fit.rmse.toFixed(3)} · {r.fit.n} samples · {(r.ms / 1000).toFixed(1)} s wall
          </dd>
        </dl>
      )}
      {job.error && <p className="mt-2 font-mono text-[11px] text-signal">{job.error}</p>}
    </section>
  )
}
