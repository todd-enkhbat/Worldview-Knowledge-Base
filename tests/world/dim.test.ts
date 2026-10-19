import { describe, expect, it } from 'vitest'
import { Color, MeshStandardMaterial } from 'three'
import { applyArchitectureDim } from '../../src/world/environment/dim.ts'

describe('applyArchitectureDim', () => {
  it('scales from the original colour, so repeated changes never compound', () => {
    const m = new MeshStandardMaterial({ color: new Color(0.8, 0.6, 0.4), envMapIntensity: 1.2 })
    applyArchitectureDim([m], 0.5)
    applyArchitectureDim([m], 0.5)
    expect(m.color.r).toBeCloseTo(0.4, 6)
    expect(m.envMapIntensity).toBeCloseTo(0.6, 6)
    applyArchitectureDim([m], 1)
    expect(m.color.g).toBeCloseTo(0.6, 6)
    expect(m.envMapIntensity).toBeCloseTo(1.2, 6)
  })
})
