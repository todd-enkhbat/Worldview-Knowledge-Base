// Entropy diagnostic (float64 is allowed here; nothing feeds back into the kernel).
//
// S = −D_KL(p ‖ q) of the one-particle phase-space distribution p of the active nodes,
// relative to the equilibrium reference q = N(0, I₆) in the reduced coordinates
//   z = (u_x/l_xz, u_y/l_y, u_z/l_xz, v_x/v_T, v_y/v_T, v_z/v_T),
// with
//   l_a  = √(T_REF/k_a)   the thermal tether length per axis at T_REF = 1 (decoded k:
//                          l_xz = 1.00004 u = l, l_y = 0.125001 u because kY = 64),
//   v_T  = √(T_REF/m_i)   the thermal speed of node i at T_REF (u/s),
// so a node population in equilibrium at T_REF with the tether alone sits at S = 0, and
// the Past-Hypothesis spawn (|u| ≤ 0.05 l) starts far below it. S rises toward a
// plateau ≤ 0 (nodes colder than T_REF, the landscape and the pair cores keep p ≠ q).
//
// D_KL(p ‖ q) = −H(p) − E_p[log q] = −H(p) + (d/2)·log 2π + E_p|z|²/2, so
//   S = H(p) − (d/2)·log 2π − ⟨|z|²⟩/2,
// with H(p) from the Kozachenko–Leonenko k-NN estimator (k = 4):
//   Ĥ = ψ(N) − ψ(k) + log V_d + (d/N′)·Σ_i log r_i,  V_d = π^{d/2}/Γ(d/2 + 1),
// r_i the Euclidean distance from z_i to its k-th nearest neighbour (exact, brute force
// on ≤ 2k samples). r = 0 guard: exact duplicates (zero distances) are skipped when
// ranking neighbours, so r_i is the k-th smallest *positive* distance; a point with
// fewer than k distinct neighbours is left out of the sum (N′ counts the rest).
//
// Whitening: the raw KL estimator is badly biased on strongly anisotropic samples (the
// Past-Hypothesis state has σ_u/σ_v ≈ 0.05: +1.5 nats at n = 2000 on the analytic
// Gaussian). Ĥ is therefore evaluated on the sample whitened by its own covariance,
// w = L⁻¹(z − z̄) with Σ̂ = LLᵀ, and mapped back exactly: H(z) = H(w) + log det L. The
// estimator is then affine-equivariant, and its bias is that of the isotropic case.
//
// The sample is ≤ ENTROPY_MAX_SAMPLES active slots chosen by id hash (bottom-k of
// lowbias32(fnv1a32(id))): deterministic, independent of slot order and stable when
// other nodes are inserted or removed. Never Math.random.

import { D_FRAC, STEPS_PER_SECOND, X_FRAC } from './fixed.ts'
import type { ParticleSystem } from './integrator.ts'
import { massOf, tetherK } from './params.ts'
import { fnv1a32, lowbias32 } from './rng.ts'

/** The HUD shows "—" below this many active nodes (the caller's job). */
export const MIN_ENTROPY_SAMPLES = 5
/** Neighbour rank of the Kozachenko–Leonenko estimator. */
export const ENTROPY_K = 4
/** Sample cap (exact kNN is O(n²)). */
export const ENTROPY_MAX_SAMPLES = 2000
/** Phase-space dimension. */
export const PHASE_DIM = 6
/** Reference temperature of the equilibrium N(0, I) in z. */
export const T_REF = 1

const X_SCALE = 2 ** -X_FRAC
const V_SCALE = 2 ** -D_FRAC * STEPS_PER_SECOND

export interface EntropyResult {
  /** −D_KL(p ‖ N(0, I)) in nats; NaN when fewer than k + 1 usable samples. */
  readonly S: number
  /** Sample size actually used (N′ ≤ N). */
  readonly n: number
  /** Differential entropy estimate Ĥ(p) in nats. */
  readonly H: number
  /** ⟨|z|²⟩ over the sample. */
  readonly meanZ2: number
}

/** ψ(n) for a positive integer n: −γ + Σ_{j<n} 1/j. */
export function digammaInt(n: number): number {
  let s = -0.5772156649015329
  for (let j = 1; j < n; j++) s += 1 / j
  return s
}

