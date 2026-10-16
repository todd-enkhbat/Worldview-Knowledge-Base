// Birth-compensated energy ledger for the main world (float64 diagnostics only; nothing
// here feeds back into K, spawn, slots or births).
//
//   L_n = E_n − E_0 − Σ_{births in (n0, n]} ΔE_birth − W_ramp(n0 → n)
//
// E_n is the energy of the active set A(n) with the synchronised velocity
// v_n = D_n + K_n/2, every constant decoded from the integer params exactly as in
// energy.ts (energyFor is energy() restricted to a slot list; over every slot of a
// birth-free system the two agree to rounding, see tests/physics/ledger.test.ts).
//
// Births. Crossing n → n+1 activates every slot with birth = n+1 in its spawn state.
// Its pairs have age 0, so λ = 0: they add no pair energy and no pair impulse, and no
// other node's K changes. The jump of E is therefore exactly the newborn's own
//   ΔE_birth = ½m|D + K_f/2|² + U_T(u) + τ·U_L(x),
// with K_f its field-only kick (tether + landscape). Crossing back removes it again.
//
// Ramp work. λ_ij(n) = smoothstep((n − max(n_i, n_j))/120) makes H explicitly
// time-dependent while a pair is young. Split one step of the leapfrog as
//   E(X_{k+1}, D_{k+1}; λ_{k+1}) − E(X_k, D_k; λ_k)
//     = [E(X_{k+1}, D_{k+1}; λ_{k+1}) − E(X_{k+1}, D_{k+1}; λ_k)]   (work of dλ/dn: W_k)
//     + [E(X_{k+1}, D_{k+1}; λ_k)     − E(X_k, D_k; λ_k)]           (fixed-λ integrator error).
// W_k has two parts: the potential Δλ_k·φ(r_{k+1}) and, because v = D + K/2 depends on λ
// through K, a kinetic part m·v·ΔK/2. With ΔK = Δλ_k·f·dt²/m for the pair force f, the
// kinetic part summed over both members is Δλ_k·(f_i·v_i + f_j·v_j)·dt/2 =
// −Δλ_k·(dt/2)·dφ/dt, so
//   W_k = Δλ_k·[φ(r_{k+1}) − (dt/2)·φ̇] + O(Δλ·dt²) = Δλ_k·½(φ(r_k) + φ(r_{k+1})) + O(Δλ·dt²),
// the trapezoid rule over the step. The ledger accumulates exactly that over every pair
// whose ramp moves in the step (age a_k ∈ [0, 119]: Δλ_k = λ(a_k + 1) − λ(a_k)), with
// φ = ε(1 − r²/σ²)³ unramped and r taken from X_k and X_{k+1}. What is left in L_n is
// the bounded fixed-λ leapfrog error plus O(dt²) per ramp, so L stays flat while E jumps.
//
// The ledger is path-dependent through W, so it must see every step: call advance()
// after each single step (either direction). After a seek, rebuild it at the new step
// (its origin moves there). Stepping back across a birth subtracts the ΔE recorded when
// that birth was crossed forward.

import { D_FRAC, STEPS_PER_SECOND, TAU_ONE, X_FRAC } from './fixed.ts'
import type { EnergyComponents } from './energy.ts'
import {
  type PairAccumulator,
  type ParticleSystem,
  accumulatePairsListBruteForce,
  computeKicksFor,
} from './integrator.ts'
import {
  LANDSCAPE_MODES,
  RAMP_STEPS,
  landscapeAmplitude,
  massOf,
  pairEpsilonEff,
  pairSigmaEff,
  rampAt,
  tetherK,
} from './params.ts'
import { addLandscapeImpulse, kickFromImpulse, tetherImpulse } from './potentials.ts'

const X_SCALE = 2 ** -X_FRAC
const V_SCALE = 2 ** -D_FRAC * STEPS_PER_SECOND
const PHASE_TO_RAD = (2 * Math.PI) / 2 ** 32

