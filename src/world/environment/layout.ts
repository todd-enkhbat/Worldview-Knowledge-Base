import { Color } from 'three'
import { CORE_RADIUS, SPUR_HALF_WIDTH } from '../../domain/placement.ts'
import type { Vec3 } from '../../domain/types.ts'
import {
  CATWALK_WIDTH,
  SPUR_WIDTH,
  type Landing,
  type PathGraph,
  type PresentMark,
  type Spur,
} from '../paths.ts'
import { PALETTE } from './materials.ts'

// Pure layout of every repeated architectural element as instance lists. Components only copy
// these into InstancedMeshes, so the whole world is a handful of draw calls and the layout can
// be unit-tested without a GPU.

const TAU = Math.PI * 2

/** A box instance: unit box scaled by `s`, rotated (Euler order YXZ: tilt `rz` about the box's
 *  own z first, then `ry` about world y), then translated to `p`. Local +x is the long axis. */
export interface BoxInst {
  p: Vec3
  s: Vec3
  ry?: number
  rz?: number
  /** Linear RGB multiplier (instanceColor). */
  c?: Vec3
}

/** A fluted-shaft instance: unit fluted cylinder (base at y = 0) scaled to radius × height. */
export interface ShaftInst {
  x: number
  z: number
  y0: number
  height: number
  radius: number
  tone?: number
}

const lin = (hex: string, k = 1): Vec3 => {
  const c = new Color(hex)
  return [c.r * k, c.g * k, c.b * k]
}
const grey = (k: number): Vec3 => [k, k, k]

export const TONE = {
  wall: grey(1),
  deck: grey(0.82),
  pier: grey(0.9),
  monolith: grey(0.74),
  beam: grey(0.94),
}
export const METAL = {
  brass: lin(PALETTE.brass),
  steel: lin(PALETTE.steel, 0.85),
}
export const EMBER_HDR = (k: number): Vec3 => lin(PALETTE.ember, k)
export const SIGNAL_HDR = (k: number): Vec3 => lin(PALETTE.signal, k)

/** Box whose long axis runs from a to b (thickness h vertical, width w across). */
export function segmentBox(a: Vec3, b: Vec3, h: number, w: number, c?: Vec3, extend = 0): BoxInst {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const dz = b[2] - a[2]
  const horiz = Math.hypot(dx, dz)
  const len = Math.hypot(horiz, dy)
  return {
    p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
    s: [len + extend, h, w],
    ry: -Math.atan2(dz, dx),
    rz: Math.atan2(dy, horiz),
    c,
  }
}

/** Box spanning radii [r0, r1] along azimuth φ, vertical extent [y0, y1], width w across. */
export function radialBox(phi: number, r0: number, r1: number, y0: number, y1: number, w: number, c?: Vec3): BoxInst {
  const rm = (r0 + r1) / 2
  return {
    p: [rm * Math.cos(phi), (y0 + y1) / 2, rm * Math.sin(phi)],
    s: [Math.abs(r1 - r0), Math.abs(y1 - y0), w],
    ry: -phi,
    c,
  }
}

/** Box centred on radius r at azimuth φ with its long axis tangential. */
export function tangentialBox(phi: number, r: number, y0: number, y1: number, len: number, depth: number, c?: Vec3): BoxInst {
  return {
    p: [r * Math.cos(phi), (y0 + y1) / 2, r * Math.sin(phi)],
    s: [len, Math.abs(y1 - y0), depth],
    ry: -(phi + Math.PI / 2),
    c,
  }
}

function polar(phi: number, r: number, y: number): Vec3 {
  return [r * Math.cos(phi), y, r * Math.sin(phi)]
}

/** Small deterministic hash in [0, 1). */
export function hash01(n: number): number {
  let x = (n * 0x9e3779b1) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}

// ─── static architecture ────────────────────────────────────────────────────────────────

export const CORE_FLUTES = 36
/** The colonnade stands well outside the outermost node ring (entities, r 50 ± 2.5), so it
 *  frames the nodes from any orbit instead of caging them. */
