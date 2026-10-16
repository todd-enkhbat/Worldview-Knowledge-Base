// Node-side checks for the GPU dust port (src/gpu/dust). The bit-identity itself is
// proven on a real GPU by the S2 lab check (#/lab, window.__s2()); here we pin what can
// be checked without WebGL: the generated GLSL embeds exactly the constants of
// src/physics, every structural literal of the port reproduces the TS kernel when
// evaluated with GLSL integer semantics, and the texel packing/comparison is lossless.

import { describe, expect, it } from 'vitest'
import {
  GLSL_PRECISION_HEADER,
  type DustKernelSpec,
  dustKernelSpec,
  dustStepFragmentShader,
  dustVertexShader,
  glslInt,
  glslUint,
} from '../../src/gpu/dust/glsl.ts'
import { compareDust, dustTextureSize, packDust, sinLutTexels } from '../../src/gpu/dust/layout.ts'
import { DRIFT_SHIFT, INT_MIN, KICK_SHIFT, UNIT } from '../../src/physics/fixed.ts'
import { stateHash, stepBackward, stepForward } from '../../src/physics/integrator.ts'
import { AMP_ONE, LANDSCAPE_MODES, makePhysicsParams } from '../../src/physics/params.ts'
import { TETHER_SHIFT, landscapeCoef } from '../../src/physics/potentials.ts'
import { SIN_LUT, SIN_LUT_SIZE } from '../../src/physics/sinlut.ts'
import { s2Schedule } from '../../src/lab/s2/runS2.ts'
import { makeS2DustWorld } from '../../src/lab/s2/world.ts'

const params = makePhysicsParams({ seed: 0x5eed })
const frag = dustStepFragmentShader(params)
const spec = dustKernelSpec(params)

