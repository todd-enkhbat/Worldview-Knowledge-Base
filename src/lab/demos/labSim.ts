import { type LabWorld, buildLab } from '../../../scripts/physics-worlds.ts'
import { MIN_ENTROPY_SAMPLES, selectEntropySample, systemEntropy } from '../../physics/entropy.ts'
import { STEPS_PER_SECOND, UNIT } from '../../physics/fixed.ts'
import { flip, overflowSentinel, stateHash, stepBackwardFor, stepForwardFor } from '../../physics/integrator.ts'
import { AMP_ONE } from '../../physics/params.ts'
import { type GrowthFit, fitGrowth } from './growthFit.ts'

// The #/lab world: N = 1000 birth-free Past-Hypothesis nodes under a 6× landscape, built
// by the same scripts/physics-worlds.ts buildLab() the acceptance tier uses (criterion S),
// so the demos and `npm run test:accept` measure one world. No DOM: runs in the lab worker
// and in node tests.
//
// Birth-free means every node was born at −RAMP_STEPS, so K(X) is the same at every
// kernel step ≥ 0 and the Loschmidt identities are exact. The kernel is therefore always
// called at step 0 (stepBackwardFor(·, 0) inverts stepForwardFor(·, 0) exactly), and the
// sim tracks its own canonical position: the state is F^flipped(Φⁿ(x₀)). A forward step
// moves n by +1 when unflipped and −1 when flipped (F∘Φ∘F = Φ⁻¹), so "back to the start"
// is always reachable and ends on the bit-identical initial state.

export interface LabConfig {
  readonly n: number
  readonly halfWidth: number
  readonly height: number
  /** Landscape amplitude, Q.8 (AMP_ONE = 1×). */
  readonly amp: number
  readonly seed?: number
}

/** The full-size lab world (scripts/accept-physics.ts LAB at full size). */
export const LAB_CONFIG: LabConfig = { n: 1000, halfWidth: 20, height: 36, amp: 6 * AMP_ONE }

/** The kernel step every lab step runs at (see the header). */
const KSTEP = 0

export class LabSim {
  readonly cfg: LabConfig
  readonly lab: LabWorld
  readonly sample: Int32Array
  /** Hash and entropy of the initial (Past-Hypothesis) state. */
  readonly h0: number
  readonly s0: number
  /** Initial positions, for "did it come home" counts. */
  readonly x0: Int32Array
  /** Canonical step: state = F^flipped(Φⁿ(x₀)). */
  n = 0
  flipped = false

  constructor(cfg: LabConfig = LAB_CONFIG) {
    this.cfg = cfg
    this.lab = buildLab({ n: cfg.n, halfWidth: cfg.halfWidth, height: cfg.height, amp: cfg.amp, seed: cfg.seed })
    this.sample = selectEntropySample(this.lab.ids, () => true)
    if (this.sample.length < MIN_ENTROPY_SAMPLES) throw new Error('lab world too small for the entropy estimator')
    this.h0 = stateHash(this.lab.sys)
    this.s0 = this.entropy()
    this.x0 = this.lab.sys.x.slice()
  }

  get count(): number {
    return this.lab.n
  }

  /** Sim seconds at the canonical step. */
  get seconds(): number {
    return this.n / STEPS_PER_SECOND
  }

  /** k steps of Φ. */
  forward(k = 1): void {
    const { sys, list, n, pairs } = this.lab
    for (let i = 0; i < k; i++) stepForwardFor(sys, KSTEP, list, n, pairs)
    this.n += this.flipped ? -k : k
  }

  /** k steps of Φ⁻¹ (the exact inverse). */
  backward(k = 1): void {
    const { sys, list, n, pairs } = this.lab
    for (let i = 0; i < k; i++) stepBackwardFor(sys, KSTEP, list, n, pairs)
    this.n += this.flipped ? k : -k
  }

  /** Steps of Φ (dir +1) or Φ⁻¹ (dir −1) that bring n back to 0. */
  homeward(): { dir: 1 | -1; steps: number } {
    if (this.n === 0) return { dir: 1, steps: 0 }
    // Unflipped: Φ raises n. Flipped: Φ lowers n.
    const forwardLowers = this.flipped
    const needLower = this.n > 0
    return { dir: needLower === forwardLowers ? 1 : -1, steps: Math.abs(this.n) }
  }

  /** The Loschmidt flip F(X, D) = (X, −(D + K(X))): an exact involution. */
  flip(): void {
    flip(this.lab.sys, KSTEP)
    this.flipped = !this.flipped
  }

