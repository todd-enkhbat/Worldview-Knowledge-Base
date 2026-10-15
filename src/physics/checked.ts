// Instrumented mirror of K: the same integer algorithm evaluated in exact float64
// arithmetic (every intermediate is an integer below 2^53), with every value that
// the i32 kernel would hold checked against [−2^31, 2^31). Used by the overflow
// sweep and the accept tier; it must agree bit-for-bit with potentials.ts.
// Intentional wraps (the u32 phase, torus differences) are reduced mod 2^32 explicitly.

import { KICK_SHIFT, TAU_FRAC, TAU_ONE } from './fixed.ts'
import { LANDSCAPE_MODES, type LandscapeParams, type PhysicsParams } from './params.ts'
import { PAIR_PRE_SHIFT, TETHER_SHIFT } from './potentials.ts'
import { SIN_LUT, SIN_LUT_SIZE } from './sinlut.ts'

const TWO16 = 65536
const TWO31 = 2 ** 31
const TWO32 = 2 ** 32

/** Running statistics of a checked evaluation. */
export interface CheckStats {
  checks: number
  /** Largest |value| seen, as log2. */
  maxLog2: number
}

export const checkStats: CheckStats = { checks: 0, maxLog2: 0 }

export function resetCheckStats(): void {
  checkStats.checks = 0
  checkStats.maxLog2 = 0
}

/** Assert v is an i32 value. */
export function chk(v: number, what: string): number {
  if (!Number.isSafeInteger(v) || v < -TWO31 || v >= TWO31) {
    throw new RangeError(`${what}: ${v} is outside i32`)
  }
  checkStats.checks++
  const a = Math.abs(v)
  if (a > 0) {
    const l = Math.log2(a)
    if (l > checkStats.maxLog2) checkStats.maxLog2 = l
  }
  return v === 0 ? 0 : v // no −0: the i32 kernel has none
}

/** Exact round-half-even of v / 2^s for |v| < 2^53. */
export function rheExact(v: number, s: number): number {
  const p = 2 ** s
  const q = Math.floor(v / p)
  const r = v - q * p
  const h = p / 2
  if (r > h) return q + 1
  if (r < h) return q
  return Math.abs(q % 2) === 1 ? q + 1 : q
}

/** Wrap an exact integer to i32 (an intentional, documented wrap). */
export function wrapI32(v: number): number {
  const m = ((v % TWO32) + TWO32) % TWO32
  return m >= TWO31 ? m - TWO32 : m
}

export function rshrChecked(x: number, s: number, what: string): number {
  chk(x, what)
  if (!(s >= 1 && s <= 30)) throw new RangeError(`${what}: shift ${s}`)
  return chk(rheExact(x, s), what)
}

export function mulshrChecked(a: number, b: number, s: number, what: string): number {
  chk(a, `${what}.a`)
  if (Math.abs(b) > 0x8000 || !Number.isInteger(b)) throw new RangeError(`${what}: |b| = ${b} > 2^15`)
  if (!(s >= 1 && s <= 30)) throw new RangeError(`${what}: shift ${s}`)
  const ah = Math.floor(a / TWO16)
  const al = a - ah * TWO16
  chk(ah * b, `${what}.ah·b`)
  const q = chk(al * b, `${what}.al·b`)
  chk(ah * b + Math.floor(q / TWO16), `${what}.hi`)
  return chk(rheExact(a * b, s), what)
}

function mulChecked(a: number, b: number, what: string): number {
  return chk(a * b, what)
}

function addChecked(a: number, b: number, what: string): number {
  return chk(a + b, what)
}

export function sinChecked(phase: number): number {
  const ph = ((phase % TWO32) + TWO32) % TWO32
  const i = Math.floor(ph / 2 ** 20)
  const f = Math.floor(ph / 16) % TWO16
  const a = SIN_LUT[i]
  const b = SIN_LUT[(i + 1) % SIN_LUT_SIZE]
  const p = mulChecked(b - a, f, 'lut.(b−a)·f')
  return chk(a + rheExact(p, 16), 'lut')
}

export function tetherChecked(u: number, k: number, uSat: number, shift: number = TETHER_SHIFT): number {
  chk(u, 'tether.u')
  const us = u > uSat ? uSat : u < -uSat ? -uSat : u
  return chk(-mulshrChecked(us, k, shift, 'tether'), 'tether.I')
}

/** Landscape impulse (x, z) of one particle with per-particle coefficients c[co..]. */
export function landscapeChecked(
  xw: number,
  zw: number,
  l: LandscapeParams,
  c: ArrayLike<number>,
  co: number,
): [number, number] {
  let ix = 0
  let iz = 0
  for (let m = 0; m < LANDSCAPE_MODES; m++) {
    const ph = wrapI32(l.kx[m] * xw + l.kz[m] * zw + l.phase[m])
    const s = mulshrChecked(c[co + m], sinChecked(ph), 15, 'landscape.s')
    ix = addChecked(ix, mulshrChecked(s, l.kx[m], 16, 'landscape.Ix'), 'landscape.ΣIx')
    iz = addChecked(iz, mulshrChecked(s, l.kz[m], 16, 'landscape.Iz'), 'landscape.ΣIz')
  }
  return [ix, iz]
}