describe('GLSL generator', () => {
  it('starts every kernel shader with the highp precision header (three prepends #version 300 es)', () => {
    for (const src of [frag, dustVertexShader()]) {
      expect(src.startsWith(`${GLSL_PRECISION_HEADER}\n`)).toBe(true)
      expect(src).not.toContain('#version')
    }
    expect(GLSL_PRECISION_HEADER.split('\n')).toEqual([
      'precision highp float;',
      'precision highp int;',
      'precision highp isampler2D;',
      'precision highp usampler2D;',
    ])
  })

  it('takes every constant from src/physics', () => {
    expect(spec.driftShift).toBe(DRIFT_SHIFT)
    expect(spec.kickShift).toBe(KICK_SHIFT)
    expect(spec.tetherShift).toBe(TETHER_SHIFT)
    expect(spec.invMass).toBe(params.dustInvMass)
    expect([spec.kXZ, spec.kY, spec.uSat]).toEqual([params.dust.kXZ, params.dust.kY, params.dust.uSat])
    expect(spec.modes).toBe(LANDSCAPE_MODES)
    for (let m = 0; m < LANDSCAPE_MODES; m++) {
      expect(spec.kx[m]).toBe(params.landscape.kx[m])
      expect(spec.kz[m]).toBe(params.landscape.kz[m])
      expect(spec.phase[m]).toBe(params.landscape.phase[m] >>> 0)
      expect(spec.lcoef[m]).toBe(landscapeCoef(params.landscape.coef[m], params.dustTau))
    }
    expect(1 << (32 - spec.sinIndexShift)).toBe(SIN_LUT_SIZE)
  })

  it('embeds exactly those constants in the shader text', () => {
    const scalars: [string, string][] = [
      ['uint DRIFT_SHIFT', `${spec.driftShift}u`],
      ['int KICK_SHIFT', glslInt(spec.kickShift)],
      ['int TETHER_SHIFT', glslInt(spec.tetherShift)],
      ['int INV_MASS', glslInt(spec.invMass)],
      ['int TETHER_KXZ', glslInt(spec.kXZ)],
      ['int TETHER_KY', glslInt(spec.kY)],
      ['int TETHER_SAT', glslInt(spec.uSat)],
      ['int SIN_Q', glslInt(spec.sinQ)],
      ['int LS_K_SHIFT', glslInt(spec.landscapeKShift)],
      ['uint SIN_INDEX_SHIFT', `${spec.sinIndexShift}u`],
      ['uint SIN_FRAC_SHIFT', `${spec.sinFracShift}u`],
      ['uint SIN_FRAC_MASK', glslUint(spec.sinFracMask)],
      ['int SIN_LUT_MASK', glslInt(spec.sinLutMask)],
      ['int LUT_TEX_SHIFT', glslInt(spec.lutTexShift)],
    ]
    for (const [decl, lit] of scalars) expect(frag).toContain(`const ${decl} = ${lit};`)
    for (let m = 0; m < LANDSCAPE_MODES; m++) {
      expect(frag).toContain(`const int LS_KX_${m} = ${glslInt(spec.kx[m])};`)
      expect(frag).toContain(`const int LS_KZ_${m} = ${glslInt(spec.kz[m])};`)
      expect(frag).toContain(`const uint LS_PHASE_${m} = ${glslUint(spec.phase[m])};`)
      expect(frag).toContain(`const int LS_C_${m} = ${glslInt(spec.lcoef[m])};`)
      expect(frag).toContain(`  // mode ${m}\n`)
    }
    // A different landscape produces a different shader.
    expect(dustStepFragmentShader(makePhysicsParams({ seed: 1 }))).not.toBe(frag)
  })

  it('has no float arithmetic in the kernel', () => {
    // Comments and hex literals (0x7e74…) stripped so neither reads as a float.
    const body = frag
      .slice(GLSL_PRECISION_HEADER.length)
      .replace(/\/\/.*$/gm, '')
      .replace(/0x[0-9a-f]+u?/gi, 'H')
    expect(body).not.toMatch(/\bfloat\b|\bvec[234]\b|\d\.\d|\d\.(?!\w)|\d[eE][+-]?\d/)
    // gl_FragCoord is the only float, truncated once to the texel index.
    expect(body.match(/gl_FragCoord/g)).toHaveLength(1)
    expect(body).toContain('ivec2 p = ivec2(gl_FragCoord.xy);')
    expect(body).toContain('layout(location = 0) out ivec4 oX;')
    expect(body).toContain('layout(location = 1) out ivec4 oD;')
  })

  it('formats every i32/u32 as a valid GLSL literal', () => {
    expect(glslInt(INT_MIN)).toBe('int(0x80000000u)')
    expect(glslInt(0x7fffffff)).toBe('2147483647')
    expect(glslInt(-5)).toBe('(-5)')
    expect(() => glslInt(2 ** 31)).toThrow()
    expect(glslUint(-1)).toBe('0xffffffffu')
    expect(glslUint(0x2a)).toBe('0x0000002au')
  })
})

// ---- the port evaluated with GLSL ES 3.00 integer semantics, using only spec numbers ----
// int ops wrap like Math.imul / | 0 (proven in-range at every call site, docs/PHYSICS.md);
// uint(...) is >>> 0; int(uint) is | 0. Any wrong structural literal in the spec breaks bit-identity.

function glslKernel(s: DustKernelSpec) {
  const lut = sinLutTexels()
  const roundUp = (r: number, f: number, h: number) => (h - r - (f & 1)) >>> 31
  const rshr = (x: number, sh: number) => (x >> sh) + roundUp(x & ((1 << sh) - 1), x >> sh, 1 << (sh - 1))
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
    return f + roundUp(((hi & ((1 << t) - 1)) << s.mulshrSplit) | ql, f, 1 << (sh - 1))
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
    return a + rshr(Math.imul(b - a, f), s.sinFracBits)
  }
  const tether = (u: number, k: number) => -mulshr(u > s.uSat ? s.uSat : u < -s.uSat ? -s.uSat : u, k, s.tetherShift)
  const kick = (x: number[], a: number[]): number[] => {
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
    return [ix, iy, iz].map((v) => mulshr(v, s.invMass, s.kickShift))
  }
  return {
    forward(x: number[], d: number[], a: number[]) {
      const k = kick(x, a)
      for (let c = 0; c < 3; c++) {
        d[c] = (d[c] + k[c]) | 0
        x[c] = (x[c] + drift(d[c])) | 0
      }
    },
    backward(x: number[], d: number[], a: number[]) {
      for (let c = 0; c < 3; c++) x[c] = (x[c] - drift(d[c])) | 0
      const k = kick(x, a)
      for (let c = 0; c < 3; c++) d[c] = (d[c] - k[c]) | 0
    },
    sin,
    drift,
  }
}

