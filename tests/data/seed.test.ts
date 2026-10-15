import { describe, expect, it } from 'vitest'
import { hashRecords } from '../../src/data/hash.ts'
import { DEMO_SIZE, buildDemoWorld, seededUuid } from '../../src/data/seed/demo.ts'
import { MS_PER_YEAR, SIGMA } from '../../src/domain/constants.ts'
import { anchorY } from '../../src/domain/placement.ts'
import { yOf } from '../../src/domain/time.ts'
import { ARCHETYPES } from '../../src/domain/types.ts'
import type { NodeRecord } from '../../src/domain/types.ts'
import { validateNode } from '../../src/domain/validate.ts'

const T0 = Date.UTC(1990, 4, 17)
const NOW = Date.UTC(2026, 9, 14, 12)

function minPairDistance(records: NodeRecord[], t0: number): number {
  let min = Infinity
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const a = records[i]
      const b = records[j]
      const d = Math.hypot(
        a.anchorXZ[0] - b.anchorXZ[0],
        anchorY(a, { T0: t0 }) - anchorY(b, { T0: t0 }),
        a.anchorXZ[1] - b.anchorXZ[1],
      )
      min = Math.min(min, d)
    }
  }
  return min
}

describe('demo seed', () => {
  const world = buildDemoWorld(T0, NOW)

  it('has ~30 records spanning all six archetypes', () => {
    expect(world.length).toBe(DEMO_SIZE)
    expect(world.length).toBeGreaterThanOrEqual(28)
    for (const a of ARCHETYPES) expect(world.some((r) => r.archetype === a), a).toBe(true)
    expect(world.filter((r) => r.archetype === 'demon')).toHaveLength(2)
    for (const d of world.filter((r) => r.archetype === 'demon')) expect(d.demon?.query.length).toBeGreaterThan(0)
    for (const e of world.filter((r) => r.archetype === 'entity')) expect(e.entity?.kind).toBeDefined()
    expect(world.some((r) => r.splat)).toBe(false)
  })

  it('every record passes validateNode with σ separation', () => {
    for (const r of world) {
      const v = validateNode(r, { settings: { T0 }, now: NOW, others: world })
      expect(v.errors, `${r.title}: ${JSON.stringify(v.errors)}`).toEqual([])
      expect(v.ok).toBe(true)
    }
    expect(minPairDistance(world, T0)).toBeGreaterThanOrEqual(SIGMA)
    expect(new Set(world.map((r) => r.slug)).size).toBe(world.length)
  })

  it('dates are biographical (≤ now, two future plans ≤ now + 5 y) with display-only historical references', () => {
    const future = world.filter((r) => r.temporalOrigin > NOW)
    expect(future.length).toBe(2)
    for (const r of future) expect(r.temporalOrigin).toBeLessThanOrEqual(NOW + 5 * MS_PER_YEAR)
    for (const r of world) expect(r.temporalOrigin).toBeGreaterThanOrEqual(T0)
    const ref = (title: string) => new Date(world.find((r) => r.title === title)!.referenceDate!.epochMs).getUTCFullYear()
    expect(ref("Maxwell's demon")).toBe(1867)
    expect(ref("Boltzmann's H-theorem")).toBe(1872)
    expect(ref("Loschmidt's reversibility paradox")).toBe(1876)
    expect(ref('Shannon entropy')).toBe(1948)
    expect(ref("Landauer's principle")).toBe(1961)
    expect(ref("Bennett's exorcism of the demon")).toBe(1982)
    // Layout ignores referenceDate: Y comes from the biographical date only.
    for (const r of world) expect(yOf(r.temporalOrigin, T0)).toBeGreaterThanOrEqual(0)
  })

  it('links resolve inside the demo world', () => {
    const ids = new Set(world.map((r) => r.id))
    const links = world.flatMap((r) => r.links)
    expect(links.length).toBeGreaterThanOrEqual(5)
    for (const l of links) expect(ids.has(l.targetId)).toBe(true)
  })

  it('is deterministic for a given T0 and reproducible ids are uuid-shaped', async () => {
    const again = buildDemoWorld(T0, NOW)
    expect(again).toEqual(world)
    expect(await hashRecords(again)).toBe(await hashRecords(world))
    for (const r of world) expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(seededUuid('x')).toBe(seededUuid('x'))
    const other = buildDemoWorld(T0 + 86_400_000, NOW)
    expect(other[0].id).not.toBe(world[0].id)
  })

  it('compresses into a young world instead of piling up at now', () => {
    const youngT0 = NOW - 3 * MS_PER_YEAR
    const young = buildDemoWorld(youngT0, NOW)
    for (const r of young) {
      const v = validateNode(r, { settings: { T0: youngT0 }, now: NOW, others: young })
      expect(v.errors, r.title).toEqual([])
    }
    const past = young.filter((r) => r.temporalOrigin <= NOW).map((r) => r.temporalOrigin)
    expect(new Set(past).size).toBeGreaterThan(past.length / 2)
    expect(minPairDistance(young, youngT0)).toBeGreaterThanOrEqual(SIGMA)
  })

  it('places around an existing world without collisions', () => {
    const base = buildDemoWorld(T0, NOW)
    const existing = base.map((r) => ({ id: `x-${r.id}`, anchorXZ: r.anchorXZ, y: anchorY(r, { T0 }) }))
    const second = buildDemoWorld(T0 + 1, NOW, { existing, existingSlugs: base.map((r) => r.slug) })
    const all = [...base, ...second]
    expect(minPairDistance(all, T0)).toBeGreaterThanOrEqual(SIGMA - 1e-6)
    expect(new Set(all.map((r) => r.slug)).size).toBe(all.length)
  })
})
