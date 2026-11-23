import type { SpatialBounds } from '../../domain/spatial.ts'
import type { Vec3 } from '../../domain/types.ts'

/** Fit the actual 3D neighborhoods and their ground, with neither date height nor a tower pivot. */
export function spatialShot(bounds: SpatialBounds, fov: number, aspect: number, maxDistance: number): { position: Vec3; target: Vec3 } {
  const min: Vec3 = [bounds.min[0] - 28, Math.min(0, bounds.min[1] - 28), bounds.min[2] - 28]
  const max: Vec3 = [bounds.max[0] + 28, bounds.max[1] + 28, bounds.max[2] + 28]
  const target: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  // Look through the tall neighborhoods, rather than down onto their ground footprints.
  // This oblique direction separates the staggered topic addresses without flattening Y.
  const azimuth = 3.1, elevation = .52
  const dir: Vec3 = [Math.cos(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.sin(azimuth) * Math.cos(elevation)]
  const right: Vec3 = [Math.sin(azimuth), 0, -Math.cos(azimuth)]
  const up: Vec3 = [-Math.cos(azimuth) * Math.sin(elevation), Math.cos(elevation), -Math.sin(azimuth) * Math.sin(elevation)]
  const tan = Math.tan(fov * Math.PI / 360)
  let distance = 180
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
    const delta: Vec3 = [x - target[0], y - target[1], z - target[2]]
    const dot = (v: Vec3) => delta[0] * v[0] + delta[1] * v[1] + delta[2] * v[2]
    distance = Math.max(distance, dot(dir) + Math.abs(dot(right)) / (tan * Math.max(.1, aspect)), dot(dir) + Math.abs(dot(up)) / tan)
  }
  distance = Math.min(maxDistance, distance * 1.06)
  return { target, position: [target[0] + dir[0] * distance, target[1] + dir[1] * distance, target[2] + dir[2] * distance] }
}
