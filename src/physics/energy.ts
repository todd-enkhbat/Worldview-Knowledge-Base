// Energy diagnostic (float64 is allowed here; nothing feeds back into the kernel).
// Every term is decoded from the integer parameters the kernel actually uses, with
// the synchronised velocity v_n = D_n + K_n/2.

import { D_FRAC, STEPS_PER_SECOND, TAU_ONE, X_FRAC } from './fixed.ts'
import { type ParticleSystem, computeKicks } from './integrator.ts'
import {
  LANDSCAPE_MODES,
  landscapeAmplitude,
  massOf,
  pairEpsilonEff,
  pairSigmaEff,
  rampAt,
  tetherK,
} from './params.ts'

export interface EnergyComponents {
  readonly kinetic: number
  readonly tether: number
  readonly landscape: number
  readonly pair: number
  readonly total: number
}

const X_SCALE = 2 ** -X_FRAC
const V_SCALE = 2 ** -D_FRAC * STEPS_PER_SECOND
const PHASE_TO_RAD = (2 * Math.PI) / 2 ** 32

function huber(u: number, k: number, sat: number): number {
  const a = Math.abs(u)
  return a <= sat ? 0.5 * k * a * a : k * sat * (a - 0.5 * sat)
}

/** E_n for the state at step n (recomputes K at n; leaves sys.kick holding K_n). */
export function energy(sys: ParticleSystem, step: number): EnergyComponents {
  computeKicks(sys, step)
  const { x, d, kick, anchor, invMass, lcoef, count, pop } = sys
  const l = sys.params.landscape
  const kxz = tetherK(pop.kXZ)
  const ky = tetherK(pop.kY, pop.yShift)
  const sat = pop.uSat * X_SCALE
  const satY = pop.uSatY * X_SCALE
  let kinetic = 0
  let tether = 0
  let landscape = 0
  for (let i = 0; i < count; i++) {
    const o = 3 * i
    const m = massOf(invMass[i])
    let v2 = 0
    for (let a = 0; a < 3; a++) {
      const v = (d[o + a] + kick[o + a] / 2) * V_SCALE
      v2 += v * v
    }
    kinetic += 0.5 * m * v2
    const ux = ((x[o] - anchor[o]) | 0) * X_SCALE
    const uy = ((x[o + 1] - anchor[o + 1]) | 0) * X_SCALE
    const uz = ((x[o + 2] - anchor[o + 2]) | 0) * X_SCALE
    tether += huber(ux, kxz, sat) + huber(uy, ky, satY) + huber(uz, kxz, sat)
    for (let mo = 0; mo < LANDSCAPE_MODES; mo++) {
      const ph = (Math.imul(l.kx[mo], x[o]) + Math.imul(l.kz[mo], x[o + 2]) + l.phase[mo]) >>> 0
      landscape += landscapeAmplitude(lcoef[LANDSCAPE_MODES * i + mo]) * Math.cos(ph * PHASE_TO_RAD)
    }
  }
  const pair = sys.pairs ? pairEnergy(sys, step) : 0
  return { kinetic, tether, landscape, pair, total: kinetic + tether + landscape + pair }
}

/** Σ_{i<j} λ_ij ε(1 − r²/σ²)³ with the decoded ε, σ. */
export function pairEnergy(sys: ParticleSystem, step: number): number {
  const p = sys.params
  const eps = pairEpsilonEff(p)
  const sig2 = pairSigmaEff(p) ** 2
  const { x, birth, count } = sys
  let e = 0
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const dx = ((x[3 * i] - x[3 * j]) | 0) * X_SCALE
      const dy = ((x[3 * i + 1] - x[3 * j + 1]) | 0) * X_SCALE
      const dz = ((x[3 * i + 2] - x[3 * j + 2]) | 0) * X_SCALE
      const s = (dx * dx + dy * dy + dz * dz) / sig2
      if (s >= 1) continue
      const lam = rampAt(step - Math.max(birth[i], birth[j])) / TAU_ONE
      e += lam * eps * (1 - s) ** 3
    }
  }
  return e
}
