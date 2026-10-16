// Every tunable of the kernel as one object of integer fields, so the GPU port can
// inject them as uniforms/defines. dt = 1/60 s is folded into each coefficient.
// Nothing here uses a float: coefficients are rational constants rounded with
// exact integer division, and the landscape is drawn with the integer PRNG.

import {
  INV_MASS_FRAC,
  MUL_SMALL_MAX,
  STEPS_PER_SECOND,
  TAU_ONE,
  TETHER_SHIFT,
  UNIT,
  mulshr,
  rshr,
  roundDiv,
} from './fixed.ts'
import { draw, fnv1aWords, normalQ16, uniformBelow } from './rng.ts'
import { cosQ15, sinQ15 } from './sinlut.ts'

/**
 * Version of the kernel's bit-level semantics (K, drift, spawn, params, births/ramp,
 * world mapping). It keys the checkpoint cache, so bump it on ANY change that can alter
 * a state bit; stale cached checkpoints are then simply never looked up again.
 */
export const PHYSICS_VERSION = 2

export const LANDSCAPE_MODES = 8
/** Newborn ramp length in steps; RAMP_LUT has RAMP_STEPS + 1 entries. */
export const RAMP_STEPS = 120
/** Tether saturation |u| ≤ 64 u (Huber continuation beyond; counted in the sentinel). */
export const TETHER_SAT = 64 * UNIT
/**
 * Node time tether (Y): kY = 64 needs a coefficient of 74 565 > 2^15 at TETHER_SHIFT, so
 * the Y axis uses shift 9 (coefficient round(64·2^20/3600) = 18 641) and saturates at
 * 16 u = 2^23, which keeps |I| ≤ 2^23·2^15/2^9 = 2^29 for every coefficient ≤ 2^15.
 */
export const NODE_TETHER_SHIFT_Y = 9
export const NODE_TETHER_SAT_Y = 16 * UNIT
/** Every tether impulse stays ≤ 2^29 (the per-node impulse budget in docs/PHYSICS.md). */
export const TETHER_IMPULSE_MAX = 2 ** 29
/** Spawn length scale l = 1 u (thermal tether length √(T_max/kXZ) for nodes). */
export const SPAWN_LENGTH = UNIT
/** Per-axis spawn half-width 0.05·l/√3, so |u| ≤ 0.05·l at spawn. */
export const SPAWN_U_HALF = 15134
/** Dust radial-burst radius 0.01·l. */
export const DUST_BURST_RADIUS = 5243
/** D0 = rshr(isqrt(T_q15 · invMass_q13) · V0_COEF, 8): 0.8/60 · 2^13 · 2^8 (v0 = 0.8·√(T/m)). */
export const V0_COEF = 27962
/** Landscape amplitude scale is Q.8 and capped at 16× (overflow bound, docs/PHYSICS.md). */
export const AMP_ONE = 256
export const AMP_MAX = 16 * AMP_ONE
/** 2π·2^17/3600 in Q.7: converts c (Q.16) to the per-mode force coefficient C. */
const LANDSCAPE_GAIN_Q7 = 29282
/** 0.8 in Q.15: the landscape amplitude standard deviation. */
const C_SIGMA_Q15 = 26214
/** |k| ∈ (2π/6)·[0.6, 1.4] in phase units per Q.19 LSB: 2^13/6 · [0.6, 1.4] = [819, 1911]. */
const K_MIN = 819
const K_SPAN = 1093

export interface PopulationParams {
  /** XZ tether coefficient: I_Q30 = −mulshr(clamp(u_Q19, ±uSat), kXZ, TETHER_SHIFT) = k·u·dt²·2^30. */
  readonly kXZ: number
  /** Y tether coefficient, applied with its own shift and saturation: −mulshr(clamp(u, ±uSatY), kY, yShift). */
  readonly kY: number
  /** Saturation bound on |u| for X and Z, Q.19. */
  readonly uSat: number
  /** Right shift of the Y tether product (TETHER_SHIFT for dust; 9 for the stiff node time tether). */
  readonly yShift: number
  /** Saturation bound on |u_y|, Q.19. */
  readonly uSatY: number
}

export interface LandscapeParams {
  /** Wave vector in phase units (2^32 ≡ 2π) per Q.19 LSB; k_y = 0. */
  readonly kx: Int32Array
  readonly kz: Int32Array
  /** Phase offset φ_m as a u32 bit pattern. */
  readonly phase: Int32Array
  /** Drawn amplitude c_m, Q.16, before the amplitude scale. */
  readonly cQ16: Int32Array
  /** Force coefficient at τ = 1: C_m = A·c_m·2π·2^33·dt² (see docs/PHYSICS.md). */
  readonly coef: Int32Array
}

