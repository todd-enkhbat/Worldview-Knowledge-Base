// Levesque–Verlet integer leapfrog over SoA particle buffers.
//   forward  n → n+1:  D += K(X, n);  X += drift(D)
//   backward n+1 → n:  X −= drift(D); D −= K(X, n)
// K depends on X and n only, every op wraps mod 2^32, so backward ∘ forward = id
// on all of (Z/2^32)^{6N}. Buffers interleave xyz per particle (stride 3), matching
// an RGBA32I texel per particle on the GPU. Nothing here allocates per step.

import { drift } from './fixed.ts'
import { LANDSCAPE_MODES, type PhysicsParams, type PopulationParams, rampAt } from './params.ts'
import {
  addLandscapeImpulse,
  kickFromImpulse,
  landscapeCoef,
  pairImpulse,
  tetherImpulse,
} from './potentials.ts'
import { fnv1aWords } from './rng.ts'

export type Population = 'node' | 'dust'

export interface ParticleSystem {
  readonly count: number
  readonly params: PhysicsParams
  readonly population: Population
  readonly pop: PopulationParams
  /** Pair core on (nodes only). */
  pairs: boolean
  /** Q.19, stride 3. */
  readonly x: Int32Array
  /** Q.27 per step, stride 3. */
  readonly d: Int32Array
  /** Q.19, stride 3. */
  readonly anchor: Int32Array
  /** Q.13. */
  readonly invMass: Int32Array
  /** Q.15. */
  readonly tau: Int32Array
  /** Birth step n_i (drives the newborn ramp). */
  readonly birth: Int32Array
  /** Per-particle landscape coefficients c_im = C_m·τ_i, stride 8. */
  readonly lcoef: Int32Array
  /** Scratch: impulse (Q.30) and kick (Q.27), stride 3. */
  readonly imp: Int32Array
  readonly kick: Int32Array
  /** Overflow sentinel: tether saturations seen by K (should stay 0). */
  saturations: number
  /**
   * Overflow sentinel: per-node impulse sums that wrapped i32 (≈ 250+ same-direction
   * neighbours). Diagnostics only — the wrap is still reversible and order-independent,
   * but the physics is wrong, so criterion B counts it. See overflowSentinel().
   */
  impulseWraps: number
  /** Exact float64 shadow of Σ impulse per component (pairs on only; never fed into K). */
  readonly impShadow: Float64Array
}

/** Criterion B: total overflow events (tether saturations + impulse-sum wraps). */
export function overflowSentinel(sys: ParticleSystem): number {
  return sys.saturations + sys.impulseWraps
}

export function createSystem(
  params: PhysicsParams,
  count: number,
  population: Population = 'node',
): ParticleSystem {
  const sys: ParticleSystem = {
    count,
    params,
    population,
    pop: population === 'node' ? params.node : params.dust,
    pairs: population === 'node',
    x: new Int32Array(3 * count),
    d: new Int32Array(3 * count),
    anchor: new Int32Array(3 * count),
    invMass: new Int32Array(count),
    tau: new Int32Array(count),
    birth: new Int32Array(count),
    lcoef: new Int32Array(LANDSCAPE_MODES * count),
    imp: new Int32Array(3 * count),
    kick: new Int32Array(3 * count),
    saturations: 0,
    impulseWraps: 0,
    // Pair sums are the only unbounded accumulation; dust has no pairs and needs no shadow.
    impShadow: new Float64Array(population === 'node' ? 3 * count : 0),
  }
  const im = population === 'dust' ? params.dustInvMass : 1 << 13
  const tau = population === 'dust' ? params.dustTau : 0
  for (let i = 0; i < count; i++) setParticle(sys, i, im, tau, 0)
  return sys
}

/** Set a particle's integer mass/coupling/birth and refresh its landscape coefficients. */
export function setParticle(
  sys: ParticleSystem,
  i: number,
  invMass: number,
  tau: number,
  birth: number,
): void {
  sys.invMass[i] = invMass
  sys.tau[i] = tau
  sys.birth[i] = birth
  const c = sys.params.landscape.coef
  for (let m = 0; m < LANDSCAPE_MODES; m++) {
    sys.lcoef[LANDSCAPE_MODES * i + m] = landscapeCoef(c[m], tau)
  }
}

