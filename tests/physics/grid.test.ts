import { describe, expect, it } from 'vitest'
import { INT_MAX, INT_MIN, UNIT } from '../../src/physics/fixed.ts'
import { accumulatePairsGrid, cellShiftFor, createPairGrid } from '../../src/physics/grid.ts'
import {
  type ParticleSystem,
  accumulatePairsBruteForce,
  accumulatePairsListBruteForce,
  createSystem,
  setParticle,
} from '../../src/physics/integrator.ts'
import { RAMP_STEPS, makePhysicsParams } from '../../src/physics/params.ts'
import { shuffled } from './worldFixture.ts'
import { testRng } from './helpers.ts'

const params = makePhysicsParams({ seed: 0x5eed })
const STEP = 1000

/**
 * n particles in clusters of `boxU` u around `centers` (Q.19), so many pairs fire; random
 * masses, τ and births straddling the ramp so λ takes every kind of value.
 */
function clusteredSystem(seed: number, n: number, boxU: number, centers: readonly (readonly [number, number, number])[]): ParticleSystem {
  const rand = testRng(seed)
  const sys = createSystem(params, n, 'node')
  for (let i = 0; i < n; i++) {
    setParticle(sys, i, 2048 + (rand() % 30721), rand() % 32769, STEP - (rand() % (2 * RAMP_STEPS)))
    const c = centers[i % centers.length]
    for (let a = 0; a < 3; a++) {
      const off = Math.imul((rand() % (boxU * 1024)) - ((boxU * 1024) >> 1), UNIT >> 10)
      sys.x[3 * i + a] = (c[a] + off) | 0
    }
  }
  return sys
}

function impulses(sys: ParticleSystem, run: () => void): { imp: Int32Array; sh: Float64Array } {
  sys.imp.fill(0)
  sys.impShadow.fill(0)
  run()
  return { imp: sys.imp.slice(), sh: sys.impShadow.slice() }
}

function allSlots(n: number): Int32Array {
  return Int32Array.from({ length: n }, (_, i) => i)
}

function expectSame(a: { imp: Int32Array; sh: Float64Array }, b: { imp: Int32Array; sh: Float64Array }): void {
  expect(a.imp).toEqual(b.imp)
  expect(a.sh).toEqual(b.sh)
}

const ORIGIN: [number, number, number] = [0, 0, 0]

