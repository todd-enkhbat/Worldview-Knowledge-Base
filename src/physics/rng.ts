// Stateless integer hashing: every draw is a pure function of (seed, stream), and
// every line maps 1:1 to GLSL uint ops (imul → uint *, >>> → uint >>).

/** lowbias32 (C. Wellons): a u32 → u32 bijection with low avalanche bias. */
export function lowbias32(x: number): number {
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  x ^= x >>> 16
  return x >>> 0
}

/** Draw number `stream` of the sequence keyed by `seed` (both u32). */
export function draw(seed: number, stream: number): number {
  return lowbias32((lowbias32(seed) + Math.imul((stream + 1) | 0, 0x9e3779b9)) | 0)
}

/** Uniform integer in [0, n) from the top 16 bits of h, n ≤ 2^15. */
export function uniformBelow(h: number, n: number): number {
  return Math.imul(h >>> 16, n) >>> 16
}

/**
 * Approximate N(0, 1) in Q.16 by Irwin–Hall: twelve u16 uniforms from a lowbias32
 * chain, summed and centred. Exactly bounded to ±6σ = ±393210; variance (2^16)² − 1.
 */
export function normalQ16(h: number): number {
  let w = h | 0
  let sum = 0
  for (let j = 0; j < 6; j++) {
    w = lowbias32((w + 0x9e3779b9) | 0)
    sum += (w >>> 16) + (w & 0xffff)
  }
  return sum - 393210
}

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 16777619

/** fnv1a32 over the UTF-8 bytes of a string (ids → u32 seeds). */
export function fnv1a32(str: string): number {
  let h = FNV_OFFSET
  for (const ch of str) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) {
      h = Math.imul(h ^ c, FNV_PRIME)
    } else if (c < 0x800) {
      h = Math.imul(h ^ (0xc0 | (c >> 6)), FNV_PRIME)
      h = Math.imul(h ^ (0x80 | (c & 63)), FNV_PRIME)
    } else if (c < 0x10000) {
      h = Math.imul(h ^ (0xe0 | (c >> 12)), FNV_PRIME)
      h = Math.imul(h ^ (0x80 | ((c >> 6) & 63)), FNV_PRIME)
      h = Math.imul(h ^ (0x80 | (c & 63)), FNV_PRIME)
    } else {
      h = Math.imul(h ^ (0xf0 | (c >> 18)), FNV_PRIME)
      h = Math.imul(h ^ (0x80 | ((c >> 12) & 63)), FNV_PRIME)
      h = Math.imul(h ^ (0x80 | ((c >> 6) & 63)), FNV_PRIME)
      h = Math.imul(h ^ (0x80 | (c & 63)), FNV_PRIME)
    }
  }
  return h >>> 0
}

/** fnv1a32 over integer words as little-endian bytes (`bytes` = 2 or 4 per word). */
export function fnv1aWords(
  words: ArrayLike<number>,
  bytes: 2 | 4 = 4,
  h: number = FNV_OFFSET,
): number {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    h = Math.imul(h ^ (w & 0xff), FNV_PRIME)
    h = Math.imul(h ^ ((w >>> 8) & 0xff), FNV_PRIME)
    if (bytes === 4) {
      h = Math.imul(h ^ ((w >>> 16) & 0xff), FNV_PRIME)
      h = Math.imul(h ^ ((w >>> 24) & 0xff), FNV_PRIME)
    }
  }
  return h >>> 0
}
