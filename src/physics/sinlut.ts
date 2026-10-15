// 4096-entry Q1.15 sine table, generated integer-only (BigInt Machin π + Taylor
// series at 2^-120), so it is bit-identical in every JS engine. Phase is a u32
// with 2^32 ≡ 2π. GLSL samples the same table from a 64×64 R16I/R32I texture
// (WebGL2 only guarantees MAX_TEXTURE_SIZE ≥ 2048).

import { rshr } from './fixed.ts'
import { fnv1aWords } from './rng.ts'

export const SIN_LUT_SIZE = 4096
export const SIN_LUT_BITS = 12
/** Table amplitude: entries are round(32767·sin), so the effective scale is 32767/32768. */
export const SIN_AMP = 32767
/** Pinned fnv1a32 of the table's little-endian int16 bytes. */
export const SIN_LUT_FNV1A = 0xee115a3a
/** Texture layout for the GPU port: texelFetch(lut, ivec2(i & 63, i >> 6), 0). */
export const SIN_LUT_TEX_WIDTH = 64

const PREC = 120n
const ONE = 1n << PREC

function atanInv(x: bigint): bigint {
  const x2 = x * x
  let term = ONE / x
  let sum = 0n
  let k = 1n
  let sign = 1n
  while (term !== 0n) {
    sum += (sign * term) / k
    term /= x2
    k += 2n
    sign = -sign
  }
  return sum
}

function buildSinLut(): Int16Array {
  const pi = 16n * atanInv(5n) - 4n * atanInv(239n)
  const lut = new Int16Array(SIN_LUT_SIZE)
  const quarter = SIN_LUT_SIZE >> 2
  const half = 1n << (PREC - 1n)
  for (let i = 0; i <= quarter; i++) {
    const theta = (pi * BigInt(i)) / BigInt(SIN_LUT_SIZE >> 1)
    const t2 = (theta * theta) / ONE
    let term = theta
    let sum = theta
    for (let k = 1n; term !== 0n; k++) {
      term = -((term * t2) / ONE) / (2n * k * (2n * k + 1n))
      sum += term
    }
    const v = sum * BigInt(SIN_AMP)
    let q = v >> PREC
    const rem = v - (q << PREC)
    if (rem > half || (rem === half && (q & 1n) === 1n)) q += 1n
    const e = Number(q)
    // Quarter-wave symmetry makes sin(π − θ) and sin(−θ) exact in the table.
    lut[i] = e
    lut[(SIN_LUT_SIZE >> 1) - i] = e
    lut[((SIN_LUT_SIZE >> 1) + i) & (SIN_LUT_SIZE - 1)] = -e
    lut[(SIN_LUT_SIZE - i) & (SIN_LUT_SIZE - 1)] = -e
  }
  return lut
}

/** The raw table, for upload to a GLSL texture. Treat as read-only. */
export const SIN_LUT: Int16Array = buildSinLut()

export function sinLutHash(lut: Int16Array = SIN_LUT): number {
  return fnv1aWords(lut, 2)
}

/** Runtime check that this engine produced the pinned table (call at worker start). */
export function assertSinLut(): void {
  const h = sinLutHash()
  if (h !== SIN_LUT_FNV1A) {
    throw new Error(`sine LUT hash mismatch: ${h.toString(16)} != ${SIN_LUT_FNV1A.toString(16)}`)
  }
}

/**
 * sin(2π·phase/2^32) in Q1.15 (|result| ≤ 32767). index = phase >>> 20,
 * frac = 16 bits below it; |b − a| ≤ 51, so (b − a)·frac < 2^22.
 */
export function sinQ15(phase: number): number {
  const i = phase >>> 20
  const f = (phase >>> 4) & 0xffff
  const a = SIN_LUT[i]
  const b = SIN_LUT[(i + 1) & (SIN_LUT_SIZE - 1)]
  return (a + rshr(Math.imul(b - a, f), 16)) | 0
}

/** cos(Φ) = sin(Φ + 2^30). */
export function cosQ15(phase: number): number {
  return sinQ15((phase + 0x40000000) | 0)
}
