import { BufferGeometry, Float32BufferAttribute, ShapeUtils, Vector2 } from 'three'

// Procedural geometry for the architecture: fluted shafts and profiles swept along the helix.
// Builders emit one BufferGeometry per call so a whole catwalk is one draw call.

const TAU = Math.PI * 2

/**
 * Unit fluted cylinder: radius 1, height 1, base at y = 0. Concave (Doric) flutes meet in sharp
 * arrises; each flute has its own vertices so the arrises stay crisp. Scale per instance.
 */
export function createFlutedCylinderGeometry({
  flutes = 20,
  depth = 0.06,
  segmentsPerFlute = 6,
  caps = true,
}: { flutes?: number; depth?: number; segmentsPerFlute?: number; caps?: boolean } = {}): BufferGeometry {
  const pos: number[] = []
  const nrm: number[] = []
  const idx: number[] = []
  const dTheta = TAU / flutes
  for (let f = 0; f < flutes; f++) {
    const base = pos.length / 3
    for (let j = 0; j <= segmentsPerFlute; j++) {
      const u = j / segmentsPerFlute
      const th = (f + u) * dTheta
      // Scallop r(u) = 1 − d·sin(πu); dr/dθ = −d·π·cos(πu) / dθ.
      const r = 1 - depth * Math.sin(Math.PI * u)
      const drdth = (-depth * Math.PI * Math.cos(Math.PI * u)) / dTheta
      const c = Math.cos(th)
      const s = Math.sin(th)
      // Outward normal of the curve p(θ) = r(θ)(cos θ, sin θ).
      const tx = drdth * c - r * s
      const tz = drdth * s + r * c
      let nx = tz
      let nz = -tx
      const l = Math.hypot(nx, nz) || 1
      nx /= l
      nz /= l
      pos.push(r * c, 0, r * s, r * c, 1, r * s)
      nrm.push(nx, 0, nz, nx, 0, nz)
    }
    for (let j = 0; j < segmentsPerFlute; j++) {
      const a = base + j * 2
      const b = a + 2
      // a: bottom j, a+1: top j, b: bottom j+1, b+1: top j+1 (θ increasing).
      idx.push(a, a + 1, b, b, a + 1, b + 1)
    }
  }
  if (caps) {
    for (const [y, ny] of [
      [1, 1],
      [0, -1],
    ] as const) {
      const center = pos.length / 3
      pos.push(0, y, 0)
      nrm.push(0, ny, 0)
      const ring = pos.length / 3
      const n = flutes * segmentsPerFlute
      for (let k = 0; k < n; k++) {
        const u = (k % segmentsPerFlute) / segmentsPerFlute
        const th = (k / n) * TAU
        const r = 1 - depth * Math.sin(Math.PI * u)
        pos.push(r * Math.cos(th), y, r * Math.sin(th))
        nrm.push(0, ny, 0)
      }
      for (let k = 0; k < n; k++) {
        const a = ring + k
        const b = ring + ((k + 1) % n)
        if (ny > 0) idx.push(center, b, a)
        else idx.push(center, a, b)
      }
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new Float32BufferAttribute(nrm, 3))
  g.setIndex(idx)
  g.computeBoundingSphere()
  return g
}

// ─── helix sweeps ───────────────────────────────────────────────────────────────────────

/** Closed polygon in the radial plane: [radius, height above the walking surface]. */
export type Profile = readonly (readonly [number, number])[]

export interface SweepHelix {
  radius: number
  pitch: number
  phase0: number
}

/** Accumulates swept pieces into one indexed geometry. */
export class SweepBuilder {
  readonly pos: number[] = []
  readonly nrm: number[] = []
  readonly idx: number[] = []
  private readonly h: SweepHelix
  private readonly samplesPerTurn: number

  constructor(h: SweepHelix, samplesPerTurn = 64) {
    this.h = h
    this.samplesPerTurn = samplesPerTurn
  }

  private angle(y: number): number {
    return this.h.phase0 + (TAU * y) / this.h.pitch
  }

  /**
   * Sweeps `profile` along the helix from y0 to y1. Each polygon edge gets its own vertex strip
   * (hard edges); `caps` closes both ends.
   */
  sweep(profile: Profile, y0: number, y1: number, caps = true): void {
    if (!(y1 > y0)) return
    const poly = ccw(profile)
    const n = Math.max(2, Math.ceil(((y1 - y0) / this.h.pitch) * this.samplesPerTurn) + 1)
    const ang: number[] = []
    const ys: number[] = []
    for (let i = 0; i < n; i++) {
      const y = y0 + ((y1 - y0) * i) / (n - 1)
      ys.push(y)
      ang.push(this.angle(y))
    }
    const m = poly.length
    for (let j = 0; j < m; j++) {
      const [ra, za] = poly[j]
      const [rb, zb] = poly[(j + 1) % m]
      const er = rb - ra
      const ez = zb - za
      const el = Math.hypot(er, ez) || 1
      // Outward normal of a CCW polygon edge in the (r, z) plane.
      const nr = ez / el
      const nz = -er / el
      const base = this.pos.length / 3
      for (let i = 0; i < n; i++) {
        const c = Math.cos(ang[i])
        const s = Math.sin(ang[i])
        this.pos.push(ra * c, ys[i] + za, ra * s, rb * c, ys[i] + zb, rb * s)
        this.nrm.push(nr * c, nz, nr * s, nr * c, nz, nr * s)
      }
      for (let i = 0; i + 1 < n; i++) {
        const a = base + i * 2
        const b = a + 1
        const a2 = a + 2
        const b2 = a + 3
        this.idx.push(a, b, a2, b, b2, a2)
      }
    }
    if (caps) {
      this.cap(poly, y0, -1)
      this.cap(poly, y1, 1)
    }
  }

  private cap(poly: Profile, y: number, dir: 1 | -1): void {
    const a = this.angle(y)
    const c = Math.cos(a)
    const s = Math.sin(a)
    // Tangent direction in XZ (the slope is ignored for the cap normal).
    const tx = -s * dir
    const tz = c * dir
    const contour = poly.map(([r, z]) => new Vector2(r, z))
    const tris = ShapeUtils.triangulateShape(contour, [])
    const base = this.pos.length / 3
    for (const [r, z] of poly) {
      this.pos.push(r * c, y + z, r * s)
      this.nrm.push(tx, 0, tz)
    }
    for (const t of tris) {
      const [i0, i1, i2] = t
      // Orient each triangle so its face normal matches the cap direction.
      const p0 = base + i0
      const p1 = base + i1
      const p2 = base + i2
      const ax = this.pos[p1 * 3] - this.pos[p0 * 3]
      const ay = this.pos[p1 * 3 + 1] - this.pos[p0 * 3 + 1]
      const az = this.pos[p1 * 3 + 2] - this.pos[p0 * 3 + 2]
      const bx = this.pos[p2 * 3] - this.pos[p0 * 3]
      const by = this.pos[p2 * 3 + 1] - this.pos[p0 * 3 + 1]
      const bz = this.pos[p2 * 3 + 2] - this.pos[p0 * 3 + 2]
      const cx = ay * bz - az * by
      const cz = ax * by - ay * bx
      if (cx * tx + cz * tz >= 0) this.idx.push(p0, p1, p2)
      else this.idx.push(p0, p2, p1)
    }
  }

  build(): BufferGeometry {
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new Float32BufferAttribute(this.nrm, 3))
    g.setIndex(this.idx)
    g.computeBoundingSphere()
    g.computeBoundingBox()
    return g
  }
}

