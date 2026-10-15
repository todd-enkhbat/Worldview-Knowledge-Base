// The generated dust shaders evaluated in JS with GLSL ES 3.00 integer semantics, using
// only the numbers of DustKernelSpec / DustSpawnSpec (never src/physics directly). int ops
// wrap like Math.imul / | 0 (in range at every call site, docs/PHYSICS.md); uint(...) is
// >>> 0 and int(uint) is | 0. Tests compare it with src/physics bit for bit, so a wrong
// structural literal in a spec breaks identity; DustSim tests run on it as a CPU backend
// that follows the shader's draw semantics (births included) texel by texel.

import type { DustKernelSpec, DustSpawnSpec } from './glsl.ts'
import { sinLutTexels } from './layout.ts'

export interface DustMirror {
  /** One step of one texel, in place on x[0..3), d[0..3). */
  forward(x: Int32Array, d: Int32Array, a: ArrayLike<number>): void
  backward(x: Int32Array, d: Int32Array, a: ArrayLike<number>): void
  /** spawnDust(a, seed) of the step shader: X into x[0..3), D into d[0..3). */
  spawn(a: ArrayLike<number>, seed: number, x: Int32Array, d: Int32Array): void
  sin(phase: number): number
  drift(d: number): number
  draw(seed: number, stream: number): number
  isqrt(n: number): number
}

export function makeDustMirror(s: DustKernelSpec, sp: DustSpawnSpec): DustMirror {
  const lut = sinLutTexels()
  const roundUp = (r: number, f: number, h: number) => (h - r - (f & 1)) >>> 31
  const rshr = (x: number, sh: number) => ((x >> sh) + roundUp(x & ((1 << sh) - 1), x >> sh, 1 << (sh - 1))) | 0
  const mask = (1 << s.mulshrSplit) - 1
  const mulshr = (a: number, b: number, sh: number) => {
    const ah = a >> s.mulshrSplit
    const al = a & mask
    const q = Math.imul(al, b)
    const hi = (Math.imul(ah, b) + (q >> s.mulshrSplit)) | 0
    const ql = q & mask
    if (sh < s.mulshrSplit) return (((hi << (s.mulshrSplit - sh)) >>> 0) + (rshr(ql, sh) >>> 0)) | 0
    const t = sh - s.mulshrSplit
    const f = hi >> t
    return (f + roundUp(((hi & ((1 << t) - 1)) << s.mulshrSplit) | ql, f, 1 << (sh - 1))) | 0
  }
  const drift = (d: number) => {
    const sg = d >> 31
    const a = (((d ^ sg) >>> 0) - (sg >>> 0)) | 0
    const m = ((((a >>> 0) + (1 << (s.driftShift - 1))) >>> 0) >>> s.driftShift) & ~(a >> 31)
    return (((m ^ sg) >>> 0) - (sg >>> 0)) | 0
  }
  const fetch = (i: number) => lut.data[(i >> s.lutTexShift) * lut.width + (i & (s.lutTexWidth - 1))]
  const sin = (ph: number) => {
    const i = ph >>> s.sinIndexShift
    const f = (ph >>> s.sinFracShift) & s.sinFracMask
    const a = fetch(i)
    const b = fetch((i + 1) & s.sinLutMask)
    return (a + rshr(Math.imul(b - a, f), s.sinFracBits)) | 0
  }
  const tether = (u: number, k: number) => -mulshr(u > s.uSat ? s.uSat : u < -s.uSat ? -s.uSat : u, k, s.tetherShift) | 0
  const kk = new Int32Array(3)
  const kick = (x: ArrayLike<number>, a: ArrayLike<number>): Int32Array => {
    let ix = tether((x[0] - a[0]) | 0, s.kXZ)
    const iy = tether((x[1] - a[1]) | 0, s.kY)
    let iz = tether((x[2] - a[2]) | 0, s.kXZ)
    let lx = 0
    let lz = 0
    for (let m = 0; m < s.modes; m++) {
      const ph = (Math.imul(s.kx[m], x[0]) + Math.imul(s.kz[m], x[2]) + s.phase[m]) >>> 0
      const sm = mulshr(s.lcoef[m], sin(ph), s.sinQ)
      lx = (lx + mulshr(sm, s.kx[m], s.landscapeKShift)) >>> 0
      lz = (lz + mulshr(sm, s.kz[m], s.landscapeKShift)) >>> 0
    }
    ix = (ix + lx) | 0
    iz = (iz + lz) | 0
    kk[0] = mulshr(ix, s.invMass, s.kickShift)
    kk[1] = mulshr(iy, s.invMass, s.kickShift)
    kk[2] = mulshr(iz, s.invMass, s.kickShift)
    return kk
  }
  const lowbias32 = (v0: number) => {
    let v = v0 >>> 0
    v = (v ^ (v >>> sp.lbShift1)) >>> 0
    v = Math.imul(v, sp.lbMul1) >>> 0
    v = (v ^ (v >>> sp.lbShift2)) >>> 0
    v = Math.imul(v, sp.lbMul2) >>> 0
    v = (v ^ (v >>> sp.lbShift3)) >>> 0
    return v
  }
  const draw = (seed: number, stream: number) => lowbias32((lowbias32(seed) + Math.imul((stream + 1) >>> 0, sp.golden)) >>> 0)
  const isqrt = (n: number) => {
    let v = n >>> 0
    let r = 0
    let bit = sp.isqrtTopBit >>> 0
    for (let k = 0; k < sp.isqrtIters; k++) {
      const t = (r + bit) >>> 0
      if (v >= t) {
        v = (v - t) >>> 0
        r = ((r >>> 1) + bit) >>> 0
      } else {
        r >>>= 1
      }
      bit >>>= 2
    }
    return r
  }
  const e = new Int32Array(3)
  return {
    forward(x, d, a) {
      const k = kick(x, a)
      for (let c = 0; c < 3; c++) {
        d[c] = (d[c] + k[c]) | 0
        x[c] = (x[c] + drift(d[c])) | 0
      }
    },
    backward(x, d, a) {
      for (let c = 0; c < 3; c++) x[c] = (x[c] - drift(d[c])) | 0
      const k = kick(x, a)
      for (let c = 0; c < 3; c++) d[c] = (d[c] - k[c]) | 0
    },
    spawn(a, seed, x, d) {
      const ey = ((draw(seed, sp.streamDirY) >>> sp.eyShift) | 0) - sp.eyBias
      const rho = isqrt((sp.rhoBase - Math.imul(ey, ey)) >>> 0) | 0
      const phi = draw(seed, sp.streamDirPhi)
      e[0] = rshr(Math.imul(rho, sin((phi + sp.cosOffset) >>> 0)), sp.dirShift)
      e[1] = ey
      e[2] = rshr(Math.imul(rho, sin(phi)), sp.dirShift)
      for (let c = 0; c < 3; c++) {
        const base = mulshr(sp.burstRadius, e[c], sp.burstShift)
        const push = 1 + ((draw(seed, sp.streamU + c) & sp.burstPushMask) | 0)
        const u = base < 0 ? base - push : base + push
        const noise = ((draw(seed, sp.streamNoise + c) >>> sp.noiseShift) | 0) - sp.noiseBias
        x[c] = (a[c] + u) | 0
        d[c] = ((mulshr(sp.d0, e[c], sp.velShift) >>> 0) + (mulshr(sp.d0, noise, sp.velShift) >>> 0)) | 0
      }
    },
    sin,
    drift,
    draw,
    isqrt,
  }
}