export const PERISTYLE_RADIUS = 96
export const PERISTYLE_COLUMNS = 24
export const COLUMN_RADIUS = 2.1
/** Ground colonnade height, in years of pitch: it frames the base, never the column of time. */
export const STOA_YEARS = 3
/** Every n-th column keeps rising as a free-standing pylon, collared every TIER_YEARS. */
export const PYLON_EVERY = 4
export const TIER_YEARS = 4

export interface Architecture {
  /** Height of the world's crown (core top). */
  top: number
  core: { y0: number; height: number }
  shafts: ShaftInst[]
  boxes: BoxInst[]
  /** Short cylinders: base drums and the core crown (unit cylinder, base at y = 0). */
  drums: ShaftInst[]
  emissive: BoxInst[]
}

interface MonolithSpec {
  deg: number
  r: number
  w: number
  /** Height: > 2 is absolute, ≤ 2 is a fraction of the world top. */
  h: number
  d: number
  y0?: number
  tilt?: number
  /** Cantilevered slabs: [height fraction, length inwards, width]. */
  cant?: [number, number, number][]
}

const MONOLITHS: MonolithSpec[] = [
  { deg: 18, r: 172, w: 16, h: 1.06, d: 54, cant: [[0.62, 64, 18]] },
  { deg: 74, r: 236, w: 74, h: 0.55, d: 22 },
  { deg: 138, r: 162, w: 22, h: 0.86, d: 24, tilt: 0.045, cant: [[0.5, 46, 12]] },
  { deg: 203, r: 270, w: 116, h: 116, d: 116, y0: -42 },
  { deg: 252, r: 178, w: 14, h: 1.22, d: 42, cant: [[0.38, 58, 16], [0.81, 40, 14]] },
  { deg: 308, r: 214, w: 50, h: 0.42, d: 50 },
  { deg: 344, r: 138, w: 128, h: 9, d: 6 },
]

