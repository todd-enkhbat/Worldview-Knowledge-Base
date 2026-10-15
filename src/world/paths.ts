import type { Vector3 } from 'three'
import { FUTURE_YEARS, HELIX_RADIUS, MS_PER_YEAR, Y_PER_YEAR } from '../domain/constants.ts'
import {
  CORE_RADIUS,
  HELIX_PHASE0,
  SPUR_HALF_WIDTH,
  helixSpur,
  radiusOf,
  segmentDistanceToAxis,
  type HelixParams,
} from '../domain/placement.ts'
import { yOf } from '../domain/time.ts'
import type { Vec3 } from '../domain/types.ts'

// Catwalk path graph (PLAN § Space and time): the helix centreline from Y(T0) = 0 to
// Y(now + 5 y), one turn per year, plus one radial spur per memory. Pure math, no React and
// no scene objects: the environment builds its geometry from this, the camera rig walks it.
//
// Angle convention (shared with domain/placement.ts): helix point at height y is
// (R·cos θ(y), y, R·sin θ(y)) with θ(y) = HELIX_PHASE0 + 2π·y / pitch. Every y in this file is
// the walking surface (deck top), not the slab centre.

const TAU = Math.PI * 2

/** Deck width of the helical ramp (world units). */
export const CATWALK_WIDTH = 2.2
/** Year landings widen the deck outwards by this much. */
export const LANDING_EXT = 2.0
/** Half the arc length of a year landing along the helix centreline. */
export const LANDING_HALF_ARC = 3.0
/** The Present landing is wider and longer. */
export const PRESENT_EXT = 3.2
export const PRESENT_HALF_ARC = 4.5
/** Spur deck width (matches the core-clearance contract in placement.ts). */
export const SPUR_WIDTH = 2 * SPUR_HALF_WIDTH
/** Gap between the end of a spur and the memory anchor, so the walker stops in front of it. */
export const SPUR_STANDOFF = 2.0
/** Level platform at node height at the end of a spur (the top of the pier). */
export const SPUR_PLATFORM = 1.4
/** Preferred stair steepness (rise / run). Short spurs get steeper stairs. */
export const STAIR_SLOPE = 0.75
/** Below this height difference a spur is level and has no stair. */
export const STAIR_MIN_DY = 0.05
/** Polyline resolution of helix edges. */
export const HELIX_EDGE_SAMPLES_PER_TURN = 48

export interface PathMemory {
  id: string
  anchorXZ: readonly [number, number]
  /** Node height = Y(temporalOrigin). */
  y: number
}

export interface PathGraphInput {
  T0: number
  now: number
  yPerYear?: number
  memories: readonly PathMemory[]
}

export interface HelixPath {
  yMin: number
  yMax: number
  radius: number
  pitch: number
  phase0: number
  /** Arc length along the centreline per unit of height. */
  arcPerY: number
  /** Unwrapped helix angle at height y. */
  angleAtY(y: number): number
  pointAtY(y: number, out: Vector3): Vector3
  /** Unit tangent pointing up the helix (towards later time). */
  tangentAtY(y: number, out: Vector3): Vector3
}

export interface Landing {
  /** Calendar year whose 1 January this landing marks. */
  year: number
  y: number
  /** Helix angle at y, wrapped to [0, 2π). */
  angle: number
  /** Helix centreline point at y (walking surface). */
  center: Vec3
  /** Height range the widened slab covers along the helix. */
  span: [number, number]
  /** Outer radius of the widened slab. */
  outerRadius: number
}

export interface PresentMark {
  y: number
  angle: number
  center: Vec3
  span: [number, number]
  outerRadius: number
}

export interface Spur {
  nodeId: string
  /** Memory anchor and height. */
  anchorXZ: [number, number]
  nodeY: number
  /** Helix height where the spur leaves the catwalk (the turn nearest the node). */
  attachY: number
  /** Node polar angle φ ∈ [0, 2π); the helix angle at attachY equals it (mod 2π). */
  attachAngle: number
  /** Helix centreline attachment point. */
  from: Vec3
  /** End of the walkable spur, SPUR_STANDOFF in front of the node, at node height. */
  to: Vec3
  /** nodeY − attachY, taken up by the stair on the pier. */
  stairDY: number
  hasStair: boolean
  /** Outer radius of the catwalk slab at the attachment (deck geometry starts here). */
  edgeRadius: number
  /** Radii along the spur: deck end / stair start, stair end / platform start, platform end. */
  deckEndRadius: number
  stairEndRadius: number
  endRadius: number
  /** True when the nearest turn lay below the floor and the spur moved up one turn
   *  (|stairDY| is then between pitch/2 and pitch). */
  bumped: boolean
  /** Walkable polyline from the helix centreline outwards: [from, deckEnd, stairEnd, to]
   *  (or [from, to] for a level spur). */
  points: Vec3[]
}

