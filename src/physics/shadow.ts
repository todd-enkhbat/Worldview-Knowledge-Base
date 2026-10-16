// Continuous float64 shadow of the integer step (criterion L; diagnostics only).
//
// The SAME map as integrator.ts with every rounding removed: the integer coefficients
// of PhysicsParams are used as exact reals, the sine LUT becomes ρ·sin (ρ = 32767/32768),
// rshr/mulshr become exact division, drift(D) becomes D/2^8. In world units
// (u = x − anchor in u, w = D/2^27 in u/step):
//   w' = w + a(x),   x' = x + w'
//   a_i = (1/m_i)·I_i,  1/m_i = invMass_i/2^13
//   tether     I = −(k_q/2^22)·clamp(u, ±uSat)                      (= −k·u·dt²)
//   landscape  I += Σ_m (C_m·τ_i/2^15)·ρ·sin θ_m·(kx_m, 0, kz_m)/2^46,
//              θ_m = 2π(kx_m·x + kz_m·z)/2^13 + 2π·φ_m/2^32     (= c·τ·ρ·k·sin θ·dt²)
//   pair       I_i += d·pairCoef·(1 − s)²·λ/2^21, s = |d|²·invSig2/2^15 < 1, d = x_i − x_j
//              (= 6ε/σ²·(1 − s)²·λ·d·dt²), I_j −= the same; λ = rampAt(age)/2^15 at step n.
// The integer kernel is this map plus rounding (≤ a few LSB per step; tested).
//
// Kick and drift are shears, so det J = 1 for any a(x); the map is symplectic in the
// canonical pair (x, p = m·w) iff ∂(m·a)/∂x = −dt²·∇²U is symmetric, i.e. iff the
// mass-weighted force is a gradient. Criterion L checks both on the numerical Jacobian
// of one step for N ≤ 8:
//   |det J − 1| < 1e-6  and  ‖J_cᵀ Ω J_c − Ω‖_F < 1e-6,  J_c = T J T⁻¹, T = diag(1, m).
// The state is stored as offsets u from the anchors, so central differences see values
// of O(1) (no cancellation against |x| ~ 100 u); a translation does not change J.

import { D_FRAC, INV_MASS_FRAC, TAU_ONE, X_FRAC } from './fixed.ts'
import type { ParticleSystem } from './integrator.ts'
import { LANDSCAPE_MODES, type PhysicsParams, type PopulationParams, rampAt } from './params.ts'

const SIN_RHO = 32767 / 32768
const TWO_PI = 2 * Math.PI

export interface ShadowSystem {
  readonly n: number
  readonly params: PhysicsParams
  readonly pop: PopulationParams
  readonly pairs: boolean
  /** Anchors in u, stride 3. */
  readonly anchor: Float64Array
  /** Masses m_i = 2^13/invMass_i. */
  readonly mass: Float64Array
  /** τ_i in [0, 1]. */
  readonly tau: Float64Array
  readonly birth: Int32Array
}

/**
 * Shadow of slots[] of an integer system and its state vector
 * s = (u_0x, u_0y, u_0z, …, u_{N−1}z, w_0x, …, w_{N−1}z) in u and u/step.
 */
export function shadowFromSystem(
  sys: ParticleSystem,
  slots: ArrayLike<number> = Array.from({ length: sys.count }, (_, i) => i),
): { shadow: ShadowSystem; state: Float64Array } {
  const n = slots.length
  const anchor = new Float64Array(3 * n)
  const mass = new Float64Array(n)
  const tau = new Float64Array(n)
  const birth = new Int32Array(n)
  const state = new Float64Array(6 * n)
  for (let k = 0; k < n; k++) {
    const i = slots[k]
    mass[k] = (1 << INV_MASS_FRAC) / sys.invMass[i]
    tau[k] = sys.tau[i] / TAU_ONE
    birth[k] = sys.birth[i]
    for (let a = 0; a < 3; a++) {
      anchor[3 * k + a] = sys.anchor[3 * i + a] * 2 ** -X_FRAC
      state[3 * k + a] = ((sys.x[3 * i + a] - sys.anchor[3 * i + a]) | 0) * 2 ** -X_FRAC
      state[3 * n + 3 * k + a] = sys.d[3 * i + a] * 2 ** -D_FRAC
    }
  }
  return { shadow: { n, params: sys.params, pop: sys.pop, pairs: sys.pairs, anchor, mass, tau, birth }, state }
}

