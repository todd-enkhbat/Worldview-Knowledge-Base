import { describe, expect, it } from 'vitest'
import { energy } from '../../src/physics/energy.ts'
import {
  type ParticleSystem,
  stateHash,
  stepBackwardFor,
  stepForwardFor,
} from '../../src/physics/integrator.ts'
import { EnergyLedger, birthEnergy, energyFor, rampingPairs } from '../../src/physics/ledger.ts'
import { rampAt } from '../../src/physics/params.ts'
import { makeNodeWorld } from './helpers.ts'

/** A[step] = {i : birth_i ≤ step} written into list; returns |A|. */
function activeSet(sys: ParticleSystem, step: number, list: Int32Array): number {
  let n = 0
  for (let i = 0; i < sys.count; i++) if (sys.birth[i] <= step) list[n++] = i
  return n
}

describe('energyFor (energy.ts restricted to the active set)', () => {
  it('equals energy() over every slot of a birth-free world', () => {
    const sys = makeNodeWorld({ n: 120, seed: 2, halfWidth: 12, height: 12 })
    for (let s = 0; s < 50; s++) stepForwardFor(sys, s, Int32Array.from({ length: 120 }, (_, i) => i), 120)
    const all = Int32Array.from({ length: 120 }, (_, i) => i)
    const a = energy(sys, 50)
    const b = energyFor(sys, 50, all, 120)
    for (const key of ['kinetic', 'tether', 'landscape', 'pair', 'total'] as const) {
      expect(Math.abs(a[key] - b[key])).toBeLessThanOrEqual(1e-11 * Math.max(1, Math.abs(a[key])))
    }
    expect(a.pair).toBeGreaterThan(0)
  })

  it('a birth adds exactly ΔE_birth: the newborn has λ = 0 pairs and a field-only kick', () => {
    const sys = makeNodeWorld({ n: 80, seed: 9, halfWidth: 8, height: 12, maxBirth: 400 })
    const list = new Int32Array(80)
    let n = activeSet(sys, 0, list)
    let checked = 0
    for (let s = 0; s < 400; s++) {
      stepForwardFor(sys, s, list, n)
      const before = energyFor(sys, s + 1, list, n).total
      n = activeSet(sys, s + 1, list)
      let expected = 0
      for (let k = 0; k < n; k++) if (sys.birth[list[k]] === s + 1) expected += birthEnergy(sys, list[k])
      if (expected === 0) continue
      const after = energyFor(sys, s + 1, list, n).total
      expect(Math.abs(after - before - expected)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(after)))
      checked++
    }
    expect(checked).toBeGreaterThan(20)
  })
})

describe('birth-compensated ledger', () => {
  // N = 100 nodes in a 30 × 30 × 12 u box with births spread over [0, 3000]: newborns
  // spawn inside older nodes' cores, so the ramp work is several ⟨KE⟩ and raw E jumps.
  // Measured: max|E_n − E_0|/⟨KE⟩ = 2.7, max|L_n|/⟨KE⟩ = 5.4e-4 with the trapezoid
  // ramp work; the one-sided Δλ·φ(r_{k+1}) or Δλ·φ(r_k) would leave 3.4e-2.
  const N = 100
  const STEPS = 4000

  it('stays flat (≤ 2e-3 of ⟨KE⟩) while raw E jumps, and unwinds to 0 on the way back', () => {
    const sys = makeNodeWorld({ n: N, seed: 5, halfWidth: 15, height: 12, maxBirth: 3000 })
    const list = new Int32Array(N)
    let n = activeSet(sys, 0, list)
    const n0 = n
    const h0 = stateHash(sys)
    const ledger = new EnergyLedger(sys, 0, list, n)
    let maxRaw = 0
    let maxL = 0
    let maxNoRamp = 0
    let ke = 0
    let samples = 0
    for (let s = 0; s < STEPS; s++) {
      stepForwardFor(sys, s, list, n)
      n = activeSet(sys, s + 1, list)
      ledger.advance(sys, s + 1, list, n)
      if ((s + 1) % 10 === 0) {
        const r = ledger.read(sys, list, n)
        ke += r.E.kinetic
        samples++
        maxRaw = Math.max(maxRaw, Math.abs(r.raw))
        maxNoRamp = Math.max(maxNoRamp, Math.abs(r.raw - r.births))
        maxL = Math.max(maxL, Math.abs(r.ledger))
      }
    }
    ke /= samples
    expect(n).toBe(N)
    expect(n0).toBeLessThan(5)
    expect(maxRaw / ke).toBeGreaterThan(1)
    expect(maxNoRamp / ke).toBeGreaterThan(1)
    expect(ledger.rampWork / ke).toBeGreaterThan(0.5)
    expect(maxL / ke).toBeLessThanOrEqual(2e-3)
    for (let s = STEPS; s > 0; s--) {
      n = activeSet(sys, s - 1, list)
      stepBackwardFor(sys, s - 1, list, n)
      ledger.advance(sys, s - 1, list, n)
    }
    expect(n).toBe(n0)
    expect(stateHash(sys)).toBe(h0)
    expect(Math.abs(ledger.births)).toBeLessThan(1e-9)
    expect(Math.abs(ledger.rampWork)).toBeLessThan(1e-9)
    expect(Math.abs(ledger.read(sys, list, n).ledger)).toBeLessThan(1e-9)
  })

  it('ramp pairs: only pairs within σ whose younger member is 0..120 steps old', () => {
    const sys = makeNodeWorld({ n: 60, seed: 11, halfWidth: 6, height: 12, maxBirth: 200 })
    const list = new Int32Array(60)
    for (const step of [0, 50, 150, 320]) {
      const n = activeSet(sys, step, list)
      const m = rampingPairs(sys, step, list, n)
      for (const key of m.keys()) {
        const i = Math.floor(key / 60)
        const j = key - 60 * i
        expect(i).toBeLessThan(j)
        const age = step - Math.max(sys.birth[i], sys.birth[j])
        expect(age).toBeGreaterThanOrEqual(0)
        expect(age).toBeLessThanOrEqual(120)
      }
      if (step === 320) expect(m.size).toBe(0)
    }
    expect(rampAt(0)).toBe(0)
  })

  it('advance() refuses jumps (rebuild after a seek)', () => {
    const sys = makeNodeWorld({ n: 10, seed: 1 })
    const list = Int32Array.from({ length: 10 }, (_, i) => i)
    const ledger = new EnergyLedger(sys, 0, list, 10)
    expect(() => ledger.advance(sys, 5, list, 10)).toThrow(RangeError)
  })
})
