import { describe, expect, it } from 'vitest'
import { compareMemoryOrder, memoryIndex, memoryLabel, memoryOrdinal, type MemoryOrderKey } from '../../src/domain/memoryIndex.ts'
import type { Archetype } from '../../src/domain/types.ts'

const node = (id: string, temporalOrigin: number, createdAt = 0, archetype: Archetype = 'memory', deletedAt: number | null = null): MemoryOrderKey => ({
  id,
  archetype,
  temporalOrigin,
  createdAt,
  deletedAt,
})

const asMap = (xs: MemoryOrderKey[]) => new Map(xs.map((x) => [x.id, x]))

describe('memoryIndex', () => {
  const nodes = [
    node('c', 300),
    node('idea', 50, 0, 'idea'),
    node('b-late', 200, 20),
    node('b-early', 200, 10),
    node('tie-z', 400, 5),
    node('tie-a', 400, 5),
    node('a', 100),
    node('gone', 1, 0, 'memory', 999),
  ]

  it('orders by temporalOrigin, then createdAt, then id', () => {
    const idx = memoryIndex(nodes)
    expect([...idx.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id)).toEqual(['a', 'b-early', 'b-late', 'c', 'tie-a', 'tie-z'])
  })

  it('skips other archetypes and trashed memories', () => {
    const idx = memoryIndex(nodes)
    expect(idx.has('idea')).toBe(false)
    expect(idx.has('gone')).toBe(false)
    expect(idx.size).toBe(6)
  })

  it('is independent of input order', () => {
    const forward = memoryIndex(nodes)
    const reversed = memoryIndex([...nodes].reverse())
    expect([...reversed.entries()].sort()).toEqual([...forward.entries()].sort())
  })

  it('agrees with memoryOrdinal for every node (plaque and Inspector use these)', () => {
    const idx = memoryIndex(nodes)
    const map = asMap(nodes)
    for (const n of nodes) expect(memoryOrdinal(map, n.id)).toBe(idx.get(n.id) ?? 0)
    expect(memoryOrdinal(map, 'missing')).toBe(0)
  })

  it('compareMemoryOrder is antisymmetric and zero only for the same key', () => {
    for (const a of nodes)
      for (const b of nodes) {
        const ab = compareMemoryOrder(a, b)
        expect(Math.sign(ab) + Math.sign(compareMemoryOrder(b, a))).toBe(0)
        if (a.id !== b.id) expect(ab).not.toBe(0)
      }
  })

  it('formats the shared label', () => {
    expect(memoryLabel(1)).toBe('MEMORY 001')
    expect(memoryLabel(42)).toBe('MEMORY 042')
    expect(memoryLabel(1234)).toBe('MEMORY 1234')
  })
})