export type PathEdgeKind = 'helix' | 'spur' | 'stair'

export interface PathEdge {
  id: string
  kind: PathEdgeKind
  /** Junction ids. Helix junctions are 'helix:start', 'helix:end', 'present' and
   *  'helix@<y>' at spur attachments; spur ends are 'pier:<nodeId>' and 'node:<nodeId>'. */
  a: string
  b: string
  /** Polyline length (sum of segment lengths). */
  length: number
  points: Vec3[]
  /** Cumulative length at each point (cum[0] = 0, cum[last] = length). */
  cum: number[]
}

export interface PathGraph {
  T0: number
  now: number
  yPerYear: number
  helix: HelixPath
  landings: Landing[]
  spurs: Spur[]
  present: PresentMark
  edges: PathEdge[]
}

// ─── helix ──────────────────────────────────────────────────────────────────────────────

export function helixParamsFor(yPerYear: number): HelixParams {
  return { radius: HELIX_RADIUS, pitch: yPerYear, phase0: HELIX_PHASE0 }
}

export function wrapAngle(a: number): number {
  const w = a % TAU
  return w < 0 ? w + TAU : w
}

function makeHelix(yMin: number, yMax: number, p: HelixParams): HelixPath {
  const k = TAU / p.pitch
  const rk = p.radius * k
  const arcPerY = Math.hypot(rk, 1)
  return {
    yMin,
    yMax,
    radius: p.radius,
    pitch: p.pitch,
    phase0: p.phase0,
    arcPerY,
    angleAtY: (y) => p.phase0 + k * y,
    pointAtY: (y, out) => {
      const a = p.phase0 + k * y
      return out.set(p.radius * Math.cos(a), y, p.radius * Math.sin(a))
    },
    tangentAtY: (y, out) => {
      const a = p.phase0 + k * y
      return out.set((-rk * Math.sin(a)) / arcPerY, 1 / arcPerY, (rk * Math.cos(a)) / arcPerY)
    },
  }
}

function helixVec(h: HelixPath, y: number): Vec3 {
  const a = h.angleAtY(y)
  return [h.radius * Math.cos(a), y, h.radius * Math.sin(a)]
}

/** Height half-span of a slab covering `halfArc` of centreline on either side. */
export function halfSpanY(halfArc: number, h: Pick<HelixPath, 'radius' | 'pitch'>): number {
  return (halfArc / h.radius) * (h.pitch / TAU)
}

// ─── landings ───────────────────────────────────────────────────────────────────────────

/** 1 January of every calendar year on the catwalk (T0 < Jan 1 ≤ yMax), plus Y(T0)'s year
 *  when T0 falls exactly on 1 January. */
export function yearLandings(T0: number, yPerYear: number, h: HelixPath): Landing[] {
  const out: Landing[] = []
  const first = new Date(T0).getUTCFullYear()
  const hs = halfSpanY(LANDING_HALF_ARC, h)
  const outerRadius = h.radius + CATWALK_WIDTH / 2 + LANDING_EXT
  for (let year = first; ; year++) {
    const t = Date.UTC(year, 0, 1)
    if (t < T0) continue
    const y = yOf(t, T0, yPerYear)
    if (y > h.yMax) break
    out.push({
      year,
      y,
      angle: wrapAngle(h.angleAtY(y)),
      center: helixVec(h, y),
      span: [Math.max(h.yMin, y - hs), Math.min(h.yMax, y + hs)],
      outerRadius,
    })
  }
  return out
}

