import { describe, expect, it } from 'vitest'
import { AutonavRide, navigationPointAt } from '../../src/world/worldline/autonav.ts'
import { WorldlinePath, catmullRom, knotsFromPoses, memoryOrder, sampleCount } from '../../src/world/worldline/path.ts'
import type { NodeRecord } from '../../src/domain/types.ts'

const PER = 16

function knotsOf(list: [number, number, number][]): Float64Array {
  return Float64Array.from(list.flat())
}

describe('catmullRom (centripetal)', () => {
  it('passes through every knot exactly and has the documented sample count', () => {
    const k = knotsOf([
      [0, 0, 0],
      [5, 12, 1],
      [5.2, 12.5, 1.1],
      [-8, 40, 3],
      [2, 41, -6],
    ])
    const out = catmullRom(k, 5, PER)
    expect(out.length).toBe(3 * sampleCount(5, PER))
    for (let i = 0; i < 5; i++) {
      for (let a = 0; a < 3; a++) expect(out[3 * i * PER + a]).toBeCloseTo(k[3 * i + a], 5)
    }
  })

  it('stays finite on coincident knots and does not overshoot a short hop', () => {
    const k = knotsOf([
      [0, 0, 0],
      [0, 0, 0],
      [10, 0, 0],
      [10.01, 0, 0],
      [20, 0, 0],
    ])
    const out = catmullRom(k, 5, PER)
    for (const v of out) expect(Number.isFinite(v)).toBe(true)
    // Collinear knots: the centripetal curve stays on the line and inside the hull.
    for (let i = 0; i < out.length / 3; i++) {
      expect(Math.abs(out[3 * i + 1])).toBeLessThan(1e-4)
      expect(out[3 * i]).toBeGreaterThanOrEqual(-1e-4)
      expect(out[3 * i]).toBeLessThanOrEqual(20 + 1e-4)
    }
  })
})

describe('WorldlinePath', () => {
  const path = new WorldlinePath()
  const k = knotsOf([
    [0, 0, 0],
    [3, 12, 4],
    [-6, 30, 2],
  ])
  path.set(k, [1, 1, 0], 3, ['a', 'b', 'c'], PER)

  it('has monotone arc length ending at the curve length', () => {
    for (let i = 1; i < path.count; i++) expect(path.arc[i]).toBeGreaterThanOrEqual(path.arc[i - 1])
    expect(path.arc[path.count - 1]).toBeCloseTo(path.length, 5)
    // Longer than the chords, but not wildly (no loops).
    const chords = Math.hypot(3, 12, 4) + Math.hypot(9, 18, 2)
    expect(path.length).toBeGreaterThanOrEqual(chords - 1e-6)
    expect(path.length).toBeLessThan(1.2 * chords)
  })

  it('maps arc length to points and tangents, clamped at the ends', () => {
    const p = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z } }
    path.pointAt(-5, p)
    expect([p.x, p.y, p.z]).toEqual([0, 0, 0])
    path.pointAt(path.length + 5, p)
    expect(p.x).toBeCloseTo(-6, 5)
    expect(p.y).toBeCloseTo(30, 5)
    path.pointAt(path.knotArc[1], p)
    expect(p.x).toBeCloseTo(3, 4)
    expect(p.y).toBeCloseTo(12, 4)
    path.tangentAt(path.length / 2, p)
    expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(1, 6)
    expect(p.y).toBeGreaterThan(0) // this spatial fixture rises along Y
  })

  it('interpolates the born weight between knots (future stretch fades)', () => {
    expect(path.born[0]).toBe(1)
    expect(path.born[PER]).toBe(1)
    expect(path.born[path.count - 1]).toBe(0)
    expect(path.born[PER + PER / 2]).toBeCloseTo(0.5, 6)
  })
})

