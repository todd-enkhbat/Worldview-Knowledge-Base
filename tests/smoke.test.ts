import { describe, expect, it } from 'vitest'
import { birthStep, epochAtY, yOf } from '../src/domain/time.ts'
import { MS_PER_YEAR } from '../src/domain/constants.ts'

describe('time ↔ Y', () => {
  it('maps one year to 12 u and 600 steps', () => {
    const T0 = Date.UTC(1990, 0, 1)
    expect(yOf(T0 + MS_PER_YEAR, T0)).toBeCloseTo(12, 9)
    expect(birthStep(T0 + MS_PER_YEAR, T0)).toBe(600)
    expect(epochAtY(24, T0)).toBeCloseTo(T0 + 2 * MS_PER_YEAR, 0)
  })
})