/** Tether + landscape impulses for every particle, overwriting sys.imp. */
export function computeFieldImpulses(sys: ParticleSystem): void {
  const { x, anchor, imp, lcoef, count, pop } = sys
  const l = sys.params.landscape
  const { kXZ, kY, uSat, uSatY, yShift } = pop
  let sat = 0
  for (let i = 0; i < count; i++) {
    const o = 3 * i
    const ux = (x[o] - anchor[o]) | 0
    const uy = (x[o + 1] - anchor[o + 1]) | 0
    const uz = (x[o + 2] - anchor[o + 2]) | 0
    sat += (ux > uSat || ux < -uSat ? 1 : 0) + (uy > uSatY || uy < -uSatY ? 1 : 0) + (uz > uSat || uz < -uSat ? 1 : 0)
    imp[o] = tetherImpulse(ux, kXZ, uSat)
    imp[o + 1] = tetherImpulse(uy, kY, uSatY, yShift)
    imp[o + 2] = tetherImpulse(uz, kXZ, uSat)
    addLandscapeImpulse(x[o], x[o + 2], l, lcoef, LANDSCAPE_MODES * i, imp, o)
  }
  sys.saturations += sat
  if (sys.pairs) {
    const sh = sys.impShadow
    for (let k = 0; k < 3 * count; k++) sh[k] = imp[k]
  }
}

const pairScratch = new Int32Array(3)

/** Apply one pair (i, j) at step n: imp_i += f, imp_j −= f. Orientation-independent. */
export function addPair(sys: ParticleSystem, i: number, j: number, step: number, imp: Int32Array): void {
  const x = sys.x
  const oi = 3 * i
  const oj = 3 * j
  const bi = sys.birth[i]
  const bj = sys.birth[j]
  const lam = rampAt(step - (bi > bj ? bi : bj))
  const f = pairScratch
  if (!pairImpulse((x[oi] - x[oj]) | 0, (x[oi + 1] - x[oj + 1]) | 0, (x[oi + 2] - x[oj + 2]) | 0, lam, sys.params, f)) return
  imp[oi] = (imp[oi] + f[0]) | 0
  imp[oi + 1] = (imp[oi + 1] + f[1]) | 0
  imp[oi + 2] = (imp[oi + 2] + f[2]) | 0
  imp[oj] = (imp[oj] - f[0]) | 0
  imp[oj + 1] = (imp[oj + 1] - f[1]) | 0
  imp[oj + 2] = (imp[oj + 2] - f[2]) | 0
  // Exact in float64 (|Σ| < 2^53 for any realistic degree); diagnostics only.
  const sh = sys.impShadow
  if (sh.length) {
    sh[oi] += f[0]
    sh[oi + 1] += f[1]
    sh[oi + 2] += f[2]
    sh[oj] -= f[0]
    sh[oj + 1] -= f[1]
    sh[oj + 2] -= f[2]
  }
}

/** O(N²) brute-force pair accumulation (reference for the Phase 3 uniform grid). */
export function accumulatePairsBruteForce(sys: ParticleSystem, step: number): void {
  const n = sys.count
  const x = sys.x
  const sig = sys.params.pairSigma
  for (let i = 0; i < n; i++) {
    const oi = 3 * i
    const xi = x[oi]
    for (let j = i + 1; j < n; j++) {
      // Cheap per-axis early-out before the full pair evaluation.
      const dx = (xi - x[3 * j]) | 0
      if (dx >= sig || dx <= -sig) continue
      addPair(sys, i, j, step, sys.imp)
    }
  }
}

/** Pair accumulation from an explicit list of (i, j) index pairs in any order/orientation. */
export function accumulatePairList(sys: ParticleSystem, step: number, list: ArrayLike<number>, pairCount: number): void {
  for (let k = 0; k < pairCount; k++) addPair(sys, list[2 * k], list[2 * k + 1], step, sys.imp)
}

