import type { Vector3 } from 'three'
import { HELIX, helixAngleAt, helixSpur } from '../../domain/placement.ts'

// What the avatar walks on: the helix centreline plus one radial spur per memory.
//
// The avatar consumes only this narrow shape so it works with the catwalk path graph from
// world/paths.ts (buildPathGraph: `helix.{yMin,yMax}` and `spurs[{nodeId, attachY, points}]`)
// or with stubWalkGraph() below. The helix centreline itself is evaluated with the shared
// placement contract (HELIX, helixAngleAt) rather than through the graph's callbacks, so the
// per-frame path is allocation-free whatever the graph's helpers return.

type PointLike = readonly [number, number, number] | readonly number[] | { readonly x: number; readonly y: number; readonly z: number }

export interface WalkGraphSource {
  helix: { readonly yMin: number; readonly yMax: number }
  spurs: readonly { readonly nodeId: string; readonly attachY: number; readonly points: readonly PointLike[] }[]
}

export interface WalkSpur {
  nodeId: string
  /** Helix height where the spur leaves the catwalk. */
  attachY: number
  /** xyz per polyline vertex, from the helix attachment outwards. */
  pts: Float32Array
  /** Cumulative arc length at each vertex. */
  cum: Float32Array
  length: number
}

export interface WalkGraph {
  yMin: number
  yMax: number
  /**
   * Height of the walking surface above the helix centreline, inferred from the spurs (their
   * first vertex sits on the deck at the attachment). 0 for the stub graph.
   */
  deckY: number
  /** Sorted by attachY. */
  spurs: WalkSpur[]
}

const TAU = Math.PI * 2
/** dθ/dy of the helix. */
const K = TAU / HELIX.pitch
/** Arc length along the helix per unit of height: √((R·dθ/dy)² + 1). */
export const HELIX_ARC_PER_Y = Math.hypot(HELIX.radius * K, 1)

export function helixPoint(y: number, out: Vector3): Vector3 {
  const a = helixAngleAt(y)
  return out.set(HELIX.radius * Math.cos(a), y, HELIX.radius * Math.sin(a))
}

/** Unit tangent pointing up the helix (towards later time). */
export function helixTangent(y: number, out: Vector3): Vector3 {
  const a = helixAngleAt(y)
  const rk = HELIX.radius * K
  return out.set(-rk * Math.sin(a), 1, rk * Math.cos(a)).multiplyScalar(1 / HELIX_ARC_PER_Y)
}

function px(p: PointLike, i: 0 | 1 | 2): number {
  if ('x' in p) return i === 0 ? p.x : i === 1 ? p.y : p.z
  return (p as readonly number[])[i]
}

export function prepareWalkGraph(src: WalkGraphSource): WalkGraph {
  const spurs: WalkSpur[] = []
  for (const s of src.spurs) {
    const n = s.points.length
    if (n < 2) continue
    const pts = new Float32Array(n * 3)
    const cum = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      pts[i * 3] = px(s.points[i], 0)
      pts[i * 3 + 1] = px(s.points[i], 1)
      pts[i * 3 + 2] = px(s.points[i], 2)
      if (i > 0) {
        const o = i * 3
        cum[i] = cum[i - 1] + Math.hypot(pts[o] - pts[o - 3], pts[o + 1] - pts[o - 2], pts[o + 2] - pts[o - 1])
      }
    }
    spurs.push({ nodeId: s.nodeId, attachY: s.attachY, pts, cum, length: cum[n - 1] })
  }
  spurs.sort((a, b) => a.attachY - b.attachY)
  const deckY = spurs.length > 0 ? spurs[0].pts[1] - spurs[0].attachY : 0
  return { yMin: src.helix.yMin, yMax: Math.max(src.helix.yMin, src.helix.yMax), deckY: Number.isFinite(deckY) ? deckY : 0, spurs }
}

/**
 * Point at arc length `s` along a spur; `dirOut` (optional) receives the unit direction of
 * travel outwards at that point.
 */
export function sampleSpur(spur: WalkSpur, s: number, out: Vector3, dirOut?: Vector3): Vector3 {
  const { pts, cum } = spur
  const last = cum.length - 1
  const t = Math.min(Math.max(s, 0), spur.length)
  let i = 0
  while (i < last - 1 && cum[i + 1] < t) i++
  const seg = cum[i + 1] - cum[i]
  const f = seg > 0 ? (t - cum[i]) / seg : 0
  const o = i * 3
  const dx = pts[o + 3] - pts[o]
  const dy = pts[o + 4] - pts[o + 1]
  const dz = pts[o + 5] - pts[o + 2]
  if (dirOut) {
    const len = Math.hypot(dx, dy, dz) || 1
    dirOut.set(dx / len, dy / len, dz / len)
  }
  return out.set(pts[o] + dx * f, pts[o + 1] + dy * f, pts[o + 2] + dz * f)
}

/** Index of the spur whose attachment is nearest to helix height `y`, within `maxArc` of walking. */
export function nearestSpurAt(graph: WalkGraph, y: number, maxArc: number): number {
  const spurs = graph.spurs
  const maxDy = maxArc / HELIX_ARC_PER_Y
  // Binary search for the first attachY ≥ y − maxDy.
  let lo = 0
  let hi = spurs.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (spurs[mid].attachY < y - maxDy) lo = mid + 1
    else hi = mid
  }
  let best = -1
  let bestDy = maxDy
  for (let i = lo; i < spurs.length && spurs[i].attachY <= y + maxDy; i++) {
    const d = Math.abs(spurs[i].attachY - y)
    if (d <= bestDy) {
      bestDy = d
      best = i
    }
  }
  return best
}

export function spurIndexOf(graph: WalkGraph, nodeId: string): number {
  return graph.spurs.findIndex((s) => s.nodeId === nodeId)
}

/** Gap left between the end of a spur and the node it serves, so the avatar stops in front of it. */
const SPUR_STANDOFF = 2.5

/**
 * Stand-in for buildPathGraph (world/paths.ts) built from the placement contract: one radial
 * spur per memory from the helix at the nearest turn out towards the anchor, then the pier
 * stair taking up the height difference. Used by the sandbox and as a fallback.
 */
export function stubWalkGraph(
  memories: readonly { id: string; anchorXZ: readonly [number, number]; y: number }[],
  yMin: number,
  yMax: number,
): WalkGraphSource {
  return {
    helix: { yMin, yMax },
    spurs: memories.map((m) => {
      const sp = helixSpur(m.anchorXZ, m.y)
      const r = Math.hypot(m.anchorXZ[0], m.anchorXZ[1]) || 1
      const ux = m.anchorXZ[0] / r
      const uz = m.anchorXZ[1] / r
      const end = Math.max(HELIX.radius + 1, r - SPUR_STANDOFF)
      return {
        nodeId: m.id,
        attachY: sp.turnY,
        points: [
          [sp.attachXZ[0], sp.turnY, sp.attachXZ[1]],
          [ux * end, sp.turnY, uz * end],
          [ux * end, m.y, uz * end],
        ] as [number, number, number][],
      }
    }),
  }
}