export function buildArchitecture(helixTop: number, pitch: number): Architecture {
  const tier = TIER_YEARS * pitch
  const tiers = Math.max(2, Math.ceil((helixTop + pitch) / tier))
  const top = tiers * tier
  const shafts: ShaftInst[] = []
  const boxes: BoxInst[] = []
  const drums: ShaftInst[] = []
  const emissive: BoxInst[] = []

  // Core: a fluted drum from below the floor to above the crown.
  const core = { y0: -1, height: top + 9 }
  drums.push({ x: 0, z: 0, y0: top + 6, height: 3.2, radius: CORE_RADIUS + 1.3, tone: 0.92 })
  drums.push({ x: 0, z: 0, y0: top + 9.2, height: 1.1, radius: CORE_RADIUS + 0.5, tone: 0.86 })
  drums.push({ x: 0, z: 0, y0: -0.6, height: 1.05, radius: 9.8, tone: 0.8 })
  drums.push({ x: 0, z: 0, y0: -0.6, height: 1.6, radius: 8.4, tone: 0.86 })
  // Crown oculus: an ember ring on the crown's top edge.
  const oculusN = 48
  const oculusR = CORE_RADIUS + 0.9
  for (let i = 0; i < oculusN; i++) {
    const a = (i / oculusN) * TAU
    emissive.push(tangentialBox(a, oculusR, top + 10.3, top + 10.42, (TAU * oculusR) / oculusN + 0.02, 0.16, EMBER_HDR(5)))
  }

  // Peristyle: a single ground colonnade (stoa) carrying a ring-beam entablature. Above it
  // only a few pylons keep rising, collared at every tier like a ruler of years, each with a
  // cantilevered slab. A full-height cage of tiers occluded every node from a wide shot.
  const bay = TAU / PERISTYLE_COLUMNS
  const chord = 2 * PERISTYLE_RADIUS * Math.sin(bay / 2)
  const stoaTop = STOA_YEARS * pitch
  const plinthTop = 1.2
  const capBottom = stoaTop - 3.4
  const beamBottom = stoaTop - 2.4
  for (let i = 0; i < PERISTYLE_COLUMNS; i++) {
    const a = (i + 0.5) * bay
    const x = PERISTYLE_RADIUS * Math.cos(a)
    const z = PERISTYLE_RADIUS * Math.sin(a)
    const tone = 0.88 + hash01(i * 131 + 7) * 0.18
    boxes.push({ p: [x, 0.6, z], s: [5.4, 1.2, 5.4], ry: -a, c: TONE.beam })
    const pylon = i % PYLON_EVERY === 0
    if (!pylon) {
      shafts.push({ x, z, y0: plinthTop, height: capBottom - plinthTop, radius: COLUMN_RADIUS, tone })
      boxes.push({ p: [x, capBottom + 0.5, z], s: [5.8, 1.0, 5.8], ry: -a, c: TONE.beam })
    } else {
      // Pylon heights step between 45 % and 95 % of the crown, so the skyline is irregular.
      const k = i / PYLON_EVERY
      const h = Math.max(stoaTop + tier, Math.round((0.45 + 0.5 * hash01(k * 31 + 11)) * top / tier) * tier)
      shafts.push({ x, z, y0: plinthTop, height: h - plinthTop, radius: COLUMN_RADIUS * 1.15, tone })
      for (let y = tier; y < h - 1; y += tier) drums.push({ x, z, y0: y - 0.6, height: 1.2, radius: COLUMN_RADIUS * 1.15 + 0.45, tone: 0.84 })
      boxes.push({ p: [x, h + 0.6, z], s: [6.4, 1.2, 6.4], ry: -a, c: TONE.beam })
      emissive.push({ p: [x, h + 1.55, z], s: [0.7, 0.7, 0.7], c: SIGNAL_HDR(9) })
      // One slab cantilevered inwards off the pylon; it stops far outside the node rings.
      const yc = Math.max(stoaTop + tier, Math.round((0.35 + 0.4 * hash01(k * 17 + 3)) * h / tier) * tier) - 0.6
      if (yc < h - tier / 2) boxes.push(radialBox(a, PERISTYLE_RADIUS - 20, PERISTYLE_RADIUS + 3, yc - 1.6, yc, 7.5, TONE.monolith))
    }
    // Entablature over the bay to the next column.
    const am = (i + 1) * bay
    boxes.push(tangentialBox(am, PERISTYLE_RADIUS * Math.cos(bay / 2), beamBottom, stoaTop, chord + 5.2, 2.8, TONE.beam))
  }

  // Monoliths and their cantilevers.
  for (const m of MONOLITHS) {
    const a = (m.deg * Math.PI) / 180
    const h = m.h > 2 ? m.h : m.h * top
    const y0 = m.y0 ?? -1
    const b = radialBox(a, m.r - m.d / 2, m.r + m.d / 2, y0, y0 + h, m.w, TONE.monolith)
    if (m.tilt) b.rz = m.tilt
    boxes.push(b)
    for (const [f, len, w] of m.cant ?? []) {
      const y = y0 + f * h
      boxes.push(radialBox(a, m.r - m.d / 2 - len, m.r - m.d / 2 + 2, y - 3.2, y, w, TONE.monolith))
    }
    if (h > 40) emissive.push({ p: polar(a, m.r - m.d / 2 - 0.2, y0 + h - 2), s: [0.5, 0.5, 0.5], c: SIGNAL_HDR(9) })
  }

  return { top, core, shafts, boxes, drums, emissive }
}

// ─── catwalk ────────────────────────────────────────────────────────────────────────────

export type DeckKind = 'ramp' | 'landing' | 'present'

export interface DeckPiece {
  y0: number
  y1: number
  kind: DeckKind
  outerR: number
  /** Outer edge treatment: curb + railing, solid parapet, or flush (spur attachment). */
  outer: 'rail' | 'wall' | 'open'
}

export const INNER_R_OFFSET = CATWALK_WIDTH / 2

/** Height half-gap cut into the outer railing / parapet where a spur leaves the catwalk. */
export function spurGapHalfY(spur: Spur, g: PathGraph): number {
  const angle = (SPUR_HALF_WIDTH + 0.14) / spur.edgeRadius
  return (angle * g.helix.pitch) / TAU
}

