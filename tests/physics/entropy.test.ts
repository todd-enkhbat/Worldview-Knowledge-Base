import { describe, expect, it } from 'vitest'
import {
  ENTROPY_K,
  MIN_ENTROPY_SAMPLES,
  PHASE_DIM,
  digammaInt,
  gaussianNegKL,
  klEntropy,
  logUnitBallVolume,
  phasePoints,
  sampleKey,
  selectEntropySample,
  systemEntropy,
} from '../../src/physics/entropy.ts'
import { draw } from '../../src/physics/rng.ts'
import { computeKicks, stepForward } from '../../src/physics/integrator.ts'
import { makeNodeWorld } from './helpers.ts'

const D = PHASE_DIM

/** Deterministic N(0, 1) stream (Box–Muller on the counter PRNG; test-only floats). */
function gauss(seed: number): () => number {
  let k = 0
  return () => {
    const u1 = (draw(seed, k++) + 0.5) / 2 ** 32
    const u2 = draw(seed, k++) / 2 ** 32
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  }
}

/** n samples of N(μ, LLᵀ) in 6D. */
function sample(n: number, mu: number[], L: number[], seed: number): Float64Array {
  const g = gauss(seed)
  const z = new Float64Array(n * D)
  const e = new Float64Array(D)
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < D; a++) e[a] = g()
    for (let a = 0; a < D; a++) {
      let s = mu[a]
      for (let b = 0; b <= a; b++) s += L[a * D + b] * e[b]
      z[i * D + a] = s
    }
  }
  return z
}

function diag(s: number[]): number[] {
  const L = new Array<number>(D * D).fill(0)
  s.forEach((v, i) => (L[i * D + i] = v))
  return L
}

const zero = [0, 0, 0, 0, 0, 0]
const correlated = diag([1, 1, 1, 1, 1, 1])
correlated[1 * D + 0] = 0.8
correlated[1 * D + 1] = 0.6
correlated[4 * D + 3] = -0.5
correlated[4 * D + 4] = 0.7
correlated[5 * D + 2] = 0.3

const CASES: [string, number[], number[]][] = [
  ['reference N(0, I)', zero, diag([1, 1, 1, 1, 1, 1])],
  ['anisotropic diagonal', zero, diag([0.5, 2, 1, 1, 0.8, 1.5])],
  ['mean offset', [0.5, -0.3, 0, 0.2, 0, 1], diag([1, 1, 1, 1, 1, 1])],
  ['Past-Hypothesis-like (σ_u = 0.03)', zero, diag([0.03, 0.12, 0.03, 0.6, 0.6, 0.6])],
  ['correlated + offset', [0.2, 0, 0, 0, 0, -0.4], correlated],
]

describe('entropy: k = 4 Kozachenko–Leonenko KL against N(0, I)', () => {
  it('constants: ψ and the 6-ball volume', () => {
    expect(digammaInt(1)).toBeCloseTo(-0.5772156649, 9)
    expect(digammaInt(5)).toBeCloseTo(-0.5772156649 + 1 + 1 / 2 + 1 / 3 + 1 / 4, 9)
    expect(logUnitBallVolume(6)).toBeCloseTo(Math.log(Math.PI ** 3 / 6), 12)
    expect(logUnitBallVolume(3)).toBeCloseTo(Math.log((4 / 3) * Math.PI), 12)
    expect(logUnitBallVolume(1)).toBeCloseTo(Math.log(2), 12)
  })

  // Tolerance (measured over 8 seeds per case at n = 1000 with whitening): bias −0.04 to
  // −0.06 nats, sd ≤ 0.065 (the anisotropic diagonal's sd is mostly the ⟨|z|²⟩ sampling
  // noise), worst |error| 0.14. Asserted: every |Ŝ − S| ≤ 0.25 and |mean error| ≤ 0.1.
  it('matches the analytic −D_KL for Gaussians with known covariance (n = 1000)', () => {
    const n = 1000
    for (const [name, mu, L] of CASES) {
      const truth = gaussianNegKL(mu, L, D)
      let sum = 0
      for (let s = 1; s <= 4; s++) {
        const r = klEntropy(sample(n, mu, L, 7919 * s + name.length), n)
        expect(r.n, name).toBe(n)
        expect(Math.abs(r.S - truth), `${name} seed ${s}: ${r.S} vs ${truth}`).toBeLessThanOrEqual(0.25)
        sum += r.S - truth
      }
      expect(Math.abs(sum / 4), name).toBeLessThanOrEqual(0.1)
    }
  })

  it('whitening removes the anisotropy bias of the raw estimator', () => {
    const [, mu, L] = CASES[3]
    const truth = gaussianNegKL(mu, L, D)
    const z = sample(1000, mu, L, 4242)
    const raw = klEntropy(z, 1000, D, ENTROPY_K, false)
    const white = klEntropy(z, 1000, D, ENTROPY_K, true)
    expect(raw.S - truth).toBeGreaterThan(1)
    expect(Math.abs(white.S - truth)).toBeLessThan(0.25)
  })

  it('orders distributions correctly: concentrated < spread < reference', () => {
    const n = 800
    const s = [0.05, 0.3, 1].map((sd) => klEntropy(sample(n, zero, diag(new Array(D).fill(sd)), 99), n).S)
    expect(s[0]).toBeLessThan(s[1])
    expect(s[1]).toBeLessThan(s[2])
    expect(Math.abs(s[2])).toBeLessThan(0.2)
  })

  it('r = 0 guard: exact duplicates are skipped, a fully degenerate sample is NaN', () => {
    const base = sample(300, zero, diag([1, 1, 1, 1, 1, 1]), 5)
    const dup = new Float64Array(600 * D)
    dup.set(base, 0)
    dup.set(base, 300 * D)
    const r = klEntropy(dup, 600)
    expect(Number.isFinite(r.S)).toBe(true)
    expect(r.n).toBe(600)
    // Duplicating every point does not change the distribution much; no −∞ from log 0.
    expect(Math.abs(r.S - klEntropy(base, 300).S)).toBeLessThan(0.5)
    const same = new Float64Array(10 * D).fill(0.25)
    expect(Number.isNaN(klEntropy(same, 10).S)).toBe(true)
    // Below k + 1 points the estimator is undefined.
    expect(Number.isNaN(klEntropy(base, ENTROPY_K).S)).toBe(true)
    expect(MIN_ENTROPY_SAMPLES).toBeGreaterThanOrEqual(ENTROPY_K + 1)
  })
})