describe('uniform pair grid', () => {
  it('uses 4 u cells for σ = 3 u', () => {
    expect(cellShiftFor(params.pairSigma)).toBe(21)
    expect(2 ** 21).toBeGreaterThanOrEqual(params.pairSigma)
  })

  it('equals the O(N²) reference bit-for-bit (dense and hash layouts, shuffled orders)', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const n = 150 + 50 * seed
      const sys = clusteredSystem(seed, n, 8 + 4 * seed, [ORIGIN, [20 * UNIT, -5 * UNIT, 3 * UNIT]])
      const ref = impulses(sys, () => accumulatePairsBruteForce(sys, STEP))
      let fired = 0
      for (let k = 0; k < ref.imp.length; k++) if (ref.imp[k] !== 0) fired++
      expect(fired).toBeGreaterThan(n) // pairs actually act
      expectSame(impulses(sys, () => accumulatePairsListBruteForce(sys, STEP, allSlots(n), n)), ref)
      for (const forceHash of [false, true]) {
        const g = createPairGrid(params.pairSigma)
        g.forceHash = forceHash
        for (let r = 0; r < 3; r++) {
          const list = Int32Array.from(shuffled([...allSlots(n)], seed * 31 + r))
          expectSame(impulses(sys, () => accumulatePairsGrid(sys, STEP, list, n, g)), ref)
          expect(g.lastMode).toBe(forceHash ? 'hash' : 'dense')
          expect(g.lastCandidates).toBeGreaterThan(0)
        }
      }
    }
  })

  it('handles active subsets in any order', () => {
    const n = 400
    const sys = clusteredSystem(11, n, 14, [ORIGIN])
    const g = createPairGrid(params.pairSigma, 8) // grows on demand
    for (let r = 0; r < 5; r++) {
      const sub = shuffled([...allSlots(n)], 100 + r).slice(0, 50 + 70 * r)
      const list = Int32Array.from(sub)
      const ref = impulses(sys, () => accumulatePairsListBruteForce(sys, STEP, list, list.length))
      expectSame(impulses(sys, () => accumulatePairsGrid(sys, STEP, list, list.length, g)), ref)
      const rev = Int32Array.from(sub.slice().reverse())
      g.forceHash = r % 2 === 1
      expectSame(impulses(sys, () => accumulatePairsGrid(sys, STEP, rev, rev.length, g)), ref)
      // Inactive particles are never touched.
      const inSub = new Set(sub)
      const got = impulses(sys, () => accumulatePairsGrid(sys, STEP, list, list.length, g))
      for (let i = 0; i < n; i++) if (!inSub.has(i)) expect([got.imp[3 * i], got.imp[3 * i + 1], got.imp[3 * i + 2]]).toEqual([0, 0, 0])
    }
  })

  it('finds pairs across the torus seam (±4096 u) on every axis', () => {
    const near = INT_MAX - 2 * UNIT
    const seams: [number, number, number][] = [
      [INT_MAX, 0, 0],
      [0, INT_MIN, 0],
      [0, 0, INT_MAX],
      [INT_MIN, INT_MAX, INT_MIN],
      [near, -near, near],
    ]
    for (let k = 0; k < seams.length; k++) {
      const sys = clusteredSystem(40 + k, 300, 10, [seams[k]])
      const ref = impulses(sys, () => accumulatePairsBruteForce(sys, STEP))
      const g = createPairGrid(params.pairSigma)
      const got = impulses(sys, () => accumulatePairsGrid(sys, STEP, allSlots(300), 300, g))
      expectSame(got, ref)
      // A cluster straddling the seam spans the whole signed range, so the hash layout runs.
      if (k < 4) expect(g.lastMode).toBe('hash')
    }
    // Seam pairs exist: two particles 1 u apart across X = ±4096 u interact.
    const sys = createSystem(params, 2, 'node')
    setParticle(sys, 0, 8192, 0, 0)
    setParticle(sys, 1, 8192, 0, 0)
    sys.x[0] = INT_MAX - (UNIT >> 1)
    sys.x[3] = INT_MIN + (UNIT >> 1)
    const g = createPairGrid(params.pairSigma)
    const got = impulses(sys, () => accumulatePairsGrid(sys, STEP, allSlots(2), 2, g))
    expect(got.imp[0]).toBeLessThan(0) // pushed away across the seam (towards −x)
    expect(got.imp[3]).toBe(-got.imp[0])
    expectSame(got, impulses(sys, () => accumulatePairsBruteForce(sys, STEP)))
  })

  it('matches on sparse full-range and widely spread worlds (hash fallback)', () => {
    for (let seed = 1; seed <= 3; seed++) {
      const rand = testRng(500 + seed)
      const centers: [number, number, number][] = []
      for (let c = 0; c < 12; c++) centers.push([rand() | 0, rand() | 0, rand() | 0])
      const sys = clusteredSystem(600 + seed, 360, 9, centers)
      const ref = impulses(sys, () => accumulatePairsBruteForce(sys, STEP))
      const g = createPairGrid(params.pairSigma)
      expectSame(impulses(sys, () => accumulatePairsGrid(sys, STEP, allSlots(360), 360, g)), ref)
      expect(g.lastMode).toBe('hash')
    }
  })

  it('handles degenerate inputs: 0/1 particles, everything in one cell, exact cell boundaries', () => {
    const g = createPairGrid(params.pairSigma)
    const one = clusteredSystem(7, 1, 1, [ORIGIN])
    expectSame(impulses(one, () => accumulatePairsGrid(one, STEP, allSlots(1), 1, g)), impulses(one, () => undefined))
    expectSame(impulses(one, () => accumulatePairsGrid(one, STEP, allSlots(1), 0, g)), impulses(one, () => undefined))
    const pile = clusteredSystem(8, 120, 1, [[3 * UNIT, 3 * UNIT, 3 * UNIT]])
    expectSame(impulses(pile, () => accumulatePairsGrid(pile, STEP, allSlots(120), 120, g)), impulses(pile, () => accumulatePairsBruteForce(pile, STEP)))
    // Particles exactly on cell walls (multiples of 2^21) and σ − 1 / σ apart.
    const sys = createSystem(params, 6, 'node')
    const sig = params.pairSigma
    const xs = [0, 1 << 21, (1 << 21) - 1, (1 << 21) + sig - 1, -(1 << 21), -(1 << 21) + sig]
    for (let i = 0; i < 6; i++) {
      setParticle(sys, i, 8192, 0, 0)
      sys.x[3 * i] = xs[i]
    }
    for (const forceHash of [false, true]) {
      g.forceHash = forceHash
      expectSame(impulses(sys, () => accumulatePairsGrid(sys, STEP, allSlots(6), 6, g)), impulses(sys, () => accumulatePairsBruteForce(sys, STEP)))
    }
  })
})