  /** S = −D_KL of the one-particle phase-space density (entropy.ts), in nats. */
  entropy(): number {
    return systemEntropy(this.lab.sys, this.sample).S
  }

  hash(): number {
    return stateHash(this.lab.sys)
  }

  /** At the canonical origin with the bit-identical initial state? */
  isHome(): boolean {
    return this.n === 0 && !this.flipped && this.hash() === this.h0
  }

  /** Nudge one coordinate by `lsb` units of Q.19 (2⁻¹⁹ u). */
  perturb(slot = 0, axis = 0, lsb = 1): void {
    const k = 3 * slot + axis
    this.lab.sys.x[k] = (this.lab.sys.x[k] + lsb) | 0
  }

  /** Positions in world units, xyz stride 3. */
  positions(out: Float32Array = new Float32Array(3 * this.lab.n)): Float32Array {
    const x = this.lab.sys.x
    const s = 1 / UNIT
    for (let k = 0; k < 3 * this.lab.n; k++) out[k] = x[k] * s
    return out
  }

  /** Particles more than `radius` u from their initial position. */
  strayed(radius = 0.1): number {
    const { x } = this.lab.sys
    let c = 0
    for (let i = 0; i < this.lab.n; i++) {
      let r2 = 0
      for (let a = 0; a < 3; a++) r2 += (((x[3 * i + a] - this.x0[3 * i + a]) | 0) / UNIT) ** 2
      if (r2 > radius * radius) c++
    }
    return c
  }

  snapshot(): LabSnapshot {
    return { x: this.lab.sys.x.slice(), d: this.lab.sys.d.slice(), n: this.n, flipped: this.flipped }
  }

  restore(s: LabSnapshot): void {
    this.lab.sys.x.set(s.x)
    this.lab.sys.d.set(s.d)
    this.n = s.n
    this.flipped = s.flipped
  }

  sentinel(): number {
    return overflowSentinel(this.lab.sys)
  }
}

export interface LabSnapshot {
  readonly x: Int32Array
  readonly d: Int32Array
  readonly n: number
  readonly flipped: boolean
}

// ---------------------------------------------------------------- arrow of time

export interface ArrowOptions {
  /** Forward steps (≥ 18000 = 300 s for the demo). */
  readonly steps: number
  /** S sample spacing (steps) after the first `fineSteps`, and within them. */
  readonly sampleEvery: number
  readonly fineSteps: number
  readonly fineEvery: number
  /** Steps per generator yield (progress granularity). */
  readonly chunk: number
  readonly cfg: LabConfig
}

export const ARROW_DEFAULTS: ArrowOptions = {
  steps: 18_000,
  sampleEvery: 60,
  fineSteps: 600,
  fineEvery: 3,
  chunk: 60,
  cfg: LAB_CONFIG,
}

export type ArrowPhase = 'build' | 'forward' | 'perturbed' | 'control' | 'done'

export interface ArrowProgress {
  readonly phase: ArrowPhase
  /** Steps done of the 3·steps total. */
  readonly done: number
  readonly total: number
  /** Latest S sample of the running phase (t in seconds since that phase began). */
  readonly last: readonly [number, number] | null
}

/** [t (s), S (nats)] samples. */
export type Series = [number, number][]

export interface ArrowResult {
  readonly n: number
  readonly steps: number
  readonly seconds: number
  readonly s0: number
  readonly sFwd: number
  /** Perturbed (1 LSB on particle 0, x) reversal. */
  readonly sRet: number
  /** (S_ret − S0)/(S_fwd − S0); the arrow holds when ≥ 0.5. */
  readonly ratio: number
  readonly threshold: 0.5
  readonly strayed: number
  /** The unperturbed control (flip, forward, flip) returns the initial hash. */
  readonly controlReturn: boolean
  readonly h0: string
  readonly controlHash: string
  readonly sControlEnd: number
  readonly pass: boolean
  readonly forward: Series
  readonly perturbed: Series
  readonly control: Series
  /** Growth fit of the forward branch (null with fewer than 4 samples). */
  readonly growth: GrowthFit | null
  readonly sentinel: number
  readonly ms: number
}

const hex = (h: number) => `0x${(h >>> 0).toString(16).padStart(8, '0')}`

/**
 * The arrow-of-time experiment (PLAN Phase 3, criterion S): forward `steps`, nudge one
 * particle by 1 LSB, flip and run forward `steps` again (the would-be return). Entropy
 * keeps rising instead of retracing. The unperturbed control (same flip, same run, flip)
 * returns bit for bit. A generator so a worker or a time-sliced loop can drive it; it
 * yields every `chunk` steps.
 */