/** Outer radius of the catwalk slab at height y (landings are wider than the ramp). */
export function deckOuterRadiusAt(
  y: number,
  h: HelixPath,
  landings: readonly Landing[],
  present: PresentMark | null,
): number {
  if (present && y >= present.span[0] && y <= present.span[1]) return present.outerRadius
  // landings are sorted by y; binary search for the last landing starting at or before y.
  let lo = 0
  let hi = landings.length - 1
  let idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (landings[mid].span[0] <= y) {
      idx = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  if (idx >= 0 && y <= landings[idx].span[1]) return landings[idx].outerRadius
  return h.radius + CATWALK_WIDTH / 2
}

/** Year landings whose slab would overlap the Present landing are dropped (the Present wins). */
function withoutPresentOverlap(landings: Landing[], present: PresentMark): Landing[] {
  return landings.filter((l) => l.span[1] < present.span[0] || l.span[0] > present.span[1])
}

// ─── spurs ──────────────────────────────────────────────────────────────────────────────

export interface SpurLayoutContext {
  helix: HelixPath
  params: HelixParams
  landings: readonly Landing[]
  present: PresentMark | null
}

/**
 * Radial spur for one memory. Attachment per helixSpur (helix angle = node angle φ, nearest
 * turn); a turn below the floor moves up one pitch. Along the spur: a level deck at the turn
 * height, a straight stair taking up stairDY, then a platform at node height that ends
 * SPUR_STANDOFF in front of the node.
 */
export function layoutSpur(m: PathMemory, ctx: SpurLayoutContext): Spur {
  const { helix: h } = ctx
  const sp = helixSpur(m.anchorXZ, m.y, ctx.params)
  let attachY = sp.turnY
  let bumped = false
  if (attachY < h.yMin - 1e-9) {
    attachY += h.pitch
    bumped = true
  }
  const phi = sp.attachAngle
  const c = Math.cos(phi)
  const s = Math.sin(phi)
  const dy = m.y - attachY
  const hasStair = Math.abs(dy) > STAIR_MIN_DY
  const edgeRadius = deckOuterRadiusAt(attachY, h, ctx.landings, ctx.present)
  const rNode = radiusOf(m.anchorXZ)
  const minEnd = edgeRadius + (hasStair ? SPUR_PLATFORM + 0.2 : 0.6)
  const endRadius = Math.max(minEnd, rNode - SPUR_STANDOFF)
  const stairEndRadius = hasStair ? endRadius - SPUR_PLATFORM : endRadius
  const run = hasStair ? Math.min(Math.abs(dy) / STAIR_SLOPE, stairEndRadius - edgeRadius) : 0
  const deckEndRadius = stairEndRadius - run
  const endY = hasStair ? m.y : attachY

  const from: Vec3 = [h.radius * c, attachY, h.radius * s]
  const deckEnd: Vec3 = [deckEndRadius * c, attachY, deckEndRadius * s]
  const stairEnd: Vec3 = [stairEndRadius * c, endY, stairEndRadius * s]
  const to: Vec3 = [endRadius * c, endY, endRadius * s]
  return {
    nodeId: m.id,
    anchorXZ: [m.anchorXZ[0], m.anchorXZ[1]],
    nodeY: m.y,
    attachY,
    attachAngle: phi,
    from,
    to,
    stairDY: dy,
    hasStair,
    edgeRadius,
    deckEndRadius,
    stairEndRadius,
    endRadius,
    bumped,
    points: hasStair ? [from, deckEnd, stairEnd, to] : [from, to],
  }
}

/**
 * Pure geometry check: does the spur's footprint (centreline ± half width) come within
 * `coreRadius` of the vertical core axis? The pier stair is vertical over the same radial
 * line, so the XZ segment from → to is the whole footprint.
 */
export function spurIntersectsCore(
  spur: Pick<Spur, 'from' | 'to'>,
  coreRadius = CORE_RADIUS,
  halfWidth = SPUR_HALF_WIDTH,
): boolean {
  return segmentDistanceToAxis([spur.from[0], spur.from[2]], [spur.to[0], spur.to[2]]) < coreRadius + halfWidth
}

// ─── edges ──────────────────────────────────────────────────────────────────────────────

function polyEdge(id: string, kind: PathEdgeKind, a: string, b: string, points: Vec3[]): PathEdge {
  const cum = [0]
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    const q = points[i - 1]
    cum.push(cum[i - 1] + Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]))
  }
  return { id, kind, a, b, length: cum[cum.length - 1], points, cum }
}

function helixPolyline(h: HelixPath, y0: number, y1: number): Vec3[] {
  const n = Math.max(1, Math.ceil(((y1 - y0) / h.pitch) * HELIX_EDGE_SAMPLES_PER_TURN))
  const pts: Vec3[] = []
  for (let i = 0; i <= n; i++) pts.push(helixVec(h, y0 + ((y1 - y0) * i) / n))
  return pts
}

export function helixJunctionId(y: number): string {
  return `helix@${y.toFixed(4)}`
}

// ─── graph ──────────────────────────────────────────────────────────────────────────────

