import { describe, expect, it } from 'vitest'
import {
  SIN_AMP,
  SIN_LUT,
  SIN_LUT_FNV1A,
  SIN_LUT_SIZE,
  assertSinLut,
  cosQ15,
  sinLutHash,
  sinQ15,
} from '../../src/physics/sinlut.ts'
import { testRng } from './helpers.ts'

describe('sine LUT', () => {
  it('has the pinned hash and passes the runtime assert', () => {
    expect(sinLutHash()).toBe(SIN_LUT_FNV1A)
    expect(SIN_LUT_FNV1A).toBe(0xee115a3a)
    expect(() => assertSinLut()).not.toThrow()
  })

  it('entries are round(32767·sin) and no entry is near a rounding tie', () => {
    let minTie = 1
    for (let i = 0; i < SIN_LUT_SIZE; i++) {
      const v = SIN_AMP * Math.sin((2 * Math.PI * i) / SIN_LUT_SIZE)
      expect(Math.abs(SIN_LUT[i] - v)).toBeLessThanOrEqual(0.5)
      if (i % 1024 !== 0) minTie = Math.min(minTie, Math.abs(v - Math.floor(v) - 0.5))
    }
    // Far above any Math.sin ulp error (~1e-11 here): a float build would agree too.
    expect(minTie).toBeGreaterThan(1e-4)
  })

  it('has exact quarter-wave symmetry', () => {
    for (let i = 0; i < SIN_LUT_SIZE; i++) {
      expect(SIN_LUT[(SIN_LUT_SIZE - i) & 4095]).toBe(-SIN_LUT[i] | 0)
      expect(SIN_LUT[(2048 - i) & 4095]).toBe(SIN_LUT[i])
    }
  })

  it('interpolates within 1 LSB of 32767·sin, and cos(Φ) = sin(Φ + 2^30)', () => {
    const rand = testRng(7)
    let maxErr = 0
    for (let k = 0; k < 200000; k++) {
      const p = k < SIN_LUT_SIZE ? (k << 20) | 0 : rand() | 0
      const ref = SIN_AMP * Math.sin((2 * Math.PI * (p >>> 0)) / 2 ** 32)
      maxErr = Math.max(maxErr, Math.abs(sinQ15(p) - ref))
      expect(cosQ15(p)).toBe(sinQ15((p + 0x40000000) | 0))
    }
    expect(maxErr).toBeLessThanOrEqual(1)
  })
})
