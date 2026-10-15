import { useEffect, useMemo } from 'react'
import { STEPS_PER_SECOND } from '../../physics/fixed.ts'
import { LabPoints } from './LabPoints.tsx'
import { type LiveEvent, acquireLive, sendLive, useLabLive } from './labClient.ts'
import { SeriesPlot, type PlotLine } from './SeriesPlot.tsx'

// Demos 1–3: the N = 1000 birth-free Past-Hypothesis world (6× landscape) running live in
// a worker, its S(t) at ≤ 4 Hz, exact reversal back to step 0 (hash = initial hash) and the
// Loschmidt flip F (an exact involution: flip, run, flip retraces to the initial state).

const SPEEDS = [1, 2, 5, 10] as const

const EVENT_COLOR: Record<LiveEvent['kind'], string> = {
  reset: 'var(--color-concrete)',
  flip: 'var(--color-glass)',
  perturb: 'var(--color-signal)',
  home: 'var(--color-brass)',
  reverse: 'var(--color-concrete)',
  forward: 'var(--color-concrete)',
}

const EVENT_LABEL: Partial<Record<LiveEvent['kind'], string>> = { flip: 'F', perturb: '±1', home: '⌂', reverse: 'Φ⁻¹' }

export function LabWorldPanel() {
  const s = useLabLive()
  useEffect(() => acquireLive(), [])

  const cfg = s.cfg
  const halfHeight = cfg ? cfg.height / 2 : 18
  const center = useMemo<[number, number, number]>(() => [0, halfHeight, 0], [halfHeight])
  const busy = !s.ready || s.homing
  const vLines: PlotLine[] = s.events
    .filter((e) => EVENT_LABEL[e.kind])
    .map((e) => ({ at: e.t, color: EVENT_COLOR[e.kind], label: EVENT_LABEL[e.kind] }))
  const homeOk = s.home ? s.home.identical : null

  return (
    <section className="hud-panel mb-6 p-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <h2 className="hud-label text-bone">Lab world: reversible chaos</h2>
        <span className="font-mono text-[11px] uppercase tracking-wider text-concrete">
          {s.ready ? `N = ${s.count} · birth-free · landscape ${cfg ? (cfg.amp / 256).toFixed(0) : '?'}×` : s.error ? 'error' : 'building…'}
        </span>
      </div>
      <p className="mb-3 max-w-[80ch] text-[11px] leading-relaxed text-concrete">
        A Past-Hypothesis start (every node within 0.05 u of its anchor) under the integer leapfrog. Points are
        coloured by how far they have wandered. <span className="text-bone">Reverse to 0</span> runs Φ⁻¹ back to the
        initial step and compares the state hash with the initial one. <span className="text-bone">F</span> is the
        Loschmidt flip (X, D) → (X, −(D + K)): after F, playing forward retraces the past, and S falls. A 1-LSB nudge
        (±1) breaks the return.
      </p>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <LabPoints center={center} className="h-[340px] border border-bone/10" />
        <div className="flex flex-col gap-3">
          <SeriesPlot
            height={200}
            series={[{ id: 'S', points: s.entropy, color: 'var(--color-ember)', label: 'S(t), nats' }]}
            hLines={Number.isFinite(s.s0) ? [{ at: s.s0, color: 'var(--color-concrete)', label: 'S₀' }] : []}
            vLines={vLines}
            xLabel="dynamics run (s)"
            yLabel="S"
          />
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[11px]">
            <dt className="text-concrete">step n</dt>
            <dd className="text-bone">
              {s.n} ({(s.n / STEPS_PER_SECOND).toFixed(1)} s){s.flipped ? ' · flipped' : ''}
              {s.perturbed ? ' · perturbed' : ''}
            </dd>
            <dt className="text-concrete">run</dt>
            <dd className="text-bone">
              {s.homing ? 'homing…' : s.speed === 0 ? 'paused' : `${s.speed > 0 ? 'Φ' : 'Φ⁻¹'} at ${Math.abs(s.speed)}×`} · {(s.steps / STEPS_PER_SECOND).toFixed(1)} s run
            </dd>
            <dt className="text-concrete">hash</dt>
            <dd className={s.hash && s.hash === s.h0 ? 'text-glass' : 'text-bone'}>
              {s.hash || '—'} <span className="text-concrete">(initial {s.h0 || '—'})</span>
            </dd>
            <dt className="text-concrete">S</dt>
            <dd className="text-bone">
              {s.entropy.length ? s.entropy[s.entropy.length - 1][1].toFixed(3) : '—'} <span className="text-concrete">(S₀ {Number.isFinite(s.s0) ? s.s0.toFixed(3) : '—'})</span>
            </dd>
            <dt className="text-concrete">return</dt>
            <dd className={homeOk === null ? 'text-concrete' : homeOk ? 'text-glass' : 'text-signal'}>
              {s.home
                ? s.home.identical
                  ? 'bit-identical to the initial state'
                  : `differs (${s.home.hash} ≠ ${s.home.h0})${s.home.perturbed ? ': perturbed, as expected' : ''}`
                : '—'}
            </dd>
          </dl>
          {s.error && <p className="font-mono text-[11px] text-signal">{s.error}</p>}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {SPEEDS.map((v) => (
          <button key={v} className="hud-btn" disabled={busy} aria-pressed={s.speed === v} onClick={() => sendLive({ type: 'speed', speed: v })}>
            Φ {v}×
          </button>
        ))}
        <button className="hud-btn" disabled={busy} aria-pressed={s.speed < 0} onClick={() => sendLive({ type: 'speed', speed: -5 })}>
          Φ⁻¹ 5×
        </button>
        <button className="hud-btn" disabled={busy || s.speed === 0} onClick={() => sendLive({ type: 'speed', speed: 0 })}>
          pause
        </button>
        <span className="mx-1 h-4 w-px bg-bone/20" />
        <button className="hud-btn" disabled={busy} onClick={() => sendLive({ type: 'flip' })} title="Loschmidt flip F(X, D) = (X, −(D + K(X)))">
          F flip
        </button>
        <button className="hud-btn" disabled={busy || (s.n === 0 && !s.flipped)} onClick={() => sendLive({ type: 'home' })} title="Run back to step 0 and compare the hash">
          reverse to 0
        </button>
        <button className="hud-btn" disabled={busy} onClick={() => sendLive({ type: 'perturb' })} title="Nudge particle 0 by one LSB (2⁻¹⁹ u) along x">
          ±1 LSB
        </button>
        <button className="hud-btn" disabled={!s.ready} onClick={() => sendLive({ type: 'init' })}>
          reset
        </button>
      </div>
    </section>
  )
}