describe('port structure ≡ TS kernel', () => {
  it('reproduces sinQ15 and drift over their edge classes', async () => {
    const { sinQ15 } = await import('../../src/physics/sinlut.ts')
    const { drift } = await import('../../src/physics/fixed.ts')
    const k = glslKernel(spec)
    for (let i = 0; i < SIN_LUT_SIZE; i++) {
      for (const lo of [0, 1, 0x7ffff, 0x80000, 0xfffff]) {
        const ph = (i << 20) | lo
        expect(k.sin(ph >>> 0)).toBe(sinQ15(ph))
      }
    }
    for (const d of [0, 1, -1, 127, 128, -128, 383, 384, -384, 0x7fffffff, INT_MIN, INT_MIN + 1]) {
      expect(k.drift(d)).toBe(drift(d))
    }
  })

  it('steps the S2 world bit-identically forward and backward', () => {
    const n = 1024
    const sys = makeS2DustWorld({ n, params })
    const { width, height } = dustTextureSize(n)
    const t = packDust(sys, width, height)
    const k = glslKernel(spec)
    const steps = 60
    for (let st = 0; st < steps; st++) stepForward(sys, st)
    const gx = t.x.slice()
    const gd = t.d.slice()
    for (let i = 0; i < n; i++) {
      const x = [gx[4 * i], gx[4 * i + 1], gx[4 * i + 2]]
      const d = [gd[4 * i], gd[4 * i + 1], gd[4 * i + 2]]
      const a = [t.anchor[4 * i], t.anchor[4 * i + 1], t.anchor[4 * i + 2]]
      for (let st = 0; st < steps; st++) k.forward(x, d, a)
      gx.set(x, 4 * i)
      gd.set(d, 4 * i)
    }
    expect(compareDust(n, sys.x, sys.d, gx, gd)).toEqual({ identical: true, mismatches: 0, first: null })
    for (let st = steps - 1; st >= 0; st--) stepBackward(sys, st)
    for (let i = 0; i < n; i++) {
      const x = [gx[4 * i], gx[4 * i + 1], gx[4 * i + 2]]
      const d = [gd[4 * i], gd[4 * i + 1], gd[4 * i + 2]]
      const a = [t.anchor[4 * i], t.anchor[4 * i + 1], t.anchor[4 * i + 2]]
      for (let st = 0; st < steps; st++) k.backward(x, d, a)
      gx.set(x, 4 * i)
      gd.set(d, 4 * i)
    }
    expect(compareDust(n, sys.x, sys.d, gx, gd).identical).toBe(true)
    expect(compareDust(n, sys.x, sys.d, t.x, t.d).identical).toBe(true)
  })

  it('fails when any structural literal is off by one (the mirror is discriminating)', () => {
    const n = 256
    const fields = ['sinQ', 'landscapeKShift', 'sinFracShift', 'sinIndexShift', 'driftShift', 'kickShift', 'tetherShift'] as const
    for (const f of fields) {
      const sys = makeS2DustWorld({ n, params })
      const t = packDust(sys, 64, 4)
      stepForward(sys, 0)
      const k = glslKernel({ ...spec, [f]: spec[f] + 1 })
      for (let i = 0; i < n; i++) {
        const x = Array.from(t.x.subarray(4 * i, 4 * i + 3))
        const d = Array.from(t.d.subarray(4 * i, 4 * i + 3))
        k.forward(x, d, Array.from(t.anchor.subarray(4 * i, 4 * i + 3)))
        t.x.set(x, 4 * i)
        t.d.set(d, 4 * i)
      }
      expect(compareDust(n, sys.x, sys.d, t.x, t.d).identical, f).toBe(false)
    }
  })
})