export function* arrowOfTime(options: Partial<ArrowOptions> = {}): Generator<ArrowProgress, ArrowResult, void> {
  const o = { ...ARROW_DEFAULTS, ...options }
  const t0 = performance.now()
  const total = 3 * o.steps
  yield { phase: 'build', done: 0, total, last: null }
  const sim = new LabSim(o.cfg)
  const s0 = sim.s0
  const sampleAt = (k: number) => (k <= o.fineSteps ? k % o.fineEvery === 0 : k % o.sampleEvery === 0) || k === o.steps
  let done = 0

  function* run(phase: ArrowPhase, series: Series): Generator<ArrowProgress, void, void> {
    series.push([0, sim.entropy()])
    for (let k = 1; k <= o.steps; k++) {
      sim.forward(1)
      done++
      if (sampleAt(k)) series.push([k / STEPS_PER_SECOND, sim.entropy()])
      if (k % o.chunk === 0 || k === o.steps) yield { phase, done, total, last: series[series.length - 1] }
    }
  }

  const forward: Series = []
  yield* run('forward', forward)
  const sFwd = forward[forward.length - 1][1]
  const atT = sim.snapshot()

  const perturbed: Series = []
  sim.perturb(0, 0, 1)
  sim.flip()
  yield* run('perturbed', perturbed)
  const sRet = perturbed[perturbed.length - 1][1]
  const strayed = sim.strayed()

  sim.restore(atT)
  const control: Series = []
  sim.flip()
  yield* run('control', control)
  sim.flip()
  const controlHash = sim.hash()
  const controlReturn = controlHash === sim.h0
  // After the last flip: the state is x₀ again, so S is S₀ to the last bit.
  const sControlEnd = sim.entropy()
  const ratio = (sRet - s0) / (sFwd - s0)
  const tS = forward.map(([t]) => t)
  const sS = forward.map(([, s]) => s)
  yield { phase: 'done', done, total, last: null }
  return {
    n: sim.count,
    steps: o.steps,
    seconds: o.steps / STEPS_PER_SECOND,
    s0,
    sFwd,
    sRet,
    ratio,
    threshold: 0.5,
    strayed,
    controlReturn,
    h0: hex(sim.h0),
    controlHash: hex(controlHash),
    sControlEnd,
    pass: ratio >= 0.5 && controlReturn,
    forward,
    perturbed,
    control,
    growth: tS.length >= 4 ? fitGrowth(tS, sS) : null,
    sentinel: sim.sentinel(),
    ms: Math.round(performance.now() - t0),
  }
}

/** Drive a generator to completion synchronously (node tests, scripts). */
export function runToEnd<T, R>(gen: Generator<T, R, void>): R {
  for (;;) {
    const r = gen.next()
    if (r.done) return r.value
  }
}

// ---------------------------------------------------------------- growth rate

export interface GrowthOptions {
  /** Steps to run (the fit window). */
  readonly steps: number
  /** S every `every` steps. */
  readonly every: number
  readonly chunk: number
  readonly cfg: LabConfig
}

export const GROWTH_DEFAULTS: GrowthOptions = { steps: 1800, every: 2, chunk: 60, cfg: LAB_CONFIG }

export interface GrowthResult {
  readonly steps: number
  readonly series: Series
  readonly fit: GrowthFit
  readonly ms: number
}

/** S(t) at fine resolution from the Past-Hypothesis start, fitted by fitGrowth. */
export function* growthRate(options: Partial<GrowthOptions> = {}): Generator<ArrowProgress, GrowthResult, void> {
  const o = { ...GROWTH_DEFAULTS, ...options }
  const t0 = performance.now()
  yield { phase: 'build', done: 0, total: o.steps, last: null }
  const sim = new LabSim(o.cfg)
  const series: Series = [[0, sim.s0]]
  for (let k = 1; k <= o.steps; k++) {
    sim.forward(1)
    if (k % o.every === 0 || k === o.steps) series.push([k / STEPS_PER_SECOND, sim.entropy()])
    if (k % o.chunk === 0 || k === o.steps) yield { phase: 'forward', done: k, total: o.steps, last: series[series.length - 1] }
  }
  const fit = fitGrowth(
    series.map(([t]) => t),
    series.map(([, s]) => s),
  )
  return { steps: o.steps, series, fit, ms: Math.round(performance.now() - t0) }
}
