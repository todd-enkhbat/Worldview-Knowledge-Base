import { describe, expect, it } from 'vitest'
import { crossingTime, fitGrowth } from '../../src/lab/demos/growthFit.ts'

function synth(tau: number, s0: number, plat: number, n: number, dt: number, noise = 0): { t: number[]; s: number[] } {
  const t: number[] = []
  const s: number[] = []
  let h = 12345
  for (let i = 0; i < n; i++) {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0
    const e = ((h >>> 8) / 2 ** 24 - 0.5) * 2 * noise
    t.push(i * dt)
    s.push(plat - (plat - s0) * Math.exp(-(i * dt) / tau) + e)
  }
  return { t, s }
}

describe('fitGrowth', () => {
  it('recovers τ, the plateau and S0 of an exact exponential approach', () => {
    const { t, s } = synth(0.75, -10.9, -2.05, 1800, 1 / 60)
    const f = fitGrowth(t, s)
    expect(f.tau).toBeCloseTo(0.75, 4)
    expect(f.rate).toBeCloseTo(1 / 0.75, 3)
    expect(f.plateau).toBeCloseTo(-2.05, 4)
    expect(f.s0Fit).toBeCloseTo(-10.9, 4)
    expect(f.r2).toBeGreaterThan(0.999999)
    // Model-free crossings: ln 2 · τ and ln 20 · τ, to the sample spacing.
    expect(f.t50!).toBeGreaterThanOrEqual(Math.LN2 * 0.75 - 1 / 60)
    expect(f.t50!).toBeLessThanOrEqual(Math.LN2 * 0.75 + 1 / 60)
    expect(f.t95!).toBeGreaterThanOrEqual(Math.log(20) * 0.75 - 1 / 30)
    expect(f.t95!).toBeLessThanOrEqual(Math.log(20) * 0.75 + 1 / 30)
  })

  it('is robust to noise of the size the entropy estimator shows', () => {
    const { t, s } = synth(2, -8, -1, 3000, 1 / 60, 0.08)
    const f = fitGrowth(t, s)
    expect(f.tau).toBeGreaterThan(1.9)
    expect(f.tau).toBeLessThan(2.1)
    expect(f.plateauSd).toBeGreaterThan(0)
  })

  it('crossingTime finds the first crossing or null', () => {
    expect(crossingTime([0, 1, 2, 3], [0, 0.4, 0.6, 1], 0, 1, 0.5)).toBe(2)
    expect(crossingTime([0, 1], [0, 0.2], 0, 1, 0.95)).toBeNull()
    expect(() => fitGrowth([0, 1, 2], [0, 1, 2])).toThrow()
  })
})
