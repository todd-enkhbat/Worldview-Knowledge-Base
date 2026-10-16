import { describe, expect, it } from 'vitest'
import { HELIX_PITCH, HELIX_RADIUS, MAX_ANCHOR_RADIUS, MS_PER_YEAR, SIGMA } from '../../src/domain/constants.ts'
import {
  CORE_RADIUS,
  MEMORY_MIN_RADIUS,
  RING_RADIUS,
  SECTOR_WIDTH,
  findCoreIntersections,
  helixAngleAt,
  helixSpur,
  nodeAngle,
  placeAnchor,
  radiusOf,
  replaceOnTagChange,
  sectorAngle,
  sectorOf,
  spurClearance,
  spurIntersectsCore,
  toPlacedAnchors,
  type PlacedAnchor,
} from '../../src/domain/placement.ts'
import { yOf } from '../../src/domain/time.ts'
import { ARCHETYPES, type Archetype, type NodeRecord } from '../../src/domain/types.ts'
import { makeNodeDraft } from '../../src/domain/validate.ts'

const T0 = Date.UTC(1990, 0, 1)
const NOW = Date.UTC(2026, 9, 14)
const opts = { T0 }
const TAU = 2 * Math.PI

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic uuid-shaped id from a PRNG (the tests must not depend on crypto randomness). */
function fakeId(rand: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16)).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
}

function node(id: string, archetype: Archetype, tags: string[], temporalOrigin: number): NodeRecord {
  return makeNodeDraft(archetype, { id, tags, temporalOrigin, title: id }, { now: NOW })
}

function randomWorld(n: number, seed: number, { spanYears = 3, tagPool = 5 } = {}): NodeRecord[] {
  const rand = mulberry32(seed)
  const pool = Array.from({ length: tagPool }, (_, i) => `tag-${i}`)
  const out: NodeRecord[] = []
  const placed: PlacedAnchor[] = []
  for (let i = 0; i < n; i++) {
    const archetype = ARCHETYPES[Math.floor(rand() * ARCHETYPES.length)]
    const tags = rand() < 0.15 ? [] : [pool[Math.floor(rand() * pool.length)]]
    const t = T0 + 30 * MS_PER_YEAR + rand() * spanYears * MS_PER_YEAR
    const r = node(fakeId(rand), archetype, tags, t)
    r.anchorXZ = placeAnchor(r, placed, opts)
    placed.push({ id: r.id, anchorXZ: r.anchorXZ, y: yOf(t, T0) })
    out.push(r)
  }
  return out
}

function minPairDistance(records: NodeRecord[]): number {
  const pts = records.map((r) => [r.anchorXZ[0], yOf(r.temporalOrigin, T0), r.anchorXZ[1]])
  let min = Infinity
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      min = Math.min(min, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]))
  return min
}

describe('sectors and angles', () => {
  it('derives the sector from the primary tag, normalised', () => {
    const a = node('a', 'idea', ['Physics', 'zz'], NOW)
    const b = node('b', 'lens', ['  #physics '], NOW)
    expect(sectorOf(a)).toBe(sectorOf(b))
    expect(sectorAngle(a)).toBeCloseTo(sectorAngle(b))
    expect(sectorAngle(a)).toBeGreaterThanOrEqual(0)
    expect(sectorAngle(a)).toBeLessThan(TAU)
  })

  it('falls back to an id-hash sector when untagged', () => {
    const sectors = new Set<number>()
    for (let i = 0; i < 200; i++) sectors.add(sectorOf({ id: `id-${i}`, tags: [] }))
    expect(sectors.size).toBe(12)
    expect(sectorOf({ id: 'x', tags: [] })).toBe(sectorOf({ id: 'x', tags: ['  '] }))
  })

  it('nodeAngle is in [0, 2π) and inverts the polar form', () => {
    for (const a of [0, 1, 3, 4.5, 6.2]) {
      const xz: [number, number] = [10 * Math.cos(a), 10 * Math.sin(a)]
      expect(nodeAngle(xz)).toBeCloseTo(a, 9)
    }
    expect(nodeAngle([-1, -1e-12])).toBeLessThan(TAU)
    expect(nodeAngle([-1, -1e-12])).toBeGreaterThan(Math.PI)
  })
})

