import type { NodeRecord } from '../../domain/types.ts'

// Field layout (milestone 2): where each note sits on the ground of the particle world. No
// archetype rings and no time axis: a deterministic force layout in which links and shared
// tags pull notes together, semantic neighbours attract when the embedding index is on, and
// every pair repels. It starts from the frozen anchors (so the world's shape survives a
// reload) and warm-starts from the previous layout when notes are added, so keeping a note
// nudges its neighbourhood instead of reshuffling the world. Pure: same input, same output.

export type XZ = [number, number]

export interface FieldLayoutInput {
  records: readonly NodeRecord[]
  /** Unit embeddings by id (semantic index), when available. */
  vectors?: ReadonlyMap<string, Float32Array>
  /** The previous layout, to warm-start from. */
  previous?: ReadonlyMap<string, XZ>
}

const LINK_REST = 16
const TAG_REST = 24
const SEM_REST = 14
const SEM_K = 4
const REPULSE = 700
const GRAVITY = 0.004
/** Anchors live on rings of radius ~13–90 u; the field starts from them, scaled down. */
const ANCHOR_SCALE = 0.45

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** fnv1a of the id, for a stable jitter when two notes start on the same spot. */
function hash(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193)
  return h >>> 0
}

export function computeFieldLayout({ records, vectors, previous }: FieldLayoutInput): Map<string, XZ> {
  const live = records.filter((r) => r.deletedAt === null).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const n = live.length
  const out = new Map<string, XZ>()
  if (!n) return out
  const idx = new Map(live.map((r, i) => [r.id, i]))
  const x = new Float64Array(n)
  const z = new Float64Array(n)
  let warm = 0
  for (let i = 0; i < n; i++) {
    const r = live[i]
    const prev = previous?.get(r.id)
    const h = hash(r.id)
    const jx = ((h & 0xffff) / 0xffff - 0.5) * 2
    const jz = ((h >>> 16) / 0xffff - 0.5) * 2
    if (prev) {
      x[i] = prev[0]
      z[i] = prev[1]
      warm++
    } else {
      x[i] = r.anchorXZ[0] * ANCHOR_SCALE + jx
      z[i] = r.anchorXZ[1] * ANCHOR_SCALE + jz
    }
  }

  // Springs: links (strong), shared tags (weak), semantic neighbours (medium).
  const springs: { a: number; b: number; rest: number; k: number }[] = []
  for (const r of live) {
    const a = idx.get(r.id)!
    for (const l of r.links) {
      const b = idx.get(l.targetId)
      if (b !== undefined && b !== a) springs.push({ a, b, rest: LINK_REST, k: l.kind === 'relates' ? 0.05 : 0.08 })
    }
  }
  const byTag = new Map<string, number[]>()
  live.forEach((r, i) => r.tags.forEach((t) => (byTag.get(t) ?? byTag.set(t, []).get(t)!).push(i)))
  for (const members of byTag.values()) {
    if (members.length < 2 || members.length > 40) continue
    for (let p = 0; p < members.length; p++) for (let q = p + 1; q < members.length; q++) springs.push({ a: members[p], b: members[q], rest: TAG_REST, k: 0.012 })
  }
  if (vectors?.size) {
    for (let i = 0; i < n; i++) {
      const vi = vectors.get(live[i].id)
      if (!vi) continue
      const sims: { j: number; s: number }[] = []
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        const vj = vectors.get(live[j].id)
        if (vj) sims.push({ j, s: dot(vi, vj) })
      }
      sims.sort((p, q) => q.s - p.s)
      for (const { j, s } of sims.slice(0, SEM_K)) if (s > 0.3 && i < j) springs.push({ a: i, b: j, rest: SEM_REST * (1.6 - s), k: 0.03 * s })
    }
  }

  // Fewer steps when most notes already have a place; fewer still for big worlds.
  const fresh = n - warm
  const cold = fresh > n / 2
  const iters = Math.round((cold ? 320 : 90) * Math.min(1, 400 / n))
  // A warm start runs cooler: settle the newcomers, leave the rest where people know them.
  const heat = cold ? 1 : 0.3
  const fx = new Float64Array(n)
  const fz = new Float64Array(n)
  for (let it = 0; it < iters; it++) {
    const step = (0.9 * (1 - it / iters) + 0.05) * heat
    fx.fill(0)
    fz.fill(0)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = x[i] - x[j]
        let dz = z[i] - z[j]
        let d2 = dx * dx + dz * dz
        if (d2 < 1e-6) {
          dx = ((i * 7919 + j) % 13) / 13 - 0.5
          dz = ((j * 104729 + i) % 17) / 17 - 0.5
          d2 = dx * dx + dz * dz
        }
        if (d2 > 160 * 160) continue
        const f = REPULSE / (d2 + 4)
        const d = Math.sqrt(d2)
        fx[i] += (dx / d) * f
        fz[i] += (dz / d) * f
        fx[j] -= (dx / d) * f
        fz[j] -= (dz / d) * f
      }
    }
    for (const s of springs) {
      const dx = x[s.b] - x[s.a]
      const dz = z[s.b] - z[s.a]
      const d = Math.hypot(dx, dz) || 1e-3
      const f = s.k * (d - s.rest)
      fx[s.a] += (dx / d) * f
      fz[s.a] += (dz / d) * f
      fx[s.b] -= (dx / d) * f
      fz[s.b] -= (dz / d) * f
    }
    for (let i = 0; i < n; i++) {
      fx[i] -= x[i] * GRAVITY * 10
      fz[i] -= z[i] * GRAVITY * 10
      // Cap the move per step so the layout cools smoothly.
      const m = Math.hypot(fx[i], fz[i])
      const cap = 4 * step
      const k = m > cap ? cap / m : 1
      x[i] += fx[i] * k * step
      z[i] += fz[i] * k * step
    }
  }
  // Room to breathe: a note's cloud and rise are ~10–20 u across, so a big world would pack
  // them into one blur. Scale the map (shape unchanged) so the median distance to the nearest
  // neighbour is at least MIN_SPACING. Small worlds are already wider and are left alone.
  const k = spacingScale(x, z)
  for (let i = 0; i < n; i++) out.set(live[i].id, [Math.round(x[i] * k * 1000) / 1000, Math.round(z[i] * k * 1000) / 1000])
  return out
}