function huber(u: number, k: number, sat: number): number {
  const a = Math.abs(u)
  return a <= sat ? 0.5 * k * a * a : k * sat * (a - 0.5 * sat)
}

/** Kinetic + tether + landscape of slot i with kick K (Q.27) for the synchronised velocity. */
function particleEnergy(sys: ParticleSystem, i: number, kick: ArrayLike<number>, ko: number): [number, number, number] {
  const { x, d, anchor, invMass, lcoef, pop } = sys
  const l = sys.params.landscape
  const o = 3 * i
  const m = massOf(invMass[i])
  let v2 = 0
  for (let a = 0; a < 3; a++) {
    const v = (d[o + a] + kick[ko + a] / 2) * V_SCALE
    v2 += v * v
  }
  const sat = pop.uSat * X_SCALE
  const ux = ((x[o] - anchor[o]) | 0) * X_SCALE
  const uy = ((x[o + 1] - anchor[o + 1]) | 0) * X_SCALE
  const uz = ((x[o + 2] - anchor[o + 2]) | 0) * X_SCALE
  const tether = huber(ux, tetherK(pop.kXZ), sat) + huber(uy, tetherK(pop.kY, pop.yShift), pop.uSatY * X_SCALE) + huber(uz, tetherK(pop.kXZ), sat)
  let landscape = 0
  for (let mo = 0; mo < LANDSCAPE_MODES; mo++) {
    const ph = (Math.imul(l.kx[mo], x[o]) + Math.imul(l.kz[mo], x[o + 2]) + l.phase[mo]) >>> 0
    landscape += landscapeAmplitude(lcoef[LANDSCAPE_MODES * i + mo]) * Math.cos(ph * PHASE_TO_RAD)
  }
  return [0.5 * m * v2, tether, landscape]
}

/** Unramped pair potential ε(1 − s)³ of (i, j) at the current X (0 beyond σ). */
export function pairPhi(sys: ParticleSystem, i: number, j: number): number {
  const x = sys.x
  const dx = ((x[3 * i] - x[3 * j]) | 0) * X_SCALE
  const dy = ((x[3 * i + 1] - x[3 * j + 1]) | 0) * X_SCALE
  const dz = ((x[3 * i + 2] - x[3 * j + 2]) | 0) * X_SCALE
  const s = (dx * dx + dy * dy + dz * dz) / pairSigmaEff(sys.params) ** 2
  return s >= 1 ? 0 : pairEpsilonEff(sys.params) * (1 - s) ** 3
}

/**
 * Calls fn(i, j) (i < j) once for every unordered pair of list[0..n) closer than σ along
 * the sweep axis: a sort-and-sweep on the axis of largest extent (Y, time, in the main
 * world), O(n log n + candidates). Pairs across the ±4096 u torus seam are not visited;
 * worlds stay far from it.
 */
export function forEachNearPair(
  sys: ParticleSystem,
  list: Int32Array,
  n: number,
  fn: (i: number, j: number) => void,
): void {
  if (n < 2) return
  const x = sys.x
  const sig = sys.params.pairSigma
  let axis = 0
  let best = -1
  for (let a = 0; a < 3; a++) {
    let lo = x[3 * list[0] + a]
    let hi = lo
    for (let k = 1; k < n; k++) {
      const v = x[3 * list[k] + a]
      if (v < lo) lo = v
      else if (v > hi) hi = v
    }
    if (hi - lo > best) {
      best = hi - lo
      axis = a
    }
  }
  const order = Int32Array.from(list.subarray(0, n)).sort((a, b) => x[3 * a + axis] - x[3 * b + axis] || a - b)
  for (let a = 0; a < n; a++) {
    const i = order[a]
    const xi = x[3 * i + axis]
    for (let b = a + 1; b < n; b++) {
      const j = order[b]
      if (x[3 * j + axis] - xi >= sig) break
      fn(i < j ? i : j, i < j ? j : i)
    }
  }
}

