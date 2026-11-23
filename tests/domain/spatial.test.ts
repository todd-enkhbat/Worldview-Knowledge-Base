import { describe, expect, it } from 'vitest'
import { computeSpatialWorld } from '../../src/domain/spatial.ts'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import type { NodeRecord } from '../../src/domain/types.ts'

const rec = (id: string, tags: string[] = [], links: string[] = []): NodeRecord => makeNodeDraft('idea', {
  id, title: `Thought ${id}`, tags,
  links: links.map((targetId) => ({ targetId, kind: 'supports', createdAt: 1 })),
})

describe('semantic XYZ world, time as history', () => {
  const records = [
    ...Array.from({ length: 12 }, (_, i) => rec(`physics-${i}`, ['physics'], i ? ['physics-0'] : [])),
    ...Array.from({ length: 8 }, (_, i) => rec(`art-${i}`, ['art'])),
    rec('linked-source', [], ['physics-0']),
  ]

  it('creates real topic clusters and places linked untagged records with their source neighborhood', () => {
    const world = computeSpatialWorld(records)
    expect(world.clusters).toHaveLength(2)
    expect(world.clusterOf.get('linked-source')).toBe('tag:physics')
    expect(world.clusters.find((c) => c.id === 'tag:physics')).toMatchObject({ label: 'Physics', count: 13 })
    expect(world.positions.size).toBe(records.length)
    expect(world.clusters.reduce((n, c) => n + c.memberIds.length, 0)).toBe(records.length)
    const physics = world.clusters.find((c) => c.id === 'tag:physics')!
    const ys = physics.memberIds.map((id) => world.positions.get(id)![1])
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(20)
    expect(Math.hypot(...world.clusters[0]!.center.map((v, axis) => v - world.clusters[1]!.center[axis]!))).toBeGreaterThan(100)
  })

  it('preserves positions through input reordering, title/date edits, and unrelated new neighborhoods', () => {
    const before = computeSpatialWorld(records)
    expect([...computeSpatialWorld([...records].reverse()).positions]).toEqual([...before.positions])
    const edited = records.map((r) => ({ ...r, title: `Renamed ${r.id}`, temporalOrigin: r.temporalOrigin - 123456789000, updatedAt: r.updatedAt + 5000 }))
    expect([...computeSpatialWorld(edited).positions]).toEqual([...before.positions])
    const expanded = computeSpatialWorld([...edited, rec('new-place', ['travel']), rec('new-place2', ['travel'], ['new-place'])])
    for (const [id, position] of before.positions) expect(expanded.positions.get(id)).toEqual(position)
    expect(expanded.clusters.find((c) => c.id === 'tag:physics')!.center).toEqual(before.clusters.find((c) => c.id === 'tag:physics')!.center)
  })

  it('gives a linked topic substantial depth in all three dimensions, above the shared ground', () => {
    const notes = Array.from({ length: 48 }, (_, i) => rec(`volume-${i}`, ['physics'], i ? ['volume-0'] : []))
    const world = computeSpatialWorld(notes)
    const points = [...world.positions.values()]
    const span = [0, 1, 2].map((axis) => Math.max(...points.map((p) => p[axis]!)) - Math.min(...points.map((p) => p[axis]!)))
    expect(span[0]).toBeGreaterThan(75)
    expect(span[2]).toBeGreaterThan(75)
    expect(span[1]).toBeGreaterThan(120)
    const centerY = world.clusters[0]!.center[1]
    expect(centerY).toBeGreaterThanOrEqual(150)
    expect(centerY).toBeLessThanOrEqual(230)
    for (const point of points) expect(point[1]).toBeGreaterThanOrEqual(60)

    // A tilted plane can span XYZ too; its covariance determinant still has zero volume.
    const mean = [0, 1, 2].map((axis) => points.reduce((sum, p) => sum + p[axis]!, 0) / points.length)
    const covariance = [0, 1, 2].map((a) => [0, 1, 2].map((b) => points.reduce((sum, p) => sum + (p[a]! - mean[a]!) * (p[b]! - mean[b]!), 0) / points.length))
    const [a, b, c] = covariance as [[number, number, number], [number, number, number], [number, number, number]]
    const determinant = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
    expect(determinant / (a[0] * b[1] * c[2])).toBeGreaterThan(.6)
  })

  it('retains local graph affinity without flattening semantic altitude', () => {
    const a = rec('affinity-a', ['physics'])
    const b = rec('affinity-b', ['physics'])
    const apart = computeSpatialWorld([a, b])
    const linked = computeSpatialWorld([{ ...a, links: [{ targetId: b.id, kind: 'supports', createdAt: 1 }] }, b])
    const distance = (world: ReturnType<typeof computeSpatialWorld>) => Math.hypot(...world.positions.get(a.id)!.map((value, axis) => value - world.positions.get(b.id)![axis]!))
    expect(distance(linked)).toBeLessThan(distance(apart))
    expect(distance(linked)).toBeGreaterThan(distance(apart) * .6)
    expect(Math.abs(linked.positions.get(a.id)![1] - linked.positions.get(b.id)![1])).toBeGreaterThan(5)
  })

  it('uses graph neighborhoods for large untagged components rather than one global cloud', () => {
    const chain = Array.from({ length: 24 }, (_, i) => rec(`chain-${String(i).padStart(2, '0')}`, [], i ? [`chain-${String(i - 1).padStart(2, '0')}`] : []))
    const world = computeSpatialWorld(chain)
    expect(world.clusters).toHaveLength(3)
    expect(new Set(world.clusterOf.values()).size).toBe(3)
    expect(world.clusters.every((c) => c.memberIds.length > 0 && chain.some((r) => r.title === c.label))).toBe(true)
  })

  it('honors absolute XZ pins without binding semantic altitude to historical dates', () => {
    const before = computeSpatialWorld(records)
    const pinned = records.map((r) => r.id === 'physics-1' ? { ...r, fieldAnchorXZ: [123, -87] as [number, number] } : r)
    const after = computeSpatialWorld(pinned)
    expect(after.positions.get('physics-1')).toEqual([123, before.positions.get('physics-1')![1], -87])
    expect(records.find((r) => r.id === 'physics-1')!.fieldAnchorXZ).toBeUndefined()
  })

  it('has no fabricated clusters or records and excludes trash from spatial content', () => {
    expect(computeSpatialWorld([]).clusters).toEqual([])
    expect(computeSpatialWorld([]).positions.size).toBe(0)
    const deleted = { ...rec('deleted', ['physics']), deletedAt: 100 }
    expect(computeSpatialWorld([deleted]).positions.size).toBe(0)
    for (const p of computeSpatialWorld(records).positions.values()) expect(p.every(Number.isFinite)).toBe(true)
  })
})
