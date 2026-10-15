// GPU dust with births, checked in node: the generated step shader's spawn port and birth
// logic, evaluated with GLSL integer semantics from the spec numbers only (src/gpu/dust/
// mirror.ts), against the CPU reference dust world built on src/physics. The in-browser
// CPU≡GPU run (src/gpu/dust/identity.ts) is the integrator's check.

import { describe, expect, it } from 'vitest'
import { DUST_SEGMENT } from '../../src/gpu/dust/alloc.ts'
import {
  DUST_FREE_BIRTH,
  type DustOwner,
  DustRowsJob,
  computeDustRows,
  createDustWorld,
  dustParticleSeed,
  dustWorldTexels,
  runDustTo,
  setDustSegment,
} from '../../src/gpu/dust/dustWorld.ts'
import {
  type DustSpawnSpec,
  GLSL_PRECISION_HEADER,
  dustKernelSpec,
  dustPatchFragmentShader,
  dustSpawnSpec,
  dustStepFragmentShader,
  glslInt,
  glslUint,
} from '../../src/gpu/dust/glsl.ts'
import { compareDust } from '../../src/gpu/dust/layout.ts'
import { makeDustMirror, mirrorDraw } from '../../src/gpu/dust/mirror.ts'
import { UNIT, isqrt } from '../../src/physics/fixed.ts'
import { DUST_BURST_RADIUS, makePhysicsParams } from '../../src/physics/params.ts'
import { draw, fnv1a32 } from '../../src/physics/rng.ts'
import { spawnDustState, spawnSpeed } from '../../src/physics/spawn.ts'

const params = makePhysicsParams({ seed: 0x5eed })
const kspec = dustKernelSpec(params)
const sspec = dustSpawnSpec(params)
const frag = dustStepFragmentShader(params)

const SEEDS = [0, 1, -1, 0x7fffffff, -0x80000000, 0x5eed, 0x9e3779b9 | 0, ...Array.from({ length: 2000 }, (_, i) => draw(0xd057, i) | 0)]

function owner(id: string, birth: number, ax: number, ay: number, az: number, style = 0): DustOwner {
  return { id, anchor: [Math.round(ax * UNIT), Math.round(ay * UNIT), Math.round(az * UNIT)], birth, seed: fnv1a32(id) | 0, style }
}

