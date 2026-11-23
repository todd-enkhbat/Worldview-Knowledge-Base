import type { NodeRecord, Vec3 } from './types.ts'

/** Bump when anchor rules change so derived physics/checkpoint mappings cannot mix layouts. */
export const SPATIAL_LAYOUT_VERSION = 'semantic-volume-v2'

export interface SpatialBounds {
  min: Vec3
  max: Vec3
  center: Vec3
  radius: number
}
export interface SpatialCluster {
  id: string
  label: string
  memberIds: string[]
  count: number
  center: Vec3
  radius: number
  bounds: SpatialBounds
  tags: string[]
}
export interface SpatialWorld {
  version: string
  positions: Map<string, Vec3>
  clusterOf: Map<string, string>
  clusters: SpatialCluster[]
  bounds: SpatialBounds
}

const hash = (text: string): number => {
  let value = 0x811c9dc5
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 0x01000193)
  return value >>> 0
}
const unit = (id: string, salt: string) => {
  let value = hash(`${salt}:${id}`)
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d)
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b)
  return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff
}
const normalizedTag = (tag: string) => tag.trim().toLowerCase().replace(/\s+/g, ' ')
const displayTag = (tag: string) => tag.replace(/[-_]/g, ' ').replace(/^\p{L}/u, (c) => c.toUpperCase())

function clusterCenter(id: string): Vec3 {
  // Stable spatial addresses, independent of cluster enumeration. Adding an unrelated
  // neighborhood therefore cannot shift an existing place or its simulation anchors.
  const value = hash(`spatial:${id}`)
  return [
    ((value & 255) % 5 - 2) * 210 + (((value >>> 20) & 255) / 255 - 0.5) * 36,
    150 + unit(id, 'cluster-height') * 80,
    (((value >>> 8) & 255) % 5 - 2) * 210 + ((value >>> 24) / 255 - 0.5) * 36,
  ]
}

function memberOffset(id: string): Vec3 {
  const azimuth = unit(id, 'azimuth') * Math.PI * 2
  const elevation = unit(id, 'elevation') * 1.8 - 0.9
  const radius = 35 + 30 * unit(id, 'radius')
  // Vertical extent belongs to the actual shared anchors, not a renderer-only lift.
  // Keep whole molecular packets above the datum while making each topic a deep volume.
  const height = 60 + 40 * unit(id, 'height')
  const flat = Math.sqrt(1 - elevation * elevation)
  return [Math.cos(azimuth) * flat * radius, elevation * height, Math.sin(azimuth) * flat * radius]
}

export function boundsOfPositions(positions: Iterable<readonly number[]>, padding = 8, includeGround = false): SpatialBounds {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  let count = 0
  for (const position of positions) {
    if (!position.every(Number.isFinite)) continue
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, position[axis]! - padding)
      max[axis] = Math.max(max[axis]!, position[axis]! + padding)
    }
    count++
  }
  if (!count) return { min: [-80, 0, -80], max: [80, 90, 80], center: [0, 45, 0], radius: Math.hypot(80, 45, 80) }
  if (includeGround) min[1] = Math.min(0, min[1])
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  return { min, max, center, radius: Math.hypot(max[0] - center[0], max[1] - center[1], max[2] - center[2]) }
}

/** Weighted graph distances, used only within a connected real-data component. */
function distances(seed: string, adjacency: ReadonlyMap<string, Map<string, number>>, allowed?: ReadonlySet<string>): Map<string, number> {
  const out = new Map([[seed, 0]])
  const queue = [seed]
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!
    const d = out.get(id)!
    for (const [neighbor, cost] of adjacency.get(id) ?? []) {
      if (allowed && !allowed.has(neighbor)) continue
      if (d + cost < (out.get(neighbor) ?? Infinity)) { out.set(neighbor, d + cost); queue.push(neighbor) }
    }
  }
  return out
}

/**
 * One pure shared layout for CPU physics, GPU dust, fallback poses, ground, cameras and UI.
 * Time is deliberately absent: dates control births, never XYZ. Primary tags seed real
 * neighborhoods; untagged notes inherit the nearest linked topic. Remaining graph components
 * use deterministic hub neighborhoods. Link affinity also shapes local 3-D constellations.
 */
