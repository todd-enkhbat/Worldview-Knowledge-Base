import { describe, expect, it } from 'vitest'
import { stepForward } from '../../src/physics/integrator.ts'
import { AMP_ONE, makePhysicsParams } from '../../src/physics/params.ts'
import {
  checkShadowStep,
  determinant,
  matMul,
  shadowFromSystem,
  shadowJacobian,
  shadowStep,
  symplecticDefect,
} from '../../src/physics/shadow.ts'
import { makeNodeWorld } from './helpers.ts'

// Lab-strength landscape (6×), anchors packed into a 3 × 1 × 3 u box so the pair cores
// overlap, births in [0, 60] so some ramps are still moving at step 100.
const params = makePhysicsParams({ seed: 0x5eed, landscapeAmp: 6 * AMP_ONE })

function packedWorld(n: number, seed: number) {
  const sys = makeNodeWorld({ n, seed, halfWidth: 1.5, height: 1, maxBirth: 60, params })
  for (let s = 0; s < 100; s++) stepForward(sys, s)
  return sys
}

describe('criterion L: f64 shadow of one step (N ≤ 8)', () => {
  // Measured (central differences, h = 1e-5 u): |det J − 1| ≤ 1.4e-10 and mass-weighted
  // defect ≤ 2.3e-10 over these states; the unweighted (x, w) form shows 1e-3 to 2e-2.
  it('|det J − 1| < 1e-6 and ‖J_cᵀΩJ_c − Ω‖_F < 1e-6 with pair cores and ramps active', () => {
    let pairs = 0
    for (const n of [2, 4, 8]) {
      for (const seed of [1, 2, 3]) {
        const sys = packedWorld(n, seed)
        const { shadow, state } = shadowFromSystem(sys)
        const c = checkShadowStep(shadow, state, 100)
        expect(c.detError, `N=${n} seed=${seed}`).toBeLessThan(1e-6)
        expect(c.defect.frobenius, `N=${n} seed=${seed}`).toBeLessThan(1e-6)
        pairs += c.pairsInRange
      }
    }
    expect(pairs).toBeGreaterThan(20)
  })

  it('the defect is sensitive: without the mass weighting unequal masses break it', () => {
    const sys = packedWorld(8, 2)
    const { shadow, state } = shadowFromSystem(sys)
    const J = shadowJacobian(shadow, state, 100)
    expect(symplecticDefect(J, shadow.mass, true).frobenius).toBeLessThan(1e-6)
    expect(symplecticDefect(J, shadow.mass, false).frobenius).toBeGreaterThan(1e-4)
  })

  it('60-step Jacobian (chain rule) stays volume-preserving and symplectic', () => {
    const sys = packedWorld(8, 3)
    const { shadow, state } = shadowFromSystem(sys)
    const dim = 6 * shadow.n
    let J: Float64Array | undefined
    let st = state.slice()
    const next = new Float64Array(dim)
    for (let s = 0; s < 60; s++) {
      const Jk = shadowJacobian(shadow, st, 100 + s)
      J = J ? matMul(Jk, J, dim) : Jk
      shadowStep(shadow, st, 100 + s, next)
      st = next.slice()
    }
    expect(Math.abs(determinant(J!, dim) - 1)).toBeLessThan(1e-6)
    expect(symplecticDefect(J!, shadow.mass).frobenius).toBeLessThan(1e-6)
  })

  it('the integer step is the shadow step plus rounding', () => {
    for (const [n, seed] of [
      [4, 2],
      [8, 1],
      [8, 3],
    ]) {
      const sys = packedWorld(n, seed)
      const { shadow, state } = shadowFromSystem(sys)
      const out = new Float64Array(state.length)
      shadowStep(shadow, state, 100, out)
      stepForward(sys, 100)
      const { state: next } = shadowFromSystem(sys)
      const n3 = 3 * n
      let du = 0
      let dw = 0
      let maxK = 0
      for (let k = 0; k < n3; k++) {
        du = Math.max(du, Math.abs(next[k] - out[k]) * 2 ** 19)
        dw = Math.max(dw, Math.abs(next[n3 + k] - out[n3 + k]) * 2 ** 27)
        maxK = Math.max(maxK, Math.abs(out[n3 + k] - state[n3 + k]) * 2 ** 27)
      }
      // Kick: the documented per-term rounding bounds (pre-shift, LUT, rhe) stay below 1e-3
      // of the largest kick here (measured ≤ 2.6e-4). Drift: ½ LSB plus the kick error /2^8.
      expect(dw).toBeLessThanOrEqual(1e-3 * maxK + 2)
      expect(du).toBeLessThanOrEqual(0.5 + dw / 256 + 1e-6)
    }
  })
})
