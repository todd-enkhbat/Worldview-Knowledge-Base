import { describe, expect, it } from 'vitest'
import { UNIT } from '../../src/physics/fixed.ts'
import {
  type ParticleSystem,
  createSystem,
  flip,
  runBackward,
  runForward,
  setParticle,
  stateHash,
  stepBackward,
  stepForward,
} from '../../src/physics/integrator.ts'
import { makePhysicsParams } from '../../src/physics/params.ts'
import { cloneState, makeDustWorld, makeNodeWorld, testRng } from './helpers.ts'

/** Uniformly random full-range i32 X, D and anchors; a third of the particles clustered so pairs fire. */
function randomFullRange(seed: number, n = 48, births = false): ParticleSystem {
  const rand = testRng(seed)
  const sys = createSystem(makePhysicsParams({ seed: 0x5eed, landscapeAmp: 4096 }), n, 'node')
  for (let i = 0; i < n; i++) {
    setParticle(sys, i, 2048 + (rand() % 30721), rand() % 32769, births ? (rand() % 400) - 200 : -1000)
    for (let a = 0; a < 3; a++) {
      const k = 3 * i + a
      sys.anchor[k] = rand() | 0
      sys.d[k] = rand() | 0
      sys.x[k] = i % 3 === 0 ? ((rand() % (4 * UNIT)) - 2 * UNIT) | 0 : rand() | 0
    }
  }
  return sys
}

function sameState(sys: ParticleSystem, s: { x: Int32Array; d: Int32Array }): boolean {
  return sys.x.every((v, k) => v === s.x[k]) && sys.d.every((v, k) => v === s.d[k])
}

describe('integer leapfrog is a bijection', () => {
  it('inverse(forward(s)) = s over uniformly random full-range i32 states', () => {
    for (const steps of [1, 10, 100]) {
      for (let seed = 1; seed <= 4; seed++) {
        const sys = randomFullRange(seed * 31 + steps, 48, seed % 2 === 0)
        const s0 = cloneState(sys)
        const sat0 = sys.saturations
        runForward(sys, 77, steps)
        expect(sameState(sys, s0)).toBe(false)
        runBackward(sys, 77 + steps, steps)
        expect(sameState(sys, s0)).toBe(true)
        // Full-range anchors put most offsets past the Huber bound: the sentinel sees it.
        expect(sys.saturations).toBeGreaterThan(sat0)
      }
    }
  })

  it('R1-lite: N = 100 realistic world with newborn ramps restores the state hash', () => {
    for (const n of [1, 600, 6000]) {
      const sys = makeNodeWorld({ n: 100, seed: 5, maxBirth: 300, halfWidth: 20, height: 24 })
      const h0 = stateHash(sys)
      runForward(sys, 0, n)
      if (n > 1) expect(stateHash(sys)).not.toBe(h0)
      runBackward(sys, n, n)
      expect(stateHash(sys)).toBe(h0)
      expect(sys.saturations).toBe(0)
    }
  })

  it('dust (no pairs) reverses exactly', () => {
    const sys = makeDustWorld(256)
    const h0 = stateHash(sys)
    runForward(sys, 0, 1200)
    runBackward(sys, 1200, 1200)
    expect(stateHash(sys)).toBe(h0)
  })
})

describe('Loschmidt flip F(X, D) = (X, −(D + K(X)))', () => {
  it('is an involution: F∘F = id', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const sys = randomFullRange(100 + seed)
      const s0 = cloneState(sys)
      flip(sys, 0)
      expect(sameState(sys, s0)).toBe(false)
      flip(sys, 0)
      expect(sameState(sys, s0)).toBe(true)
    }
  })

  it('F∘Φ∘F = Φ⁻¹ on full-range states', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const a = randomFullRange(200 + seed)
      const b = randomFullRange(200 + seed)
      flip(a, 0)
      stepForward(a, 0)
      flip(a, 0)
      stepBackward(b, 0)
      expect(sameState(a, cloneState(b))).toBe(true)
    }
  })

  it('forward n → flip → forward n → flip returns the original state', () => {
    const sys = makeNodeWorld({ n: 100, seed: 9, halfWidth: 20, height: 24 })
    const h0 = stateHash(sys)
    runForward(sys, 0, 600)
    flip(sys, 0)
    runForward(sys, 0, 600)
    flip(sys, 0)
    expect(stateHash(sys)).toBe(h0)
  })
})