export function computeSpatialWorld(input: Iterable<NodeRecord>): SpatialWorld {
  const records = [...input].filter((r) => r.deletedAt === null).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const byId = new Map(records.map((r) => [r.id, r]))
  const adjacency = new Map(records.map((r) => [r.id, new Map<string, number>()]))
  for (const record of records) for (const link of record.links ?? []) {
    if (!byId.has(link.targetId) || link.targetId === record.id) continue
    const cost = link.kind === 'relates' ? 2 : 1
    adjacency.get(record.id)!.set(link.targetId, Math.min(cost, adjacency.get(record.id)!.get(link.targetId) ?? Infinity))
    adjacency.get(link.targetId)!.set(record.id, Math.min(cost, adjacency.get(link.targetId)!.get(record.id) ?? Infinity))
  }
  const clusterOf = new Map<string, string>()
  const labels = new Map<string, string>()
  const tags = new Map<string, string>()
  const queue: { id: string; cluster: string; distance: number }[] = []
  const best = new Map<string, number>()
  const tagged = new Set<string>()
  for (const record of records) {
    const tag = record.tags?.map(normalizedTag).find(Boolean)
    if (!tag) continue
    const cluster = `tag:${tag}`
    clusterOf.set(record.id, cluster)
    tagged.add(record.id)
    labels.set(cluster, displayTag(tag))
    tags.set(cluster, tag)
    best.set(record.id, 0)
    queue.push({ id: record.id, cluster, distance: 0 })
  }
  // Multi-source propagation. Deterministic tie-breaking depends on topic id, never title/date.
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!
    if (best.get(current.id) !== current.distance || clusterOf.get(current.id) !== current.cluster) continue
    for (const [neighbor, cost] of adjacency.get(current.id) ?? []) {
      if (tagged.has(neighbor)) continue
      const distance = current.distance + cost
      const previous = best.get(neighbor) ?? Infinity
      if (distance < previous || distance === previous && current.cluster < (clusterOf.get(neighbor) ?? '\uffff')) {
        clusterOf.set(neighbor, current.cluster)
        best.set(neighbor, distance)
        queue.push({ id: neighbor, cluster: current.cluster, distance })
      }
    }
  }
  const remaining = new Set(records.filter((r) => !clusterOf.has(r.id)).map((r) => r.id))
  while (remaining.size) {
    const first = [...remaining].sort()[0]!
    const component = [...distances(first, adjacency, remaining).keys()].sort()
    component.forEach((id) => remaining.delete(id))
    const allowed = new Set(component)
    const ranked = [...component].sort((a, b) => (adjacency.get(b)?.size ?? 0) - (adjacency.get(a)?.size ?? 0) || (a < b ? -1 : 1))
    const hubs = [ranked[0]!]
    const maps = [distances(hubs[0]!, adjacency, allowed)]
    // Large untagged components get local graph neighborhoods, rather than a single ball.
    while (hubs.length < Math.ceil(component.length / 8)) {
      let chosen = '', farthest = -1
      for (const id of component) {
        if (hubs.includes(id)) continue
        const near = Math.min(...maps.map((map) => map.get(id) ?? Infinity))
        if (near > farthest) { chosen = id; farthest = near }
      }
      if (!chosen) break
      hubs.push(chosen)
      maps.push(distances(chosen, adjacency, allowed))
    }
    hubs.forEach((hub) => labels.set(`links:${hub}`, byId.get(hub)!.title?.trim() || byId.get(hub)!.archetype || 'Related notes'))
    for (const id of component) {
      let nearest = 0
      for (let i = 1; i < hubs.length; i++) {
        const a = maps[i]!.get(id) ?? Infinity, b = maps[nearest]!.get(id) ?? Infinity
        if (a < b || a === b && hubs[i]! < hubs[nearest]!) nearest = i
      }
      clusterOf.set(id, `links:${hubs[nearest]}`)
    }
  }
  const members = new Map<string, string[]>()
  for (const record of records) {
    const cluster = clusterOf.get(record.id)!
    const list = members.get(cluster) ?? []
    list.push(record.id)
    members.set(cluster, list)
  }
  const offsets = new Map(records.map((r) => [r.id, memberOffset(r.id)]))
  const positions = new Map<string, Vec3>()
  const clusters: SpatialCluster[] = []
  for (const id of [...members.keys()].sort()) {
    const memberIds = members.get(id)!
    const center = clusterCenter(id)
    for (const memberId of memberIds) {
      const record = byId.get(memberId)!
      const offset = offsets.get(memberId)!
      const neighbors = [...(adjacency.get(memberId)?.keys() ?? [])].filter((neighbor) => clusterOf.get(neighbor) === id).sort()
      const local: Vec3 = [...offset]
      if (neighbors.length) {
        for (let axis = 0; axis < 3; axis++) {
          const mean = neighbors.reduce((sum, neighbor) => sum + offsets.get(neighbor)![axis]!, 0) / neighbors.length
          // Links draw neighbors together without collapsing the neighborhood's depth.
          local[axis] = offset[axis]! * 0.82 + mean * 0.18
        }
      }
      const position: Vec3 = [center[0] + local[0], center[1] + local[1], center[2] + local[2]]
      // Explicit user pins retain their absolute XZ intent; vertical position remains semantic.
      if (record.fieldAnchorXZ?.every(Number.isFinite)) { position[0] = record.fieldAnchorXZ[0]; position[2] = record.fieldAnchorXZ[1] }
      positions.set(memberId, position)
    }
    const bounds = boundsOfPositions(memberIds.map((memberId) => positions.get(memberId)!), 8)
    let radius = 32
    for (const memberId of memberIds) {
      const p = positions.get(memberId)!
      radius = Math.max(radius, Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]) + 8)
    }
    clusters.push({ id, label: labels.get(id)!, memberIds, count: memberIds.length, center, radius, bounds, tags: tags.has(id) ? [tags.get(id)!] : [] })
  }
  return { version: SPATIAL_LAYOUT_VERSION, positions, clusterOf, clusters, bounds: boundsOfPositions(positions.values(), 10, true) }
}
