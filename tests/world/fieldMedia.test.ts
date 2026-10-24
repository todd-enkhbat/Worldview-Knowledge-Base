import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '../../src/domain/types.ts'
import { sceneReveal } from '../../src/world/field/FieldMedia.tsx'

describe('scenes in the field', () => {
  const scene = { id: 's', splat: { proxyAssetId: 'p' } } as unknown as NodeRecord
  const plain = { id: 'p' } as unknown as NodeRecord

  it('thins a scene note’s cloud as you approach, and leaves other notes alone', () => {
    expect(sceneReveal(scene, 500)).toBe(0)
    expect(sceneReveal(scene, 100)).toBeGreaterThan(0)
    expect(sceneReveal(scene, 10)).toBeCloseTo(0.85, 5)
    expect(sceneReveal(plain, 10)).toBe(0)
  })
})
