import { BufferAttribute } from 'three'
import { describe, expect, it } from 'vitest'
import { WorldlinePath } from '../../src/world/worldline/path.ts'
import { RibbonBuffers } from '../../src/world/worldline/ribbon.ts'

function setKnots(path: WorldlinePath, coordinates: number[], born: number[] = coordinates.map(() => 1)) {
  const count = coordinates.length / 3
  path.set(coordinates, born, count, Array.from({ length: count }, (_, i) => `memory-${i}`))
}

describe('worldline ribbon lifecycle', () => {
  it('supports repeated empty updates before the first memory exists', () => {
    const buffers = new RibbonBuffers()
    const path = new WorldlinePath()
    expect(buffers.geometry.drawRange.count).toBe(0)
    for (let i = 0; i < 5; i++) {
      setKnots(path, [])
      expect(() => buffers.update(path)).not.toThrow()
      expect(buffers.geometry.drawRange.count).toBe(0)
    }
    expect(buffers.geometry.getAttribute('position')).toBeUndefined()
    buffers.dispose()
  })

  it('builds complete memory data after an empty start and removes old draws when the route becomes empty', () => {
    const buffers = new RibbonBuffers()
    const path = new WorldlinePath()
    setKnots(path, [])
    buffers.update(path)
    setKnots(path, [2, 7, 9], [1])
    buffers.update(path)
    expect(Array.from((buffers.geometry.getAttribute('position') as BufferAttribute).array.slice(0, 6))).toEqual([2, 7, 9, 2, 7, 9])
    expect(buffers.geometry.drawRange.count).toBe(0)
    setKnots(path, [2, 7, 9, 12, 17, 19], [1, 0])
    buffers.update(path)
    expect(buffers.geometry.drawRange.count).toBe(6 * (path.count - 1))
    const born = buffers.geometry.getAttribute('aBorn') as BufferAttribute
    expect(born.getX(0)).toBe(1)
    expect(born.getX(2 * (path.count - 1))).toBe(0)
    setKnots(path, [])
    buffers.update(path)
    expect(buffers.geometry.drawRange.count).toBe(0)
    setKnots(path, [30, 40, 50, 60, 70, 80], [1, 1])
    buffers.update(path)
    expect(Array.from((buffers.geometry.getAttribute('position') as BufferAttribute).array.slice(0, 3))).toEqual([30, 40, 50])
    buffers.dispose()
  })

  it('reuses retained CPU data after disposal and rebuilds a fresh mount without losing the path', () => {
    const path = new WorldlinePath()
    setKnots(path, [3, 9, 12, 18, 27, 36], [1, 0])
    const buffers = new RibbonBuffers()
    buffers.update(path)
    const expected = (buffers.geometry.getAttribute('position') as BufferAttribute).array.slice()
    buffers.dispose()
    buffers.dispose()
    expect(() => buffers.update(path)).not.toThrow()
    expect((buffers.geometry.getAttribute('position') as BufferAttribute).array).toEqual(expected)
    const remounted = new RibbonBuffers()
    remounted.update(path)
    expect((remounted.geometry.getAttribute('position') as BufferAttribute).array).toEqual(expected)
    expect(remounted.geometry.drawRange.count).toBe(buffers.geometry.drawRange.count)
    buffers.dispose(); remounted.dispose()
  })

  it('rebuilds when the path identity changes even if both paths have the same local version', () => {
    const first = new WorldlinePath(), second = new WorldlinePath()
    setKnots(first, [1, 2, 3, 4, 5, 6], [1, 1])
    setKnots(second, [9, 8, 7, 6, 5, 4], [0, 1])
    expect(first.version).toBe(second.version)
    const buffers = new RibbonBuffers()
    buffers.update(first)
    buffers.update(second)
    expect(Array.from((buffers.geometry.getAttribute('position') as BufferAttribute).array.slice(0, 3))).toEqual([9, 8, 7])
    buffers.dispose()
  })
})
