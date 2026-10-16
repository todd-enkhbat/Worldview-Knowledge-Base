// Frame statistics for #/lab/perf (criterion P), free of DOM and three so node tests run
// them. Criterion P: at native refresh, ≤ 1 % of frames exceed 1.5× the vsync interval,
// and the median main-thread frame work is < 8 ms.

export const P_LIMITS = { slowShare: 0.01, slowFactor: 1.5, medianMainMs: 8 } as const

/** Common panel refresh rates (Hz), for snapping the measured vsync interval. */
const REFRESH_RATES = [24, 30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 180, 240, 360] as const

export interface Summary {
  readonly n: number
  readonly mean: number
  readonly median: number
  readonly p90: number
  readonly p95: number
  readonly p99: number
  readonly max: number
  readonly min: number
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return Number.NaN
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[i]
}

export function summarize(values: readonly number[]): Summary {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length === 0) return { n: 0, mean: Number.NaN, median: Number.NaN, p90: Number.NaN, p95: Number.NaN, p99: Number.NaN, max: Number.NaN, min: Number.NaN }
  let sum = 0
  for (const x of v) sum += x
  return {
    n: v.length,
    mean: sum / v.length,
    median: percentile(v, 0.5),
    p90: percentile(v, 0.9),
    p95: percentile(v, 0.95),
    p99: percentile(v, 0.99),
    max: v[v.length - 1],
    min: v[0],
  }
}

export interface VsyncEstimate {
  readonly ms: number
  readonly hz: number
  /** 'snapped' to a common refresh rate within 8 %, or the 'raw' low percentile. */
  readonly method: 'snapped' | 'raw' | 'none'
}

/**
 * The display's frame interval from rAF intervals. The low tail (10th percentile) is the
 * interval of frames that made vsync even when many did not; snapping it to a common
 * panel rate removes timer jitter. Assumes most frames hit vsync at least sometimes.
 */
export function estimateVsync(intervals: readonly number[]): VsyncEstimate {
  const v = intervals.filter((x) => Number.isFinite(x) && x > 0.5).sort((a, b) => a - b)
  if (v.length === 0) return { ms: Number.NaN, hz: Number.NaN, method: 'none' }
  const raw = percentile(v, 0.1)
  let best: number | null = null
  for (const hz of REFRESH_RATES) {
    const ms = 1000 / hz
    if (Math.abs(raw - ms) / ms <= 0.08 && (best === null || Math.abs(raw - ms) < Math.abs(raw - 1000 / best))) best = hz
  }
  if (best !== null) return { ms: 1000 / best, hz: best, method: 'snapped' }
  return { ms: raw, hz: 1000 / raw, method: 'raw' }
}

export interface FrameSample {
  /** ms since the measured run started (rAF timestamp). */
  readonly t: number
  /** rAF-to-rAF interval (ms). */
  readonly interval: number
  readonly phase: string
}

export interface WorkSample {
  readonly t: number
  /** Main-thread work of one rendered frame (ms): first to last useFrame callback. */
  readonly main: number
  /** GPU time of the frame's render + post (ms), when a timer query is available. */
  gpu: number | null
  readonly phase: string
  readonly calls: number
  readonly triangles: number
  readonly points: number
}

export interface PhaseReport {
  readonly frames: number
  readonly seconds: number
  readonly fps: number
  readonly intervalMs: Summary
  /** Share of rAF intervals > 1.5× vsync (criterion P: ≤ 1 %). */
  readonly slowShare: number
  readonly slowFrames: number
  /** Intervals ≥ 2.5× vsync (two or more missed vsyncs). */
  readonly droppedFrames: number
  readonly mainMs: Summary
  readonly gpuMs: Summary | null
  readonly drawCalls: Summary
  readonly triangles: Summary
  readonly points: Summary
}

export function phaseReport(frames: readonly FrameSample[], work: readonly WorkSample[], vsyncMs: number): PhaseReport {
  const intervals = frames.map((f) => f.interval)
  const slowLimit = P_LIMITS.slowFactor * vsyncMs
  const slow = intervals.filter((x) => x > slowLimit).length
  const dropped = intervals.filter((x) => x >= 2.5 * vsyncMs).length
  const seconds = intervals.reduce((a, b) => a + b, 0) / 1000
  const gpu = work.map((w) => w.gpu).filter((g): g is number => g !== null)
  return {
    frames: intervals.length,
    seconds,
    fps: seconds > 0 ? intervals.length / seconds : Number.NaN,
    intervalMs: summarize(intervals),
    slowShare: intervals.length ? slow / intervals.length : Number.NaN,
    slowFrames: slow,
    droppedFrames: dropped,
    mainMs: summarize(work.map((w) => w.main)),
    gpuMs: gpu.length ? summarize(gpu) : null,
    drawCalls: summarize(work.map((w) => w.calls)),
    triangles: summarize(work.map((w) => w.triangles)),
    points: summarize(work.map((w) => w.points)),
  }
}

export interface Verdict {
  readonly slowShare: number
  readonly slowShareLimit: number
  readonly medianMainMs: number
  readonly medianMainLimitMs: number
  readonly pass: boolean
}

export function verdict(all: PhaseReport): Verdict {
  const pass = all.slowShare <= P_LIMITS.slowShare && all.mainMs.median < P_LIMITS.medianMainMs
  return {
    slowShare: all.slowShare,
    slowShareLimit: P_LIMITS.slowShare,
    medianMainMs: all.mainMs.median,
    medianMainLimitMs: P_LIMITS.medianMainMs,
    pass,
  }
}

/** Collects rAF intervals and per-frame work, tagged with the phase they ran in. */
export class PerfRecorder {
  readonly frames: FrameSample[] = []
  readonly work: WorkSample[] = []
  phase: string | null = null
  private t0 = Number.NaN
  private lastRaf = Number.NaN

  /** Call from a requestAnimationFrame loop with its timestamp. */
  raf(ts: number): void {
    if (Number.isNaN(this.t0)) this.t0 = ts
    const prev = this.lastRaf
    this.lastRaf = ts
    if (this.phase === null || Number.isNaN(prev)) return
    const dt = ts - prev
    // A hidden tab pauses rAF: a multi-second gap is not a frame.
    if (dt <= 0 || dt > 1000) return
    this.frames.push({ t: ts - this.t0, interval: dt, phase: this.phase })
  }

  /** Record one rendered frame's main-thread work; returns the sample (for a late GPU result). */
  frame(now: number, mainMs: number, calls: number, triangles: number, points: number): WorkSample | null {
    if (this.phase === null) return null
    const s: WorkSample = { t: Number.isNaN(this.t0) ? 0 : now - this.t0, main: mainMs, gpu: null, phase: this.phase, calls, triangles, points }
    this.work.push(s)
    return s
  }

  report(phases: readonly string[]): { vsync: VsyncEstimate; phases: Record<string, PhaseReport>; all: PhaseReport; verdict: Verdict } {
    const vsync = estimateVsync(this.frames.map((f) => f.interval))
    const out: Record<string, PhaseReport> = {}
    for (const p of phases) {
      out[p] = phaseReport(
        this.frames.filter((f) => f.phase === p),
        this.work.filter((w) => w.phase === p),
        vsync.ms,
      )
    }
    const measured = new Set(phases)
    const all = phaseReport(
      this.frames.filter((f) => measured.has(f.phase)),
      this.work.filter((w) => measured.has(w.phase)),
      vsync.ms,
    )
    return { vsync, phases: out, all, verdict: verdict(all) }
  }
}