/** Splits the helix into deck pieces by landing spans and spur gaps. */
export function deckPieces(g: PathGraph): DeckPiece[] {
  const h = g.helix
  const cuts = new Set<number>([h.yMin, h.yMax])
  const landingSpans = g.landings.map((l) => l.span)
  for (const [a, b] of landingSpans) cuts.add(a).add(b)
  cuts.add(g.present.span[0]).add(g.present.span[1])
  const gaps: [number, number][] = g.spurs.map((s) => {
    const hg = spurGapHalfY(s, g)
    return [s.attachY - hg, s.attachY + hg]
  })
  for (const [a, b] of gaps) cuts.add(Math.max(h.yMin, a)).add(Math.min(h.yMax, b))
  const ys = [...cuts].filter((y) => y >= h.yMin && y <= h.yMax).sort((a, b) => a - b)

  const rampOuter = h.radius + INNER_R_OFFSET
  const inSpan = (y: number, spans: readonly (readonly [number, number])[]) => {
    for (const [a, b] of spans) if (y > a && y < b) return true
    return false
  }
  const pieces: DeckPiece[] = []
  for (let i = 0; i + 1 < ys.length; i++) {
    const y0 = ys[i]
    const y1 = ys[i + 1]
    if (y1 - y0 < 1e-6) continue
    const mid = (y0 + y1) / 2
    const gap = inSpan(mid, gaps)
    let kind: DeckKind = 'ramp'
    let outerR = rampOuter
    if (mid > g.present.span[0] && mid < g.present.span[1]) {
      kind = 'present'
      outerR = g.present.outerRadius
    } else if (inSpan(mid, landingSpans)) {
      kind = 'landing'
      outerR = g.landings[0]?.outerRadius ?? rampOuter
    }
    const outer = gap ? 'open' : kind === 'ramp' ? 'rail' : 'wall'
    const prev = pieces[pieces.length - 1]
    if (prev && prev.kind === kind && prev.outer === outer && Math.abs(prev.y1 - y0) < 1e-9) prev.y1 = y1
    else pieces.push({ y0, y1, kind, outerR, outer })
  }
  return pieces
}

export interface CatwalkInstances {
  /** Concrete: spur decks, stair treads and stringers, platforms, piers, plinth. */
  boxes: BoxInst[]
  /** Metal: railing posts (steel) and spur handrails (brass). */
  metal: BoxInst[]
  /** HDR emitters: Present strip, mast and core ring, landing slots, spur thresholds. */
  emissive: BoxInst[]
}

const POST_SPACING = 1.8
const RAIL_HEIGHT = 1.05

export function buildCatwalkInstances(g: PathGraph, pieces: readonly DeckPiece[], emptyWorld: boolean): CatwalkInstances {
  const h = g.helix
  const boxes: BoxInst[] = []
  const metal: BoxInst[] = []
  const emissive: BoxInst[] = []
  const innerR = h.radius - INNER_R_OFFSET

  // Railing posts on the curbs: inner edge everywhere, outer edge on railed ramp pieces.
  const postAt = (r: number, y: number) => {
    const a = h.angleAtY(y)
    metal.push({ p: polar(a, r, y + 0.1 + (RAIL_HEIGHT - 0.1) / 2), s: [0.055, RAIL_HEIGHT - 0.1, 0.055], ry: -a, c: METAL.steel })
  }
  for (const p of pieces) {
    const rails: number[] = [innerR + 0.07]
    if (p.outer === 'rail') rails.push(p.outerR - 0.07)
    for (const r of rails) {
      const dy = POST_SPACING / Math.hypot((r * TAU) / h.pitch, 1)
      const n = Math.max(1, Math.round((p.y1 - p.y0) / dy))
      for (let i = r === rails[0] ? 1 : 0; i <= n; i++) postAt(r, p.y0 + ((p.y1 - p.y0) * i) / n)
    }
  }

  // Spurs.
  for (const s of g.spurs) addSpur(s, boxes, metal, emissive)

  // Year landings: an ember slot under the engraved numeral on the parapet face.
  for (const l of g.landings) addLandingSlot(l, emissive)

  // The Present: ember strip along the inner curb, a light mast, and a ring on the core.
  addPresent(g, emissive, boxes, emptyWorld)

  return { boxes, metal, emissive }
}