/** log V_d, V_d = π^{d/2}/Γ(d/2 + 1) (unit-ball volume). */
export function logUnitBallVolume(d: number): number {
  // log Γ(d/2 + 1) by recurrence from Γ(1) = 1 or Γ(1/2) = √π.
  let lg = d % 2 === 0 ? 0 : 0.5 * Math.log(Math.PI)
  for (let x = d % 2 === 0 ? 1 : 0.5; x < d / 2 + 1 - 1e-9; x += 1) lg += Math.log(x)
  return (d / 2) * Math.log(Math.PI) - lg
}

/**
 * Kozachenko–Leonenko differential entropy of n points (row-major, `dim` per point).
 * Exact kNN by brute force with the r = 0 guard described above.
 */
export function knnEntropy(
  z: Float64Array,
  n: number,
  dim: number = PHASE_DIM,
  k: number = ENTROPY_K,
): { H: number; used: number } {
  if (n < k + 1) return { H: Number.NaN, used: 0 }
  // best[i*k .. i*k+k−1]: the k smallest positive squared distances of point i, ascending.
  const best = new Float64Array(n * k).fill(Number.POSITIVE_INFINITY)
  for (let i = 0; i < n; i++) {
    const oi = i * dim
    for (let j = i + 1; j < n; j++) {
      const oj = j * dim
      let r2 = 0
      for (let a = 0; a < dim; a++) {
        const t = z[oi + a] - z[oj + a]
        r2 += t * t
      }
      if (r2 === 0) continue
      insertBest(best, i * k, k, r2)
      insertBest(best, j * k, k, r2)
    }
  }
  let sumLog = 0
  let used = 0
  for (let i = 0; i < n; i++) {
    const r2 = best[i * k + k - 1]
    if (r2 === Number.POSITIVE_INFINITY) continue
    sumLog += 0.5 * Math.log(r2)
    used++
  }
  if (used === 0) return { H: Number.NaN, used: 0 }
  const H = digammaInt(n) - digammaInt(k) + logUnitBallVolume(dim) + (dim * sumLog) / used
  return { H, used }
}

function insertBest(best: Float64Array, o: number, k: number, r2: number): void {
  if (r2 >= best[o + k - 1]) return
  let p = o + k - 1
  while (p > o && best[p - 1] > r2) {
    best[p] = best[p - 1]
    p--
  }
  best[p] = r2
}

/** S = Ĥ − (d/2)·log 2π − ⟨|z|²⟩/2 for points already in reduced coordinates. */
export function klEntropy(
  z: Float64Array,
  n: number,
  dim: number = PHASE_DIM,
  k: number = ENTROPY_K,
  whiten = true,
): EntropyResult {
  let H: number
  let used: number
  const w = whiten ? whitenSample(z, n, dim) : undefined
  if (w) {
    const r = knnEntropy(w.w, n, dim, k)
    H = r.H + w.logDetL
    used = r.used
  } else {
    ;({ H, used } = knnEntropy(z, n, dim, k))
  }
  let z2 = 0
  for (let i = 0; i < n * dim; i++) z2 += z[i] * z[i]
  const meanZ2 = n > 0 ? z2 / n : Number.NaN
  const S = used > 0 ? H - (dim / 2) * Math.log(2 * Math.PI) - meanZ2 / 2 : Number.NaN
  return { S, n: used, H, meanZ2 }
}

/**
 * w = L⁻¹(z − z̄) with Σ̂ = LLᵀ the sample covariance; undefined when Σ̂ is singular
 * (fewer than dim + 1 distinct points, or a coordinate with no spread): the caller then
 * falls back to the raw estimator.
 */
export function whitenSample(
  z: Float64Array,
  n: number,
  dim: number,
): { w: Float64Array; logDetL: number } | undefined {
  if (n <= dim) return undefined
  const mean = new Float64Array(dim)
  for (let i = 0; i < n; i++) for (let a = 0; a < dim; a++) mean[a] += z[i * dim + a]
  for (let a = 0; a < dim; a++) mean[a] /= n
  const cov = new Float64Array(dim * dim)
  for (let i = 0; i < n; i++) {
    const o = i * dim
    for (let a = 0; a < dim; a++) {
      const da = z[o + a] - mean[a]
      for (let b = 0; b <= a; b++) cov[a * dim + b] += da * (z[o + b] - mean[b])
    }
  }
  for (let a = 0; a < dim * dim; a++) cov[a] /= n - 1
  // Cholesky (lower), in place.
  const L = new Float64Array(dim * dim)
  let logDetL = 0
  for (let a = 0; a < dim; a++) {
    for (let b = 0; b <= a; b++) {
      let s = cov[a * dim + b]
      for (let c = 0; c < b; c++) s -= L[a * dim + c] * L[b * dim + c]
      if (a === b) {
        // Relative pivot floor: a coordinate with (numerically) no spread is singular.
        if (!(s > 1e-24 * Math.max(cov[a * dim + a], 1e-300))) return undefined
        L[a * dim + a] = Math.sqrt(s)
        logDetL += Math.log(L[a * dim + a])
      } else {
        L[a * dim + b] = s / L[b * dim + b]
      }
    }
  }
  const w = new Float64Array(n * dim)
  for (let i = 0; i < n; i++) {
    const o = i * dim
    // Forward substitution L·w = z − z̄.
    for (let a = 0; a < dim; a++) {
      let s = z[o + a] - mean[a]
      for (let c = 0; c < a; c++) s -= L[a * dim + c] * w[o + c]
      w[o + a] = s / L[a * dim + a]
    }
  }
  return { w, logDetL }
}

