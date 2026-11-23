import { computeSpatialWorld, type SpatialWorld } from '../../domain/spatial.ts'
import type { NodeRecord, WorldSettings } from '../../domain/types.ts'

export type XZ = [number, number]
export interface VerticalBounds { minY: number; maxY: number; centerY: number }

export interface FieldLayoutInput {
  records: readonly NodeRecord[]
  /** Retained for callers doing semantic analysis; render placement never reruns a force layout. */
  vectors?: ReadonlyMap<string, Float32Array>
  previous?: ReadonlyMap<string, XZ>
}

/** The persisted semantic anchor, with an explicit user pin taking precedence in presentation. */
export function presentationAnchor(record: Pick<NodeRecord, 'anchorXZ' | 'fieldAnchorXZ'>): XZ {
  return [...(record.fieldAnchorXZ ?? record.anchorXZ)]
}

const worlds = new WeakMap<object, SpatialWorld>()

/** Cached shared model for immutable store Map snapshots. Never starts an embedding model. */
export function spatialWorldFor(nodes: ReadonlyMap<string, NodeRecord>): SpatialWorld {
  let world = worlds.get(nodes)
  if (!world) { world = computeSpatialWorld(nodes.values()); worlds.set(nodes, world) }
  return world
}

export function computeFieldLayout({ records }: FieldLayoutInput): Map<string, XZ> {
  return new Map([...computeSpatialWorld(records).positions].map(([id, p]) => [id, [p[0], p[2]]]))
}

/** Legacy spacing diagnostic; never used to rescale the displayed canonical world. */
export function spacingScale(x: ArrayLike<number>, z: ArrayLike<number>): number {
  if (x.length < 3) return 1
  const nearest: number[] = []
  const stride = Math.max(1, Math.floor(x.length / 400))
  for (let i = 0; i < x.length; i += stride) {
    let best = Infinity
    for (let j = 0; j < x.length; j++) if (i !== j) best = Math.min(best, Math.hypot(x[i]! - x[j]!, z[i]! - z[j]!))
    nearest.push(best)
  }
  nearest.sort((a, b) => a - b)
  const median = nearest[nearest.length >> 1]!
  return median > 0 && median < 18 ? 18 / median : 1
}

export function layoutBounds(layout: ReadonlyMap<string, XZ>): { cx: number; cz: number; radius: number } {
  if (!layout.size) return { cx: 0, cz: 0, radius: 40 }
  let cx = 0, cz = 0
  for (const [x, z] of layout.values()) { cx += x; cz += z }
  cx /= layout.size
  cz /= layout.size
  let radius = 0
  for (const [x, z] of layout.values()) radius = Math.max(radius, Math.hypot(x - cx, z - cz))
  return { cx, cz, radius: Math.max(30, radius) }
}

/** Legacy camera adapter: vertical bounds now come from semantic space, never dates. */
export function fieldVerticalBounds(records: Iterable<NodeRecord>, _settings?: Pick<WorldSettings, 'T0' | 'yPerYear'>, _nowMs?: number): VerticalBounds {
  const { min, max, center } = computeSpatialWorld(records).bounds
  return { minY: min[1], maxY: max[1], centerY: center[1] }
}

/** Frame all real cluster extents and their shared ground in a perspective camera. */
export function spatialCameraShot(world: SpatialWorld, vfovDeg: number, aspect: number, maxDistance: number) {
  const { bounds } = world
  const layout = new Map<string, XZ>([['min', [bounds.min[0], bounds.min[2]]], ['max', [bounds.max[0], bounds.max[2]]]])
  return fieldShot(layout, vfovDeg, aspect, maxDistance, { minY: bounds.min[1], maxY: bounds.max[1], centerY: bounds.center[1] })
}

/** Frame the canonical three-dimensional world, rather than aiming at a fixed shallow plane. */
export function fieldShot(
  layout: ReadonlyMap<string, XZ>, vfovDeg: number, aspect: number, maxDistance: number,
  vertical: VerticalBounds = { minY: 0, maxY: 0, centerY: 0 },
): { position: [number, number, number]; target: [number, number, number] } {
  const { cx, cz, radius } = layoutBounds(layout)
  const halfV = Math.tan(vfovDeg * Math.PI / 360)
  const elevation = 0.37
  const azimuth = 0.7
  const r = radius + 8
  const halfY = Math.max(6, (vertical.maxY - vertical.minY) / 2 + 6)
  const depth = r * Math.cos(elevation) + halfY * Math.sin(elevation)
  const projectedY = halfY * Math.cos(elevation) + r * Math.sin(elevation)
  const fit = Math.max(projectedY / halfV, r / (halfV * Math.max(0.1, aspect))) + depth
  const d = Math.min(maxDistance, Math.max(95, fit * 1.06))
  const target: [number, number, number] = [cx, vertical.centerY, cz]
  return {
    target,
    position: [cx + Math.cos(azimuth) * Math.cos(elevation) * d, vertical.centerY + Math.sin(elevation) * d, cz + Math.sin(azimuth) * Math.cos(elevation) * d],
  }
}