describe('spawn port', () => {
  it('takes its physics constants from src/physics', () => {
    expect(sspec.burstRadius).toBe(DUST_BURST_RADIUS)
    expect(sspec.d0).toBe(spawnSpeed(params.dustTemp, params.dustInvMass))
  })

  it('embeds exactly the spec constants in the shader text', () => {
    const lines: [string, string][] = [
      ['int SP_BURST_RADIUS', glslInt(sspec.burstRadius)],
      ['int SP_D0', glslInt(sspec.d0)],
      ['int SP_STREAM_U', glslInt(sspec.streamU)],
      ['int SP_STREAM_DIR_Y', glslInt(sspec.streamDirY)],
      ['int SP_STREAM_DIR_PHI', glslInt(sspec.streamDirPhi)],
      ['int SP_STREAM_NOISE', glslInt(sspec.streamNoise)],
      ['uint SP_EY_SHIFT', `${sspec.eyShift}u`],
      ['int SP_EY_BIAS', glslInt(sspec.eyBias)],
      ['int SP_RHO_BASE', glslInt(sspec.rhoBase)],
      ['uint SP_COS_OFFSET', glslUint(sspec.cosOffset)],
      ['int SP_DIR_SHIFT', glslInt(sspec.dirShift)],
      ['int SP_BURST_SHIFT', glslInt(sspec.burstShift)],
      ['uint SP_PUSH_MASK', glslUint(sspec.burstPushMask)],
      ['uint SP_NOISE_SHIFT', `${sspec.noiseShift}u`],
      ['int SP_NOISE_BIAS', glslInt(sspec.noiseBias)],
      ['int SP_VEL_SHIFT', glslInt(sspec.velShift)],
      ['uint LB_MUL1', glslUint(sspec.lbMul1)],
      ['uint LB_MUL2', glslUint(sspec.lbMul2)],
      ['uint LB_SHIFT1', `${sspec.lbShift1}u`],
      ['uint LB_SHIFT2', `${sspec.lbShift2}u`],
      ['uint LB_SHIFT3', `${sspec.lbShift3}u`],
      ['uint RNG_GOLDEN', glslUint(sspec.golden)],
      ['int ISQRT_ITERS', glslInt(sspec.isqrtIters)],
      ['uint ISQRT_TOP_BIT', glslUint(sspec.isqrtTopBit)],
    ]
    for (const [decl, lit] of lines) expect(frag).toContain(`const ${decl} = ${lit};`)
    // Births: dormant texels are regenerated from the anchor and the meta seed.
    expect(frag).toContain('uniform isampler2D uMeta;')
    expect(frag).toContain('uniform int uStep;')
    expect(frag).toContain('uniform int uBirths;')
    expect(frag.match(/spawnDust\(a, uint\(texelFetch\(uMeta, p, 0\)\.x\), x, d\);/g)).toHaveLength(2)
    // A different physics seed changes only the landscape, not the spawn constants.
    expect(dustSpawnSpec(makePhysicsParams({ seed: 7 }))).toEqual(sspec)
  })

  it('reproduces rng draw and isqrt', () => {
    const m = makeDustMirror(kspec, sspec)
    for (const s of SEEDS.slice(0, 200)) {
      for (let k = 0; k < 8; k++) expect(m.draw(s >>> 0, k)).toBe(draw(s, k))
      expect(m.isqrt(s >>> 0)).toBe(isqrt(s))
    }
    for (const n of [0, 1, 2, 3, 4, 0x3fffffff, 0x40000000, 0xffffffff, 0xfffe0001]) expect(m.isqrt(n)).toBe(isqrt(n))
  })

  it('reproduces spawnDustState bit for bit (X = anchor + u, wrapping)', () => {
    const m = makeDustMirror(kspec, sspec)
    const out = new Int32Array(6)
    const x = new Int32Array(3)
    const d = new Int32Array(3)
    const anchors = [
      [0, 0, 0],
      [4096 * UNIT - 1, -12 * UNIT, -(4096 * UNIT - 1)],
      [-0x80000000, 0x7fffffff, 123456789],
    ]
    for (const a of anchors) {
      for (const s of SEEDS) {
        spawnDustState(s, params.dustTemp, params.dustInvMass, out)
        m.spawn(a, s >>> 0, x, d)
        expect([x[0], x[1], x[2], d[0], d[1], d[2]]).toEqual([
          (a[0] + out[0]) | 0,
          (a[1] + out[1]) | 0,
          (a[2] + out[2]) | 0,
          out[3],
          out[4],
          out[5],
        ])
      }
    }
  })

  it('fails when any spawn literal is off by one (the mirror is discriminating)', () => {
    const fields = Object.keys(sspec) as (keyof DustSpawnSpec)[]
    const out = new Int32Array(6)
    const x = new Int32Array(3)
    const d = new Int32Array(3)
    for (const f of fields) {
      // The LUT ignores the low 20 phase bits at its 4096-entry resolution far more often
      // than not, so the quarter-turn offset is perturbed by one table entry.
      // isqrt's top bit is shifted right by 2 before its low bits matter, so it is moved
      // to the next power of four.
      const delta = f === 'cosOffset' ? 1 << 20 : f === 'isqrtTopBit' ? -0x30000000 : 1
      const m = makeDustMirror(kspec, { ...sspec, [f]: sspec[f] + delta })
      // isqrt's top bit only matters above the spawn's 2^30 inputs: check the helper too.
      let differs = [0xffffffff, 0x80000000, 0x40000001].some((n) => m.isqrt(n) !== isqrt(n))
      for (const s of SEEDS) {
        if (differs) break
        spawnDustState(s, params.dustTemp, params.dustInvMass, out)
        m.spawn([0, 0, 0], s >>> 0, x, d)
        if (x[0] !== out[0] || x[1] !== out[1] || x[2] !== out[2] || d[0] !== out[3] || d[1] !== out[4] || d[2] !== out[5]) {
          differs = true
          break
        }
      }
      expect(differs, f).toBe(true)
    }
  })
})

