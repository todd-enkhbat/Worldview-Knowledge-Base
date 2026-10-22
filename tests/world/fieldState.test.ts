import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '../../src/domain/types.ts'
import { activeRipples, buildHeightfield, noteState, sampleHeight, YEAR } from '../../src/world/field/state.ts'

const T = Date.UTC(2020, 0, 1)
const rec = (t = T, mass = 1) => ({ id: 'a', temporalOrigin: t, thermo: { mass, temperature: 0.3 } }) as unknown as NodeRecord

describe('field time', () => {
  it('is unborn before its date, condenses after, then loses order slowly', () => {
    expect(noteState(rec(), T - 1, 0).born).toBe(false)
    const newborn = noteState(rec(), T + 0.01 * YEAR, 0)
    const grown = noteState(rec(), T + 0.5 * YEAR, 0)
    const old = noteState(rec(), T + 20 * YEAR, 0)
    expect(newborn.condense).toBeLessThan(0.1)
    expect(newborn.sigma).toBeGreaterThan(grown.sigma)
    expect(grown.condense).toBe(1)
    expect(old.order).toBeLessThan(grown.order)
    expect(old.sigma).toBeGreaterThan(grown.sigma)
    // Links hold order.
    expect(noteState(rec(), T + 20 * YEAR, 6).order).toBeGreaterThan(old.order)
  })

  it('is a pure function of the playhead (scrub back = same state)', () => {
    const a = noteState(rec(), T + 3.3 * YEAR, 2)
    noteState(rec(), T + 9 * YEAR, 2)
    expect(noteState(rec(), T + 3.3 * YEAR, 2)).toEqual(a)
  })

  it('raises land where born notes are, and ripples outward from recent births', () => {
    const s = noteState(rec(), T + YEAR, 0)
    const hf = buildHeightfield([{ xz: [10, 0], state: s }], { cx: 0, cz: 0, half: 50 }, 64)
    expect(sampleHeight(hf, 10, 0)).toBeGreaterThan(sampleHeight(hf, 30, 0))
    expect(sampleHeight(hf, 10, 0)).toBeCloseTo(s.amp, 0)
    expect(activeRipples([{ rec: rec(), xz: [1, 2] }], T + 0.5 * YEAR)).toHaveLength(1)
    expect(activeRipples([{ rec: rec(), xz: [1, 2] }], T + 3 * YEAR)).toHaveLength(0)
  })
})

describe('attention', () => {
  it('a touch restores order, and only counts once the playhead reaches it', async () => {
    const { indexTouches, lastTouch, _setTouchesForTests } = await import('../../src/world/field/attention.ts')
    const r = rec()
    const touch = T + 15 * YEAR
    _setTouchesForTests([{ id: 'e', t: touch, kind: 'inspect', nodeId: 'a' }, { id: 'f', t: T + 2 * YEAR, kind: 'demon-match', nodeId: 'a' }])
    expect(lastTouch('a', T + 10 * YEAR)).toBe(-Infinity)
    expect(lastTouch('a', T + 16 * YEAR)).toBe(touch)
    const neglected = noteState(r, T + 16 * YEAR, 0, lastTouch('a', T + 10 * YEAR))
    const rehearsed = noteState(r, T + 16 * YEAR, 0, lastTouch('a', T + 16 * YEAR))
    expect(rehearsed.order).toBeGreaterThan(neglected.order)
    expect(rehearsed.sigma).toBeLessThan(neglected.sigma)
    expect(indexTouches([{ id: 'x', t: 5, kind: 'dwell', nodeId: 'b' }, { id: 'y', t: 1, kind: 'enter', nodeId: 'b' }]).get('b')).toEqual(Float64Array.from([1, 5]))
  })
})

describe('field entropy', () => {
  it('sums the born clouds and grows as they spread', async () => {
    const { fieldEntropy } = await import('../../src/world/field/state.ts')
    expect(fieldEntropy([1, 2], [0, 0])).toBeNull()
    const tight = fieldEntropy([1, 1], [1, 1])!
    const spread = fieldEntropy([2, 1], [1, 1])!
    expect(spread - tight).toBeCloseTo(3 * Math.log(2), 10)
  })
})