/** Σ_{i<j} λ_ij ε(1 − s)³ over list[0..n) at step n. */
export function pairEnergyFor(sys: ParticleSystem, step: number, list: Int32Array, n: number): number {
  const birth = sys.birth
  let e = 0
  forEachNearPair(sys, list, n, (i, j) => {
    const phi = pairPhi(sys, i, j)
    if (phi > 0) e += (rampAt(step - Math.max(birth[i], birth[j])) / TAU_ONE) * phi
  })
  return e
}

/**
 * energy() of energy.ts restricted to the active slots list[0..n): recomputes K_n for
 * them with the given pair accumulator (leaves sys.kick holding K_n).
 */
export function energyFor(
  sys: ParticleSystem,
  step: number,
  list: Int32Array,
  n: number,
  pairs: PairAccumulator = accumulatePairsListBruteForce,
): EnergyComponents {
  computeKicksFor(sys, step, list, n, pairs)
  let kinetic = 0
  let tether = 0
  let landscape = 0
  for (let k = 0; k < n; k++) {
    const i = list[k]
    const [ke, te, le] = particleEnergy(sys, i, sys.kick, 3 * i)
    kinetic += ke
    tether += te
    landscape += le
  }
  const pair = sys.pairs ? pairEnergyFor(sys, step, list, n) : 0
  return { kinetic, tether, landscape, pair, total: kinetic + tether + landscape + pair }
}

const birthImp = new Int32Array(3)
const birthKick = new Int32Array(3)

/**
 * ΔE_birth of slot i in its current (spawn) state: ½m|D + K_f/2|² + U_T + τ·U_L, with the
 * field-only kick K_f (its pairs are at λ = 0 on the birth step).
 */
export function birthEnergy(sys: ParticleSystem, i: number): number {
  const { x, anchor, pop } = sys
  const o = 3 * i
  birthImp[0] = tetherImpulse((x[o] - anchor[o]) | 0, pop.kXZ, pop.uSat)
  birthImp[1] = tetherImpulse((x[o + 1] - anchor[o + 1]) | 0, pop.kY, pop.uSatY, pop.yShift)
  birthImp[2] = tetherImpulse((x[o + 2] - anchor[o + 2]) | 0, pop.kXZ, pop.uSat)
  addLandscapeImpulse(x[o], x[o + 2], sys.params.landscape, sys.lcoef, LANDSCAPE_MODES * i, birthImp, 0)
  for (let a = 0; a < 3; a++) birthKick[a] = kickFromImpulse(birthImp[a], sys.invMass[i])
  const [ke, te, le] = particleEnergy(sys, i, birthKick, 0)
  return ke + te + le
}

/**
 * Unramped φ of every pair of list[0..n) within σ whose age at `step` is in
 * [0, RAMP_STEPS] (the pairs whose λ moves in the step before or after), keyed i·stride + j.
 */
export function rampingPairs(
  sys: ParticleSystem,
  step: number,
  list: Int32Array,
  n: number,
  stride: number = sys.count,
): Map<number, number> {
  const out = new Map<number, number>()
  const birth = sys.birth
  const young: number[] = []
  for (let k = 0; k < n; k++) {
    const a = step - birth[list[k]]
    if (a >= 0 && a <= RAMP_STEPS) young.push(list[k])
  }
  if (young.length === 0) return out
  const x = sys.x
  const sig = sys.params.pairSigma
  for (const y of young) {
    for (let k = 0; k < n; k++) {
      const j = list[k]
      if (j === y) continue
      const dx = (x[3 * y] - x[3 * j]) | 0
      if (dx >= sig || dx <= -sig) continue
      const i0 = y < j ? y : j
      const j0 = y < j ? j : y
      const key = i0 * stride + j0
      if (out.has(key)) continue
      const age = step - Math.max(birth[i0], birth[j0])
      if (age < 0 || age > RAMP_STEPS) continue
      const phi = pairPhi(sys, i0, j0)
      if (phi > 0) out.set(key, phi)
    }
  }
  return out
}