describe('texel layout', () => {
  it('sizes textures in powers of two of at least one 64-texel segment', () => {
    expect(dustTextureSize(1)).toEqual({ width: 64, height: 1 })
    expect(dustTextureSize(4096)).toEqual({ width: 64, height: 64 })
    expect(dustTextureSize(16384)).toEqual({ width: 128, height: 128 })
    expect(dustTextureSize(131072)).toEqual({ width: 512, height: 256 })
  })

  it('packs X, D, anchor and birth losslessly and finds the first differing int', () => {
    const n = 200
    const sys = makeS2DustWorld({ n, params })
    for (let i = 0; i < n; i++) sys.birth[i] = i - 7
    const t = packDust(sys, 64, 4)
    expect(compareDust(n, sys.x, sys.d, t.x, t.d)).toEqual({ identical: true, mismatches: 0, first: null })
    for (let i = 0; i < n; i++) {
      expect(Array.from(t.anchor.subarray(4 * i, 4 * i + 4))).toEqual([...sys.anchor.subarray(3 * i, 3 * i + 3), i - 7])
    }
    expect(t.x.subarray(4 * n).every((v) => v === 0)).toBe(true)
    t.d[4 * 57 + 2] ^= 1
    t.x[4 * 90] ^= 1 << 31
    const c = compareDust(n, sys.x, sys.d, t.x, t.d)
    expect(c.mismatches).toBe(2)
    expect(c.first).toEqual({ index: 57, field: 'd', axis: 2, cpu: sys.d[3 * 57 + 2], gpu: sys.d[3 * 57 + 2] ^ 1 })
  })

  it('lays the sine LUT out as 64×64 with texel (i & 63, i >> 6) = entry i', () => {
    const l = sinLutTexels()
    expect([l.width, l.height]).toEqual([64, 64])
    for (let i = 0; i < SIN_LUT_SIZE; i++) expect(l.data[(i >> 6) * l.width + (i & 63)]).toBe(SIN_LUT[i])
  })
})

describe('S2 world and schedule', () => {
  it('spreads owners over the world, including the torus seam', () => {
    const n = 4096
    const sys = makeS2DustWorld({ n, params })
    const seam = 4000 * UNIT
    let atSeam = 0
    let far = 0
    for (let i = 0; i < n; i += 64) {
      const ax = sys.anchor[3 * i]
      if (Math.abs(ax) > seam) atSeam++
      else if (Math.abs(ax) > 64 * UNIT) far++
      // One anchor per 64-texel segment.
      for (let j = 1; j < 64; j++) expect(sys.anchor[3 * (i + j)]).toBe(ax)
    }
    expect(atSeam).toBeGreaterThanOrEqual(2)
    expect(far).toBeGreaterThan(0)
    // Pinned: window.__s2({ n: 4096 }) reports the same initialHash / forwardHash.
    expect(stateHash(sys).toString(16)).toBe('e3cbe8f9')
    for (let st = 0; st < 500; st++) stepForward(sys, st)
    expect(stateHash(sys).toString(16)).toBe('12b4ca67')
  })

  it('schedules a single-step draw first, then drawSteps-aligned draws', () => {
    expect(s2Schedule(500, 100)).toEqual([1, 99, 100, 100, 100, 100])
    expect(s2Schedule(3000, 250).reduce((a, b) => a + b, 0)).toBe(3000)
    expect(s2Schedule(1, 100)).toEqual([1])
    expect(s2Schedule(0, 100)).toEqual([])
  })

  it('uses the default landscape amplitude for the acceptance world', () => {
    expect(params.landscapeAmp).toBe(AMP_ONE)
  })
})