export interface PhysicsParams {
  readonly seed: number
  readonly node: PopulationParams
  readonly dust: PopulationParams
  /** Dust is one population: m = 1, τ = 1, T = 1. */
  readonly dustInvMass: number
  readonly dustTau: number
  readonly dustTemp: number
  /** Landscape amplitude scale, Q.8 (256 = 1×). */
  readonly landscapeAmp: number
  readonly landscape: LandscapeParams
  /** Pair core cutoff σ in Q.19 (per-axis early-out and the s ≥ 1 test). */
  readonly pairSigma: number
  /** s_Q15 = mulshr(r²_Q26, pairInvSig2, 26) = 2^15/σ². */
  readonly pairInvSig2: number
  /** g = 6ε/σ²·dt²·2^11 in Q.10 so f_Q30 = mulshr(d_Q19, g·(1−s)²·λ, 10). */
  readonly pairCoef: number
  readonly rampSteps: number
}

/** Tether coefficient for k = num/den (force units per u) at the given product shift. */
export function tetherCoef(num: number, den: number, shift: number = TETHER_SHIFT): number {
  return roundDiv(num * 2 ** (shift + 11), den * STEPS_PER_SECOND * STEPS_PER_SECOND)
}

/** Largest |tether impulse| of one axis: uSat·|k|/2^shift (Huber caps |u| at uSat). */
export function tetherImpulseBound(k: number, uSat: number, shift: number): number {
  return Math.ceil((uSat * Math.abs(k)) / 2 ** shift)
}

/**
 * Load-time guard of the tether overflow contract: every coefficient fits mulshr's small
 * operand (|k| ≤ 2^15), every shift is in [1, 15] (the mulshr branch whose result is
 * exact when it fits), and every axis's impulse stays ≤ 2^29.
 */
export function assertTetherBounds(pop: PopulationParams): void {
  const axes: [string, number, number, number][] = [
    ['xz', pop.kXZ, pop.uSat, TETHER_SHIFT],
    ['y', pop.kY, pop.uSatY, pop.yShift],
  ]
  for (const [axis, k, sat, shift] of axes) {
    const ok =
      Number.isInteger(k) && Math.abs(k) <= MUL_SMALL_MAX &&
      Number.isInteger(shift) && shift >= 1 && shift <= 15 &&
      Number.isInteger(sat) && sat > 0 && tetherImpulseBound(k, sat, shift) <= TETHER_IMPULSE_MAX
    if (!ok) throw new RangeError(`tether ${axis}: k ${k}, uSat ${sat}, shift ${shift} breaks the 2^29 impulse bound`)
  }
}

/** smoothstep(a/120) in Q.15, a = 0..120, computed with exact integer division. */
export function buildRampLut(steps: number = RAMP_STEPS): Int32Array {
  const lut = new Int32Array(steps + 1)
  const den = steps * steps * steps
  for (let a = 0; a <= steps; a++) {
    lut[a] = roundDiv(TAU_ONE * a * a * (3 * steps - 2 * a), den)
  }
  return lut
}

export const RAMP_LUT: Int32Array = buildRampLut()

/** λ for a pair whose younger member is `age` steps old. */
export function rampAt(age: number): number {
  return age >= RAMP_STEPS ? TAU_ONE : age <= 0 ? 0 : RAMP_LUT[age]
}

/** Draw the 8 landscape modes from a u32 seed, integer-only. */
export function generateLandscape(seed: number, amp: number = AMP_ONE): LandscapeParams {
  if (amp < 0 || amp > AMP_MAX) throw new RangeError(`landscape amplitude ${amp} outside [0, ${AMP_MAX}]`)
  const kx = new Int32Array(LANDSCAPE_MODES)
  const kz = new Int32Array(LANDSCAPE_MODES)
  const phase = new Int32Array(LANDSCAPE_MODES)
  const cQ16 = new Int32Array(LANDSCAPE_MODES)
  const coef = new Int32Array(LANDSCAPE_MODES)
  for (let m = 0; m < LANDSCAPE_MODES; m++) {
    const kmag = K_MIN + uniformBelow(draw(seed, 4 * m), K_SPAN)
    const dir = draw(seed, 4 * m + 1) | 0
    kx[m] = rshr(Math.imul(kmag, cosQ15(dir)), 15)
    kz[m] = rshr(Math.imul(kmag, sinQ15(dir)), 15)
    phase[m] = draw(seed, 4 * m + 2) | 0
    cQ16[m] = mulshr(normalQ16(draw(seed, 4 * m + 3)), C_SIGMA_Q15, 15)
    coef[m] = mulshr(mulshr(cQ16[m], LANDSCAPE_GAIN_Q7, 7), amp, 8)
  }
  return { kx, kz, phase, cQ16, coef }
}

export function landscapeHash(l: LandscapeParams): number {
  let h = fnv1aWords(l.kx)
  h = fnv1aWords(l.kz, 4, h)
  h = fnv1aWords(l.phase, 4, h)
  return fnv1aWords(l.coef, 4, h)
}

export interface ParamOptions {
  readonly seed?: number
  /** Q.8; the lab uses a stronger landscape. */
  readonly landscapeAmp?: number
}