/** A small dust world: owners with births before, inside and after the run, plus free segments. */
function birthWorld() {
  const segments = 12
  const w = createDustWorld(params, segments * DUST_SEGMENT)
  const owners: (DustOwner | null)[] = [
    owner('born-at-0', 0, 3, 10, -2),
    owner('born-at-1', 1, -4, 11, 5),
    owner('born-mid', 37, 20, 120, 7, 4),
    owner('born-on-draw-edge', 50, -9, 30, -30),
    owner('born-late', 113, 0.5, 400, 0.25),
    owner('never-in-run', 100000, 1, 2, 3),
    null,
    owner('seam', 64, 4095.9, 12, -4095.9),
    owner('far', 5, -3000, 2000, 1500),
    null,
    owner('born-at-149', 149, 6, 66, 6),
    owner('born-at-150', 150, -6, 66, -6),
  ]
  owners.forEach((o, s) => setDustSegment(w, s, o))
  return { w, owners, segments }
}

describe('births: CPU dust world ≡ step shader (GLSL semantics)', () => {
  it('matches at every draw boundary forward and backward, dormant and free texels included', () => {
    const { w, segments } = birthWorld()
    const n = segments * DUST_SEGMENT
    const t = dustWorldTexels(w, 64, segments)
    const m = makeDustMirror(kspec, sspec)
    // Scramble the dormant texels on the "GPU": every draw must regenerate them.
    for (let i = 0; i < n; i++) if (t.anchor[4 * i + 3] > 0) t.x[4 * i] ^= 0x5a5a
    const schedule = [1, 7, 25, 17, 0, 50, 13, 37]
    let step = 0
    mirrorDraw(m, { step, steps: 0, backward: false, births: true }, t.x, t.d, t.anchor, t.meta, n)
    expect(compareDust(n, w.sys.x, w.sys.d, t.x, t.d).identical).toBe(true)
    for (const k of schedule) {
      mirrorDraw(m, { step, steps: k, backward: false, births: true }, t.x, t.d, t.anchor, t.meta, n)
      step += k
      runDustTo(w, step)
      expect(compareDust(n, w.sys.x, w.sys.d, t.x, t.d), `forward to ${step}`).toEqual({ identical: true, mismatches: 0, first: null })
    }
    expect(step).toBe(150)
    for (const k of [...schedule].reverse()) {
      mirrorDraw(m, { step, steps: k, backward: true, births: true }, t.x, t.d, t.anchor, t.meta, n)
      step -= k
      runDustTo(w, step)
      expect(compareDust(n, w.sys.x, w.sys.d, t.x, t.d).identical, `backward to ${step}`).toBe(true)
    }
    // Back at 0: everything is the spawn state again, exactly.
    const fresh = birthWorld().w
    expect(compareDust(n, fresh.sys.x, fresh.sys.d, t.x, t.d).identical).toBe(true)
  })

  it('without births the shader is the plain S2 kernel (births in .w ignored)', () => {
    const { w, segments } = birthWorld()
    const n = segments * DUST_SEGMENT
    const t = dustWorldTexels(w, 64, segments)
    const m = makeDustMirror(kspec, sspec)
    mirrorDraw(m, { step: 0, steps: 20, backward: false, births: false }, t.x, t.d, t.anchor, t.meta, n)
    // Compare one dormant texel against 20 plain steps of the mirror.
    const i = 4 * DUST_SEGMENT
    const ref = birthWorld().w
    const x = Int32Array.from(ref.sys.x.subarray(3 * i, 3 * i + 3))
    const d = Int32Array.from(ref.sys.d.subarray(3 * i, 3 * i + 3))
    const a = ref.sys.anchor.subarray(3 * i, 3 * i + 3)
    for (let k = 0; k < 20; k++) m.forward(x, d, a)
    expect([...t.x.subarray(4 * i, 4 * i + 3), ...t.d.subarray(4 * i, 4 * i + 3)]).toEqual([...x, ...d])
  })

  it('re-spawns a dormant segment from new anchor/meta inputs on a 0-step draw', () => {
    const { w, segments } = birthWorld()
    const n = segments * DUST_SEGMENT
    runDustTo(w, 60)
    const t = dustWorldTexels(w, 64, segments)
    // Edit the dormant 'born-late' segment (4): new anchor and owner, still unborn at 60.
    const moved = owner('born-late-moved', 90, -7, 333, 2)
    setDustSegment(w, 4, moved)
    const t2 = dustWorldTexels(w, 64, segments)
    t.anchor.set(t2.anchor)
    t.meta.set(t2.meta)
    mirrorDraw(makeDustMirror(kspec, sspec), { step: 60, steps: 0, backward: false, births: true }, t.x, t.d, t.anchor, t.meta, n)
    expect(compareDust(n, w.sys.x, w.sys.d, t.x, t.d).identical).toBe(true)
  })
})

