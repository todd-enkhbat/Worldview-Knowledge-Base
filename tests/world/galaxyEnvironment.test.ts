import { describe, expect, it } from 'vitest'
import { advanceGalaxyTime, createParallaxStars } from '../../src/world/environment/GalaxyEnvironment.tsx'

describe('surrounding astronomical art', () => {
  it('surrounds the camera in every direction with a bounded far star volume', () => {
    const geometry = createParallaxStars()
    const positions = geometry.getAttribute('position')
    const octants = new Int32Array(8)
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i)
      const radius = Math.hypot(x, y, z)
      expect(radius).toBeGreaterThanOrEqual(899)
      expect(radius).toBeLessThanOrEqual(6201)
      octants[(x > 0 ? 1 : 0) | (y > 0 ? 2 : 0) | (z > 0 ? 4 : 0)]++
    }
    expect([...octants].every((count) => count > 300)).toBe(true)
    expect(geometry.getAttribute('aSize').count).toBe(positions.count)
    expect(geometry.getAttribute('aColor').count).toBe(positions.count)
    geometry.dispose()
  })
  it('freezes ambient motion with the flow control and resumes without a hidden-tab leap', () => {
    let time = advanceGalaxyTime(0, .05, true)
    expect(time).toBe(.05)
    time = advanceGalaxyTime(time, 25, false)
    expect(time).toBe(.05)
    time = advanceGalaxyTime(time, 25, true)
    expect(time).toBeCloseTo(.15)
    expect(advanceGalaxyTime(time, -1, true)).toBe(time)
  })

  it('reuses a stable star catalog rather than randomizing the surrounding field', () => {
    const first = createParallaxStars(), second = createParallaxStars()
    for (const attribute of ['position', 'aColor', 'aSize', 'aPhase']) expect(second.getAttribute(attribute).array).toEqual(first.getAttribute(attribute).array)
    first.dispose(); second.dispose()
  })
})