export function buildPathGraph(input: PathGraphInput): PathGraph {
  const yPerYear = input.yPerYear ?? Y_PER_YEAR
  const params = helixParamsFor(yPerYear)
  const { T0, now } = input
  const yNow = Math.max(0, yOf(now, T0, yPerYear))
  const yFuture = Math.max(yNow, yOf(now + FUTURE_YEARS * MS_PER_YEAR, T0, yPerYear))

  // The helix must reach every spur attachment. helixSpur's nearest turn can lie up to half a
  // pitch above the top; extend the helix there rather than violate |stairDY| ≤ pitch/2.
  const probe = makeHelix(0, yFuture, params)
  let yMax = yFuture
  for (const m of input.memories) {
    const sp = helixSpur(m.anchorXZ, m.y, params)
    const t = sp.turnY < 0 ? sp.turnY + params.pitch : sp.turnY
    if (t > yMax) yMax = t
  }
  const helix = yMax === yFuture ? probe : makeHelix(0, yMax, params)

  const pHalf = halfSpanY(PRESENT_HALF_ARC, helix)
  const present: PresentMark = {
    y: yNow,
    angle: wrapAngle(helix.angleAtY(yNow)),
    center: helixVec(helix, yNow),
    span: [Math.max(0, yNow - pHalf), Math.min(helix.yMax, yNow + pHalf)],
    outerRadius: helix.radius + CATWALK_WIDTH / 2 + PRESENT_EXT,
  }
  const landings = withoutPresentOverlap(yearLandings(T0, yPerYear, helix), present)

  const ctx: SpurLayoutContext = { helix, params, landings, present }
  const spurs = input.memories
    .filter((m) => Number.isFinite(m.y) && Number.isFinite(m.anchorXZ[0]) && Number.isFinite(m.anchorXZ[1]))
    .map((m) => layoutSpur(m, ctx))
    .sort((a, b) => a.attachY - b.attachY || (a.nodeId < b.nodeId ? -1 : 1))

  // Helix junctions: both ends, the present, and every spur attachment (deduplicated by height).
  const junctions = new Map<string, number>()
  junctions.set('helix:start', helix.yMin)
  junctions.set('helix:end', helix.yMax)
  junctions.set('present', yNow)
  const attachIds = new Map<Spur, string>()
  for (const s of spurs) {
    const id = helixJunctionId(s.attachY)
    attachIds.set(s, id)
    if (!junctions.has(id)) junctions.set(id, s.attachY)
  }
  const sorted = [...junctions].sort((a, b) => a[1] - b[1])

  const edges: PathEdge[] = []
  for (let i = 0; i + 1 < sorted.length; i++) {
    const [aId, ya] = sorted[i]
    const [bId, yb] = sorted[i + 1]
    if (yb - ya < 1e-9) continue
    edges.push(polyEdge(`helix:${i}`, 'helix', aId, bId, helixPolyline(helix, ya, yb)))
  }
  for (const s of spurs) {
    const a = attachIds.get(s)!
    const nodeEnd = `node:${s.nodeId}`
    if (s.hasStair) {
      const pier = `pier:${s.nodeId}`
      edges.push(polyEdge(`spur:${s.nodeId}`, 'spur', a, pier, [s.points[0], s.points[1]]))
      edges.push(polyEdge(`stair:${s.nodeId}`, 'stair', pier, nodeEnd, [s.points[1], s.points[2], s.points[3]]))
    } else {
      edges.push(polyEdge(`spur:${s.nodeId}`, 'spur', a, nodeEnd, s.points))
    }
  }

  return { T0, now, yPerYear, helix, landings, spurs, present, edges }
}

/** Point at arc length s along an edge (clamped); `dirOut` receives the unit direction a → b. */
export function sampleEdge(edge: PathEdge, s: number, out: Vector3, dirOut?: Vector3): Vector3 {
  const { points, cum } = edge
  const last = points.length - 1
  if (last <= 0) {
    const p = points[0]
    dirOut?.set(0, 0, 0)
    return out.set(p[0], p[1], p[2])
  }
  const t = Math.min(Math.max(s, 0), edge.length)
  // Binary search for the segment [i, i+1] containing t.
  let lo = 0
  let hi = last - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (cum[mid] <= t) lo = mid
    else hi = mid - 1
  }
  const p = points[lo]
  const q = points[lo + 1]
  const seg = cum[lo + 1] - cum[lo]
  const f = seg > 0 ? (t - cum[lo]) / seg : 0
  const dx = q[0] - p[0]
  const dy = q[1] - p[1]
  const dz = q[2] - p[2]
  if (dirOut) {
    const len = Math.hypot(dx, dy, dz) || 1
    dirOut.set(dx / len, dy / len, dz / len)
  }
  return out.set(p[0] + dx * f, p[1] + dy * f, p[2] + dz * f)
}

/** Default T0 for sandboxes and pre-first-run renders: thirty years before `now`. */
export function fallbackT0(now: number): number {
  return now - 30 * MS_PER_YEAR
}