/** W_k = Σ Δλ_k·½(φ_k + φ_{k+1}) over the union of two rampingPairs maps (k → k+1). */
export function rampWorkStep(
  sys: ParticleSystem,
  k: number,
  phiK: Map<number, number>,
  phiK1: Map<number, number>,
  stride: number = sys.count,
): number {
  const birth = sys.birth
  let w = 0
  const add = (key: number, a: number, b: number) => {
    const i = Math.floor(key / stride)
    const j = key - i * stride
    const age = k - Math.max(birth[i], birth[j])
    if (age < 0 || age >= RAMP_STEPS) return
    w += ((rampAt(age + 1) - rampAt(age)) / TAU_ONE) * 0.5 * (a + b)
  }
  for (const [key, a] of phiK) add(key, a, phiK1.get(key) ?? 0)
  for (const [key, b] of phiK1) if (!phiK.has(key)) add(key, 0, b)
  return w
}

export interface LedgerReading {
  readonly E: EnergyComponents
  readonly e0: number
  /** E_n − E_0. */
  readonly raw: number
  /** Σ ΔE_births since the origin. */
  readonly births: number
  /** Accumulated ramp work since the origin. */
  readonly rampWork: number
  /** E_n − E_0 − births − rampWork. */
  readonly ledger: number
}

export class EnergyLedger {
  readonly origin: number
  readonly e0: number
  step: number
  births = 0
  rampWork = 0
  private phi: Map<number, number>
  private readonly stride: number
  private readonly pairs: PairAccumulator
  private readonly birthE = new Map<number, number>()
  private readonly bornAt = new Map<number, number[]>()

  /** Origin at `step` with active set list[0..n). */
  constructor(
    sys: ParticleSystem,
    step: number,
    list: Int32Array,
    n: number,
    pairs: PairAccumulator = accumulatePairsListBruteForce,
  ) {
    this.origin = step
    this.step = step
    this.stride = sys.count
    this.pairs = pairs
    this.e0 = energyFor(sys, step, list, n, pairs).total
    this.phi = rampingPairs(sys, step, list, n, this.stride)
  }

  /** Account one step of the world (newStep = step ± 1); list[0..n) is A(newStep). */
  advance(sys: ParticleSystem, newStep: number, list: Int32Array, n: number): void {
    const dir = newStep - this.step
    if (dir !== 1 && dir !== -1) throw new RangeError('EnergyLedger.advance takes one step at a time; rebuild it after a seek')
    const next = rampingPairs(sys, newStep, list, n, this.stride)
    if (dir === 1) {
      this.rampWork += rampWorkStep(sys, this.step, this.phi, next, this.stride)
      const born: number[] = []
      for (let k = 0; k < n; k++) {
        const s = list[k]
        if (sys.birth[s] !== newStep) continue
        const e = birthEnergy(sys, s)
        this.birthE.set(s, e)
        this.births += e
        born.push(s)
      }
      if (born.length) this.bornAt.set(newStep, born)
    } else {
      this.rampWork -= rampWorkStep(sys, newStep, next, this.phi, this.stride)
      const born = this.bornAt.get(this.step)
      if (born) {
        for (const s of born) {
          this.births -= this.birthE.get(s) ?? 0
          this.birthE.delete(s)
        }
        this.bornAt.delete(this.step)
      }
    }
    this.phi = next
    this.step = newStep
  }

  /** The ledger at the current step (recomputes E_n and K_n for list[0..n)). */
  read(sys: ParticleSystem, list: Int32Array, n: number): LedgerReading {
    const E = energyFor(sys, this.step, list, n, this.pairs)
    const raw = E.total - this.e0
    return { E, e0: this.e0, raw, births: this.births, rampWork: this.rampWork, ledger: raw - this.births - this.rampWork }
  }
}