const MIN_SPACING = 18

/** Factor that lifts the median nearest-neighbour distance to MIN_SPACING (≥ 1). */
export function spacingScale(x: ArrayLike<number>, z: ArrayLike<number>): number {
  const n = x.length
  if (n < 3) return 1
  // Sample up to 400 notes: the median is stable and this stays O(400·n).
  const step = Math.max(1, Math.floor(n / 400))
  const nn: number[] = []
  for (let i = 0; i < n; i += step) {
    let best = Infinity
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const d = (x[i] - x[j]) ** 2 + (z[i] - z[j]) ** 2
      if (d < best) best = d
    }
    nn.push(Math.sqrt(best))
  }
  nn.sort((a, b) => a - b)
  const median = nn[nn.length >> 1]
  return median > 0 && median < MIN_SPACING ? MIN_SPACING / median : 1
}

/** Centre and radius of a layout (for the camera and the terrain extent). */
export function layoutBounds(layout: ReadonlyMap<string, XZ>): { cx: number; cz: number; radius: number } {
  if (!layout.size) return { cx: 0, cz: 0, radius: 40 }
  let cx = 0
  let cz = 0
  for (const [x, z] of layout.values()) {
    cx += x
    cz += z
  }
  cx /= layout.size
  cz /= layout.size
  let r = 0
  for (const [x, z] of layout.values()) r = Math.max(r, Math.hypot(x - cx, z - cz))
  return { cx, cz, radius: Math.max(30, r) }
}

/**
 * The opening shot over the field: a raised three-quarter view of the whole layout (the land
 * extends a little past the notes), never closer than the cloud heights need.
 */
export function fieldShot(layout: ReadonlyMap<string, XZ>, vfovDeg: number, aspect: number, maxDistance: number): { position: [number, number, number]; target: [number, number, number] } {
  const { cx, cz, radius } = layoutBounds(layout)
  const half = Math.tan((vfovDeg * Math.PI) / 360)
  const elevation = 0.62
  const azimuth = 0.7
  const fit = (radius * 1.15) / (half * Math.min(1, aspect))
  const d = Math.min(maxDistance, Math.max(60, fit))
  const ty = 6
  return {
    target: [cx, ty, cz],
    position: [cx + Math.cos(azimuth) * Math.cos(elevation) * d, ty + Math.sin(elevation) * d, cz + Math.sin(azimuth) * Math.cos(elevation) * d],
  }
}
