import { describe, expect, it } from 'vitest'
import { applySimilarity, fitSimilarity, recrystallise, semanticAnchorHint, type XZ } from '../../src/ai/layout.ts'
import { bruteKnn, EMBED_DIM, fromBase64, toBase64, truncateNormalize } from '../../src/ai/embedText.ts'
import { minRadiusFor } from '../../src/domain/placement.ts'
import type { Archetype } from '../../src/domain/types.ts'

const pts: XZ[] = [[0, 0], [3, 1], [-2, 4], [5, -3], [1, 7], [-4, -2]]

function transform(p: XZ, theta: number, s: number, t: XZ, reflect: boolean): XZ {
  const y = reflect ? -p[1] : p[1]
  return [s * (Math.cos(theta) * p[0] - Math.sin(theta) * y) + t[0], s * (Math.sin(theta) * p[0] + Math.cos(theta) * y) + t[1]]
}

describe('fitSimilarity (Kabsch/Umeyama)', () => {
  it('recovers a rotation + scale + translation exactly', () => {
    const dst = pts.map((p) => transform(p, 0.7, 2.5, [10, -4], false))
    const T = fitSimilarity(pts, dst)
    expect(T.reflected).toBe(false)
    expect(T.s).toBeCloseTo(2.5, 9)
    pts.forEach((p, i) => {
      const q = applySimilarity(T, p)
      expect(q[0]).toBeCloseTo(dst[i][0], 9)
      expect(q[1]).toBeCloseTo(dst[i][1], 9)
    })
  })

  it('recovers a mirror image when reflections are allowed, and refuses one otherwise', () => {
    const dst = pts.map((p) => transform(p, -1.2, 0.5, [3, 3], true))
    const T = fitSimilarity(pts, dst)
    expect(T.reflected).toBe(true)
    pts.forEach((p, i) => {
      const q = applySimilarity(T, p)
      expect(q[0]).toBeCloseTo(dst[i][0], 9)
      expect(q[1]).toBeCloseTo(dst[i][1], 9)
    })
    expect(fitSimilarity(pts, dst, false).reflected).toBe(false)
  })
})

describe('semantic placement', () => {
  it('points a new node at its similar neighbours, on its own ring', () => {
    const hint = semanticAnchorHint(
      [
        { anchorXZ: [0, 30], similarity: 0.9 },
        { anchorXZ: [0, 40], similarity: 0.8 },
        { anchorXZ: [30, 0], similarity: 0.1 }, // below the similarity floor: ignored
      ],
      'idea',
    )!
    expect(Math.atan2(hint[1], hint[0])).toBeCloseTo(Math.PI / 2, 6)
    expect(Math.hypot(...hint)).toBeGreaterThan(30)
    expect(semanticAnchorHint([{ anchorXZ: [10, 0], similarity: 0.05 }], 'idea')).toBeNull()
    const mem = semanticAnchorHint([{ anchorXZ: [1, 0], similarity: 0.9 }], 'memory')!
    expect(Math.hypot(...mem)).toBeGreaterThanOrEqual(minRadiusFor('memory'))
  })
})

describe('re-crystallise', () => {
  const archetypes: Archetype[] = ['idea', 'entity', 'lens', 'document', 'memory', 'idea']
  // Two clusters of meaning: ids a* share a direction, b* another.
  function world() {
    const records = []
    const vectors = new Map<string, Float32Array>()
    for (let i = 0; i < 12; i++) {
      const id = `${i < 6 ? 'a' : 'b'}${i}`
      const v = new Float32Array(EMBED_DIM)
      for (let k = 0; k < EMBED_DIM; k++) v[k] = (i < 6 ? Math.sin(k) : Math.cos(3 * k)) + 0.05 * Math.sin(i * 31 + k * 7)
      vectors.set(id, truncateNormalize(v, EMBED_DIM))
      const angle = (i / 12) * 2 * Math.PI
      const r = 30 + (i % 3) * 5
      records.push({ id, archetype: archetypes[i % archetypes.length], anchorXZ: [r * Math.cos(angle), r * Math.sin(angle)] as [number, number] })
    }
    return { records, vectors }
  }

  it('is deterministic for a seed, keeps each radius, and groups by meaning', () => {
    const { records, vectors } = world()
    const a = recrystallise({ records, vectors, seed: 7 })
    const b = recrystallise({ records, vectors, seed: 7 })
    expect([...a.targets.entries()]).toEqual([...b.targets.entries()])
    for (const r of records) {
      const t = a.targets.get(r.id)!
      expect(Math.hypot(...t)).toBeCloseTo(Math.max(minRadiusFor(r.archetype), Math.hypot(...r.anchorXZ)), 6)
    }
    // Mean angular spread inside a cluster is smaller than between the two clusters.
    const ang = (id: string) => Math.atan2(a.targets.get(id)![1], a.targets.get(id)![0])
    const gap = (x: number, y: number) => Math.abs(Math.atan2(Math.sin(x - y), Math.cos(x - y)))
    const ids = records.map((r) => r.id)
    let inside = 0, ni = 0, across = 0, na = 0
    for (const x of ids) for (const y of ids) {
      if (x >= y) continue
      if (x[0] === y[0]) { inside += gap(ang(x), ang(y)); ni++ } else { across += gap(ang(x), ang(y)); na++ }
    }
    expect(inside / ni).toBeLessThan(across / na)
  })

  it('needs enough embedded nodes', () => {
    const { records, vectors } = world()
    expect(() => recrystallise({ records: records.slice(0, 4), vectors, seed: 1 })).toThrow(/at least 5/)
  })
})

describe('vector helpers', () => {
  it('truncates to a unit vector, ranks by cosine and survives base64', () => {
    const v = truncateNormalize([3, 4, 12, 99], 2)
    expect(Array.from(v).map((x) => +x.toFixed(6))).toEqual([0.6, 0.8])
    const all = new Map([['x', truncateNormalize([1, 0], 2)], ['y', truncateNormalize([0, 1], 2)], ['z', truncateNormalize([1, 1], 2)]])
    expect(bruteKnn(truncateNormalize([1, 0.1], 2), all, 2).map((h) => h.id)).toEqual(['x', 'z'])
    const big = truncateNormalize(Array.from({ length: EMBED_DIM }, (_, i) => Math.sin(i)), EMBED_DIM)
    expect(Array.from(fromBase64(toBase64(big)))).toEqual(Array.from(big))
  })
})
