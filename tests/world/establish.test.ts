import { describe, expect, it } from 'vitest'
import { MS_PER_YEAR, Y_PER_YEAR } from '../../src/domain/constants.ts'
import type { NodeRecord } from '../../src/domain/types.ts'
import { establishingShot } from '../../src/world/camera/establish.ts'

const T0 = Date.UTC(1990, 0, 1)
const settings = { T0, yPerYear: Y_PER_YEAR }

function node(id: string, years: number, r: number, deletedAt: number | null = null): NodeRecord {
  return { id, temporalOrigin: T0 + years * MS_PER_YEAR, anchorXZ: [r, 0], deletedAt } as unknown as NodeRecord
}

const halfV = Math.tan((50 * Math.PI) / 360)

describe('establishingShot', () => {
  it('is null for an empty (or all-trashed) world', () => {
    expect(establishingShot([], settings, 50, 4 / 3, 800)).toBeNull()
    expect(establishingShot([node('a', 3, 30, 1)], settings, 50, 4 / 3, 800)).toBeNull()
  })

  it('aims at the middle of the populated band and fits it in the frame', () => {
    const nodes = Array.from({ length: 21 }, (_, i) => node(`n${i}`, 10 + i, 22 + (i % 5) * 7))
    const shot = establishingShot(nodes, settings, 50, 4 / 3, 800)!
    // The 10–90 % band of years 10..30 is years 12..28.
    const yMid = ((12 + 28) / 2) * Y_PER_YEAR
    expect(shot.target[0]).toBe(0)
    expect(shot.target[2]).toBe(0)
    expect(shot.target[1]).toBeCloseTo(yMid, 6)
    const d = Math.hypot(shot.position[0], shot.position[1] - shot.target[1], shot.position[2])
    // The band (16 years) fits vertically, and the camera looks down on it.
    expect(16 * Y_PER_YEAR).toBeLessThan(2 * d * halfV)
    expect(shot.position[1]).toBeGreaterThan(shot.target[1])
  })

  it('ignores outliers beyond the 10–90 % band and respects the distance cap', () => {
    const nodes = [...Array.from({ length: 20 }, (_, i) => node(`n${i}`, 20 + i * 0.1, 30)), node('far', 200, 30)]
    const shot = establishingShot(nodes, settings, 50, 4 / 3, 800)!
    expect(shot.target[1]).toBeLessThan(25 * Y_PER_YEAR)
    const capped = establishingShot(nodes, settings, 50, 4 / 3, 50)!
    expect(Math.hypot(capped.position[0], capped.position[1] - capped.target[1], capped.position[2])).toBeCloseTo(50, 6)
  })
})
