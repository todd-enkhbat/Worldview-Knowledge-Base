import { beforeEach, describe, expect, it } from 'vitest'
import { MS_PER_YEAR } from '../../src/domain/constants.ts'
import type { NodeRecord } from '../../src/domain/types.ts'
import { getPoseTable } from '../../src/world/poses.ts'
import { getFieldFrame, resetField, updateField } from '../../src/world/field/runtime.ts'

const T = Date.UTC(2015, 0, 1)
const rec = (id: string, years: number, anchor: [number, number], links: string[] = []): NodeRecord =>
  ({
    id,
    temporalOrigin: T + years * MS_PER_YEAR,
    anchorXZ: anchor,
    tags: [],
    links: links.map((t) => ({ targetId: t, kind: 'supports', createdAt: 0 })),
    thermo: { mass: 1, temperature: 0.3 },
    deletedAt: null,
  }) as unknown as NodeRecord

describe('field runtime', () => {
  beforeEach(() => resetField())

  it('writes the shared pose table: born notes sit on the land, unborn ones are flagged', () => {
    const nodes = new Map([rec('a', 0, [20, 0], ['b']), rec('b', 2, [-20, 0]), rec('c', 9, [0, 30])].map((r) => [r.id, r]))
    updateField(nodes, null, T + 5 * MS_PER_YEAR, 0)
    const table = getPoseTable()
    const row = (id: string) => table.index.get(id)!
    expect(table.born[row('a')]).toBe(1)
    expect(table.born[row('c')]).toBe(0)
    // Clouds float above the land, and the land has risen under them.
    expect(table.pos[row('a') * 3 + 1]).toBeGreaterThan(4)
    expect(getFieldFrame().heightfield.h.some((h) => h > 1)).toBe(true)
  })

  it('scrubbing back restores the exact same frame', () => {
    const nodes = new Map([rec('a', 0, [20, 0]), rec('b', 2, [-20, 0])].map((r) => [r.id, r]))
    updateField(nodes, null, T + 3 * MS_PER_YEAR, 0)
    const first = Float32Array.from(getFieldFrame().centers)
    updateField(nodes, null, T + 7 * MS_PER_YEAR, 1)
    updateField(nodes, null, T + 3 * MS_PER_YEAR, 2)
    expect(Array.from(getFieldFrame().centers)).toEqual(Array.from(first))
  })
})