export function makePhysicsParams(opts: ParamOptions = {}): PhysicsParams {
  const seed = (opts.seed ?? 0x5eed) >>> 0
  const landscapeAmp = opts.landscapeAmp ?? AMP_ONE
  const node: PopulationParams = {
    kXZ: tetherCoef(1, 1),
    kY: tetherCoef(64, 1, NODE_TETHER_SHIFT_Y),
    uSat: TETHER_SAT,
    yShift: NODE_TETHER_SHIFT_Y,
    uSatY: NODE_TETHER_SAT_Y,
  }
  // Dust keeps one shift and saturation on every axis: the GPU kernel (src/gpu/dust/glsl.ts)
  // has a single TETHER_SHIFT/TETHER_SAT and must stay bit-identical.
  const dust: PopulationParams = {
    kXZ: tetherCoef(3, 10),
    kY: tetherCoef(3, 2),
    uSat: TETHER_SAT,
    yShift: TETHER_SHIFT,
    uSatY: TETHER_SAT,
  }
  assertTetherBounds(node)
  assertTetherBounds(dust)
  return {
    seed,
    node,
    dust,
    dustInvMass: 1 << INV_MASS_FRAC,
    dustTau: TAU_ONE,
    dustTemp: TAU_ONE,
    landscapeAmp,
    landscape: generateLandscape(seed, landscapeAmp),
    pairSigma: 3 * UNIT,
    pairInvSig2: roundDiv(TAU_ONE, 9),
    // 6ε/σ² · 2^21 / 3600 with ε = 50, σ = 3
    pairCoef: roundDiv(6 * 50 * 2 ** 21, 9 * STEPS_PER_SECOND * STEPS_PER_SECOND),
    rampSteps: RAMP_STEPS,
  }
}

// ---- effective (decoded) physical values: float64, diagnostics only ----

const DT = 1 / STEPS_PER_SECOND
const SIN_RHO = 32767 / 32768

/** Effective spring constant of a tether coefficient applied at the given shift. */
export function tetherK(coef: number, shift: number = TETHER_SHIFT): number {
  return coef / (2 ** (shift + 11) * DT * DT)
}

/** Effective XZ spring constant of a population. */
export function tetherKXZ(pop: PopulationParams): number {
  return tetherK(pop.kXZ, TETHER_SHIFT)
}

/** Effective Y (time) spring constant of a population. */
export function tetherKY(pop: PopulationParams): number {
  return tetherK(pop.kY, pop.yShift)
}

export function massOf(invMass: number): number {
  return (1 << INV_MASS_FRAC) / invMass
}

/** Effective τ·c of a per-particle landscape coefficient c_im (energy units). */
export function landscapeAmplitude(cim: number): number {
  return (cim * SIN_RHO) / (2 * Math.PI * 2 ** 33 * DT * DT)
}

/** |k| in rad/u of mode m. */
export function waveNumber(l: LandscapeParams, m: number): number {
  return (Math.hypot(l.kx[m], l.kz[m]) * 2 * Math.PI) / 2 ** 13
}

export function pairSigmaEff(p: PhysicsParams): number {
  return Math.sqrt(TAU_ONE / p.pairInvSig2)
}

export function pairEpsilonEff(p: PhysicsParams): number {
  const s2 = TAU_ONE / p.pairInvSig2
  return (p.pairCoef / 2 ** 10) * s2 / (6 * DT * DT * 2 ** 11)
}

/**
 * Upper bound on ω·dt over all particles: tether, landscape curvature Σ|c||k|²τ/m and
 * one pair core at its steepest (|φ''| ≤ 6ε/σ², reduced against the lightest mass).
 */
export function computeOmegaMaxDt(
  p: PhysicsParams,
  invMass: ArrayLike<number>,
  tau: ArrayLike<number>,
  pop: PopulationParams = p.node,
  pairs = true,
): number {
  // Summing the stiffest axis with the (XZ-only) landscape curvature over-bounds the
  // block-diagonal field Hessian; kept conservative on purpose (docs/PHYSICS.md § Stability).
  const kt = Math.max(tetherKXZ(pop), tetherKY(pop))
  let lc = 0
  for (let m = 0; m < LANDSCAPE_MODES; m++) {
    const k = waveNumber(p.landscape, m)
    lc += Math.abs(landscapeAmplitude(p.landscape.coef[m])) * k * k
  }
  const pc = pairs ? (6 * pairEpsilonEff(p)) / (pairSigmaEff(p) ** 2) : 0
  let imMax = 0
  for (let i = 0; i < invMass.length; i++) imMax = Math.max(imMax, invMass[i])
  let w2 = 0
  for (let i = 0; i < invMass.length; i++) {
    const im = 1 / massOf(invMass[i])
    const t = tau[i] / TAU_ONE
    w2 = Math.max(w2, kt * im + lc * t * im + pc * (im + 1 / massOf(imMax)))
  }
  return Math.sqrt(w2) * DT
}

/** Load-time stability gate: ω_max·dt < 0.5. */
export function assertStable(
  p: PhysicsParams,
  invMass: ArrayLike<number>,
  tau: ArrayLike<number>,
  pop: PopulationParams = p.node,
  pairs = true,
): number {
  const w = computeOmegaMaxDt(p, invMass, tau, pop, pairs)
  if (!(w < 0.5)) throw new Error(`unstable step: ω_max·dt = ${w.toFixed(3)} ≥ 0.5`)
  return w
}
