import { fnv1a32 } from '../domain/placement.ts'
import type { NodeRecord } from '../domain/types.ts'

// Kepler satellites: an entity monolith's attachments (cards) and small glyphs of its linked
// nodes circle it on fixed orbits with Kepler's third law, T ∝ a^{3/2}. Satellites are
// decoration: real nodes never move. Orbits are a function of the records (phases and
// inclinations seeded from ids) and of wall-clock time.

export const KEPLER = {
  /** Innermost semi-major axis (world units): clear of the 3 u monolith's half-width. */
  A0: 2.4,
  /** Spacing between successive orbits. */
  DA: 0.7,
  /** Period of the innermost orbit, seconds. */
  T0_S: 20,
  /** Max inclination of an orbit plane, radians. */
  INCLINATION: 0.35,
  /** Satellites per entity (attachments first, then links). */
  MAX_PER_ENTITY: 24,
} as const

export interface Orbit {
  /** Attachment id ('card') or linked node id ('glyph'). */
  id: string
  kind: 'card' | 'glyph'
  /** Semi-major axis (circular orbit radius). */
  a: number
  periodS: number
  phase0: number
  incl: number
  /** Longitude of the ascending node. */
  node: number
}

/** T = T0·(a/A0)^{3/2}, i.e. T² ∝ a³. */
export function keplerPeriod(a: number): number {
  return KEPLER.T0_S * Math.pow(a / KEPLER.A0, 1.5)
}

function unit(h: number): number {
  return (h >>> 0) / 0x1_0000_0000
}

export function makeOrbit(id: string, kind: Orbit['kind'], k: number, salt: string): Orbit {
  const a = KEPLER.A0 + k * KEPLER.DA
  const h1 = fnv1a32(`${salt}:${id}:phase`)
  const h2 = fnv1a32(`${salt}:${id}:incl`)
  const h3 = fnv1a32(`${salt}:${id}:node`)
  return {
    id,
    kind,
    a,
    periodS: keplerPeriod(a),
    phase0: unit(h1) * 2 * Math.PI,
    incl: (unit(h2) * 2 - 1) * KEPLER.INCLINATION,
    node: unit(h3) * 2 * Math.PI,
  }
}

/** Ids of live nodes linked to or from `entity`, sorted. */
export function linkedIds(entity: NodeRecord, nodes: ReadonlyMap<string, NodeRecord>): string[] {
  const ids = new Set<string>()
  for (const l of entity.links) if (l.targetId !== entity.id && nodes.has(l.targetId)) ids.add(l.targetId)
  for (const n of nodes.values()) {
    if (n.id === entity.id) continue
    if (n.links.some((l) => l.targetId === entity.id)) ids.add(n.id)
  }
  return [...ids].sort()
}

/** The satellite system of one entity. */
export function entityOrbits(entity: NodeRecord, nodes: ReadonlyMap<string, NodeRecord>): Orbit[] {
  const out: Orbit[] = []
  for (const at of entity.attachments) {
    if (out.length >= KEPLER.MAX_PER_ENTITY) return out
    out.push(makeOrbit(at.id, 'card', out.length, entity.id))
  }
  for (const id of linkedIds(entity, nodes)) {
    if (out.length >= KEPLER.MAX_PER_ENTITY) break
    out.push(makeOrbit(id, 'glyph', out.length, entity.id))
  }
  return out
}

/** Every live entity with at least one satellite. */
export function satelliteSystems(nodes: ReadonlyMap<string, NodeRecord>): Map<string, Orbit[]> {
  const out = new Map<string, Orbit[]>()
  for (const n of nodes.values()) {
    if (n.archetype !== 'entity' || n.deletedAt !== null) continue
    const orbits = entityOrbits(n, nodes)
    if (orbits.length > 0) out.set(n.id, orbits)
  }
  return out
}

/** Offset of a satellite from its entity at wall-clock `tSec`, written into `out`. */
export function orbitOffset<T extends { x: number; y: number; z: number }>(o: Orbit, tSec: number, out: T): T {
  const th = o.phase0 + (2 * Math.PI * tSec) / o.periodS
  // In-plane circle, tilted by `incl` about the line of nodes at angle `node`.
  const px = o.a * Math.cos(th)
  const pz = o.a * Math.sin(th)
  const cn = Math.cos(o.node)
  const sn = Math.sin(o.node)
  // Rotate into the node frame (u along the line of nodes, v across it), tilt v, rotate back.
  const u = px * cn + pz * sn
  const v = -px * sn + pz * cn
  const vy = v * Math.sin(o.incl)
  const vh = v * Math.cos(o.incl)
  out.x = u * cn - vh * sn
  out.z = u * sn + vh * cn
  out.y = vy
  return out
}
