import { describe, expect, it } from 'vitest'
import { Vector3, PerspectiveCamera } from 'three'
import { computeSpatialWorld } from '../../src/domain/spatial.ts'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import { MS_PER_YEAR } from '../../src/domain/constants.ts'
import type { NodeRecord } from '../../src/domain/types.ts'
import { computeFieldLayout, fieldVerticalBounds, layoutBounds, spatialCameraShot, spatialWorldFor } from '../../src/world/field/layout.ts'

const T0 = Date.UTC(2000, 0, 1)
const settings = { T0, yPerYear: 12 }
const rec = (id: string, tags: string[] = [], year = 0): NodeRecord => makeNodeDraft('idea', { id, title: id, tags, temporalOrigin: T0 + year * MS_PER_YEAR })

describe('shared spatial field layout', () => {
  it('returns deterministic shared anchors regardless of input order or unrelated neighborhoods', () => {
    const records = [rec('a', ['physics']), rec('b', ['physics'])]
    const world = computeSpatialWorld(records)
    const first = computeFieldLayout({ records })
    const semantic = computeFieldLayout({ records: [...records].reverse(), vectors: new Map([['a', new Float32Array([1, 0])], ['b', new Float32Array([1, 0])]]), previous: new Map([['a', [999, 999]]]) })
    expect([...first]).toEqual([...semantic])
    expect(first.get('a')).toEqual([world.positions.get('a')![0], world.positions.get('a')![2]])
    const added = computeFieldLayout({ records: [...records, rec('c', ['art'])], previous: first })
    expect(added.get('a')).toEqual(first.get('a'))
    expect(layoutBounds(added).radius).toBeGreaterThanOrEqual(30)
    const nodes = new Map(records.map((r) => [r.id, r]))
    expect(spatialWorldFor(nodes)).toBe(spatialWorldFor(nodes))
  })

  it('honors explicit XZ pins across reload', () => {
    const a = { ...rec('a', ['physics']), fieldAnchorXZ: [120, -75] as [number, number] }
    const saved = JSON.parse(JSON.stringify([a])) as NodeRecord[]
    expect(computeFieldLayout({ records: saved }).get('a')).toEqual([120, -75])
    expect(computeFieldLayout({ records: [{ ...a, deletedAt: 1 }] }).size).toBe(0)
  })
})

describe('spatial full-scene framing', () => {
  it('uses real XYZ bounds independent of dates and T0', () => {
    const records = [rec('a', ['physics'], 10), rec('b', ['art'], 30)]
    const bounds = fieldVerticalBounds(records, settings)
    const changed = records.map((r) => ({ ...r, temporalOrigin: r.temporalOrigin + 20 * MS_PER_YEAR }))
    expect(fieldVerticalBounds(changed, { T0: T0 - 50 * MS_PER_YEAR, yPerYear: 200 })).toEqual(bounds)
    expect(bounds.minY).toBe(0)
    expect(bounds.maxY).toBeGreaterThan(40)
  })

  it('fits the real cluster extents and ground in portrait and landscape cameras', () => {
    const world = computeSpatialWorld([rec('a', ['physics']), rec('b', ['art'])])
    for (const aspect of [0.46, 1.5]) {
      const shot = spatialCameraShot(world, 50, aspect, 10000)
      const camera = new PerspectiveCamera(50, aspect, 0.1, 20000)
      camera.position.set(...shot.position)
      camera.lookAt(...shot.target)
      camera.updateMatrixWorld()
      for (const x of [world.bounds.min[0], world.bounds.max[0]]) for (const z of [world.bounds.min[2], world.bounds.max[2]]) for (const y of [0, world.bounds.max[1]]) {
        const projected = new Vector3(x, y, z).project(camera)
        expect(Math.abs(projected.x)).toBeLessThan(1)
        expect(Math.abs(projected.y)).toBeLessThan(1)
      }
    }
    const shot = spatialCameraShot(world, 50, 0.46, 100)
    expect(Math.hypot(...shot.position.map((p, i) => p - shot.target[i]!))).toBeCloseTo(100)
  })
})
