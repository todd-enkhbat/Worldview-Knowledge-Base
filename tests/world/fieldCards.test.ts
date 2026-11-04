import { describe, expect, it } from 'vitest'
import { cardOffset, currentGrainsPerLink } from '../../src/world/field/FieldLayer.tsx'

describe('field cards and currents', () => {
  it('centres a strip of cards on the note', () => {
    expect(cardOffset(0, 1)).toBe(0)
    expect(cardOffset(0, 3)).toBeCloseTo(-1.08)
    expect(cardOffset(2, 3)).toBeCloseTo(1.08)
    expect(cardOffset(0, 2) + cardOffset(1, 2)).toBeCloseTo(0)
  })

  it('thins each current in big worlds so the total stays bounded', () => {
    expect(currentGrainsPerLink(10)).toBe(40)
    expect(currentGrainsPerLink(1500)).toBe(40)
    expect(currentGrainsPerLink(3000)).toBe(20)
    expect(currentGrainsPerLink(3000) * 3000).toBeLessThanOrEqual(60_000)
    expect(currentGrainsPerLink(100_000)).toBe(8)
  })
})
