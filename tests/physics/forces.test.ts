import { describe, expect, it } from 'vitest'
import { X_FRAC } from '../../src/physics/fixed.ts'
import {
  accumulatePairList,
  computeFieldImpulses,
  computeKicks,
  impulsesToKicks,
} from '../../src/physics/integrator.ts'
import { LANDSCAPE_MODES, pairSigmaEff, rampAt } from '../../src/physics/params.ts'
import { makeNodeWorld, testRng } from './helpers.ts'

const RHO = 32767 / 32768

describe('force accuracy: integer K vs float64 −∇U of the decoded potential', () => {
  it('stays within the stated per-term bounds (Q.30 impulse units)', () => {
    const sys = makeNodeWorld({ n: 80, seed: 21, halfWidth: 5, height: 4, maxBirth: 200 })
    const rand = testRng(5)
    // push some offsets past the Huber bound too
    for (let i = 0; i < 8; i++) sys.x[3 * i] = (sys.anchor[3 * i] + (rand() % 2 ? 1 : -1) * (70 << X_FRAC)) | 0
    const step = 150
    const { x, anchor, lcoef, pop, params } = sys
    const l = params.landscape
    const s2 = pairSigmaEff(params) ** 2
    const P = params.pairCoef / 1024
    computeKicks(sys, step)
    let maxErr = 0
    let maxRef = 0
    let pairsHit = 0
    for (let i = 0; i < sys.count; i++) {
      const o = 3 * i
      const ref = [0, 0, 0]
      const bound = [0.5, 0.5, 0.5]
      for (let a = 0; a < 3; a++) {
        const u = (x[o + a] - anchor[o + a]) | 0
        // Y is the stiff time tether: its own coefficient, shift and saturation (params.ts).
        const sat = a === 1 ? pop.uSatY : pop.uSat
        const us = Math.max(-sat, Math.min(sat, u))
        ref[a] = (-(a === 1 ? pop.kY : pop.kXZ) * us) / 2 ** (a === 1 ? pop.yShift : 11)
      }
      for (let m = 0; m < LANDSCAPE_MODES; m++) {
        const c = lcoef[LANDSCAPE_MODES * i + m]
        const ph = (Math.imul(l.kx[m], x[o]) + Math.imul(l.kz[m], x[o + 2]) + l.phase[m]) >>> 0
        const sn = c * RHO * Math.sin((2 * Math.PI * ph) / 2 ** 32)
        ref[0] += (sn * l.kx[m]) / 65536
        ref[2] += (sn * l.kz[m]) / 65536
        // LUT error ≤ 1 LSB of Q1.15, then two half-LSB roundings
        const ds = Math.abs(c) / 32768 + 0.5
        bound[0] += (ds * Math.abs(l.kx[m])) / 65536 + 0.5
        bound[2] += (ds * Math.abs(l.kz[m])) / 65536 + 0.5
      }
      for (let j = 0; j < sys.count; j++) {
        if (j === i) continue
        const d = [0, 1, 2].map((a) => (x[o + a] - x[3 * j + a]) | 0)
        const r2 = d.reduce((acc, v) => acc + (v / 2 ** X_FRAC) ** 2, 0)
        const s = r2 / s2
        if (s >= 1 || d.some((v) => Math.abs(v) >= params.pairSigma)) continue
        pairsHit++
        const lam = rampAt(step - Math.max(sys.birth[i], sys.birth[j])) / 32768
        for (let a = 0; a < 3; a++) {
          ref[a] += P * (1 - s) ** 2 * lam * d[a]
          // r² from Q.13 separations (Δs ≤ 4.5 LSB), then the g and f roundings
          bound[a] += (Math.abs(d[a]) * 6.63) / 1024 + 0.5
        }
      }
      for (let a = 0; a < 3; a++) {
        const err = Math.abs(sys.imp[o + a] - ref[a])
        expect(err).toBeLessThanOrEqual(bound[a] + 1e-6)
        maxErr = Math.max(maxErr, err)
        maxRef = Math.max(maxRef, Math.abs(ref[a]))
        // K = rhe(I·im/2^16): the kick inherits the bound scaled by 1/m, plus ½ LSB.
        const kRef = (ref[a] * sys.invMass[i]) / 65536
        expect(Math.abs(sys.kick[o + a] - kRef)).toBeLessThanOrEqual((bound[a] * sys.invMass[i]) / 65536 + 0.5 + 1e-6)
      }
    }
    expect(pairsHit).toBeGreaterThan(50)
    // Worst absolute error is ~1e-4 of the largest force in a compressed world.
    expect(maxErr / maxRef).toBeLessThan(3e-4)
  })
})

describe('pair accumulation', () => {
  it('is independent of pair order and orientation (bit-identical kicks)', () => {
    const sys = makeNodeWorld({ n: 60, seed: 4, halfWidth: 4, height: 4, maxBirth: 150 })
    const step = 90
    computeKicks(sys, step)
    const ref = sys.kick.slice()
    const pairs: number[] = []
    for (let i = 0; i < sys.count; i++) for (let j = i + 1; j < sys.count; j++) pairs.push(i, j)
    const rand = testRng(77)
    for (let trial = 0; trial < 5; trial++) {
      const list = pairs.slice()
      for (let k = list.length / 2 - 1; k > 0; k--) {
        const r = rand() % (k + 1)
        const [a, b] = [list[2 * k], list[2 * k + 1]]
        list[2 * k] = list[2 * r]
        list[2 * k + 1] = list[2 * r + 1]
        list[2 * r] = a
        list[2 * r + 1] = b
      }
      for (let k = 0; k < list.length; k += 2) {
        if (rand() & 1) [list[k], list[k + 1]] = [list[k + 1], list[k]]
      }
      computeFieldImpulses(sys)
      accumulatePairList(sys, step, list, list.length / 2)
      impulsesToKicks(sys)
      expect(Array.from(sys.kick)).toEqual(Array.from(ref))
    }
  })

  it('pair impulses cancel exactly (Σ_i f_ij = 0)', () => {
    const sys = makeNodeWorld({ n: 60, seed: 4, halfWidth: 4, height: 4 })
    computeFieldImpulses(sys)
    const field = sys.imp.slice()
    sys.imp.fill(0)
    const pairs: number[] = []
    for (let i = 0; i < sys.count; i++) for (let j = i + 1; j < sys.count; j++) pairs.push(i, j)
    accumulatePairList(sys, 0, pairs, pairs.length / 2)
    const sum = [0, 0, 0]
    let nonzero = 0
    for (let i = 0; i < sys.count; i++) for (let a = 0; a < 3; a++) {
      sum[a] += sys.imp[3 * i + a]
      if (sys.imp[3 * i + a] !== 0) nonzero++
    }
    expect(sum).toEqual([0, 0, 0])
    expect(nonzero).toBeGreaterThan(30)
    expect(field.length).toBe(sys.imp.length)
  })
})