describe('memoryOrder / knotsFromPoses', () => {
  const rec = (id: string, archetype: NodeRecord['archetype'], t: number, deleted = false) =>
    ({ id, archetype, temporalOrigin: t, deletedAt: deleted ? 1 : null }) as unknown as NodeRecord

  it('keeps live memories in date order, ties by id', () => {
    const ids = memoryOrder([rec('c', 'memory', 5), rec('a', 'memory', 5), rec('x', 'idea', 1), rec('b', 'memory', 1), rec('d', 'memory', 0, true)])
    expect(ids).toEqual(['b', 'a', 'c'])
  })

  it('reads poses by row and skips ids missing from the table', () => {
    const table = {
      index: new Map([
        ['b', 1],
        ['a', 0],
      ]),
      pos: Float32Array.from([1, 2, 3, 4, 5, 6]),
      born: Uint8Array.from([1, 0]),
    }
    const pts = new Float64Array(9)
    const born = new Float32Array(3)
    const ids: string[] = []
    const n = knotsFromPoses(['b', 'zz', 'a'], table, pts, born, ids)
    expect(n).toBe(2)
    expect(ids).toEqual(['b', 'a'])
    expect(Array.from(pts.slice(0, 6))).toEqual([4, 5, 6, 1, 2, 3])
    expect(Array.from(born.slice(0, 2))).toEqual([0, 1])
  })
})

