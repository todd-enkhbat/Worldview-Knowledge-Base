import { describe, expect, it } from 'vitest'
import { DWELL_MS, DwellTracker } from '../../src/world/overlays/useDwell.ts'

describe('dwell tracker', () => {
  it('logs one dwell per visit after 1 s of attention', () => {
    const d = new DwellTracker()
    expect(d.update(['a'], 0)).toEqual([])
    expect(d.update(['a'], DWELL_MS - 1)).toEqual([])
    expect(d.update(['a'], DWELL_MS)).toEqual(['a'])
    expect(d.update(['a'], 10 * DWELL_MS)).toEqual([])
    // Leaving ends the visit; the next one can dwell again.
    expect(d.update([], 11 * DWELL_MS)).toEqual([])
    expect(d.update(['a'], 12 * DWELL_MS)).toEqual([])
    expect(d.update(['a'], 13 * DWELL_MS)).toEqual(['a'])
  })

  it('counts near-then-selected as one visit and short glances as none', () => {
    const d = new DwellTracker()
    d.update(['a'], 0)
    expect(d.update(['b'], 500)).toEqual([])
    expect(d.update(['b', 'a'], 600)).toEqual([])
    expect(d.update(['a'], 1700)).toEqual(['a'])
    expect(d.update(['a', 'c'], 1800)).toEqual([])
  })
})
