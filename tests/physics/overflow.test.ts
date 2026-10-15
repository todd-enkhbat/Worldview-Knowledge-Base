import { describe, expect, it } from 'vitest'
import {
  checkStats,
  kickChecked,
  landscapeChecked,
  landscapeCoefChecked,
  pairChecked,
  particleKickChecked,
  resetCheckStats,
  sinChecked,
  tetherChecked,
} from '../../src/physics/checked.ts'
import { INT_MAX, INT_MIN, INV_MASS_MAX, INV_MASS_MIN, TAU_ONE, UNIT } from '../../src/physics/fixed.ts'
import { computeKicks } from '../../src/physics/integrator.ts'
import {
  AMP_MAX,
  type LandscapeParams,
  RAMP_STEPS,
  TETHER_SAT,
  generateLandscape,
  makePhysicsParams,
  rampAt,
} from '../../src/physics/params.ts'
import {
  addLandscapeImpulse,
  kickFromImpulse,
  landscapeCoef,
  pairImpulse,
  tetherImpulse,
} from '../../src/physics/potentials.ts'
import { sinQ15 } from '../../src/physics/sinlut.ts'
import { makeNodeWorld, testRng } from './helpers.ts'

const rand = testRng(99)
const i32 = () => rand() | 0
const p = makePhysicsParams()

/** Worst-case landscape: every mode at the Irwin–Hall bound and the strongest amplitude. */
function extremeLandscape(): LandscapeParams {
  const l = generateLandscape(0x5eed, AMP_MAX)
  const cMax = Math.round((393210 * 26214) / 32768) // 6σ·0.8 in Q.16
  const coef = Math.floor((((cMax * 29282) / 128) * AMP_MAX) / 256) + 1
  const sign = [1, -1, 1, -1, 1, 1, -1, -1]
  return {
    ...l,
    kx: Int32Array.from([1911, -1911, 0, 1351, -1351, 1911, 0, -1351]),
    kz: Int32Array.from([0, 0, 1911, 1351, 1351, 0, -1911, -1351]),
    coef: Int32Array.from(sign.map((s) => s * coef)),
  }
}

describe('overflow sweep (checked mirror agrees bit-for-bit and never leaves i32)', () => {
  it('tether over all i32 offsets, including the saturation boundary', () => {
    const us = [0, 1, -1, INT_MAX, INT_MIN, TETHER_SAT, -TETHER_SAT, TETHER_SAT + 1, -TETHER_SAT - 1, TETHER_SAT - 1]
    for (let k = 0; k < 40000; k++) us.push(k % 2 ? i32() : i32() >> 6)
    for (const k of [p.node.kXZ, p.node.kY, p.dust.kXZ, p.dust.kY, 0x8000]) {
      for (const u of us) expect(tetherImpulse(u, k, TETHER_SAT)).toBe(tetherChecked(u, k, TETHER_SAT))
    }
  })

  it('sine interpolation at every LUT index and fraction extreme', () => {
    for (let i = 0; i < 4096; i++) {
      for (const f of [0, 1, 0x7fff, 0x8000, 0x8001, 0xffff]) {
        for (const lo of [0, 15]) {
          const ph = ((i << 20) | (f << 4) | lo) | 0
          expect(sinQ15(ph)).toBe(sinChecked(ph))
        }
      }
    }
  })

  it('landscape over all phases, all τ and the strongest amplitude', () => {
    const l = extremeLandscape()
    const out = new Int32Array(3)
    const taus = [0, 1, TAU_ONE - 1, TAU_ONE, 12345]
    for (const tau of taus) {
      const c = Int32Array.from(l.coef, (cm) => landscapeCoef(cm, tau))
      expect(Array.from(c)).toEqual(Array.from(l.coef, (cm) => landscapeCoefChecked(cm, tau)))
      for (let k = 0; k < 6000; k++) {
        const x = i32()
        const z = i32()
        out.fill(0)
        addLandscapeImpulse(x, z, l, c, 0, out, 0)
        const [ix, iz] = landscapeChecked(x, z, l, c, 0)
        expect(out[0]).toBe(ix)
        expect(out[2]).toBe(iz)
      }
    }
  })

  it('pair core over distances 0..σ (incl. r = 0), every ramp age, and is exactly antisymmetric', () => {
    const f = new Int32Array(3)
    const g = new Int32Array(3)
    const sig = p.pairSigma
    const ds: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [sig - 1, 0, 0], [sig - 1, sig - 1, sig - 1]]
    for (let k = 0; k <= 512; k++) {
      const r = Math.floor(((sig - 1) * k) / 512)
      ds.push([r, 0, 0], [0, -r, 0], [0, 0, r], [r, r, 0], [-r, r, -r].map((v) => Math.trunc(v / Math.sqrt(3))) as [number, number, number])
    }
    for (let k = 0; k < 6000; k++) ds.push([(i32() % sig) | 0, (i32() % sig) | 0, (i32() % sig) | 0])
    for (let age = -1; age <= RAMP_STEPS + 1; age++) {
      const lam = rampAt(age)
      for (let k = age === RAMP_STEPS ? 0 : ds.length - 300; k < ds.length; k++) {
        const [dx, dy, dz] = ds[k]
        const hit = pairImpulse(dx, dy, dz, lam, p, f)
        const ref = pairChecked(dx, dy, dz, lam, p)
        expect(hit).toBe(ref !== null)
        if (!ref) continue
        expect(Array.from(f)).toEqual(ref)
        expect(pairImpulse(-dx | 0, -dy | 0, -dz | 0, lam, p, g)).toBe(true)
        expect(Array.from(g)).toEqual(Array.from(f, (v) => -v | 0))
      }
    }
  })

  it('kick over every i32 impulse and every mass', () => {
    const imps = [0, 1, -1, INT_MAX, INT_MIN]
    for (let k = 0; k < 20000; k++) imps.push(i32())
    for (const im of [INV_MASS_MIN, INV_MASS_MAX, 8192, 3000, 32767]) {
      for (const I of imps) expect(kickFromImpulse(I, im)).toBe(kickChecked(I, im))
    }
  })

  it('per-node impulse sum has headroom for ≥ 128 worst-case pair neighbours', () => {
    const l = extremeLandscape()
    const tetherMax = Math.abs(tetherChecked(TETHER_SAT, 0x8000, TETHER_SAT))
    let landMax = 0
    for (let m = 0; m < 8; m++) landMax += Math.ceil((Math.abs(l.coef[m]) * 1911) / 65536) + 1
    let pairMax = 0
    for (let r = 0; r < p.pairSigma; r += 997) {
      const f = pairChecked(r, 0, 0, TAU_ONE, p)
      if (f) pairMax = Math.max(pairMax, Math.abs(f[0]))
    }
    const neighbours = Math.floor((2 ** 31 - 1 - tetherMax - landMax) / pairMax)
    expect(neighbours).toBeGreaterThanOrEqual(128)
  })

  it('full K of realistic and compressed worlds matches the checked mirror', () => {
    for (const halfWidth of [25, 3]) {
      const sys = makeNodeWorld({ n: 60, seed: 11, halfWidth, height: 4, maxBirth: 200 })
      computeKicks(sys, 100)
      resetCheckStats()
      for (let i = 0; i < sys.count; i++) {
        expect(particleKickChecked(sys, i, 100)).toEqual(Array.from(sys.kick.subarray(3 * i, 3 * i + 3)))
      }
      expect(checkStats.checks).toBeGreaterThan(1000)
      expect(checkStats.maxLog2).toBeLessThan(31)
    }
    expect(UNIT).toBe(1 << 19)
  })
})
