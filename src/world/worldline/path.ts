import type { NodeRecord } from '../../domain/types.ts'
import type { PoseTable } from '../poses.ts'

// The worldline: a centripetal Catmull–Rom curve through the memory poses in date order.
// Pure (no three, no React) so the ribbon, the autonav ride and the tests share one
// definition. Centripetal (α = ½) rather than uniform: memories are spaced very unevenly
// (a decade apart, or the same afternoon), and the uniform spline overshoots and loops on
// such knots, while the centripetal one provably has no cusps or self-intersections
// within a segment.

/** Samples per Catmull–Rom segment (between two consecutive memories). */
export const SAMPLES_PER_SEGMENT = 16
/** Knot-distance floor: coincident memories must not divide by zero. */
const MIN_KNOT_DT = 1e-4

/** Memory ids in date order (temporalOrigin, then id for a total order). */
export function memoryOrder(nodes: Iterable<NodeRecord>): string[] {
  const list: NodeRecord[] = []
  for (const n of nodes) if (n.archetype === 'memory' && n.deletedAt === null) list.push(n)
  list.sort((a, b) => a.temporalOrigin - b.temporalOrigin || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return list.map((n) => n.id)
}

/**
 * One point of the centripetal Catmull–Rom segment P1→P2 (Barry–Goldman pyramid), at
 * u ∈ [0, 1]. p0..p3 are offsets into `pts` (xyz stride 3).
 */
function segmentPoint(pts: ArrayLike<number>, p0: number, p1: number, p2: number, p3: number, u: number, out: Float32Array, o: number): void {
  const d01 = knotDt(pts, p0, p1)
  const d12 = knotDt(pts, p1, p2)
  const d23 = knotDt(pts, p2, p3)
  const t0 = 0
  const t1 = d01
  const t2 = t1 + d12
  const t3 = t2 + d23
  const t = t1 + u * d12
  for (let a = 0; a < 3; a++) {
    const P0 = pts[p0 + a]
    const P1 = pts[p1 + a]
    const P2 = pts[p2 + a]
    const P3 = pts[p3 + a]
    const A1 = ((t1 - t) * P0 + (t - t0) * P1) / (t1 - t0)
    const A2 = ((t2 - t) * P1 + (t - t1) * P2) / (t2 - t1)
    const A3 = ((t3 - t) * P2 + (t - t2) * P3) / (t3 - t2)
    const B1 = ((t2 - t) * A1 + (t - t0) * A2) / (t2 - t0)
    const B2 = ((t3 - t) * A2 + (t - t1) * A3) / (t3 - t1)
    out[o + a] = ((t2 - t) * B1 + (t - t1) * B2) / (t2 - t1)
  }
}

function knotDt(pts: ArrayLike<number>, i: number, j: number): number {
  const dx = pts[j] - pts[i]
  const dy = pts[j + 1] - pts[i + 1]
  const dz = pts[j + 2] - pts[i + 2]
  // α = ½: the square root of the chord length.
  return Math.max(MIN_KNOT_DT, Math.sqrt(Math.sqrt(dx * dx + dy * dy + dz * dz)))
}

/** Sample count of a curve through `knots` points. */
export function sampleCount(knots: number, perSegment: number = SAMPLES_PER_SEGMENT): number {
  return knots < 2 ? knots : (knots - 1) * perSegment + 1
}

/**
 * Centripetal Catmull–Rom through `knots` points (xyz stride 3), `perSegment` samples per
 * segment, written to `out` (xyz stride 3, sampleCount() points). The end tangents come
 * from phantom points reflected through the end knots (P₋₁ = 2P₀ − P₁), so the curve
 * starts and ends exactly on the first and last memory. Every knot is hit exactly.
 */
export function catmullRom(
  pts: ArrayLike<number>,
  knots: number,
  perSegment: number = SAMPLES_PER_SEGMENT,
  out: Float32Array = new Float32Array(3 * sampleCount(knots, perSegment)),
  scratch?: Float64Array,
): Float32Array {
  if (knots === 0) return out
  if (knots === 1) {
    out[0] = pts[0]
    out[1] = pts[1]
    out[2] = pts[2]
    return out
  }
  // Knots plus two phantom ends: ext[0] and ext[knots + 1].
  const ext = scratch && scratch.length >= 3 * (knots + 2) ? scratch : new Float64Array(3 * (knots + 2))
  for (let k = 0; k < 3 * knots; k++) ext[3 + k] = pts[k]
  const last = 3 * knots
  for (let a = 0; a < 3; a++) {
    ext[a] = 2 * ext[3 + a] - ext[6 + a]
    ext[last + 3 + a] = 2 * ext[last + a] - ext[last - 3 + a]
  }
  let o = 0
  for (let s = 0; s < knots - 1; s++) {
    const p0 = 3 * s
    for (let k = 0; k < perSegment; k++) {
      segmentPoint(ext, p0, p0 + 3, p0 + 6, p0 + 9, k / perSegment, out, o)
      o += 3
    }
  }
  // The last sample is the last knot, exactly.
  out[o] = pts[last - 3]
  out[o + 1] = pts[last - 2]
  out[o + 2] = pts[last - 1]
  return out
}

/** A sampled worldline with cumulative arc length, for the ribbon and the ride. */
export class WorldlinePath {
  /** Sample positions, xyz stride 3 (first `count` are valid). */
  samples = new Float32Array(0)
  /** Cumulative arc length at each sample (arc[0] = 0). */
  arc = new Float32Array(0)
  /** Per-sample "born" weight in [0, 1], interpolated between the knots' born flags. */
  born = new Float32Array(0)
  /** Arc length at each knot (memory). */
  knotArc = new Float32Array(0)
  /** Memory id of each knot, in date order. */
  knotIds: string[] = []
  count = 0
  knots = 0
  length = 0
  /** Bumped whenever the samples change. */
  version = 0
  private scratch = new Float64Array(0)

  /** Rebuild from knot positions (xyz stride 3) and per-knot born flags. */
  set(pts: ArrayLike<number>, bornFlags: ArrayLike<number>, knots: number, ids: string[], perSegment: number = SAMPLES_PER_SEGMENT): void {
    const n = sampleCount(knots, perSegment)
    if (this.samples.length < 3 * n) {
      const cap = Math.max(3 * n, 2 * this.samples.length)
      this.samples = new Float32Array(cap)
      this.arc = new Float32Array(cap / 3)
      this.born = new Float32Array(cap / 3)
    }
    if (this.knotArc.length < knots) this.knotArc = new Float32Array(Math.max(knots, 2 * this.knotArc.length))
    if (this.scratch.length < 3 * (knots + 2)) this.scratch = new Float64Array(3 * (knots + 2) * 2)
    catmullRom(pts, knots, perSegment, this.samples, this.scratch)
    this.count = n
    this.knots = knots
    this.knotIds = ids
    const s = this.samples
    let len = 0
    if (n > 0) this.arc[0] = 0
    for (let i = 1; i < n; i++) {
      const o = 3 * i
      len += Math.hypot(s[o] - s[o - 3], s[o + 1] - s[o - 2], s[o + 2] - s[o - 1])
      this.arc[i] = len
    }
    this.length = len
    for (let k = 0; k < knots; k++) this.knotArc[k] = this.arc[Math.min(n - 1, k * perSegment)]
    for (let i = 0; i < n; i++) {
      const seg = Math.min(knots - 2, Math.floor(i / perSegment))
      if (seg < 0) {
        this.born[i] = bornFlags[0] ?? 0
        continue
      }
      const u = (i - seg * perSegment) / perSegment
      this.born[i] = (1 - u) * bornFlags[seg] + u * bornFlags[seg + 1]
    }
    this.version++
  }

  /** Index i with arc[i] ≤ s < arc[i + 1] (binary search), clamped to the curve. */
  private segmentAt(s: number): number {
    let lo = 0
    let hi = this.count - 1
    if (hi <= 0) return 0
    if (s <= 0) return 0
    if (s >= this.length) return hi - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (this.arc[mid] <= s) lo = mid
      else hi = mid
    }
    return lo
  }

  /** Point at arc length s (clamped to [0, length]) into `out`. */
  pointAt<T extends { set(x: number, y: number, z: number): unknown }>(s: number, out: T): T {
    const n = this.count
    if (n === 0) {
      out.set(0, 0, 0)
      return out
    }
    if (n === 1) {
      out.set(this.samples[0], this.samples[1], this.samples[2])
      return out
    }
    const i = this.segmentAt(s)
    const a0 = this.arc[i]
    const a1 = this.arc[i + 1]
    const u = a1 > a0 ? Math.min(1, Math.max(0, (s - a0) / (a1 - a0))) : 0
    const o = 3 * i
    const p = this.samples
    out.set(p[o] + u * (p[o + 3] - p[o]), p[o + 1] + u * (p[o + 4] - p[o + 1]), p[o + 2] + u * (p[o + 5] - p[o + 2]))
    return out
  }

  /** Unit tangent at arc length s into `out` ((0, 1, 0) for a degenerate curve). */
  tangentAt<T extends { set(x: number, y: number, z: number): unknown }>(s: number, out: T): T {
    if (this.count < 2) {
      out.set(0, 1, 0)
      return out
    }
    const o = 3 * this.segmentAt(s)
    const p = this.samples
    const dx = p[o + 3] - p[o]
    const dy = p[o + 4] - p[o + 1]
    const dz = p[o + 5] - p[o + 2]
    const l = Math.hypot(dx, dy, dz)
    if (l < 1e-9) out.set(0, 1, 0)
    else out.set(dx / l, dy / l, dz / l)
    return out
  }

  /** Distance along the curve from s to the nearest knot (memory). */
  distanceToKnot(s: number): number {
    let best = Infinity
    for (let k = 0; k < this.knots; k++) best = Math.min(best, Math.abs(this.knotArc[k] - s))
    return best
  }
}

/**
 * Knot positions of the memories `ids` from the pose table (rows missing from the table
 * are skipped). Returns the knot count; positions go to `pts`, born flags to `born`, the
 * ids that made it to `outIds`.
 */
export function knotsFromPoses(
  ids: readonly string[],
  table: Pick<PoseTable, 'index' | 'pos' | 'born'>,
  pts: Float64Array,
  born: Float32Array,
  outIds: string[],
): number {
  outIds.length = 0
  let k = 0
  for (const id of ids) {
    const row = table.index.get(id)
    if (row === undefined) continue
    const o = 3 * row
    pts[3 * k] = table.pos[o]
    pts[3 * k + 1] = table.pos[o + 1]
    pts[3 * k + 2] = table.pos[o + 2]
    born[k] = table.born[row] === 1 ? 1 : 0
    outIds.push(id)
    k++
  }
  return k
}
