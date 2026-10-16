import { describe, expect, it } from 'vitest'
import { INT_MAX, INT_MIN, drift, isqrt, mulshr, rshr } from '../../src/physics/fixed.ts'
import { fnv1a32, lowbias32, normalQ16 } from '../../src/physics/rng.ts'
import { testRng } from './helpers.ts'

/** Exact round-half-even of x / 2^s in BigInt. */
function rheRef(x: bigint, s: number): bigint {
  const p = 1n << BigInt(s)
  let q = x >= 0n ? x / p : -((-x + p - 1n) / p) // floor
  const r = x - q * p
  const h = p >> 1n
  if (r > h || (r === h && (q & 1n) === 1n)) q += 1n
  return q
}

const rand = testRng(42)
const i32 = () => rand() | 0

describe('rshr', () => {
  it('matches the BigInt reference on random, tie, negative and extreme inputs', () => {
    const xs: number[] = [0, 1, -1, INT_MAX, INT_MIN, INT_MIN + 1, INT_MAX - 1]
    for (let k = 0; k < 20000; k++) xs.push(i32())
    for (let s = 1; s <= 30; s++) {
      const half = 2 ** (s - 1)
      for (let k = 0; k < 200; k++) {
        // exact ties: q·2^s ± 2^(s−1) for random q of both signs
        const q = (i32() >> s) | 0
        xs.push((q * 2 ** s + half) | 0, (q * 2 ** s - half) | 0)
      }
      for (const x of xs) {
        expect(rshr(x, s)).toBe(Number(rheRef(BigInt(x), s)))
      }
    }
  })

  it('is odd-symmetric', () => {
    for (let k = 0; k < 20000; k++) {
      const x = i32()
      if (x === INT_MIN) continue
      const s = 1 + (rand() % 30)
      expect(rshr(-x, s)).toBe(-rshr(x, s) | 0)
    }
  })
})

describe('mulshr', () => {
  it('equals rhe(a·b / 2^s) exactly whenever the result fits in i32', () => {
    const bs = [0, 1, -1, 0x8000, -0x8000, 0x7fff, -0x7fff]
    const as = [0, 1, -1, INT_MAX, INT_MIN, 0xffff, -0x10000, 0x10000]
    let tested = 0
    for (let k = 0; k < 60000; k++) {
      const a = k < as.length * bs.length ? as[k % as.length] : i32()
      const b = k < as.length * bs.length ? bs[Math.floor(k / as.length)] : (rand() % 0x10001) - 0x8000
      const s = 1 + (k % 30)
      const ref = rheRef(BigInt(a) * BigInt(b), s)
      if (ref < -(2n ** 31n) || ref >= 2n ** 31n) continue
      expect(mulshr(a, b, s)).toBe(Number(ref))
      tested++
    }
    expect(tested).toBeGreaterThan(30000)
  })

  it('resolves exact ties to even for every shift', () => {
    for (let s = 1; s <= 30; s++) {
      for (let k = 0; k < 50; k++) {
        // a·b = q·2^s + 2^(s−1) with b = 1
        const q = (i32() >> s) | 0
        const a = (q * 2 ** s + 2 ** (s - 1)) | 0
        expect(mulshr(a, 1, s)).toBe(Number(rheRef(BigInt(a), s)))
      }
    }
  })
})

describe('drift', () => {
  const ref = (d: number): number => {
    if (d === INT_MIN) return 0
    const m = Math.floor((Math.abs(d) + 128) / 256)
    return d < 0 ? -m | 0 : m
  }
  it('is sgn(D)·((|D| + 128) >> 8) and exactly odd on all of Z/2^32', () => {
    const ds = [0, 1, -1, 127, 128, 129, -127, -128, -129, 383, 384, -384, INT_MAX, INT_MIN, INT_MIN + 1]
    for (let k = 0; k < 50000; k++) ds.push(i32())
    for (const d of ds) {
      expect(drift(d)).toBe(ref(d))
      expect(drift(-d | 0)).toBe(-drift(d) | 0)
    }
  })
})

describe('isqrt', () => {
  it('is floor(√n) over u32', () => {
    const ns = [0, 1, 2, 3, 4, 0xffffffff, 0x40000000, 0x3fffffff]
    for (let k = 0; k < 20000; k++) ns.push(rand())
    for (let r = 0; r < 70000; r += 97) ns.push(r * r, r * r - 1, r * r + 1)
    for (const n of ns) {
      if (n < 0 || n > 0xffffffff) continue
      const r = isqrt(n)
      expect(r * r <= n && (r + 1) * (r + 1) > n).toBe(true)
    }
  })
})

describe('integer PRNG', () => {
  it('fnv1a32 matches the published vectors and UTF-8 bytes', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5)
    expect(fnv1a32('a')).toBe(0xe40c292c)
    expect(fnv1a32('foobar')).toBe(0xbf9cf968)
    const s = 'é ü 漢 😀 3f1c2a9e-0000-4000-8000-000000000000'
    let h = 0x811c9dc5
    for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 16777619)
    expect(fnv1a32(s)).toBe(h >>> 0)
  })

  it('lowbias32 is pinned', () => {
    expect([lowbias32(0), lowbias32(1), lowbias32(0xdeadbeef)]).toEqual([0, 0x688990c0, 0xe628c683])
  })

  it('normalQ16 is bounded with unit variance', () => {
    let s1 = 0
    let s2 = 0
    const n = 40000
    for (let k = 0; k < n; k++) {
      const z = normalQ16(rand())
      expect(Math.abs(z)).toBeLessThanOrEqual(393210)
      s1 += z / 65536
      s2 += (z / 65536) ** 2
    }
    expect(Math.abs(s1 / n)).toBeLessThan(0.02)
    expect(Math.abs(s2 / n - 1)).toBeLessThan(0.03)
  })
})