/** a(x) in u/step² for the offsets u = state[0..3n) at step n (λ from the ramp at n). */
export function shadowAccel(sh: ShadowSystem, state: Float64Array, step: number, out: Float64Array): void {
  const { n, params: p, pop, anchor, mass, tau } = sh
  const l = p.landscape
  const kxz = pop.kXZ / 2 ** 22
  const ky = pop.kY / 2 ** (pop.yShift + 11)
  const sat = pop.uSat * 2 ** -X_FRAC
  const satY = pop.uSatY * 2 ** -X_FRAC
  const imp = out
  for (let i = 0; i < n; i++) {
    const o = 3 * i
    const clamp = (u: number) => (u > sat ? sat : u < -sat ? -sat : u)
    imp[o] = -kxz * clamp(state[o])
    imp[o + 1] = -ky * (state[o + 1] > satY ? satY : state[o + 1] < -satY ? -satY : state[o + 1])
    imp[o + 2] = -kxz * clamp(state[o + 2])
    const x = anchor[o] + state[o]
    const z = anchor[o + 2] + state[o + 2]
    for (let m = 0; m < LANDSCAPE_MODES; m++) {
      const th = (TWO_PI * (l.kx[m] * x + l.kz[m] * z)) / 2 ** 13 + (TWO_PI * (l.phase[m] >>> 0)) / 2 ** 32
      const s = ((l.coef[m] * tau[i]) * SIN_RHO * Math.sin(th)) / 2 ** 46
      imp[o] += s * l.kx[m]
      imp[o + 2] += s * l.kz[m]
    }
  }
  if (sh.pairs) {
    const inv = p.pairInvSig2 / 2 ** 15
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = anchor[3 * i] + state[3 * i] - anchor[3 * j] - state[3 * j]
        const dy = anchor[3 * i + 1] + state[3 * i + 1] - anchor[3 * j + 1] - state[3 * j + 1]
        const dz = anchor[3 * i + 2] + state[3 * i + 2] - anchor[3 * j + 2] - state[3 * j + 2]
        const s = (dx * dx + dy * dy + dz * dz) * inv
        if (s >= 1) continue
        const lam = rampAt(step - Math.max(sh.birth[i], sh.birth[j])) / TAU_ONE
        const g = (p.pairCoef * (1 - s) ** 2 * lam) / 2 ** 21
        imp[3 * i] += g * dx
        imp[3 * i + 1] += g * dy
        imp[3 * i + 2] += g * dz
        imp[3 * j] -= g * dx
        imp[3 * j + 1] -= g * dy
        imp[3 * j + 2] -= g * dz
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const im = 1 / mass[i]
    out[3 * i] *= im
    out[3 * i + 1] *= im
    out[3 * i + 2] *= im
  }
}

/** One step n → n+1 of the shadow map: w' = w + a(x), u' = u + w'. */
export function shadowStep(sh: ShadowSystem, state: Float64Array, step: number, out: Float64Array): void {
  const n3 = 3 * sh.n
  const acc = new Float64Array(n3)
  shadowAccel(sh, state, step, acc)
  for (let k = 0; k < n3; k++) {
    const w = state[n3 + k] + acc[k]
    out[n3 + k] = w
    out[k] = state[k] + w
  }
}

/**
 * Numerical Jacobian of one shadow step by central differences (row-major 6N × 6N,
 * J[r·dim + c] = ∂out_r/∂state_c). h is in u for offsets and u/step for velocities.
 */
export function shadowJacobian(
  sh: ShadowSystem,
  state: Float64Array,
  step: number,
  h: number = 1e-5,
  hw: number = 1e-7,
): Float64Array {
  const dim = 6 * sh.n
  const J = new Float64Array(dim * dim)
  const sp = state.slice()
  const fp = new Float64Array(dim)
  const fm = new Float64Array(dim)
  for (let c = 0; c < dim; c++) {
    const hc = c < 3 * sh.n ? h : hw
    sp[c] = state[c] + hc
    shadowStep(sh, sp, step, fp)
    sp[c] = state[c] - hc
    shadowStep(sh, sp, step, fm)
    sp[c] = state[c]
    for (let r = 0; r < dim; r++) J[r * dim + c] = (fp[r] - fm[r]) / (2 * hc)
  }
  return J
}