describe('entropy: deterministic sample by id hash', () => {
  const ids = Array.from({ length: 300 }, (_, i) => (i % 7 === 3 ? null : `node-${i}`))
  const active = (s: number) => s % 5 !== 0

  it('bottom-k by lowbias32(fnv1a32(id)), ascending slot order, independent of slot layout', () => {
    const pick = selectEntropySample(ids, active, 50)
    expect(pick.length).toBe(50)
    for (let k = 1; k < pick.length; k++) expect(pick[k]).toBeGreaterThan(pick[k - 1])
    for (const s of pick) {
      expect(ids[s]).not.toBeNull()
      expect(active(s)).toBe(true)
    }
    // Every unpicked eligible id has a larger key than every picked one.
    const maxPicked = Math.max(...Array.from(pick, (s) => sampleKey(ids[s]!)))
    ids.forEach((id, s) => {
      if (id !== null && active(s) && !pick.includes(s)) expect(sampleKey(id)).toBeGreaterThan(maxPicked)
    })
    // Same ids in permuted slots → the same id set.
    const perm = ids.map((_, i) => (i * 37) % 300)
    const ids2: (string | null)[] = new Array<string | null>(300).fill(null)
    perm.forEach((to, from) => (ids2[to] = ids[from]))
    const active2 = (s: number) => active(perm.indexOf(s))
    const set1 = new Set(Array.from(pick, (s) => ids[s]))
    const set2 = new Set(Array.from(selectEntropySample(ids2, active2, 50), (s) => ids2[s]))
    expect(set2).toEqual(set1)
  })

  it('takes every eligible slot when there are fewer than the cap', () => {
    const pick = selectEntropySample(ids, active, 100000)
    const eligible = ids.filter((id, s) => id !== null && active(s)).length
    expect(pick.length).toBe(eligible)
  })
})

describe('entropy of a node world', () => {
  it('the Past-Hypothesis spawn is far below equilibrium and S rises as the world mixes', () => {
    const sys = makeNodeWorld({ n: 400, seed: 3, halfWidth: 40, height: 36 })
    const slots = Int32Array.from({ length: sys.count }, (_, i) => i)
    const s0 = systemEntropy(sys, slots).S
    for (let n = 0; n < 900; n++) stepForward(sys, n)
    const s1 = systemEntropy(sys, slots).S
    expect(s0).toBeLessThan(-3)
    expect(s1).toBeGreaterThan(s0 + 2)
    expect(s1).toBeLessThan(0.3)
    // Synchronised velocity (kick holds K_n) differs from the half-step one by O(dt) only.
    computeKicks(sys, 900)
    const zs = phasePoints(sys, slots, sys.kick)
    const zh = phasePoints(sys, slots)
    expect(Math.abs(klEntropy(zs, sys.count).S - klEntropy(zh, sys.count).S)).toBeLessThan(0.05)
  })
})
