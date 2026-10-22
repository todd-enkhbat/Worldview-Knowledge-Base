import { describe, expect, it } from 'vitest'
import { MS_PER_YEAR, STEPS_PER_YEAR } from '../../src/domain/constants.ts'
import { labelStride, ringYears, yearOf, yearTicks } from '../../src/world/time/timeScale.ts'

const NOW = Date.UTC(2026, 9, 21)
const settings = { T0: NOW - 30 * MS_PER_YEAR, stepsPerYear: STEPS_PER_YEAR }

describe('year rings share the Timeline ticks (RD4)', () => {
  it('rings sit on exactly the years the Timeline ticks', () => {
    expect(ringYears(settings, NOW)).toEqual(yearTicks(settings, NOW).map((t) => t.year))
  })

  it('names the calendar year in UTC', () => {
    expect(yearOf(Date.UTC(2001, 0, 1))).toBe(2001)
    expect(yearOf(Date.UTC(2000, 11, 31, 23, 59))).toBe(2000)
  })
})

describe('labelStride', () => {
  it('prints every year when rings are far apart, thins them as they crowd', () => {
    expect(labelStride(40)).toBe(1)
    expect(labelStride(15)).toBe(2)
    expect(labelStride(5)).toBe(5)
    expect(labelStride(1)).toBe(25)
    expect(labelStride(0)).toBe(100)
  })
})

describe('nearestOnAxis', () => {
  it('picks the closest tick within tolerance', async () => {
    const { nearestOnAxis } = await import('../../src/world/time/timeScale.ts')
    expect(nearestOnAxis([0.1, 0.5, 0.52], 0.515, 0.01)).toBe(2)
    expect(nearestOnAxis([0.1, 0.5], 0.3, 0.01)).toBe(-1)
  })
})