function ccw(p: Profile): Profile {
  let area = 0
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i]
    const [x1, y1] = p[(i + 1) % p.length]
    area += x0 * y1 - x1 * y0
  }
  return area >= 0 ? p : [...p].reverse()
}

// ─── catwalk profiles ───────────────────────────────────────────────────────────────────

export type OuterEdge = 'rail' | 'wall' | 'open'

export interface DeckProfileOptions {
  innerR: number
  outerR: number
  /** Slab thickness under the walking surface. */
  depth: number
  /** Outer downstand beam (fascia): total depth and width. */
  fasciaDepth: number
  fasciaWidth: number
  outer: OuterEdge
  curb?: number
  curbWidth?: number
  wallHeight?: number
  wallWidth?: number
}

/**
 * Deck cross-section: slab, inner curb, outer downstand fascia, and an outer edge that is a
 * curb (railings stand on it), a solid parapet wall (landings) or flush (spur attachments).
 */
export function deckProfile(o: DeckProfileOptions): Profile {
  const curb = o.curb ?? 0.1
  const cw = o.curbWidth ?? 0.14
  const wallH = o.wallHeight ?? 1.05
  const wallW = o.wallWidth ?? 0.32
  const pts: [number, number][] = [
    [o.innerR, -o.depth],
    [o.outerR - o.fasciaWidth, -o.depth],
    [o.outerR - o.fasciaWidth, -o.fasciaDepth],
    [o.outerR, -o.fasciaDepth],
  ]
  if (o.outer === 'wall') pts.push([o.outerR, wallH], [o.outerR - wallW, wallH], [o.outerR - wallW, 0])
  else if (o.outer === 'rail') pts.push([o.outerR, curb], [o.outerR - cw, curb], [o.outerR - cw, 0])
  else pts.push([o.outerR, 0])
  pts.push([o.innerR + cw, 0], [o.innerR + cw, curb], [o.innerR, curb])
  return pts
}

/** Small rectangular rail section centred at (r, z). */
export function railProfile(r: number, z: number, w: number, h: number): Profile {
  return [
    [r - w / 2, z - h / 2],
    [r + w / 2, z - h / 2],
    [r + w / 2, z + h / 2],
    [r - w / 2, z + h / 2],
  ]
}