export function landscapeCoefChecked(coef: number, tau: number): number {
  if (tau < 0 || tau > TAU_ONE) throw new RangeError(`τ = ${tau}`)
  return mulshrChecked(coef, tau, TAU_FRAC, 'landscape.c·τ')
}

/** Pair impulse on i from j, or null when r ≥ σ. */
export function pairChecked(
  dx: number,
  dy: number,
  dz: number,
  lam: number,
  p: PhysicsParams,
): [number, number, number] | null {
  chk(dx, 'pair.dx')
  chk(dy, 'pair.dy')
  chk(dz, 'pair.dz')
  const sig = p.pairSigma
  if (dx >= sig || dx <= -sig || dy >= sig || dy <= -sig || dz >= sig || dz <= -sig) return null
  const qx = rshrChecked(dx, PAIR_PRE_SHIFT, 'pair.qx')
  const qy = rshrChecked(dy, PAIR_PRE_SHIFT, 'pair.qy')
  const qz = rshrChecked(dz, PAIR_PRE_SHIFT, 'pair.qz')
  const r2 = addChecked(
    addChecked(mulChecked(qx, qx, 'pair.qx²'), mulChecked(qy, qy, 'pair.qy²'), 'pair.r²'),
    mulChecked(qz, qz, 'pair.qz²'),
    'pair.r²',
  )
  const s = mulshrChecked(r2, p.pairInvSig2, 26, 'pair.s')
  if (s >= TAU_ONE) return null
  const w = TAU_ONE - s
  const w2 = rshrChecked(mulChecked(w, w, 'pair.w²'), 15, 'pair.w²')
  const g0 = rshrChecked(mulChecked(p.pairCoef, w2, 'pair.P·w²'), 15, 'pair.g')
  const g = rshrChecked(mulChecked(g0, lam, 'pair.g·λ'), 15, 'pair.gλ')
  return [
    mulshrChecked(dx, g, 10, 'pair.fx'),
    mulshrChecked(dy, g, 10, 'pair.fy'),
    mulshrChecked(dz, g, 10, 'pair.fz'),
  ]
}

export function kickChecked(imp: number, invMass: number): number {
  return mulshrChecked(imp, invMass, KICK_SHIFT, 'kick')
}

export interface ParticleView {
  readonly x: ArrayLike<number>
  readonly anchor: ArrayLike<number>
  readonly invMass: ArrayLike<number>
  readonly tau: ArrayLike<number>
  readonly birth: ArrayLike<number>
  readonly count: number
  readonly pairs: boolean
  readonly pop: { readonly kXZ: number; readonly kY: number; readonly uSat: number; readonly uSatY: number; readonly yShift: number }
  readonly params: PhysicsParams
}

/** Checked K for particle i at step n (brute-force pairs), with checked accumulation. */
export function particleKickChecked(sys: ParticleView, i: number, step: number): [number, number, number] {
  const { x, anchor, pop, params } = sys
  const o = 3 * i
  const c: number[] = []
  for (let m = 0; m < LANDSCAPE_MODES; m++) c.push(landscapeCoefChecked(params.landscape.coef[m], sys.tau[i]))
  const imp = [
    tetherChecked(wrapI32(x[o] - anchor[o]), pop.kXZ, pop.uSat),
    tetherChecked(wrapI32(x[o + 1] - anchor[o + 1]), pop.kY, pop.uSatY, pop.yShift),
    tetherChecked(wrapI32(x[o + 2] - anchor[o + 2]), pop.kXZ, pop.uSat),
  ]
  const [lx, lz] = landscapeChecked(x[o], x[o + 2], params.landscape, c, 0)
  imp[0] = addChecked(imp[0], lx, 'I.x')
  imp[2] = addChecked(imp[2], lz, 'I.z')
  if (sys.pairs) {
    for (let j = 0; j < sys.count; j++) {
      if (j === i) continue
      const oj = 3 * j
      const age = step - Math.max(sys.birth[i], sys.birth[j])
      const lam = age >= params.rampSteps ? TAU_ONE : age <= 0 ? 0 : rampValue(age, params.rampSteps)
      const f = pairChecked(wrapI32(x[o] - x[oj]), wrapI32(x[o + 1] - x[oj + 1]), wrapI32(x[o + 2] - x[oj + 2]), lam, params)
      if (f) for (let a = 0; a < 3; a++) imp[a] = addChecked(imp[a], f[a], 'I.pair')
    }
  }
  const im = sys.invMass[i]
  return [kickChecked(imp[0], im), kickChecked(imp[1], im), kickChecked(imp[2], im)]
}

function rampValue(a: number, steps: number): number {
  const num = TAU_ONE * a * a * (3 * steps - 2 * a)
  const den = steps * steps * steps
  return Math.floor((2 * num + den) / (2 * den))
}