/** Uniforms of one step-shader draw. */
export interface DustDrawUniforms {
  readonly step: number
  readonly steps: number
  readonly backward: boolean
  readonly births: boolean
}

/**
 * One step-shader draw over texels [0, count) of RGBA arrays, in place (the ping-pong is
 * irrelevant: every texel reads only itself). Follows main() of dustStepFragmentShader.
 */
export function mirrorDraw(
  m: DustMirror,
  u: DustDrawUniforms,
  x: Int32Array,
  d: Int32Array,
  anchor: Int32Array,
  meta: Int32Array,
  count: number,
): void {
  const xs = new Int32Array(3)
  const ds = new Int32Array(3)
  const a = new Int32Array(3)
  const dest = u.backward ? u.step - u.steps : u.step + u.steps
  for (let i = 0; i < count; i++) {
    const o = 4 * i
    for (let c = 0; c < 3; c++) {
      xs[c] = x[o + c]
      ds[c] = d[o + c]
      a[c] = anchor[o + c]
    }
    let steps = u.steps
    if (u.births) {
      const b = anchor[o + 3]
      if (dest <= b) {
        m.spawn(a, meta[o] >>> 0, xs, ds)
        steps = 0
      } else if (!u.backward && u.step < b) {
        m.spawn(a, meta[o] >>> 0, xs, ds)
        steps = dest - b
      }
    }
    if (!u.backward) for (let k = 0; k < steps; k++) m.forward(xs, ds, a)
    else for (let k = 0; k < steps; k++) m.backward(xs, ds, a)
    for (let c = 0; c < 3; c++) {
      x[o + c] = xs[c]
      d[o + c] = ds[c]
    }
  }
}