/** Sample-selection key of an id: lowbias32(fnv1a32(id)). */
export function sampleKey(id: string): number {
  return lowbias32(fnv1a32(id))
}

/**
 * Up to `max` active slots chosen by id hash (the bottom-`max` keys; ties by slot),
 * returned in ascending slot order so the float sums have a fixed order.
 */
export function selectEntropySample(
  ids: ArrayLike<string | null>,
  isActive: (slot: number) => boolean,
  max: number = ENTROPY_MAX_SAMPLES,
): Int32Array {
  const keys: number[] = []
  const slots: number[] = []
  for (let s = 0; s < ids.length; s++) {
    const id = ids[s]
    if (id === null || !isActive(s)) continue
    keys.push(sampleKey(id))
    slots.push(s)
  }
  const order = slots.map((_, i) => i)
  if (order.length > max) {
    order.sort((a, b) => keys[a] - keys[b] || slots[a] - slots[b])
    order.length = max
  }
  const out = Int32Array.from(order, (i) => slots[i])
  return out.sort()
}

/**
 * Reduced phase-space points of the given slots. The velocity is the synchronised
 * v_n = D_n + K_n/2 when `kick` holds K_n (e.g. after energy() or computeKicks at n);
 * without it, D_n alone (v at n − ½; the O(dt) offset is well below the estimator noise
 * and saves a K evaluation in the worker).
 */
export function phasePoints(
  sys: ParticleSystem,
  slots: ArrayLike<number>,
  kick?: Int32Array,
  out: Float64Array = new Float64Array(PHASE_DIM * slots.length),
): Float64Array {
  const pop = sys.pop
  const inv = [1 / Math.sqrt(T_REF / tetherK(pop.kXZ)), 1 / Math.sqrt(T_REF / tetherK(pop.kY, pop.yShift))]
  const { x, d, anchor, invMass } = sys
  for (let n = 0; n < slots.length; n++) {
    const i = slots[n]
    const o = 3 * i
    const p = PHASE_DIM * n
    const invVT = Math.sqrt(massOf(invMass[i]) / T_REF)
    for (let a = 0; a < 3; a++) {
      const u = ((x[o + a] - anchor[o + a]) | 0) * X_SCALE
      out[p + a] = u * inv[a === 1 ? 1 : 0]
      const dv = kick ? d[o + a] + kick[o + a] / 2 : d[o + a]
      out[p + 3 + a] = dv * V_SCALE * invVT
    }
  }
  return out
}

/** S of the given slots (see the header). */
export function systemEntropy(sys: ParticleSystem, slots: ArrayLike<number>, kick?: Int32Array): EntropyResult {
  return klEntropy(phasePoints(sys, slots, kick), slots.length)
}

/**
 * Closed-form −D_KL(N(μ, Σ) ‖ N(0, I)) = −½(tr Σ + |μ|² − d − log det Σ), for tests and
 * the lab's analytic checks. Σ is given by its Cholesky factor L (row-major, lower).
 */
export function gaussianNegKL(mu: ArrayLike<number>, chol: ArrayLike<number>, d: number): number {
  let tr = 0
  let logDet = 0
  for (let i = 0; i < d; i++) {
    for (let j = 0; j <= i; j++) tr += chol[i * d + j] ** 2
    logDet += 2 * Math.log(Math.abs(chol[i * d + i]))
  }
  let m2 = 0
  for (let i = 0; i < d; i++) m2 += mu[i] * mu[i]
  return -0.5 * (tr + m2 - d - logDet)
}
