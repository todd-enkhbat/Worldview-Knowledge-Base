export type GlobeView = { lat: number; lon: number }
export const rad = Math.PI / 180
const within = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))
export const wrapLongitude = (value: number) => ((value + 180) % 360 + 360) % 360 - 180
export const normalizedView = (lat: number, lon: number): GlobeView => ({ lat: within(lat, -90, 90), lon: wrapLongitude(lon) })

/** Orthographic coordinates on a unit sphere. Positive z faces the viewer. */
export function globeProjection(view: GlobeView) {
  const c = Math.cos(view.lat * rad), s = Math.sin(view.lat * rad)
  return (lat: number, lon: number) => {
    const phi = lat * rad, delta = (lon - view.lon) * rad
    const horizontal = Math.cos(phi) * Math.cos(delta)
    return { x: Math.cos(phi) * Math.sin(delta), y: s * horizontal - c * Math.sin(phi), z: s * Math.sin(phi) + c * horizontal }
  }
}

/** Inverse projection for a visible pixel (x right, y down, z outward).
 * The same projection is shared by coastlines, the graticule and saved places. */
export function globeTextureIndex(x: number, y: number, z: number, c: number, s: number, centerLon: number, width: number, height: number) {
  const lon = Math.atan2(x, z * c + y * s) / rad + centerLon
  const lat = Math.asin(within(z * s - y * c, -1, 1)) / rad
  const u = Math.floor((wrapLongitude(lon) + 180) / 360 * width)
  const v = Math.min(height - 1, Math.floor((90 - lat) / 180 * height))
  return v * width + u
}
