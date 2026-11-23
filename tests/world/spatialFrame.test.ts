import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import { boundsOfPositions, type SpatialBounds } from '../../src/domain/spatial.ts'
import { spatialShot } from '../../src/world/camera/spatialFrame.ts'

function cameraFor(bounds: SpatialBounds, fov: number, aspect: number) {
  const shot = spatialShot(bounds, fov, aspect, 10000)
  const camera = new PerspectiveCamera(fov, aspect, .1, 20000)
  camera.position.set(...shot.position)
  camera.lookAt(...shot.target)
  camera.updateMatrixWorld()
  return { shot, camera }
}

describe('spatial full-world framing', () => {
  it('fits the actual 3D region corners and their ground in portrait and landscape', () => {
    const fixtures = [
      boundsOfPositions([[-480, 18, -330], [430, 140, 410]], 0),
      boundsOfPositions([[260, 45, -350], [780, 170, -80]], 0),
      boundsOfPositions([[240, 55, -105], [290, 90, -65]], 0),
      boundsOfPositions([[-480, 60, -330], [430, 330, 480]], 0),
    ]
    for (const bounds of fixtures) for (const fov of [40, 65]) for (const aspect of [.4, 1.6]) {
      const { camera } = cameraFor(bounds, fov, aspect)
      for (const x of [bounds.min[0], bounds.max[0]])
        for (const y of [0, bounds.min[1], bounds.max[1]])
          for (const z of [bounds.min[2], bounds.max[2]]) {
            const projected = new Vector3(x, y, z).project(camera)
            expect(Math.abs(projected.x)).toBeLessThan(1)
            expect(Math.abs(projected.y)).toBeLessThan(1)
            expect(projected.z).toBeGreaterThan(-1)
            expect(projected.z).toBeLessThan(1)
          }
    }
  })

  it('centers on translated neighborhoods rather than the world origin', () => {
    const first = boundsOfPositions([[-120, 35, -80], [100, 160, 180]], 0)
    const translated = boundsOfPositions([[880, 35, -680], [1100, 160, -420]], 0)
    const a = spatialShot(first, 50, 1.5, 10000)
    const b = spatialShot(translated, 50, 1.5, 10000)
    for (const key of ['target', 'position'] as const) {
      expect(b[key][0] - a[key][0]).toBeCloseTo(1000, 6)
      expect(b[key][1] - a[key][1]).toBeCloseTo(0, 6)
      expect(b[key][2] - a[key][2]).toBeCloseTo(-600, 6)
    }
    expect(b.target[0]).toBeGreaterThan(800)
    expect(b.target[2]).toBeLessThan(-400)
  })

  it('backs farther away for a narrow viewport and respects an explicit distance cap', () => {
    const bounds = boundsOfPositions([[-450, 30, -200], [450, 140, 200]], 0)
    const distance = (shot: ReturnType<typeof spatialShot>) => new Vector3(...shot.position).distanceTo(new Vector3(...shot.target))
    const portrait = spatialShot(bounds, 50, .4, 10000)
    const landscape = spatialShot(bounds, 50, 1.6, 10000)
    expect(distance(portrait)).toBeGreaterThan(distance(landscape))
    const capped = spatialShot(bounds, 50, .4, 250)
    expect(distance(capped)).toBeCloseTo(250, 6)
    expect(capped.target).toEqual(portrait.target)
  })
})
