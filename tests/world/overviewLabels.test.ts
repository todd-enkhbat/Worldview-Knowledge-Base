import { describe, expect, it } from 'vitest'
import { overviewLabelIds, type OverviewLabelCandidate } from '../../src/world/nodes/ScreenLabels.tsx'

const candidate = (id: string, clusterId: string, priority: number, extra: Partial<OverviewLabelCandidate> = {}): OverviewLabelCandidate =>
  ({ id, clusterId, priority, distance: 1000, pinned: false, ...extra })

describe('overview record labels', () => {
  it('caps ordinary distant labels and prevents a dense topic from consuming the budget', () => {
    const dense = Array.from({ length: 15 }, (_, i) => candidate(`dense-${i}`, 'physics', 100 - i))
    const allowed = overviewLabelIds([...dense, candidate('art', 'art', 20), candidate('memory', 'memory', 10), candidate('other', 'other', 1)])
    expect([...allowed]).toEqual(['dense-0', 'art', 'memory'])
  })

  it('preserves selected, hovered and close-up records without using the distant budget', () => {
    const close = Array.from({ length: 8 }, (_, i) => candidate(`near-${i}`, 'physics', 0, { distance: 100 }))
    const allowed = overviewLabelIds([
      ...close,
      candidate('selected', 'physics', 1e6, { pinned: true }),
      candidate('hovered', 'physics', 5e5, { pinned: true }),
      candidate('ordinary-a', 'physics', 3), candidate('ordinary-b', 'art', 2), candidate('ordinary-c', 'memory', 1),
    ])
    expect(allowed.size).toBe(13)
    for (const record of close) expect(allowed.has(record.id)).toBe(true)
    expect(allowed.has('selected')).toBe(true)
    expect(allowed.has('hovered')).toBe(true)
    expect(allowed.has('ordinary-c')).toBe(true)
  })

  it('makes stable choices when candidate order changes and priorities tie', () => {
    const records = [candidate('b', 'physics', 3), candidate('a', 'physics', 3), candidate('c', 'art', 2)]
    expect([...overviewLabelIds(records)]).toEqual([...overviewLabelIds([...records].reverse())])
    expect([...overviewLabelIds(records)]).toEqual(['a', 'c'])
  })

  it('retains visible representatives when camera distance changes their priority', () => {
    const previous = new Set(['current'])
    expect([...overviewLabelIds([candidate('closer', 'physics', 100), candidate('current', 'physics', 90)], 3, previous)]).toEqual(['current'])
    expect([...overviewLabelIds([candidate('closer', 'physics', 100)], 3, previous)]).toEqual(['closer'])
  })

  it('leaves only selected and hovered records during the automatic orbit', () => {
    const records = [candidate('near', 'physics', 100, { distance: 30 }), candidate('far', 'memory', 90), candidate('selected', 'physics', 1e6, { pinned: true }), candidate('hovered', 'art', 5e5, { pinned: true })]
    expect([...overviewLabelIds(records, 3, new Set(['far']), true)]).toEqual(['selected', 'hovered'])
    expect(overviewLabelIds(records).has('near')).toBe(true)
  })
})
