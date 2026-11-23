import { describe, expect, it } from 'vitest'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import { computeSpatialWorld } from '../../src/domain/spatial.ts'
import { RUN_SPEED, WALK_SPEED, walkStep } from '../../src/world/camera/SpatialWalkRig.tsx'
import { buildSpatialGround, groundYAt } from '../../src/world/environment/knowledgeGround.ts'

const bounds = { min: [-100, 0, -100], max: [100, 100, 100] }
const flat = () => 4
const point = () => ({ x: 0, y: 4, z: 0 })

describe('spatial ground walking', () => {
  it('moves with view-relative WASD axes and normalizes diagonal input', () => {
    const forward = point(), diagonal = point(), backward = point(), right = point(), rotated = point()
    walkStep(forward, 1, 0, 0, .05, false, flat, bounds)
    walkStep(diagonal, 1, 1, 0, .05, false, flat, bounds)
    walkStep(backward, -1, 0, 0, .05, false, flat, bounds)
    walkStep(right, 0, 1, 0, .05, false, flat, bounds)
    walkStep(rotated, 1, 0, Math.PI / 2, .05, false, flat, bounds)
    const length = (p: ReturnType<typeof point>) => Math.hypot(p.x, p.z)
    expect(forward.z).toBeLessThan(0)
    expect(backward.z).toBeGreaterThan(0)
    expect(right.x).toBeGreaterThan(0)
    expect(rotated.x).toBeLessThan(0)
    expect(Math.abs(rotated.z)).toBeLessThan(1e-8)
    expect(diagonal.x).toBeGreaterThan(0)
    expect(diagonal.z).toBeLessThan(0)
    expect(length(diagonal)).toBeCloseTo(length(forward), 8)
    expect(length(forward)).toBeCloseTo(WALK_SPEED * .05, 8)
    const running = point()
    walkStep(running, 1, 1, 0, .05, true, flat, bounds)
    expect(length(running)).toBeCloseTo(RUN_SPEED * .05, 8)
  })

  it('keeps feet on the actual surface after constraining to the spatial walking margin', () => {
    const farBounds = { min: [500, 0, 400], max: [650, 120, 600] }
    const walker = { x: 1000, y: 900, z: -100 }
    const samples: [number, number][] = []
    const slope = (x: number, z: number) => { samples.push([x, z]); return 8 + (x - 500) * .03 + (z - 400) * .01 }
    walkStep(walker, 0, 0, 0, .05, false, slope, farBounds)
    expect(walker.x).toBe(715)
    expect(walker.z).toBe(335)
    expect(samples).toEqual([[walker.x, walker.z]])
    expect(walker.y).toBeCloseTo(13.8, 8)
  })

  it('limits a stalled frame and rejects negative elapsed time without teleporting', () => {
    const stalled = point(), regular = point(), reversed = point()
    walkStep(stalled, 1, 0, 0, 20, false, flat, bounds)
    walkStep(regular, 1, 0, 0, .1, false, flat, bounds)
    walkStep(reversed, 1, 0, 0, -1, false, flat, bounds)
    expect(stalled).toEqual(regular)
    expect(Math.hypot(stalled.x, stalled.z)).toBeCloseTo(WALK_SPEED * .1, 8)
    expect(reversed).toEqual(point())
  })

  it('walks the same real topic ground after changing only history dates', () => {
    const records = [
      makeNodeDraft('idea', { id: 'a', tags: ['science'], temporalOrigin: Date.UTC(2000, 0, 1) }),
      makeNodeDraft('memory', { id: 'b', tags: ['science'], temporalOrigin: Date.UTC(2020, 0, 1) }),
      makeNodeDraft('document', { id: 'c', tags: ['art'], temporalOrigin: Date.UTC(2025, 0, 1) }),
    ]
    const dated = records.map((r, i) => ({ ...r, temporalOrigin: Date.UTC(2080 + i, 0, 1) }))
    const follow = (source: typeof records) => {
      const world = computeSpatialWorld(source)
      const ground = buildSpatialGround(world, source)
      const start = world.positions.get('a')!
      const walker = { x: start[0], y: 0, z: start[2] }
      for (let i = 0; i < 40; i++) {
        walkStep(walker, 1, i % 2, .4, .05, i > 20, (x, z) => groundYAt(ground, x, z), world.bounds)
      }
      return walker
    }
    expect(follow(dated)).toEqual(follow(records))
  })
})