describe('AutonavRide', () => {
  const path = new WorldlinePath()
  const pts: [number, number, number][] = []
  for (let i = 0; i < 8; i++) pts.push([10 * Math.cos(i), 12 * i, 10 * Math.sin(i)])
  path.set(knotsOf(pts), new Array(8).fill(1), 8, pts.map((_, i) => `m${i}`), PER)

  it('rides from the first memory to the last and stops there', () => {
    const ride = new AutonavRide()
    ride.prime({ x: 50, y: 50, z: 50 }, { x: 0, y: 0, z: 0 })
    let frames = 0
    while (ride.update(1 / 60, path) && frames < 60 * 600) frames++
    expect(ride.done).toBe(true)
    expect(ride.s).toBeCloseTo(path.length, 6)
    const seconds = frames / 60
    // Sized to the curve: neither a blink nor a marathon.
    expect(seconds).toBeGreaterThan(10)
    expect(seconds).toBeLessThan(400)
  })

  it('is gentle: the look target never jumps more than the damping allows', () => {
    const ride = new AutonavRide()
    ride.update(1 / 60, path)
    let prev = { ...ride.look }
    let maxStep = 0
    for (let f = 0; f < 600; f++) {
      ride.update(1 / 60, path)
      maxStep = Math.max(maxStep, Math.hypot(ride.look.x - prev.x, ride.look.y - prev.y, ride.look.z - prev.z))
      prev = { ...ride.look }
    }
    // This compact route cruises near the minimum speed; damping prevents frame-sized jumps.
    expect(maxStep).toBeLessThan(0.5)
  })

  it('slows near memories and eases in at the start', () => {
    const ride = new AutonavRide()
    const atKnot = ride.speedAt(path, path.knotArc[3], 10)
    const between = ride.speedAt(path, (path.knotArc[3] + path.knotArc[4]) / 2, 10)
    expect(atKnot).toBeLessThan(between)
    expect(ride.speedAt(path, (path.knotArc[3] + path.knotArc[4]) / 2, 0)).toBeLessThan(between)
  })

  it('permits an origin-crossing memory route without modifying true knots or adding a central exclusion zone', () => {
    const crossing = new WorldlinePath()
    const knots = knotsOf([[-80, 35, 0], [0, 35, 0], [80, 35, 0]])
    crossing.set(knots, [1, 1, 1], 3, ['first', 'second', 'third'])
    const original = crossing.samples.slice()
    const guide = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z } }
    navigationPointAt(crossing, crossing.knotArc[1]!, 500, 0, guide)
    expect([guide.x, guide.y, guide.z]).toEqual([0, 35, 0])
    navigationPointAt(crossing, crossing.knotArc[1]!, 500, 4.5, guide)
    expect(Math.hypot(guide.x, guide.z)).toBeCloseTo(4.5, 5)
    expect(guide.y).toBe(35)
    expect(crossing.samples).toEqual(original)
    expect(crossing.knotIds).toEqual(['first', 'second', 'third'])
    for (let i = 0; i < 3; i++) {
      crossing.pointAt(crossing.knotArc[i]!, guide)
      expect([guide.x, guide.y, guide.z]).toEqual(Array.from(knots.subarray(i * 3, i * 3 + 3)))
    }
  })

  it('follows translated spatial routes without origin bias or reverse-facing view snaps', () => {
    const base = new WorldlinePath(), translated = new WorldlinePath()
    base.set(knotsOf([[-80, 35, 0], [0, 35, 0], [80, 35, 0]]), [1, 1, 1], 3, ['a', 'b', 'c'])
    translated.set(knotsOf([[170, 35, -180], [250, 35, -180], [330, 35, -180]]), [1, 1, 1], 3, ['a', 'b', 'c'])
    const original = base.samples.slice()
    const ride = new AutonavRide({ minSpeed: 10, maxSpeed: 10 })
    const shiftedRide = new AutonavRide({ minSpeed: 10, maxSpeed: 10 })
    ride.prime({ x: -90, y: 44, z: 7 }, { x: -65, y: 35, z: 0 })
    shiftedRide.prime({ x: 160, y: 44, z: -173 }, { x: 185, y: 35, z: -180 })
    let previousView = { x: ride.look.x - ride.camera.x, y: ride.look.y - ride.camera.y, z: ride.look.z - ride.camera.z }
    let nearestOrigin = Infinity
    for (let frame = 0; frame < 1800; frame++) {
      ride.update(1 / 60, base)
      shiftedRide.update(1 / 60, translated)
      nearestOrigin = Math.min(nearestOrigin, Math.hypot(ride.camera.x, ride.camera.z))
      for (const key of ['camera', 'look'] as const) {
        expect(shiftedRide[key].x - ride[key].x).toBeCloseTo(250, 4)
        expect(shiftedRide[key].y - ride[key].y).toBeCloseTo(0, 4)
        expect(shiftedRide[key].z - ride[key].z).toBeCloseTo(-180, 4)
      }
      const view = { x: ride.look.x - ride.camera.x, y: ride.look.y - ride.camera.y, z: ride.look.z - ride.camera.z }
      const length = Math.hypot(view.x, view.y, view.z)
      expect(Number.isFinite(length)).toBe(true)
      expect(Math.hypot(view.x, view.z)).toBeGreaterThanOrEqual(2 - 1e-6)
      const dot = (previousView.x * view.x + previousView.y * view.y + previousView.z * view.z) / (Math.hypot(previousView.x, previousView.y, previousView.z) * length)
      expect(dot).toBeGreaterThan(.98)
      previousView = view
    }
    expect(nearestOrigin).toBeLessThan(10)
    expect(ride.done).toBe(true)
    expect(base.samples).toEqual(original)
  })

  it('keeps a finite horizontal view on a vertical spatial memory route', () => {
    const vertical = new WorldlinePath()
    vertical.set(knotsOf([[24, 20, 0], [24, 44, 0], [24, 68, 0]]), [1, 1, 1], 3, ['a', 'b', 'c'])
    const ride = new AutonavRide()
    let previousLookY = -Infinity
    for (let i = 0; i < 1000; i++) {
      ride.update(1 / 60, vertical)
      expect(Math.hypot(ride.look.x - ride.camera.x, ride.look.z - ride.camera.z)).toBeGreaterThanOrEqual(2 - 1e-6)
      expect(ride.look.y).toBeGreaterThanOrEqual(previousLookY)
      previousLookY = ride.look.y
    }
  })
})
