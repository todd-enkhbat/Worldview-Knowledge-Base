// The dust points shaders and the per-frame time slicing (pure parts).

import { describe, expect, it } from 'vitest'
import { ARCHETYPES } from '../../src/domain/types.ts'
import { GLSL_PRECISION_HEADER } from '../../src/gpu/dust/glsl.ts'
import { identityOwners } from '../../src/gpu/dust/identity.ts'
import { GpuStepTimer, stepBudget } from '../../src/gpu/dust/timer.ts'
import { dustPalette, dustPointsFragmentShader, dustPointsVertexShader } from '../../src/world/dust/dustMaterial.ts'

describe('dust points shaders', () => {
  it('read the integer state by gl_VertexID with the highp int header', () => {
    const vs = dustPointsVertexShader()
    const fs = dustPointsFragmentShader()
    for (const s of [vs, fs]) {
      expect(s.startsWith(`${GLSL_PRECISION_HEADER}\n`)).toBe(true)
      expect(s).not.toContain('#version')
    }
    expect(vs).toContain('ivec2 p = ivec2(gl_VertexID % uWidth, gl_VertexID / uWidth);')
    expect(vs).toContain('vec3 x = vec3(texelFetch(uX, p, 0).xyz);')
    // Q.19 → world units, X + acc·D/256 (D is Q.27 per step).
    expect(vs).toContain('const float INV_UNIT = 1.9073486328125e-6;')
    expect(vs).toContain('const float INV_DRIFT = 3.90625e-3;')
    // Ghosts (birth after the playhead) and hidden segments are culled.
    expect(vs).toContain('bool unborn = an.w > uStep;')
    expect(vs).toContain('(meta.y & 256) != 0')
    expect(vs).toContain(`uniform vec3 uPalette[${ARCHETYPES.length}];`)
  })

  it('has one linear tint per archetype', () => {
    const p = dustPalette()
    expect(p.length).toBe(3 * ARCHETYPES.length)
    for (const v of p) expect(v).toBeGreaterThan(0)
  })
})

describe('time slicing', () => {
  it('budgets kernel steps from the measured GPU cost per texel-step', () => {
    // 0.1 ns per texel-step over the full 131k budget: 3.5 ms buys 267 steps.
    expect(stepBudget(131072, 0.1)).toBe(267)
    // Fewer texels, more steps (bounded).
    expect(stepBudget(640, 0.1)).toBe(4096)
    expect(stepBudget(131072, 1000)).toBe(1)
  })

  it('falls back to a conservative fixed texel-step budget without a timer', () => {
    expect(stepBudget(131072, null)).toBe(16)
    expect(stepBudget(65536, null)).toBe(32)
    expect(stepBudget(64, null, { maxSteps: 512 })).toBe(512)
    expect(stepBudget(0, null)).toBe(4096)
  })

  it('averages timer results, skipping disjoint and tiny samples', () => {
    const results: { ns: number; ready: boolean }[] = []
    let disjoint = false
    let open = false
    const gl = {
      QUERY_RESULT_AVAILABLE: 1,
      QUERY_RESULT: 2,
      getExtension: () => ({ TIME_ELAPSED_EXT: 10, GPU_DISJOINT_EXT: 11 }),
      createQuery: () => {
        const q = { ns: 0, ready: false }
        results.push(q)
        return q
      },
      beginQuery: () => {
        if (open) throw new Error('nested')
        open = true
      },
      endQuery: () => {
        open = false
      },
      getQueryParameter: (q: { ns: number; ready: boolean }, p: number) => (p === 1 ? q.ready : q.ns),
      getParameter: () => disjoint,
      deleteQuery: () => {},
    } as unknown as WebGL2RenderingContext
    const t = GpuStepTimer.create(gl, 2, 0.5)!
    expect(t.begin()).toBe(true)
    expect(t.begin()).toBe(false)
    t.end(1_000_000)
    expect(t.begin()).toBe(true)
    t.end(100) // tiny: ignored
    expect(t.begin()).toBe(false) // two in flight
    results[0].ns = 2_000_000
    results[0].ready = true
    results[1].ns = 9e9
    results[1].ready = true
    t.poll()
    expect(t.nsPerTexelStep).toBe(2)
    expect(t.begin()).toBe(true)
    t.end(1_000_000)
    disjoint = true
    results[2].ns = 1e12
    results[2].ready = true
    t.poll()
    expect(t.nsPerTexelStep).toBe(2)
    disjoint = false
    t.begin()
    t.end(1_000_000)
    results[3].ns = 4_000_000
    results[3].ready = true
    t.poll()
    expect(t.nsPerTexelStep).toBe(3)
    expect(GpuStepTimer.create({ getExtension: () => null } as unknown as WebGL2RenderingContext)).toBeNull()
  })
})

describe('identity world', () => {
  it('is deterministic and covers births at 0, inside, past the run, free segments and the seam', () => {
    const a = identityOwners(64, 600, 0xd1)
    expect(identityOwners(64, 600, 0xd1)).toEqual(a)
    const births = a.filter((o) => o !== null).map((o) => o!.birth)
    expect(births).toContain(0)
    expect(births.some((b) => b > 0 && b < 600)).toBe(true)
    expect(births.some((b) => b > 600)).toBe(true)
    expect(a.some((o) => o === null)).toBe(true)
    expect(Math.abs(a[0]!.anchor[0])).toBeGreaterThan(4095 * 2 ** 19)
  })
})