describe('placeAnchor', () => {
  it('is deterministic: same input, same anchor', () => {
    const world = randomWorld(50, 7)
    const r = node('11111111-2222-4333-a444-555555555555', 'memory', ['travel'], T0 + 31 * MS_PER_YEAR)
    const existing = toPlacedAnchors(world, opts)
    const a = placeAnchor(r, existing, opts)
    const b = placeAnchor(structuredClone(r), structuredClone(existing), opts)
    expect(a).toEqual(b)
    // Regenerating the whole world reproduces every anchor.
    expect(randomWorld(50, 7).map((n) => n.anchorXZ)).toEqual(world.map((n) => n.anchorXZ))
  })

  it('does not depend on the order of existing anchors', () => {
    const world = randomWorld(120, 11, { spanYears: 0.5 })
    const existing = toPlacedAnchors(world, opts)
    const rand = mulberry32(3)
    for (let k = 0; k < 10; k++) {
      const r = node(fakeId(rand), ARCHETYPES[k % ARCHETYPES.length], ['tag-1'], T0 + 30.2 * MS_PER_YEAR)
      const ref = placeAnchor(r, existing, opts)
      const shuffled = [...existing].sort(() => rand() - 0.5)
      expect(placeAnchor(r, shuffled, opts)).toEqual(ref)
      expect(placeAnchor(r, [...existing].reverse(), opts)).toEqual(ref)
    }
  })

  it('starts on the archetype ring inside the tag sector when there is no crowding', () => {
    for (const archetype of ARCHETYPES) {
      const r = node(`lonely-${archetype}`, archetype, ['music'], NOW)
      const a = placeAnchor(r, [], opts)
      expect(Math.abs(radiusOf(a) - RING_RADIUS[archetype])).toBeLessThanOrEqual(2.5 + 1e-3)
      const d = Math.abs(((nodeAngle(a) - sectorAngle(r) + 3 * Math.PI) % TAU) - Math.PI)
      expect(d).toBeLessThanOrEqual(SECTOR_WIDTH / 2)
    }
  })

  it('keeps ≥ σ in 3D for 200 random nodes (dense: 3 years, 5 tags)', () => {
    const world = randomWorld(200, 42)
    expect(minPairDistance(world)).toBeGreaterThanOrEqual(SIGMA)
    for (const r of world) {
      expect(radiusOf(r.anchorXZ)).toBeLessThan(MAX_ANCHOR_RADIUS)
      if (r.archetype === 'memory') expect(radiusOf(r.anchorXZ)).toBeGreaterThanOrEqual(MEMORY_MIN_RADIUS)
    }
  })

  it('keeps ≥ σ when 200 nodes share one date and one tag', () => {
    const rand = mulberry32(5)
    const placed: PlacedAnchor[] = []
    const world: NodeRecord[] = []
    const t = T0 + 20 * MS_PER_YEAR
    for (let i = 0; i < 200; i++) {
      const r = node(fakeId(rand), i % 2 ? 'memory' : 'idea', ['same'], t)
      r.anchorXZ = placeAnchor(r, placed, opts)
      placed.push({ id: r.id, anchorXZ: r.anchorXZ, y: yOf(t, T0) })
      world.push(r)
    }
    expect(minPairDistance(world)).toBeGreaterThanOrEqual(SIGMA)
  })

  it('ignores the record itself and soft-deleted records in existing', () => {
    const r = node('self', 'idea', ['a'], NOW)
    const alone = placeAnchor(r, [], opts)
    const ghost = { ...node('ghost', 'idea', ['a'], NOW), anchorXZ: alone, deletedAt: NOW }
    expect(placeAnchor(r, toPlacedAnchors([ghost], opts), opts)).toEqual(alone)
    expect(placeAnchor(r, [{ id: 'self', anchorXZ: alone, y: yOf(NOW, T0) }], opts)).toEqual(alone)
  })
})

