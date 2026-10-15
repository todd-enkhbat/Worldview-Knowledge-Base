import { describe, expect, it } from 'vitest'
import { INV_MASS_MAX, INV_MASS_MIN, TAU_ONE, UNIT } from '../../src/physics/fixed.ts'
import { draw } from '../../src/physics/rng.ts'
import { spawnDustState, spawnNodeState, spawnSpeed, unitDirection } from '../../src/physics/spawn.ts'

const D_TO_UPS = 60 / 2 ** 27

describe('spawn (Past-Hypothesis macrostate)', () => {
  it('node offsets satisfy 0 < |u_a| and |u| ≤ 0.05·l; velocity is v0 = 0.8·√(T/m) along a unit ê', () => {
    const out = new Int32Array(6)
    for (let k = 0; k < 5000; k++) {
      const seed = draw(1234, k)
      const temp = (k * 7) % (TAU_ONE + 1)
      const im = INV_MASS_MIN + ((k * 13) % (INV_MASS_MAX - INV_MASS_MIN + 1))
      spawnNodeState(seed, temp, im, out)
      let u2 = 0
      for (let a = 0; a < 3; a++) {
        expect(out[a]).not.toBe(0)
        u2 += (out[a] / UNIT) ** 2
      }
      expect(Math.sqrt(u2)).toBeLessThanOrEqual(0.05)
      const v = Math.hypot(out[3], out[4], out[5]) * D_TO_UPS
      const v0 = 0.8 * Math.sqrt(temp / TAU_ONE / (8192 / im))
      expect(Math.abs(v - v0)).toBeLessThanOrEqual(0.06 * v0 + 1e-4)
    }
  })

  it('directions are unit vectors and isotropic', () => {
    const e = new Int32Array(3)
    const mean = [0, 0, 0]
    const n = 20000
    for (let k = 0; k < n; k++) {
      unitDirection(draw(77, k), e, 0)
      expect(Math.abs(Math.hypot(e[0], e[1], e[2]) / 32768 - 1)).toBeLessThan(2e-4)
      for (let a = 0; a < 3; a++) mean[a] += e[a] / 32768 / n
    }
    for (const m of mean) expect(Math.abs(m)).toBeLessThan(0.02)
  })

  it('spawn speed is integer-exact at the extremes', () => {
    expect(spawnSpeed(0, INV_MASS_MAX)).toBe(0)
    // T = 1, m = 0.25: v0 = 1.6 u/s → D = 1.6/60·2^27
    expect(Math.abs(spawnSpeed(TAU_ONE, INV_MASS_MAX) * D_TO_UPS - 1.6)).toBeLessThan(1e-3)
  })

  it('dust bursts radially: u ≈ 0 (never 0) and v points outward', () => {
    const out = new Int32Array(6)
    for (let k = 0; k < 5000; k++) {
      spawnDustState(draw(99, k), TAU_ONE, 8192, out)
      for (let a = 0; a < 3; a++) expect(out[a]).not.toBe(0)
      expect(Math.hypot(out[0], out[1], out[2]) / UNIT).toBeLessThan(0.012)
      const dot = out[0] * out[3] + out[1] * out[4] + out[2] * out[5]
      expect(dot).toBeGreaterThan(0)
    }
  })
})
