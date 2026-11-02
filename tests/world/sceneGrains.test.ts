import { describe, expect, it } from 'vitest'
import { sceneGrainsFrom, type RawSplats } from '../../src/world/field/sceneGrains.ts'

/** n splats on a 10×4×6 box (y up), plus a few far floaters and faint ones. */
function raw(n: number): RawSplats {
  const total = n + 20
  const r: RawSplats = { n: total, center: new Float32Array(total * 3), color: new Float32Array(total * 3), opacity: new Float32Array(total), scale: new Float32Array(total) }
  for (let i = 0; i < total; i++) {
    const t = i / total
    const far = i >= n
    r.center.set(far ? [500, 500, 500] : [-5 + 10 * ((i * 7) % n) / n, -2 + 4 * t, -3 + 6 * ((i * 13) % n) / n], i * 3)
    r.color.set([1, 0.5, 0], i * 3)
    r.opacity[i] = i % 10 === 0 ? 0.1 : 0.9
    r.scale[i] = 0.05
  }
  return r
}

const box = { min: [-5, -2, -3] as [number, number, number], max: [5, 2, 3] as [number, number, number] }
const up: [number, number, number, number] = [0, 0, 0, 1]

describe('a scene as grains', () => {
  it('keeps visible splats inside the box, up to the budget', () => {
    const g = sceneGrainsFrom(raw(1000), box, up, 4, 500)
    expect(g.rand.length).toBe(500)
    const all = sceneGrainsFrom(raw(1000), box, up, 4)
    // Faint (every tenth) and far splats are left out.
    expect(all.rand.length).toBe(900)
  })

  it('fits the scene into the shell, centred, and reports its floor and narrower half-width', () => {
    const g = sceneGrainsFrom(raw(1000), box, up, 4)
    let maxAbs = 0
    for (const v of g.pos) maxAbs = Math.max(maxAbs, Math.abs(v))
    expect(maxAbs).toBeLessThanOrEqual(4 + 1e-4)
    // Larger half-extent 5 → 4: scale 0.8; floor 2·0.8, narrower side 3·0.8.
    expect(g.floor).toBeCloseTo(1.6, 1)
    expect(g.footprint).toBeCloseTo(2.4, 5)
  })

  it('gives grains linear colour and a bounded size', () => {
    const g = sceneGrainsFrom(raw(100), box, up, 4)
    expect(g.col[0]).toBeCloseTo(1, 5)
    expect(g.col[1]).toBeCloseTo(Math.pow(0.5, 2.2), 5)
    for (const s of g.size) {
      expect(s).toBeGreaterThan(0)
      expect(s).toBeLessThanOrEqual(4 * 0.06 + 1e-6)
    }
  })
})