describe('replaceOnTagChange', () => {
  const world = randomWorld(60, 9)
  const existing = toPlacedAnchors(world, opts)

  it('keeps the anchor (and the object) when tags did not change', () => {
    const prev = world[3]
    const next = { ...prev, title: 'renamed' }
    expect(replaceOnTagChange(prev, next, existing, opts)).toBe(next)
  })

  it('keeps the anchor when only a secondary tag changed (a drag survives)', () => {
    const prev = { ...world[4], tags: ['alpha', 'beta'] }
    const next = { ...prev, tags: ['Alpha', 'gamma'] }
    expect(replaceOnTagChange(prev, next, existing, opts).anchorXZ).toEqual(prev.anchorXZ)
  })

  it('re-places only that node into the new sector when the primary tag changed', () => {
    const prev = world.find((r) => r.tags.length > 0)!
    let tag = 'new-sector-0'
    for (let i = 1; sectorOf({ id: prev.id, tags: [tag] }) === sectorOf(prev); i++) tag = `new-sector-${i}`
    const next = { ...prev, tags: [tag] }
    const before = structuredClone(world)
    const moved = replaceOnTagChange(prev, next, existing, opts)
    expect(moved).not.toBe(next)
    expect(moved.anchorXZ).not.toEqual(prev.anchorXZ)
    expect(moved.anchorXZ).toEqual(placeAnchor(next, existing, opts))
    expect(world).toEqual(before)
    const others = world.filter((r) => r.id !== prev.id)
    expect(minPairDistance([...others, moved])).toBeGreaterThanOrEqual(SIGMA)
  })
})

describe('catwalk spurs', () => {
  it('attaches on the nearest turn where the helix angle equals φ, with |stairDY| ≤ 6', () => {
    const rand = mulberry32(99)
    for (let i = 0; i < 2000; i++) {
      const phi = rand() * TAU
      const r = MEMORY_MIN_RADIUS + rand() * 40
      const xz: [number, number] = [r * Math.cos(phi), r * Math.sin(phi)]
      const y = rand() * 3000
      const s = helixSpur(xz, y)
      expect(s.stairDY).toBeGreaterThanOrEqual(-HELIX_PITCH / 2)
      expect(s.stairDY).toBeLessThanOrEqual(HELIX_PITCH / 2)
      expect(s.stairDY).toBeLessThanOrEqual(6)
      expect(s.turnY + s.stairDY).toBeCloseTo(y, 9)
      const helixPhi = ((helixAngleAt(s.turnY) % TAU) + TAU) % TAU
      const diff = Math.abs(((helixPhi - s.attachAngle + 3 * Math.PI) % TAU) - Math.PI)
      expect(diff).toBeLessThan(1e-9)
      expect(Math.hypot(...s.attachXZ)).toBeCloseTo(HELIX_RADIUS, 9)
      expect(s.length).toBeGreaterThan(0)
    }
  })

  it('no spur of a placed memory intersects the core cylinder', () => {
    const world = randomWorld(200, 1234)
    expect(world.some((r) => r.archetype === 'memory')).toBe(true)
    expect(findCoreIntersections(world)).toEqual([])
    for (const r of world.filter((n) => n.archetype === 'memory')) {
      expect(spurIntersectsCore(r.anchorXZ)).toBe(false)
      expect(spurClearance(r.anchorXZ)).toBeGreaterThan(CORE_RADIUS + 1)
    }
  })

  it('detects a spur that would cut the core', () => {
    expect(spurIntersectsCore([2, 0])).toBe(true)
    expect(spurIntersectsCore([0.5, -0.5])).toBe(true)
    expect(spurIntersectsCore([30, 0])).toBe(false)
    const bad = { ...node('inner', 'memory', [], NOW), anchorXZ: [1, 1] as [number, number] }
    expect(findCoreIntersections([bad])).toEqual(['inner'])
  })
})
