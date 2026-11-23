import { describe, expect, it } from 'vitest'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import { computeSpatialWorld } from '../../src/domain/spatial.ts'
import { MS_PER_YEAR } from '../../src/domain/constants.ts'
import { buildSpatialGround, groundYAt, groundBirthPhase } from '../../src/world/environment/knowledgeGround.ts'

const T0 = Date.UTC(2000, 0, 1)
describe('spatial neighborhood ground', () => {
  it('grounds actual semantic clusters and preserves saved pins without a time-height axis', () => {
    const a = makeNodeDraft('idea', { id: 'a', tags: ['Science'], fieldAnchorXZ: [24, 30], temporalOrigin: T0 })
    const b = makeNodeDraft('memory', { id: 'b', tags: ['Science'], temporalOrigin: T0 + 20 * MS_PER_YEAR })
    const world = computeSpatialWorld([a, b])
    const plan = buildSpatialGround(world, [a, b])
    expect(plan.districts).toHaveLength(1)
    expect(plan.districts[0].count).toBe(2)
    expect(plan.districts[0].memberIds.sort()).toEqual(['a', 'b'])
    expect(groundYAt(plan, 24, 30)).toBeGreaterThan(0)
    expect(groundYAt(plan, plan.districts[0].x, plan.districts[0].z)).toBe(plan.districts[0].height)
    const redated = [a, b].map((n) => ({ ...n, temporalOrigin: n.temporalOrigin + 5 * MS_PER_YEAR }))
    const next = buildSpatialGround(computeSpatialWorld(redated), redated)
    expect(next.districts).toEqual(plan.districts)
    expect(world.positions.get(a.id)?.slice(0, 3).filter((_, i) => i !== 1)).toEqual([24, 30])
  })
  it('builds a walkable connecting ramp only for real inter-cluster links', () => {
    const a = makeNodeDraft('idea', { id: 'science', tags: ['science'], links: [{ targetId: 'design', kind: 'relates', createdAt: T0 }] })
    const b = makeNodeDraft('document', { id: 'design', tags: ['design'], links: [{ targetId: 'science', kind: 'supports', createdAt: T0 }] })
    const records = [a, b]
    const world = computeSpatialWorld(records)
    const plan = buildSpatialGround(world, records)
    expect(plan.corridors).toHaveLength(1)
    const corridor = plan.corridors[0]
    expect(corridor.count).toBe(1)
    const x = (corridor.ax + corridor.bx) / 2, z = (corridor.az + corridor.bz) / 2
    expect(groundYAt(plan, x, z)).toBeGreaterThan(0)
    for (let i = 1; i <= 20; i++) {
      const p = i / 20, before = (i - 1) / 20
      const y = groundYAt(plan, corridor.ax + (corridor.bx - corridor.ax) * p, corridor.az + (corridor.bz - corridor.az) * p)
      const previous = groundYAt(plan, corridor.ax + (corridor.bx - corridor.ax) * before, corridor.az + (corridor.bz - corridor.az) * before)
      const horizontalStep = Math.hypot(corridor.bx - corridor.ax, corridor.bz - corridor.az) / 20
      expect(Math.abs(y - previous) / horizontalStep).toBeLessThan(1)
    }
    expect(buildSpatialGround(world, records.map((n) => ({ ...n, links: [] }))).corridors).toEqual([])
  })
  it('adds no neighborhood, corridor or raised ground to an empty world', () => {
    const plan = buildSpatialGround(computeSpatialWorld([]))
    expect(plan.districts).toEqual([])
    expect(plan.corridors).toEqual([])
    expect(groundYAt(plan, 0, 0)).toBe(0)
    expect(groundYAt(plan, 2000, 2000)).toBe(0)
  })
  it('keeps the walkable datum low while data volumes retain their own height', () => {
    const note = makeNodeDraft('idea', { id: 'elevated-note', tags: ['phenomenology'] })
    const world = computeSpatialWorld([note])
    const plan = buildSpatialGround(world, [note])
    const district = plan.districts[0]
    const minY = Math.min(...district.memberIds.map((id) => world.positions.get(id)![1]))
    expect(district.height).toBe(Math.max(0, Math.min(10, minY - 12, 2 + Math.log2(district.count + 1) * 1.2)))
    expect(district.height).toBeGreaterThan(0)
    expect(district.height).toBeLessThanOrEqual(10)
    expect(district.radius).toBeGreaterThanOrEqual(72)
    expect(district.outerRadius / district.radius).toBeCloseTo(2.2)
    expect(groundYAt(plan, district.x + district.radius * .85, district.z)).toBeCloseTo(district.height)
    const shoulder = groundYAt(plan, district.x + district.radius * 1.5, district.z)
    expect(shoulder).toBeGreaterThan(0)
    expect(shoulder).toBeLessThan(district.height)
    expect(groundYAt(plan, district.x + district.outerRadius, district.z)).toBeCloseTo(0)
    const raised = { ...world, positions: new Map([...world.positions].map(([id, point]) => [id, [point[0], point[1] + 600, point[2]] as [number, number, number]])), clusters: world.clusters.map((cluster) => ({ ...cluster, center: [cluster.center[0], cluster.center[1] + 600, cluster.center[2]] as [number, number, number] })) }
    expect(buildSpatialGround(raised, [note]).districts[0].height).toBe(district.height)
  })
  it('only emits birth ripples for actual events in the selected time window', () => {
    const note = makeNodeDraft('idea', { temporalOrigin: T0 })
    expect(groundBirthPhase(note, T0 - 1)).toBeNull()
    expect(groundBirthPhase(note, T0 + .4 * MS_PER_YEAR)).toBeCloseTo(.5)
    expect(groundBirthPhase(note, T0 + 2 * MS_PER_YEAR)).toBeNull()
    expect(groundBirthPhase({ ...note, deletedAt: T0 }, T0 + .4 * MS_PER_YEAR)).toBeNull()
  })
  it('keeps overlapping neighborhoods within the low datum budget', () => {
    const note = makeNodeDraft('idea', { id: 'source', tags: ['source'] })
    const base = buildSpatialGround(computeSpatialWorld([note]), [note])
    const district = base.districts[0]
    const plan = { ...base, districts: Array.from({ length: 20 }, (_, i) => ({ ...district, id: String(i), x: 0, z: 0, height: 10 })), corridors: [] }
    expect(groundYAt(plan, 0, 0)).toBeLessThanOrEqual(12)
    expect(groundYAt(plan, 2000, 2000)).toBe(0)
  })
  it('joins overlapping raised neighborhoods without a sharp normal seam', () => {
    const note = makeNodeDraft('idea', { id: 'source', tags: ['source'] })
    const base = buildSpatialGround(computeSpatialWorld([note]), [note])
    const district = base.districts[0]
    const plan = { ...base, districts: [
      { ...district, id: 'left', x: -90, z: 0, height: 4 },
      { ...district, id: 'right', x: 90, z: 0, height: 4 },
    ], corridors: [] }
    const step = .02, middle = groundYAt(plan, 0, 0)
    const leftSlope = (middle - groundYAt(plan, -step, 0)) / step
    const rightSlope = (groundYAt(plan, step, 0) - middle) / step
    expect(Math.abs(leftSlope - rightSlope)).toBeLessThan(.03)
    expect(groundYAt(plan, 2000, 2000)).toBe(0)
  })
})