/** Product A·B of dim × dim row-major matrices. */
export function matMul(A: Float64Array, B: Float64Array, dim: number): Float64Array {
  const C = new Float64Array(dim * dim)
  for (let i = 0; i < dim; i++) {
    for (let k = 0; k < dim; k++) {
      const a = A[i * dim + k]
      if (a === 0) continue
      for (let j = 0; j < dim; j++) C[i * dim + j] += a * B[k * dim + j]
    }
  }
  return C
}

/** det by LU with partial pivoting. */
export function determinant(M: Float64Array, dim: number): number {
  const A = M.slice()
  let det = 1
  for (let c = 0; c < dim; c++) {
    let p = c
    for (let r = c + 1; r < dim; r++) if (Math.abs(A[r * dim + c]) > Math.abs(A[p * dim + c])) p = r
    const piv = A[p * dim + c]
    if (piv === 0) return 0
    if (p !== c) {
      for (let k = 0; k < dim; k++) {
        const t = A[c * dim + k]
        A[c * dim + k] = A[p * dim + k]
        A[p * dim + k] = t
      }
      det = -det
    }
    det *= piv
    for (let r = c + 1; r < dim; r++) {
      const f = A[r * dim + c] / piv
      if (f === 0) continue
      for (let k = c; k < dim; k++) A[r * dim + k] -= f * A[c * dim + k]
    }
  }
  return det
}

export interface SymplecticDefect {
  /** ‖J_cᵀ Ω J_c − Ω‖_F with J_c = T J T⁻¹, T = diag(1, m) (canonical (x, p = m·w)). */
  readonly frobenius: number
  readonly maxAbs: number
}

/**
 * Mass-weighted symplectic defect of a Jacobian in the (u, w) layout. With
 * massWeighted = false the raw (x, w) form is used, which is NOT symplectic for unequal
 * masses (a check that the defect detects asymmetry).
 */
export function symplecticDefect(J: Float64Array, mass: Float64Array, massWeighted = true): SymplecticDefect {
  const n = mass.length
  const n3 = 3 * n
  const dim = 2 * n3
  const t = new Float64Array(dim)
  for (let k = 0; k < dim; k++) t[k] = k < n3 || !massWeighted ? 1 : mass[Math.floor((k - n3) / 3)]
  // J_c[r][c] = t_r · J[r][c] / t_c
  const Jc = new Float64Array(dim * dim)
  for (let r = 0; r < dim; r++) for (let c = 0; c < dim; c++) Jc[r * dim + c] = (t[r] * J[r * dim + c]) / t[c]
  // (J_cᵀ Ω J_c)[a][b] = Σ_r Σ_s Jc[r][a]·Ω[r][s]·Jc[s][b]; Ω[r][r+n3] = 1, Ω[r+n3][r] = −1.
  let fro = 0
  let maxAbs = 0
  for (let a = 0; a < dim; a++) {
    for (let b = 0; b < dim; b++) {
      let v = 0
      for (let r = 0; r < n3; r++) {
        v += Jc[r * dim + a] * Jc[(r + n3) * dim + b] - Jc[(r + n3) * dim + a] * Jc[r * dim + b]
      }
      const omega = b === a + n3 ? 1 : a === b + n3 ? -1 : 0
      const e = v - omega
      fro += e * e
      maxAbs = Math.max(maxAbs, Math.abs(e))
    }
  }
  return { frobenius: Math.sqrt(fro), maxAbs }
}

export interface ShadowCheck {
  readonly detError: number
  readonly defect: SymplecticDefect
  /** Active pair cores in the state (so the check exercises the pair term). */
  readonly pairsInRange: number
}

/** Criterion L on one state: |det J − 1| and the mass-weighted symplectic defect. */
export function checkShadowStep(sh: ShadowSystem, state: Float64Array, step: number): ShadowCheck {
  const J = shadowJacobian(sh, state, step)
  const dim = 6 * sh.n
  let pairsInRange = 0
  const inv = sh.params.pairInvSig2 / 2 ** 15
  for (let i = 0; i < sh.n; i++) {
    for (let j = i + 1; j < sh.n; j++) {
      let r2 = 0
      for (let a = 0; a < 3; a++) {
        const d = sh.anchor[3 * i + a] + state[3 * i + a] - sh.anchor[3 * j + a] - state[3 * j + a]
        r2 += d * d
      }
      if (r2 * inv < 1) pairsInRange++
    }
  }
  return { detError: Math.abs(determinant(J, dim) - 1), defect: symplecticDefect(J, sh.mass), pairsInRange }
}