/** sys.imp ← total impulse at step n; sys.kick ← K. */
export function computeKicks(sys: ParticleSystem, step: number): void {
  computeFieldImpulses(sys)
  if (sys.pairs) accumulatePairsBruteForce(sys, step)
  impulsesToKicks(sys)
}

export function impulsesToKicks(sys: ParticleSystem): void {
  const { imp, kick, invMass, count } = sys
  if (sys.pairs && sys.impShadow.length) {
    const sh = sys.impShadow
    let wraps = 0
    for (let k = 0; k < 3 * count; k++) {
      const v = sh[k]
      if (v >= 2147483648 || v < -2147483648) wraps++
    }
    sys.impulseWraps += wraps
  }
  for (let i = 0; i < count; i++) {
    const im = invMass[i]
    const o = 3 * i
    kick[o] = kickFromImpulse(imp[o], im)
    kick[o + 1] = kickFromImpulse(imp[o + 1], im)
    kick[o + 2] = kickFromImpulse(imp[o + 2], im)
  }
}

/** n → n+1. */
export function stepForward(sys: ParticleSystem, step: number): void {
  computeKicks(sys, step)
  const { x, d, kick } = sys
  for (let k = 0; k < x.length; k++) {
    const dk = (d[k] + kick[k]) | 0
    d[k] = dk
    x[k] = (x[k] + drift(dk)) | 0
  }
}

/** n+1 → n (exact inverse of stepForward(sys, step)). */
export function stepBackward(sys: ParticleSystem, step: number): void {
  const { x, d } = sys
  for (let k = 0; k < x.length; k++) x[k] = (x[k] - drift(d[k])) | 0
  computeKicks(sys, step)
  const kick = sys.kick
  for (let k = 0; k < x.length; k++) d[k] = (d[k] - kick[k]) | 0
}

/** Advance `count` steps from `step`; returns the new step. */
export function runForward(sys: ParticleSystem, step: number, count: number): number {
  for (let k = 0; k < count; k++) stepForward(sys, step + k)
  return step + count
}

/** Rewind `count` steps from `step`; returns the new step. */
export function runBackward(sys: ParticleSystem, step: number, count: number): number {
  for (let k = 1; k <= count; k++) stepBackward(sys, step - k)
  return step - count
}

/**
 * Loschmidt flip F(X, D) = (X, −(D + K(X))): an exact involution with F∘Φ∘F = Φ⁻¹
 * when K does not depend on n (birth-free world with every ramp saturated).
 */
export function flip(sys: ParticleSystem, step: number): void {
  computeKicks(sys, step)
  const { d, kick } = sys
  for (let k = 0; k < d.length; k++) d[k] = -((d[k] + kick[k]) | 0) | 0
}

/** fnv1a32 over X then D (little-endian words). */
export function stateHash(sys: ParticleSystem): number {
  return fnv1aWords(sys.d, 4, fnv1aWords(sys.x))
}

// ---- Active-set kernels (Phase 3 worlds with births) ----
// The same K and leapfrog restricted to the particles listed in list[0..n): the active
// set A(n) of a world with births. Dormant slots are never read or written, so their
// buffers may hold anything. The order of `list` does not matter: every per-particle op
// is independent and pair sums are wrapping i32 additions (associative, commutative).

/** Accumulates pair impulses into sys.imp for the listed particles at step n. */
export type PairAccumulator = (sys: ParticleSystem, step: number, list: Int32Array, n: number) => void

/** Tether + landscape impulses for list[0..n), overwriting their sys.imp (and shadow). */
export function computeFieldImpulsesFor(sys: ParticleSystem, list: Int32Array, n: number): void {
  const { x, anchor, imp, lcoef, pop } = sys
  const l = sys.params.landscape
  const { kXZ, kY, uSat, uSatY, yShift } = pop
  const sh = sys.pairs ? sys.impShadow : null
  let sat = 0
  for (let k = 0; k < n; k++) {
    const i = list[k]
    const o = 3 * i
    const ux = (x[o] - anchor[o]) | 0
    const uy = (x[o + 1] - anchor[o + 1]) | 0
    const uz = (x[o + 2] - anchor[o + 2]) | 0
    sat += (ux > uSat || ux < -uSat ? 1 : 0) + (uy > uSatY || uy < -uSatY ? 1 : 0) + (uz > uSat || uz < -uSat ? 1 : 0)
    imp[o] = tetherImpulse(ux, kXZ, uSat)
    imp[o + 1] = tetherImpulse(uy, kY, uSatY, yShift)
    imp[o + 2] = tetherImpulse(uz, kXZ, uSat)
    addLandscapeImpulse(x[o], x[o + 2], l, lcoef, LANDSCAPE_MODES * i, imp, o)
    if (sh !== null && sh.length) {
      sh[o] = imp[o]
      sh[o + 1] = imp[o + 1]
      sh[o + 2] = imp[o + 2]
    }
  }
  sys.saturations += sat
}

