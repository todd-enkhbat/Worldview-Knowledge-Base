import { describe, expect, it } from 'vitest'
import { chooseDistrictLabels, type DistrictLabelCandidate } from '../../src/world/environment/districtLabels.ts'

const district = (id: string, count: number, x: number, y = 250): DistrictLabelCandidate => ({ id, count, x, y })

describe('stable neighborhood names', () => {
  it('prioritizes the largest real districts within a small separated budget', () => {
    const candidates = [district('small', 2, 200), district('large', 10, 215), district('second', 8, 450), district('third', 5, 700), district('fourth', 4, 950)]
    expect(chooseDistrictLabels(candidates, new Set(), 3)).toEqual(['large', 'second', 'third'])
    expect(chooseDistrictLabels(candidates, new Set(), 2)).toEqual(['large', 'second'])
  })

  it('keeps current readable names until they leave view, then admits another district', () => {
    const current = district('current', 4, 210)
    const candidates = [district('new', 12, 220), current, district('other', 3, 500)]
    expect(chooseDistrictLabels(candidates, new Set(['current', 'other']), 2)).toEqual(['current', 'other'])
    expect(chooseDistrictLabels(candidates.filter((candidate) => candidate.id !== 'current'), new Set(['current', 'other']), 2)).toEqual(['other', 'new'])
  })
})
