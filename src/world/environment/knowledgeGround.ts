import type { NodeRecord } from '../../domain/types.ts'
import type { SpatialWorld } from '../../domain/spatial.ts'
import { spatialWorldFor } from '../field/layout.ts'
import { MS_PER_YEAR } from '../../domain/constants.ts'

export interface GroundDistrict {
  id: string
  label: string
  memberIds: string[]
  count: number
  x: number
  z: number
  radius: number
  outerRadius: number
  height: number
  connections: number
}
export interface GroundCorridor {
  source: string
  target: string
  count: number
  ax: number
  az: number
  bx: number
  bz: number
  heightA: number
  heightB: number
  width: number
}
export interface SpatialGroundPlan {
  world: SpatialWorld
  districts: GroundDistrict[]
  corridors: GroundCorridor[]
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
}

/** Low, broad neighborhoods come only from the semantic clusters' actual members. */
export function buildSpatialGround(world: SpatialWorld, records: Iterable<NodeRecord> = []): SpatialGroundPlan {
  const districts = world.clusters.map((cluster): GroundDistrict => {
    let radius = 72, minY = Infinity
    for (const id of cluster.memberIds) {
      const point = world.positions.get(id)
      if (!point) continue
      radius = Math.max(radius, Math.hypot(point[0] - cluster.center[0], point[2] - cluster.center[2]) + 14)
      minY = Math.min(minY, point[1])
    }
    // Ground is a quiet walkable datum. The records own the spatial height; the floor
    // must not turn their volumes into raised, filled islands.
    const height = Math.max(0, Math.min(10, minY - 12, 2 + Math.log2(cluster.count + 1) * 1.2))
    return { id: cluster.id, label: cluster.label, memberIds: [...cluster.memberIds], count: cluster.count, x: cluster.center[0], z: cluster.center[2], radius, outerRadius: radius * 2.2, height, connections: 0 }
  }).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
  const byId = new Map(districts.map((d) => [d.id, d]))
  const recordsById = new Map([...records].filter((n) => n.deletedAt === null).map((n) => [n.id, n]))
  const links = new Set<string>()
  const corridorCounts = new Map<string, number>()
  for (const note of recordsById.values()) for (const link of note.links) {
    if (!recordsById.has(link.targetId) || link.targetId === note.id) continue
    const edge = [note.id, link.targetId].sort().join('\0')
    if (links.has(edge)) continue
    links.add(edge)
    const a = world.clusterOf.get(note.id), b = world.clusterOf.get(link.targetId)
    if (!a || !b) continue
    const da = byId.get(a), db = byId.get(b)
    if (da) da.connections++
    if (db && b !== a) db.connections++
    if (a !== b) { const key = [a, b].sort().join('\0'); corridorCounts.set(key, (corridorCounts.get(key) ?? 0) + 1) }
  }
  const corridors: GroundCorridor[] = []
  for (const [key, count] of corridorCounts) {
    const [source, target] = key.split('\0')
    const a = byId.get(source), b = byId.get(target)
    if (!a || !b) continue
    corridors.push({ source, target, count, ax: a.x, az: a.z, bx: b.x, bz: b.z, heightA: a.height, heightB: b.height, width: 8 + Math.min(12, Math.log2(count + 1) * 3) })
  }
  let minX = -80, maxX = 80, minZ = -80, maxZ = 80
  for (const d of districts) { minX = Math.min(minX, d.x - d.outerRadius - 12); maxX = Math.max(maxX, d.x + d.outerRadius + 12); minZ = Math.min(minZ, d.z - d.outerRadius - 12); maxZ = Math.max(maxZ, d.z + d.outerRadius + 12) }
  return { world, districts, corridors, bounds: { minX, maxX, minZ, maxZ } }
}

const smooth = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t) }

/** Round real overlapping surfaces without adding height where neither surface exists. */
function joinGround(a: number, b: number): number {
  const band = Math.min(4, 2 * Math.min(a, b))
  if (band < 1e-5) return Math.max(a, b)
  const mix = Math.max(0, 1 - Math.abs(a - b) / band)
  return Math.max(a, b) + mix * mix * band * .25
}

/** The same continuous surface is used by rendering, footprints, particles, and walking. */
export function groundYAt(plan: SpatialGroundPlan, x: number, z: number): number {
  let height = 0
  for (const district of plan.districts) {
    const d = Math.hypot(x - district.x, z - district.z) / district.radius
    height = joinGround(height, district.height * (1 - smooth((d - .9) / 1.3)))
  }
  for (const corridor of plan.corridors) {
    const dx = corridor.bx - corridor.ax, dz = corridor.bz - corridor.az
    const length2 = dx * dx + dz * dz
    const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - corridor.ax) * dx + (z - corridor.az) * dz) / length2)) : 0
    const distance = Math.hypot(x - corridor.ax - dx * t, z - corridor.az - dz * t)
    const center = corridor.heightA + (corridor.heightB - corridor.heightA) * smooth(t)
    height = joinGround(height, center * (1 - smooth(distance / (corridor.width * 1.7))))
  }
  return Math.min(12, height)
}

/** A wave is tied to a real birth in the selected history, never an ambient fake event. */
export function groundBirthPhase(record: Pick<NodeRecord, 'temporalOrigin' | 'deletedAt'>, epoch: number): number | null {
  if (record.deletedAt !== null) return null
  const progress = (epoch - record.temporalOrigin) / (.8 * MS_PER_YEAR)
  return progress >= 0 && progress < 1 ? progress : null
}

let cachedNodes: ReadonlyMap<string, NodeRecord> | null = null
let cached: SpatialGroundPlan | null = null
export function spatialGroundFor(nodes: ReadonlyMap<string, NodeRecord>): SpatialGroundPlan {
  if (nodes !== cachedNodes || !cached) {
    cachedNodes = nodes
    cached = buildSpatialGround(spatialWorldFor(nodes), nodes.values())
  }
  return cached
}
