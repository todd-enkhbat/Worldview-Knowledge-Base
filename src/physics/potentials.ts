// The three force terms as pure integer functions of position. They return the
// mass-weighted impulse I = F·dt² in Q.30; the per-particle kick is
// K = mulshr(ΣI, invMass, 16) in Q.27. Each body maps line-for-line to GLSL.

import { KICK_SHIFT, TAU_FRAC, TAU_ONE, TETHER_SHIFT, mulshr, rshr } from './fixed.ts'
import { LANDSCAPE_MODES, type LandscapeParams, type PhysicsParams } from './params.ts'
import { sinQ15 } from './sinlut.ts'

/** Q.19 × Q.11 coefficient → Q.30 (the default; defined in fixed.ts so params.ts can use it). */
export { TETHER_SHIFT }
/** Pair separations are pre-shifted Q.19 → Q.13 so r² fits in i32. */
export const PAIR_PRE_SHIFT = 6

/**
 * Tether impulse on one axis for the wrapped offset u = (X − A) | 0.
 * Harmonic inside |u| ≤ uSat, constant force beyond (a Huber continuation of the
 * same potential), so it stays conservative and bounded for every i32 input.
 * The output is bounded by uSat·|k|/2^shift; params.ts keeps that ≤ 2^29 for every axis.
 */
export function tetherImpulse(u: number, k: number, uSat: number, shift: number = TETHER_SHIFT): number {
  const us = u > uSat ? uSat : u < -uSat ? -uSat : u
  return -mulshr(us, k, shift) | 0
}

/** Per-particle landscape coefficient c_im = C_m·τ_i (computed once per particle). */
export function landscapeCoef(coef: number, tau: number): number {
  return mulshr(coef, tau, TAU_FRAC)
}

/**
 * Landscape impulse Σ_m s_m·k_m with s_m = c_im·sin(Φ_m), Φ_m = kx·X + kz·Z + φ
 * (wrapping u32 phase). Each mode's force is along k_m, so the field has no curl
 * beyond per-component rounding. Adds into out[o] (x) and out[o + 2] (z).
 */
export function addLandscapeImpulse(
  xw: number,
  zw: number,
  l: LandscapeParams,
  c: Int32Array,
  co: number,
  out: Int32Array,
  o: number,
): void {
  let ix = 0
  let iz = 0
  for (let m = 0; m < LANDSCAPE_MODES; m++) {
    const kx = l.kx[m]
    const kz = l.kz[m]
    const ph = (Math.imul(kx, xw) + Math.imul(kz, zw) + l.phase[m]) | 0
    const s = mulshr(c[co + m], sinQ15(ph), 15)
    ix = (ix + mulshr(s, kx, 16)) | 0
    iz = (iz + mulshr(s, kz, 16)) | 0
  }
  out[o] = (out[o] + ix) | 0
  out[o + 2] = (out[o + 2] + iz) | 0
}

/**
 * Pair-core impulse on i from j for the wrapped separation d = (X_i − X_j) | 0 and
 * ramp λ (Q.15). φ = ε(1 − s)³, s = r²/σ²; f = 6ε/σ²·(1 − s)²·λ·d, polynomial in r².
 * Writes f into out[0..2] and returns true when r < σ. f(−d) = −f(d) exactly
 * (rshr and mulshr round half-even, which is odd-symmetric).
 */
export function pairImpulse(
  dx: number,
  dy: number,
  dz: number,
  lam: number,
  p: PhysicsParams,
  out: Int32Array,
): boolean {
  const sig = p.pairSigma
  if (dx >= sig || dx <= -sig || dy >= sig || dy <= -sig || dz >= sig || dz <= -sig) return false
  const qx = rshr(dx, PAIR_PRE_SHIFT)
  const qy = rshr(dy, PAIR_PRE_SHIFT)
  const qz = rshr(dz, PAIR_PRE_SHIFT)
  const r2 = (Math.imul(qx, qx) + Math.imul(qy, qy) + Math.imul(qz, qz)) | 0
  const s = mulshr(r2, p.pairInvSig2, 26)
  if (s >= TAU_ONE) return false
  const w = TAU_ONE - s
  const w2 = rshr(Math.imul(w, w), 15)
  const g = rshr(Math.imul(rshr(Math.imul(p.pairCoef, w2), 15), lam), 15)
  out[0] = mulshr(dx, g, 10)
  out[1] = mulshr(dy, g, 10)
  out[2] = mulshr(dz, g, 10)
  return true
}

/** K = I·(1/m): Q.30 impulse × Q.13 inverse mass → Q.27; |K| ≤ 2^30 for every i32 I. */
export function kickFromImpulse(imp: number, invMass: number): number {
  return mulshr(imp, invMass, KICK_SHIFT)
}
