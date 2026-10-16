import { UMAP } from 'umap-js'
import { RING_RADIUS, minRadiusFor } from '../domain/placement.ts'
import type { Archetype, NodeRecord } from '../domain/types.ts'

// Semantic layout (Phase 4; replaces tag-hash sectors). Pure: no repo, no workers.
//
// Anchored incremental: between re-crystallise events nothing moves. A new node goes to
// the angle of its semantic neighbours (similarity-weighted circular mean) on its
// archetype's ring, so meaning sets the bearing and the archetype keeps its ring.
//
// Re-crystallise (an explicit, undoable event): UMAP embeds every live node's vector in 2D;
// a similarity transform (Kabsch/Umeyama: rotation, optional reflection, uniform scale,
// translation) aligns that layout to the current anchors, so the world turns as little as
// possible; then each node takes its aligned bearing and keeps its own radius (archetype
// ring and any drag). Seeded, so the same world and seed give the same layout.

export type XZ = [number, number]

export interface NeighbourAnchor {
  anchorXZ: readonly [number, number]
  similarity: number
}

/** Where a new node of `archetype` should go, given its nearest neighbours; null if none are similar. */
export function semanticAnchorHint(neighbours: readonly NeighbourAnchor[], archetype: Archetype, minSimilarity = 0.2): XZ | null {
  let sx = 0
  let sz = 0
  let sr = 0
  let sw = 0
  for (const n of neighbours) {
    const w = Math.max(0, n.similarity - minSimilarity) ** 2
    if (w === 0) continue
    const r = Math.hypot(n.anchorXZ[0], n.anchorXZ[1])
    if (r === 0) continue
    sx += (w * n.anchorXZ[0]) / r
    sz += (w * n.anchorXZ[1]) / r
    sr += w * r
    sw += w
  }
  if (sw === 0 || Math.hypot(sx, sz) < 1e-9) return null
  const angle = Math.atan2(sz, sx)
  // Halfway between the archetype's ring and where the neighbours sit.
  const radius = Math.max(minRadiusFor(archetype), 0.5 * RING_RADIUS[archetype] + 0.5 * (sr / sw))
  return [radius * Math.cos(angle), radius * Math.sin(angle)]
}

/** mulberry32: a small seeded PRNG for UMAP. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Similarity2D {
  /** Row-major 2×2 (rotation, or rotation × reflection). */
  R: [number, number, number, number]
  s: number
  t: XZ
  reflected: boolean
}

export function applySimilarity(T: Similarity2D, p: readonly [number, number]): XZ {
  const [a, b, c, d] = T.R
  return [T.s * (a * p[0] + b * p[1]) + T.t[0], T.s * (c * p[0] + d * p[1]) + T.t[1]]
}

/**
 * Least-squares similarity src → dst (Umeyama 1991; Kabsch for the rotation). With
 * allowReflection the mirror image is considered too (UMAP's handedness is arbitrary).
 */
export function fitSimilarity(src: readonly XZ[], dst: readonly XZ[], allowReflection = true): Similarity2D {
  const n = src.length
  if (n === 0 || n !== dst.length) throw new Error('fitSimilarity: need matching, non-empty point sets')
  let mx = 0, my = 0, nx = 0, ny = 0
  for (let i = 0; i < n; i++) {
    mx += src[i][0]; my += src[i][1]
    nx += dst[i][0]; ny += dst[i][1]
  }
  mx /= n; my /= n; nx /= n; ny /= n
  // Cross-covariance terms and source variance.
  let sxx = 0, sxy = 0, syx = 0, syy = 0, varS = 0
  for (let i = 0; i < n; i++) {
    const ax = src[i][0] - mx, ay = src[i][1] - my
    const bx = dst[i][0] - nx, by = dst[i][1] - ny
    sxx += ax * bx; sxy += ay * bx; syx += ax * by; syy += ay * by
    varS += ax * ax + ay * ay
  }
  // 2D closed form: the best proper rotation angle maximises trace(R·Σ).
  const fit = (reflect: boolean) => {
    // For a reflection, mirror the source y first: (x, y) → (x, −y).
    const xx = sxx, xy = reflect ? -sxy : sxy, yx = syx, yy = reflect ? -syy : syy
    const theta = Math.atan2(yx - xy, xx + yy)
    const cos = Math.cos(theta), sin = Math.sin(theta)
    const trace = cos * (xx + yy) + sin * (yx - xy)
    const R: [number, number, number, number] = reflect ? [cos, sin, sin, -cos] : [cos, -sin, sin, cos]
    return { R, trace }
  }
  const proper = fit(false)
  const mirror = allowReflection ? fit(true) : null
  const best = mirror && mirror.trace > proper.trace ? { ...mirror, reflected: true } : { ...proper, reflected: false }
  const s = varS > 0 ? Math.max(best.trace, 0) / varS : 1
  const [a, b, c, d] = best.R
  const t: XZ = [nx - s * (a * mx + b * my), ny - s * (c * mx + d * my)]
  return { R: best.R, s: s > 0 ? s : 1, t, reflected: best.reflected }
}

export interface RecrystalliseInput {
  records: readonly Pick<NodeRecord, 'id' | 'archetype' | 'anchorXZ'>[]
  vectors: ReadonlyMap<string, Float32Array>
  seed: number
}

export interface RecrystalliseResult {
  targets: Map<string, XZ>
  /** Mean bearing change in radians (how far the world turned). */
  meanTurn: number
  transform: Similarity2D
}

export const MIN_RECRYSTALLISE_NODES = 5

export function recrystallise({ records, vectors, seed }: RecrystalliseInput): RecrystalliseResult {
  const nodes = records.filter((r) => vectors.has(r.id)).sort((a, b) => (a.id < b.id ? -1 : 1))
  if (nodes.length < MIN_RECRYSTALLISE_NODES) {
    throw new Error(`Re-crystallising needs at least ${MIN_RECRYSTALLISE_NODES} embedded nodes (have ${nodes.length})`)
  }
  const data = nodes.map((r) => Array.from(vectors.get(r.id)!))
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors: Math.min(15, nodes.length - 1),
    minDist: 0.25,
    spread: 1,
    random: seededRandom(seed),
  })
  const y = umap.fit(data).map((p) => [p[0], p[1]] as XZ)
  const current = nodes.map((r) => [r.anchorXZ[0], r.anchorXZ[1]] as XZ)
  const T = fitSimilarity(y, current)
  const targets = new Map<string, XZ>()
  let turn = 0
  nodes.forEach((r, i) => {
    const p = applySimilarity(T, y[i])
    const radius = Math.max(minRadiusFor(r.archetype), Math.hypot(r.anchorXZ[0], r.anchorXZ[1]))
    const angle = Math.atan2(p[1], p[0])
    targets.set(r.id, [radius * Math.cos(angle), radius * Math.sin(angle)])
    const before = Math.atan2(r.anchorXZ[1], r.anchorXZ[0])
    turn += Math.abs(Math.atan2(Math.sin(angle - before), Math.cos(angle - before)))
  })
  return { targets, meanTurn: turn / nodes.length, transform: T }
}