/** K for list[0..n) from sys.imp; counts impulse-sum wraps of the listed particles. */
export function impulsesToKicksFor(sys: ParticleSystem, list: Int32Array, n: number): void {
  const { imp, kick, invMass } = sys
  if (sys.pairs && sys.impShadow.length) {
    const sh = sys.impShadow
    let wraps = 0
    for (let k = 0; k < n; k++) {
      const o = 3 * list[k]
      for (let a = 0; a < 3; a++) {
        const v = sh[o + a]
        if (v >= 2147483648 || v < -2147483648) wraps++
      }
    }
    sys.impulseWraps += wraps
  }
  for (let k = 0; k < n; k++) {
    const i = list[k]
    const im = invMass[i]
    const o = 3 * i
    kick[o] = kickFromImpulse(imp[o], im)
    kick[o + 1] = kickFromImpulse(imp[o + 1], im)
    kick[o + 2] = kickFromImpulse(imp[o + 2], im)
  }
}

/** Reference pair accumulation over list[0..n): O(n²), any list order (tests, small worlds). */
export function accumulatePairsListBruteForce(sys: ParticleSystem, step: number, list: Int32Array, n: number): void {
  const x = sys.x
  const sig = sys.params.pairSigma
  for (let a = 0; a < n; a++) {
    const i = list[a]
    const xi = x[3 * i]
    for (let b = a + 1; b < n; b++) {
      const j = list[b]
      const dx = (xi - x[3 * j]) | 0
      if (dx >= sig || dx <= -sig) continue
      addPair(sys, i, j, step, sys.imp)
    }
  }
}

/** sys.kick ← K(X, n) for list[0..n). */
export function computeKicksFor(
  sys: ParticleSystem,
  step: number,
  list: Int32Array,
  n: number,
  pairs: PairAccumulator = accumulatePairsListBruteForce,
): void {
  computeFieldImpulsesFor(sys, list, n)
  if (sys.pairs) pairs(sys, step, list, n)
  impulsesToKicksFor(sys, list, n)
}

/** n → n+1 on list[0..n) (the active set A(n)). */
export function stepForwardFor(
  sys: ParticleSystem,
  step: number,
  list: Int32Array,
  n: number,
  pairs?: PairAccumulator,
): void {
  computeKicksFor(sys, step, list, n, pairs)
  const { x, d, kick } = sys
  for (let k = 0; k < n; k++) {
    const o = 3 * list[k]
    for (let a = o; a < o + 3; a++) {
      const dk = (d[a] + kick[a]) | 0
      d[a] = dk
      x[a] = (x[a] + drift(dk)) | 0
    }
  }
}

/** n+1 → n on list[0..n) (exact inverse of stepForwardFor with the same list contents). */
export function stepBackwardFor(
  sys: ParticleSystem,
  step: number,
  list: Int32Array,
  n: number,
  pairs?: PairAccumulator,
): void {
  const { x, d } = sys
  for (let k = 0; k < n; k++) {
    const o = 3 * list[k]
    for (let a = o; a < o + 3; a++) x[a] = (x[a] - drift(d[a])) | 0
  }
  computeKicksFor(sys, step, list, n, pairs)
  const kick = sys.kick
  for (let k = 0; k < n; k++) {
    const o = 3 * list[k]
    for (let a = o; a < o + 3; a++) d[a] = (d[a] - kick[a]) | 0
  }
}
