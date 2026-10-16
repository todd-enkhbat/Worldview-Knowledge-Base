import { describe, expect, it } from 'vitest'
import {
  DUST_BUDGET_SEGMENTS,
  DUST_BUDGET_TEXELS,
  DUST_SEGMENT,
  DUST_TEXTURE_WIDTH,
  type DustCandidate,
  allocateDust,
  compareCandidates,
  rowsForSegments,
  segmentOrigin,
} from '../../src/gpu/dust/alloc.ts'

const cand = (id: string, significance = 1, memory = false, birth = 0): DustCandidate => ({ id, significance, memory, birth })

describe('dust allocation', () => {
  it('fixes the budget at 131k texels in 64-texel segments of a 512-wide texture', () => {
    expect(DUST_SEGMENT).toBe(64)
    expect(DUST_BUDGET_TEXELS).toBe(131072)
    expect(DUST_BUDGET_SEGMENTS).toBe(2048)
    expect(DUST_TEXTURE_WIDTH % DUST_SEGMENT).toBe(0)
    expect(segmentOrigin(0, 512)).toEqual({ x: 0, y: 0 })
    expect(segmentOrigin(7, 512)).toEqual({ x: 448, y: 0 })
    expect(segmentOrigin(8, 512)).toEqual({ x: 0, y: 1 })
    expect(rowsForSegments(0, 512)).toBe(0)
    expect(rowsForSegments(1, 512)).toBe(1)
    expect(rowsForSegments(9, 512)).toBe(2)
    expect(() => segmentOrigin(1, 100)).toThrow()
  })

  it('funds memory nodes first, then by significance, birth and id', () => {
    const cs = [cand('a', 4), cand('m2', 0.25, true, 50), cand('b', 2), cand('m1', 0.25, true, 10), cand('c', 2, false, -1)]
    expect([...cs].sort(compareCandidates).map((c) => c.id)).toEqual(['m1', 'm2', 'a', 'c', 'b'])
    const { allocation, diff } = allocateDust(null, cs, 3)
    expect(diff.assigned).toEqual([
      { id: 'm1', segment: 0 },
      { id: 'm2', segment: 1 },
      { id: 'a', segment: 2 },
    ])
    expect(allocation.segmentOf.has('b')).toBe(false)
    expect(allocation.used).toBe(3)
  })

  it('keeps every surviving owner on its segment and reuses freed segments lowest-first', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `n${i}`)
    let r = allocateDust(null, ids.map((id, i) => cand(id, 10 - i)), DUST_BUDGET_SEGMENTS)
    const before = new Map(r.allocation.segmentOf)
    // Remove n2 and n5, add two new owners of top significance.
    const next = ids.filter((id) => id !== 'n2' && id !== 'n5').map((id, i) => cand(id, 10 - i))
    next.push(cand('x', 100), cand('y', 99))
    r = allocateDust(r.allocation, next, DUST_BUDGET_SEGMENTS)
    for (const id of ids) if (id !== 'n2' && id !== 'n5') expect(r.allocation.segmentOf.get(id)).toBe(before.get(id))
    expect(r.diff.released).toEqual([
      { id: 'n2', segment: 2 },
      { id: 'n5', segment: 5 },
    ])
    expect(r.diff.assigned).toEqual([
      { id: 'x', segment: 2 },
      { id: 'y', segment: 5 },
    ])
    expect(r.allocation.used).toBe(10)
    // A no-op re-allocation changes nothing.
    const again = allocateDust(r.allocation, next, DUST_BUDGET_SEGMENTS)
    expect(again.diff).toEqual({ assigned: [], released: [] })
    expect(again.allocation.ownerOf).toEqual(r.allocation.ownerOf)
  })

  it('gives owners beyond the budget no dust, and funds them when a slot frees', () => {
    const cs = [cand('a', 3), cand('b', 2), cand('c', 1)]
    let r = allocateDust(null, cs, 2)
    expect([...r.allocation.segmentOf.keys()].sort()).toEqual(['a', 'b'])
    // A memory node displaces the least significant funded owner.
    r = allocateDust(r.allocation, [...cs, cand('m', 0.25, true)], 2)
    expect(r.diff.released).toEqual([{ id: 'b', segment: 1 }])
    expect(r.diff.assigned).toEqual([{ id: 'm', segment: 1 }])
    expect(r.allocation.segmentOf.get('a')).toBe(0)
    // Removing the memory funds b again, on the freed segment.
    r = allocateDust(r.allocation, cs, 2)
    expect(r.diff.assigned).toEqual([{ id: 'b', segment: 1 }])
  })

  it('tracks the used range and starts afresh on a budget change', () => {
    let r = allocateDust(null, [cand('a', 3), cand('b', 2), cand('c', 1)], 8)
    r = allocateDust(r.allocation, [cand('a', 3)], 8)
    expect(r.allocation.used).toBe(1)
    r = allocateDust(r.allocation, [cand('a', 3), cand('z', 5)], 4)
    expect(r.diff.released).toEqual([{ id: 'a', segment: 0 }])
    expect(r.diff.assigned).toEqual([
      { id: 'z', segment: 0 },
      { id: 'a', segment: 1 },
    ])
  })

  it('rejects duplicate ids and non-finite ranks', () => {
    expect(() => allocateDust(null, [cand('a'), cand('a')], 4)).toThrow(/duplicate/)
    expect(() => allocateDust(null, [cand('a', Number.NaN)], 4)).toThrow(RangeError)
  })

  it('fills the whole budget without collisions', () => {
    const cs = Array.from({ length: DUST_BUDGET_SEGMENTS + 100 }, (_, i) => cand(`id${i}`, i % 7, i % 13 === 0, i))
    const { allocation } = allocateDust(null, cs, DUST_BUDGET_SEGMENTS)
    expect(allocation.segmentOf.size).toBe(DUST_BUDGET_SEGMENTS)
    expect(new Set(allocation.segmentOf.values()).size).toBe(DUST_BUDGET_SEGMENTS)
    expect(allocation.used).toBe(DUST_BUDGET_SEGMENTS)
    // Every memory candidate is funded.
    for (let i = 0; i < cs.length; i += 13) expect(allocation.segmentOf.has(`id${i}`)).toBe(true)
  })
})
