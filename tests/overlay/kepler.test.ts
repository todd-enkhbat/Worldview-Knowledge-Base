import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '../../src/domain/types.ts'
import { KEPLER, entityOrbits, keplerPeriod, linkedIds, orbitOffset, satelliteSystems } from '../../src/overlay/kepler.ts'

const T = Date.UTC(2026, 0, 1)

function rec(id: string, p: Partial<NodeRecord> = {}): NodeRecord {
  return {
    id,
    slug: id,
    archetype: 'idea',
    title: id,
    contentMd: '',
    tags: [],
    temporalOrigin: T,
    temporalPrecision: 'day',
    referenceDate: null,
    thermo: { mass: 1, temperature: 0.5 },
    anchorXZ: [0, 0],
    links: [],
    attachments: [],
    visibility: 'private',
    createdAt: T,
    updatedAt: T,
    deletedAt: null,
    schemaVersion: 1,
    ...p,
  }
}

const link = (targetId: string) => ({ targetId, kind: 'relates' as const, createdAt: T })
const att = (id: string) => ({ id, kind: 'image' as const, name: id, mime: 'image/png', bytes: 1, blobId: id, createdAt: T })

describe('kepler satellites', () => {
  it('obeys T² ∝ a³', () => {
    const r = (keplerPeriod(4 * KEPLER.A0) / keplerPeriod(KEPLER.A0)) ** 2
    expect(r).toBeCloseTo(64, 9)
    for (const a of [1, 2.5, 7]) expect(keplerPeriod(a) ** 2 / a ** 3).toBeCloseTo(KEPLER.T0_S ** 2 / KEPLER.A0 ** 3, 9)
  })

  it('orbits attachments then linked nodes (both directions), live only', () => {
    const e = rec('e', { archetype: 'entity', links: [link('b'), link('gone')], attachments: [att('img1')] })
    const nodes = new Map([e, rec('a', { links: [link('e')] }), rec('b'), rec('c')].map((n) => [n.id, n]))
    expect(linkedIds(e, nodes)).toEqual(['a', 'b'])
    const orbits = entityOrbits(e, nodes)
    expect(orbits.map((o) => [o.kind, o.id])).toEqual([
      ['card', 'img1'],
      ['glyph', 'a'],
      ['glyph', 'b'],
    ])
    expect(orbits[1].a).toBeGreaterThan(orbits[0].a)
    expect(orbits[2].periodS).toBeGreaterThan(orbits[1].periodS)
    expect([...satelliteSystems(nodes).keys()]).toEqual(['e'])
  })

  it('moves satellites on circles of radius a and period T; real nodes are untouched', () => {
    const e = rec('e', { archetype: 'entity', attachments: [att('x')] })
    const nodes = new Map([[e.id, e]])
    const before = structuredClone(e)
    const [o] = entityOrbits(e, nodes)
    const p = orbitOffset(o, 3.7, { x: 0, y: 0, z: 0 })
    expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(o.a, 9)
    expect(Math.abs(p.y)).toBeLessThanOrEqual(o.a * Math.sin(KEPLER.INCLINATION) + 1e-9)
    const q = orbitOffset(o, 3.7 + o.periodS, { x: 0, y: 0, z: 0 })
    expect(q.x).toBeCloseTo(p.x, 9)
    expect(q.y).toBeCloseTo(p.y, 9)
    expect(q.z).toBeCloseTo(p.z, 9)
    expect(e).toEqual(before)
  })
})
