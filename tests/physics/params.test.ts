import { describe, expect, it } from 'vitest'
import { INV_MASS_MAX, INV_MASS_MIN, TAU_ONE } from '../../src/physics/fixed.ts'
import {
  AMP_MAX,
  RAMP_LUT,
  assertStable,
  computeOmegaMaxDt,
  generateLandscape,
  landscapeHash,
  makePhysicsParams,
  waveNumber,
} from '../../src/physics/params.ts'
import { makeNodeWorld } from './helpers.ts'

describe('physics params', () => {
  it('derives the documented integer coefficients', () => {
    const p = makePhysicsParams()
    // Node kY = 64 (criterion B fix): coefficient round(64·2^20/3600) at shift 9, saturating at 16 u.
    expect(p.node).toEqual({ kXZ: 1165, kY: 18641, uSat: 1 << 25, yShift: 9, uSatY: 1 << 23 })
    expect(p.dust).toEqual({ kXZ: 350, kY: 1748, uSat: 1 << 25, yShift: 11, uSatY: 1 << 25 })
    expect([p.pairSigma, p.pairInvSig2, p.pairCoef]).toEqual([3 << 19, 3641, 19418])
  })

  it('pins the landscape generated from a fixed seed', () => {
    const p = makePhysicsParams({ seed: 0x5eed })
    expect(landscapeHash(p.landscape)).toBe(0x2a41d855)
    expect(Array.from(p.landscape.kx)).toEqual([1631, -1195, 909, -93, 1029, 138, 465, -514])
    expect(Array.from(p.landscape.cQ16)).toEqual([23450, 125868, 40539, 49118, -69179, 83180, -84893, -80727])
    expect(landscapeHash(generateLandscape(0x5eed, AMP_MAX))).toBe(0x7fe6d224)
  })

  it('draws |k| ∈ (2π/6)·[0.6, 1.4] and c ~ N(0, 0.8²)', () => {
    const k0 = (2 * Math.PI) / 6
    let s2 = 0
    let n = 0
    for (let seed = 1; seed <= 400; seed++) {
      const l = generateLandscape(seed)
      for (let m = 0; m < 8; m++) {
        const k = waveNumber(l, m)
        expect(k).toBeGreaterThan(0.6 * k0 - 0.002)
        expect(k).toBeLessThan(1.4 * k0 + 0.002)
        s2 += (l.cQ16[m] / 65536) ** 2
        n++
      }
    }
    expect(Math.sqrt(s2 / n)).toBeCloseTo(0.8, 1)
  })

  it('builds the smoothstep ramp LUT', () => {
    expect(RAMP_LUT.length).toBe(121)
    expect([RAMP_LUT[0], RAMP_LUT[60], RAMP_LUT[120]]).toEqual([0, 16384, 32768])
    for (let a = 1; a <= 120; a++) expect(RAMP_LUT[a]).toBeGreaterThanOrEqual(RAMP_LUT[a - 1])
    for (let a = 0; a <= 120; a++) expect(RAMP_LUT[a] + RAMP_LUT[120 - a]).toBeGreaterThanOrEqual(32767)
  })

  it('passes the ω_max·dt < 0.5 load-time gate for realistic worlds and rejects stiff ones', () => {
    const sys = makeNodeWorld({ n: 100 })
    const w = assertStable(sys.params, sys.invMass, sys.tau)
    // The stiff time tether alone contributes ω_y·dt = √(64/0.25)/60 ≈ 0.27 at the lightest mass.
    expect(w).toBeLessThan(0.45)
    // Worst case of the documented ranges: lightest mass, τ = 1, strongest lab landscape.
    const lab = makePhysicsParams({ landscapeAmp: 4 * 256 })
    expect(computeOmegaMaxDt(lab, [INV_MASS_MAX], [TAU_ONE])).toBeLessThan(0.5)
    expect(computeOmegaMaxDt(lab, [INV_MASS_MIN], [0])).toBeLessThan(0.1)
    expect(() => assertStable(makePhysicsParams({ landscapeAmp: AMP_MAX }), [INV_MASS_MAX], [TAU_ONE])).toThrow(/unstable/)
  })
})
