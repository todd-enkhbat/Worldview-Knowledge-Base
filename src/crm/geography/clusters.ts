import type { City } from './places.ts'

export interface PlacePin { city: City; count: number }
export interface PlaceCluster { x: number; y: number; count: number; pins: PlacePin[] }
/** Keep markers anchored to observed cities, with enough on-screen separation for their buttons. */
export function clusterPlaces(pins: PlacePin[], width: number): PlaceCluster[] {
  const w = Math.max(120,width), h = w / 2, spacing = 34
  const buckets = new Map<string, PlaceCluster[]>(), result: PlaceCluster[] = []
  for (const pin of [...pins].sort((a,b) => b.count-a.count || a.city.lon-b.city.lon || a.city.lat-b.city.lat)) {
    const px = Math.max(15,Math.min(w - 15,(pin.city.lon + 180)/360*w))
    const py = Math.max(15,Math.min(h - 15,(90 - pin.city.lat)/180*h))
    const col = Math.floor(px / spacing), row = Math.floor(py / spacing)
    let nearest: PlaceCluster | undefined, best = spacing
    for (let x = col-1; x <= col+1; x++) for (let y = row-1; y <= row+1; y++) {
      for (const cluster of buckets.get(x+','+y) ?? []) {
        const distance = Math.hypot(cluster.x*w-px,cluster.y*h-py)
        if (distance < best) { nearest = cluster; best = distance }
      }
    }
    if (nearest) { nearest.pins.push(pin); nearest.count += pin.count; continue }
    const marker = {x:px/w,y:py/h,count:pin.count,pins:[pin]}
    const cell = col + ',' + row
    if (!buckets.has(cell)) buckets.set(cell,[])
    buckets.get(cell)!.push(marker); result.push(marker)
  }
  return result
}