function addLandingSlot(l: Landing, emissive: BoxInst[]): void {
  emissive.push(tangentialBox(l.angle, l.outerRadius + 0.015, l.y - 1.32, l.y - 1.27, 2.4, 0.03, EMBER_HDR(3.2)))
}

function addSpur(s: Spur, boxes: BoxInst[], metal: BoxInst[], emissive: BoxInst[]): void {
  const phi = s.attachAngle
  const yA = s.attachY
  const yE = s.to[1]
  const w = SPUR_WIDTH
  // Deck.
  if (s.deckEndRadius - s.edgeRadius > 0.01) {
    boxes.push(radialBox(phi, s.edgeRadius - 0.05, s.deckEndRadius, yA - 0.42, yA, w, TONE.deck))
    // Downstand edge beams give the thin deck some mass.
    const t: Vec3 = [-Math.sin(phi), 0, Math.cos(phi)]
    for (const side of [-1, 1]) {
      const b = radialBox(phi, s.edgeRadius - 0.05, s.deckEndRadius, yA - 0.95, yA - 0.42, 0.3, TONE.deck)
      const o = side * (w / 2 - 0.15)
      b.p = [b.p[0] + t[0] * o, b.p[1], b.p[2] + t[2] * o]
      boxes.push(b)
    }
  }
  // Stair: floating treads on a raking stringer.
  if (s.hasStair) {
    const run = s.stairEndRadius - s.deckEndRadius
    const dy = yE - yA
    const n = Math.max(2, Math.round(Math.abs(dy) / 0.19))
    const tread = run / n
    const rise = dy / n
    for (let i = 0; i < n; i++) {
      const top = yA + rise * (i + 1)
      const r0 = s.deckEndRadius + i * tread
      boxes.push(radialBox(phi, r0 - 0.01, r0 + tread + 0.01, top - 0.16, top, w - 0.2, TONE.deck))
    }
    const a = polar(phi, s.deckEndRadius, yA - 0.42)
    const b = polar(phi, s.stairEndRadius, yE - 0.42)
    boxes.push(segmentBox(a, b, 0.34, w - 0.5, TONE.pier, 0.2))
    // Platform at node height.
    boxes.push(radialBox(phi, s.stairEndRadius, s.endRadius, yE - 0.5, yE, w, TONE.deck))
  }
  // Pier: a concrete block under the platform, deep enough to read as the stair's support.
  const pierTop = yE - 0.5
  const pierBottom = Math.min(yA, yE) - 2.6
  boxes.push(radialBox(phi, s.endRadius - 1.5, s.endRadius + 0.1, pierBottom, pierTop, 1.5, TONE.pier))

  // Handrails: brass top rail per segment, steel posts at segment ends, both sides.
  const t: Vec3 = [-Math.sin(phi), 0, Math.cos(phi)]
  const segs: [Vec3, Vec3][] = []
  const pDeck0 = polar(phi, s.edgeRadius, yA)
  const pDeck1 = polar(phi, s.deckEndRadius, yA)
  const pEnd = polar(phi, s.endRadius, yE)
  if (s.hasStair) {
    const pStair1 = polar(phi, s.stairEndRadius, yE)
    if (s.deckEndRadius - s.edgeRadius > 0.05) segs.push([pDeck0, pDeck1])
    segs.push([pDeck1, pStair1], [pStair1, pEnd])
  } else segs.push([pDeck0, pEnd])
  for (const side of [-1, 1]) {
    const o = side * (w / 2 - 0.06)
    const off = (p: Vec3, dy: number): Vec3 => [p[0] + t[0] * o, p[1] + dy, p[2] + t[2] * o]
    for (const [a, b] of segs) {
      metal.push(segmentBox(off(a, RAIL_HEIGHT), off(b, RAIL_HEIGHT), 0.05, 0.06, METAL.brass, 0.05))
      metal.push(segmentBox(off(a, 0.55), off(b, 0.55), 0.028, 0.028, METAL.brass))
      const pa = off(a, RAIL_HEIGHT / 2)
      metal.push({ p: pa, s: [0.055, RAIL_HEIGHT, 0.055], ry: -phi, c: METAL.steel })
    }
    metal.push({ p: off(pEnd, RAIL_HEIGHT / 2), s: [0.055, RAIL_HEIGHT, 0.055], ry: -phi, c: METAL.steel })
  }
  // Threshold: an ember line where the platform ends in front of the memory.
  emissive.push(tangentialBox(phi, s.endRadius - 0.06, yE + 0.005, yE + 0.03, w - 0.3, 0.06, EMBER_HDR(3.5)))
}

