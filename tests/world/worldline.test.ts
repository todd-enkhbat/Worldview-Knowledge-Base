import { describe, expect, it } from 'vitest'
import { AutonavRide } from '../../src/world/worldline/autonav.ts'
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
    expect(p.y).toBeGreaterThan(0) // time runs up the curve
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
    // Cruise ≤ maxSpeed (14 u/s): the damped target moves well under 1 u per frame.
    expect(maxStep).toBeLessThan(0.5)
  })

  it('slows near memories and eases in at the start', () => {
    const ride = new AutonavRide()
    const atKnot = ride.speedAt(path, path.knotArc[3], 10)
    const between = ride.speedAt(path, (path.knotArc[3] + path.knotArc[4]) / 2, 10)
    expect(atKnot).toBeLessThan(between)
    expect(ride.speedAt(path, (path.knotArc[3] + path.knotArc[4]) / 2, 0)).toBeLessThan(between)
  })
})
