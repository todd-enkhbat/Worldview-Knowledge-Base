import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '../../src/domain/types.ts'
import { nearness, sceneReveal } from '../../src/world/field/FieldMedia.tsx'

describe('scenes in the field', () => {
  const scene = { id: 's', splat: { proxyAssetId: 'p' } } as unknown as NodeRecord
  const plain = { id: 'p' } as unknown as NodeRecord

  it('clears a scene note’s cloud as you approach, and leaves other notes alone', () => {
    expect(sceneReveal(scene, 500)).toBe(0)
    expect(sceneReveal(scene, 100)).toBeGreaterThan(0)
    expect(sceneReveal(scene, 10)).toBe(1)
    expect(sceneReveal(plain, 10)).toBe(0)
  })

  it('brings a scene in smoothly with distance', () => {
    expect(nearness(500)).toBe(0)
    expect(nearness(10)).toBe(1)
    const mid = [60, 90, 120].map(nearness)
    expect(mid[0]).toBeGreaterThan(mid[1])
    expect(mid[1]).toBeGreaterThan(mid[2])
  })
})