describe('CPU edit rows', () => {
  it('computeDustRows equals the dust world segment at every requested step', () => {
    const o = owner('edited', 40, 2, 50, -3)
    const steps = [0, 39, 40, 41, 97, 300, 41]
    const rows = computeDustRows(o, steps, params)
    const w = createDustWorld(params, DUST_SEGMENT)
    setDustSegment(w, 0, o)
    for (const [k, s] of steps.entries()) {
      runDustTo(w, s)
      expect(rows[k].step).toBe(s)
      expect(compareDust(DUST_SEGMENT, w.sys.x, w.sys.d, rows[k].x, rows[k].d).identical, `step ${s}`).toBe(true)
    }
  })

  it('setDustSegment at a later step equals spawning at birth and stepping', () => {
    const o = owner('late-edit', 10, -1, 20, 1)
    const a = createDustWorld(params, 2 * DUST_SEGMENT)
    setDustSegment(a, 1, o)
    runDustTo(a, 250)
    const b = createDustWorld(params, 2 * DUST_SEGMENT)
    runDustTo(b, 250)
    setDustSegment(b, 1, o)
    expect(compareDust(2 * DUST_SEGMENT, a.sys.x, a.sys.d, Int32Array.from(dustWorldTexels(b, 64, 2).x), dustWorldTexels(b, 64, 2).d).identical).toBe(true)
  })

  it('a rows job tracks a moving target forward and backward in bounded slices', () => {
    const o = owner('job', 100, 0, 0, 0)
    const job = new DustRowsJob(o, params)
    expect(job.advance(50)).toBe(true)
    expect(job.advance(400, 120)).toBe(false)
    expect(job.step).toBe(220)
    expect(job.advance(160, 1000)).toBe(true)
    const [ref] = computeDustRows(o, [160], params)
    expect(job.rows()).toEqual(ref)
    // Back to (and below) the birth: the spawn state, exactly.
    expect(job.advance(100)).toBe(true)
    expect(job.rows()).toEqual(computeDustRows(o, [100], params)[0])
    expect(job.advance(3)).toBe(true)
    expect(job.rows().x).toEqual(computeDustRows(o, [100], params)[0].x)
  })

  it('seeds each particle from the owner hash keyed by its index; free texels never activate', () => {
    expect(dustParticleSeed(0x1234, 5)).toBe(draw(0x1234, 5) | 0)
    const w = createDustWorld(params, DUST_SEGMENT)
    expect(w.sys.birth.every((b) => b === DUST_FREE_BIRTH)).toBe(true)
    const t = dustWorldTexels(w, 64, 2)
    expect(t.anchor[4 * 100 + 3]).toBe(DUST_FREE_BIRTH)
  })
})

describe('patch shader', () => {
  it('copies the patch rows to the scissored region, integer only', () => {
    const src = dustPatchFragmentShader()
    expect(src).toContain('oX = texelFetch(uPatchX, q, 0);')
    expect(src).toContain('oD = texelFetch(uPatchD, q, 0);')
    const body = src.slice(GLSL_PRECISION_HEADER.length).replace(/\/\/.*$/gm, '')
    expect(src.startsWith(GLSL_PRECISION_HEADER)).toBe(true)
    expect(body).not.toMatch(/\bfloat\b|\bvec[234]\b|\d\.\d/)
  })
})