function addPresent(g: PathGraph, emissive: BoxInst[], boxes: BoxInst[], emptyWorld: boolean): void {
  const h = g.helix
  const p: PresentMark = g.present
  const r = h.radius - INNER_R_OFFSET + 0.07
  const n = 16
  for (let i = 0; i < n; i++) {
    const ya = p.span[0] + ((p.span[1] - p.span[0]) * i) / n
    const yb = p.span[0] + ((p.span[1] - p.span[0]) * (i + 1)) / n
    const a = polar(h.angleAtY(ya), r, ya + 0.115)
    const b = polar(h.angleAtY(yb), r, yb + 0.115)
    emissive.push(segmentBox(a, b, 0.025, 0.09, EMBER_HDR(6), 0.01))
  }
  // Light mast at the parapet, visible from anywhere in the world.
  emissive.push({ p: polar(p.angle, p.outerRadius - 0.16, p.y + 4.3), s: [0.12, 7, 0.12], ry: -p.angle, c: EMBER_HDR(7) })
  // Ring on the core at the present height.
  const ringN = 40
  const ringR = CORE_RADIUS + 0.06
  for (let i = 0; i < ringN; i++) {
    const a = (i / ringN) * TAU
    emissive.push(tangentialBox(a, ringR, p.y - 0.08, p.y + 0.08, (TAU * ringR) / ringN + 0.02, 0.12, EMBER_HDR(5)))
  }
  if (emptyWorld) {
    const pl = presentPlinth(g)
    boxes.push(radialBox(p.angle, pl.r - 0.5, pl.r + 0.5, p.y - 0.4, p.y + 1.15, 1.9, TONE.wall))
  }
}

/** Where the "add your first memory" plinth stands on the Present landing. */
export function presentPlinth(g: PathGraph): { r: number; angle: number; y: number; top: number } {
  const p = g.present
  return { r: p.outerRadius - 0.95, angle: p.angle, y: p.y, top: p.y + 1.15 }
}

// ─── labels ─────────────────────────────────────────────────────────────────────────────

export interface LabelPlacement {
  position: Vec3
  /** Basis columns (x = text right, y = text up, z = facing). */
  x: Vec3
  y: Vec3
  z: Vec3
}

/** Vertical text on a surface facing outward (radially) at azimuth θ. */
export function outwardLabel(theta: number, r: number, y: number): LabelPlacement {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  return { position: [r * c, y, r * s], x: [s, 0, -c], y: [0, 1, 0], z: [c, 0, s] }
}

/** Vertical text facing the core axis (inward) at azimuth θ. */
export function inwardLabel(theta: number, r: number, y: number): LabelPlacement {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  return { position: [r * c, y, r * s], x: [-s, 0, c], y: [0, 1, 0], z: [-c, 0, -s] }
}

/**
 * Text lying on the sloped deck at radius r, readable by someone walking up the helix
 * (text up = direction of travel, text right = towards the core).
 */
export function deckLabel(theta: number, r: number, y: number, pitch: number, lift = 0.012): LabelPlacement {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const k = pitch / TAU
  const fl = Math.hypot(r, k)
  const f: Vec3 = [(-r * s) / fl, k / fl, (r * c) / fl]
  const right: Vec3 = [-c, 0, -s]
  // normal = right × f (points up).
  const nx = right[1] * f[2] - right[2] * f[1]
  const ny = right[2] * f[0] - right[0] * f[2]
  const nz = right[0] * f[1] - right[1] * f[0]
  const nl = Math.hypot(nx, ny, nz) || 1
  const n: Vec3 = [nx / nl, ny / nl, nz / nl]
  return { position: [r * c + n[0] * lift, y + n[1] * lift, r * s + n[2] * lift], x: right, y: f, z: n }
}
