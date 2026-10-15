import { describe, expect, it } from 'vitest'
import { energy } from '../../src/physics/energy.ts'
import { type ParticleSystem, stepForward } from '../../src/physics/integrator.ts'
import { assertStable } from '../../src/physics/params.ts'
import { makeDustWorld, makeNodeWorld } from './helpers.ts'

interface Drift {
  maxDev: number
  slope: number
  meanKE: number
  pairSteps: number
}

/** |E_n − E_0| / ⟨KE⟩ and the fitted secular slope over the run, normalised the same way. */
function energyDrift(sys: ParticleSystem, steps: number): Drift {
  const e0 = energy(sys, 0).total
  let ke = 0
  let maxDev = 0
  let pairSteps = 0
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (let n = 0; n < steps; n++) {
    stepForward(sys, n)
    const e = energy(sys, n + 1)
    ke += e.kinetic
    if (e.pair > 0) pairSteps++
    const dev = e.total - e0
    maxDev = Math.max(maxDev, Math.abs(dev))
    sx += n
    sy += dev
    sxx += n * n
    sxy += n * dev
  }
  const slope = (steps * sxy - sx * sy) / (steps * sxx - sx * sx)
  const meanKE = ke / steps
  return { maxDev: maxDev / meanKE, slope: (slope * steps) / meanKE, meanKE, pairSteps }
}

describe('E-lite: energy of the birth-free integer world', () => {
  it('N = 100 nodes, pairs on, 6000 steps: |E_n − E_0| / ⟨KE⟩ ≤ 2e-3 with no secular slope', () => {
    for (const seed of [1, 2]) {
      const sys = makeNodeWorld({ n: 100, seed, halfWidth: 25, height: 36 })
      assertStable(sys.params, sys.invMass, sys.tau)
      const r = energyDrift(sys, 6000)
      expect(r.pairSteps).toBeGreaterThan(3000)
      expect(r.maxDev).toBeLessThanOrEqual(2e-3)
      expect(Math.abs(r.slope)).toBeLessThanOrEqual(2e-4)
      expect(sys.saturations).toBe(0)
    }
  })

  it('dust (tether + landscape, no pairs) conserves energy', () => {
    const sys = makeDustWorld(256)
    const r = energyDrift(sys, 3000)
    expect(r.maxDev).toBeLessThanOrEqual(2e-3)
    expect(Math.abs(r.slope)).toBeLessThanOrEqual(2e-4)
  })
})
