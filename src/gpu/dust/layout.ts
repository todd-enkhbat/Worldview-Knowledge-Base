// Texel layout of the GPU dust state: one particle per RGBA32I texel, row-major from
// texel (0, 0) (no flipY, so texture row y is readPixels row y). Pure functions so the
// packing and the CPU≡GPU comparison are testable in node.
//   X texel      = (x, y, z  Q.19, flags)
//   D texel      = (dx, dy, dz Q.27, 0)
//   anchor texel = (ax, ay, az Q.19, birth step)
//   meta texel   = (spawn seed, style, 0, 0)   — static input, like the anchor

import type { ParticleSystem } from '../../physics/integrator.ts'
import { SIN_LUT, SIN_LUT_SIZE, SIN_LUT_TEX_WIDTH } from '../../physics/sinlut.ts'

/** meta.y: owner archetype index in the low byte (render only, never physics). */
export const STYLE_ARCHETYPE_MASK = 0xff
/** meta.y flag: the segment is waiting for CPU rows; the renderer hides it. */
export const STYLE_HIDDEN = 1 << 8

export interface DustTexels {
  readonly width: number
  readonly height: number
  /** RGBA, 4 ints per texel. */
  readonly x: Int32Array
  readonly d: Int32Array
  readonly anchor: Int32Array
  /** RGBA (seed, style, 0, 0) per texel; needed when births run on the GPU. */
  readonly meta?: Int32Array
}

/** Smallest power-of-two width ≥ √n (≥ 64, one allocation segment), height to fit n. */
export function dustTextureSize(n: number): { width: number; height: number } {
  if (!(n >= 1)) throw new RangeError(`dust count ${n} < 1`)
  let width = 64
  while (width * width < n) width *= 2
  return { width, height: Math.ceil(n / width) }
}

/** Pack the SoA system (stride 3) into RGBA texels; padding texels stay zero. */
export function packDust(sys: ParticleSystem, width: number, height: number, flags?: Int32Array): DustTexels {
  const n = sys.count
  if (n > width * height) throw new RangeError(`${n} particles do not fit ${width}×${height}`)
  const x = new Int32Array(4 * width * height)
  const d = new Int32Array(4 * width * height)
  const anchor = new Int32Array(4 * width * height)
  for (let i = 0; i < n; i++) {
    const o3 = 3 * i
    const o4 = 4 * i
    for (let a = 0; a < 3; a++) {
      x[o4 + a] = sys.x[o3 + a]
      d[o4 + a] = sys.d[o3 + a]
      anchor[o4 + a] = sys.anchor[o3 + a]
    }
    x[o4 + 3] = flags ? flags[i] : 0
    anchor[o4 + 3] = sys.birth[i]
  }
  return { width, height, x, d, anchor }
}

export interface DustMismatch {
  readonly index: number
  readonly field: 'x' | 'd'
  readonly axis: number
  readonly cpu: number
  readonly gpu: number
}

export interface DustComparison {
  readonly identical: boolean
  /** Number of differing ints among the 6n compared. */
  readonly mismatches: number
  readonly first: DustMismatch | null
}

/** Compare n particles of CPU SoA (stride 3) against GPU RGBA texels (stride 4), every int. */
export function compareDust(
  n: number,
  cpuX: Int32Array,
  cpuD: Int32Array,
  gpuX: Int32Array,
  gpuD: Int32Array,
): DustComparison {
  let mismatches = 0
  let first: DustMismatch | null = null
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const cx = cpuX[3 * i + a]
      const gx = gpuX[4 * i + a]
      if (cx !== gx) {
        mismatches++
        first ??= { index: i, field: 'x', axis: a, cpu: cx, gpu: gx }
      }
      const cd = cpuD[3 * i + a]
      const gd = gpuD[4 * i + a]
      if (cd !== gd) {
        mismatches++
        first ??= { index: i, field: 'd', axis: a, cpu: cd, gpu: gd }
      }
    }
  }
  return { identical: mismatches === 0, mismatches, first }
}

/** The 4096-entry sine table as a 64×64 R32I texture: texel (i & 63, i >> 6) holds entry i. */
export function sinLutTexels(): { width: number; height: number; data: Int32Array } {
  const width = SIN_LUT_TEX_WIDTH
  const height = SIN_LUT_SIZE / width
  // Row-major with width W: texel (i mod W, i div W) is at linear index i.
  return { width, height, data: Int32Array.from(SIN_LUT) }
}
