import { HELIX_PITCH, HELIX_RADIUS, MAX_ANCHOR_RADIUS, SIGMA, Y_PER_YEAR } from './constants.ts'
import { yOf } from './time.ts'
import type { Archetype, NodeRecord } from './types.ts'

// Deterministic anchor placement (PLAN § Space and time). An anchor is computed once, at
// creation, and persisted; it is never re-derived on load, so later changes to this file
// cannot move existing nodes. The only re-placements are an explicit tag change of that
// one node (replaceOnTagChange) or a drag. Everything here is a pure function of its
// inputs: integer hashes seed the jitter and the search, never Math.random.
//
// Angle convention (shared with the catwalk builder): an XZ point at angle θ and radius r
// is (r·cos θ, r·sin θ); angles are radians in [0, 2π). The helix is
// (HELIX_RADIUS·cos θ(y), y, HELIX_RADIUS·sin θ(y)) with θ(y) = HELIX_PHASE0 + 2π·y / HELIX_PITCH.

export type XZ = [number, number]

const TAU = 2 * Math.PI

/** Radius of the central concrete core cylinder (world units). */
export const CORE_RADIUS = 6
/** Helix angle at y = 0 (T0). The catwalk geometry must use the same phase. */
export const HELIX_PHASE0 = 0
/** Half the pitch: the largest height difference a pier stair takes up. */
export const MAX_STAIR_DY = HELIX_PITCH / 2
/** Half-width of a radial spur deck, used by the core-clearance check. */
export const SPUR_HALF_WIDTH = 1
/** Shortest radial spur we allow between the helix centreline and a memory anchor. */
export const SPUR_MIN_LENGTH = 5
/** Memories must sit outside the catwalk with room for a radial spur. */
export const MEMORY_MIN_RADIUS = HELIX_RADIUS + SPUR_MIN_LENGTH

export const SECTOR_COUNT = 12
export const SECTOR_WIDTH = TAU / SECTOR_COUNT

/**
 * Ring radius per archetype. Memories are innermost but outside the helix (r = 13) so their
 * spurs are short and radial; cold memories barely move, so they can sit close to the
 * walkway. Demons sit just outside the memories (they sort what is around them); then the
 * volatile ideas, lenses, documents, and the heavy entity monoliths on the outer ring where
 * their pull reads across the whole world. Rings are ≥ 4 u apart, more than the radial
 * jitter, so archetypes rarely compete for the same spot.
 */
export const RING_RADIUS: Readonly<Record<Archetype, number>> = {
  memory: 22,
  demon: 26,
  idea: 30,
  lens: 36,
  document: 42,
  entity: 50,
}

/** ± radial jitter around the ring (world units). */
export const RADIAL_JITTER = 2.5
/** Angular jitter spans this fraction of the sector, centred, so nodes stay inside it. */
export const ANGULAR_JITTER_FRACTION = 0.8
/** Placement keeps σ plus this margin so fixed-point conversion cannot push a pair under σ. */
export const PLACEMENT_MARGIN = 0.01
/** Anchors are quantised to 1/1024 u: exact in binary and in any Q-format with ≥ 10 fraction bits. */
export const ANCHOR_QUANTUM = 1 / 1024
/** Vogel-spiral radial step of the nudge search (world units). */
export const SPIRAL_STEP = 0.5
/** Hard cap on nudge candidates (radius SPIRAL_STEP·√cap ≈ 724 u). */
export const MAX_NUDGE_CANDIDATES = 1 << 21

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

// Salts keep the per-id hash streams independent.
const SALT_ANGLE = 0x9e3779b9
const SALT_RADIUS = 0x85ebca6b
const SALT_SPIRAL = 0xc2b2ae35

// ─── hashing ─────────────────────────────────────────────────────────────────────────

const utf8 = new TextEncoder()

/** 32-bit FNV-1a over the UTF-8 bytes of `s` (unsigned). */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5
  for (const b of utf8.encode(s)) {
    h ^= b
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Integer avalanche (lowbias32, C. Wellons): spreads FNV's weak low bits. Unsigned. */
export function mix32(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0
  x = Math.imul(x, 0x7feb352d)
  x = (x ^ (x >>> 15)) >>> 0
  x = Math.imul(x, 0x846ca68b)
  return (x ^ (x >>> 16)) >>> 0
}

/** Uniform in [0, 1) from a seed and a salt. */
export function unitHash(seed: number, salt: number): number {
  return mix32((seed ^ salt) >>> 0) / 0x1_0000_0000
}

// ─── tags and sectors ────────────────────────────────────────────────────────────────

/** Canonical tag form: NFKC, trimmed, lower-case, single spaces, no leading '#'. */
export function normalizeTag(tag: string): string {
  return tag.normalize('NFKC').trim().replace(/^#+/, '').trim().toLowerCase().replace(/\s+/g, ' ')
}

export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = []
  for (const t of tags) {
    const n = normalizeTag(t)
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

/**
 * The tag that decides the sector: the first tag as the user ordered them. Using one
 * user-chosen tag (rather than a hash of the whole set) means adding a secondary tag does not
 * throw the node into an unrelated sector, and nodes sharing a primary tag share a sector.
 */
export function primaryTag(tags: readonly string[]): string | null {
  for (const t of tags) {
    const n = normalizeTag(t)
    if (n) return n
  }
  return null
}

/** Sector index in [0, SECTOR_COUNT): primary-tag hash, or the id hash when untagged. */
export function sectorOf(record: Pick<NodeRecord, 'id' | 'tags'>): number {
  const key = primaryTag(record.tags)
  const h = key === null ? mix32(fnv1a32(record.id)) : mix32(fnv1a32(key))
  return h % SECTOR_COUNT
}

/** Centre angle (radians, [0, 2π)) of the record's sector. */
export function sectorAngle(record: Pick<NodeRecord, 'id' | 'tags'>): number {
  return (sectorOf(record) + 0.5) * SECTOR_WIDTH
}

/** Polar angle of an XZ point in [0, 2π). Used for the catwalk spur rule. */
export function nodeAngle(anchorXZ: readonly [number, number]): number {
  const a = Math.atan2(anchorXZ[1], anchorXZ[0])
  return a < 0 ? a + TAU : a
}

export function radiusOf(anchorXZ: readonly [number, number]): number {
  return Math.hypot(anchorXZ[0], anchorXZ[1])
}

/** Smallest radius an archetype may be placed at (memories stay outside the catwalk). */
export function minRadiusFor(archetype: Archetype): number {
  return archetype === 'memory' ? MEMORY_MIN_RADIUS : 0
}

export function quantize(v: number): number {
  return Math.round(v / ANCHOR_QUANTUM) * ANCHOR_QUANTUM
}

// ─── placement ───────────────────────────────────────────────────────────────────────

export interface PlacedAnchor {
  id: string
  anchorXZ: readonly [number, number]
  /** World height = yOf(temporalOrigin). */
  y: number
}

export interface PlacementOptions {
  T0: number
  yPerYear?: number
}

export type PlacementInput = Pick<NodeRecord, 'id' | 'archetype' | 'tags' | 'temporalOrigin'>

export function anchorY(record: Pick<NodeRecord, 'temporalOrigin'>, opts: PlacementOptions): number {
  return yOf(record.temporalOrigin, opts.T0, opts.yPerYear ?? Y_PER_YEAR)
}

/** Records → placement inputs. Soft-deleted records are skipped unless asked for. */
export function toPlacedAnchors(
  records: readonly NodeRecord[],
  opts: PlacementOptions,
  { includeDeleted = false }: { includeDeleted?: boolean } = {},
): PlacedAnchor[] {
  const out: PlacedAnchor[] = []
  for (const r of records) {
    if (!includeDeleted && r.deletedAt !== null) continue
    out.push({ id: r.id, anchorXZ: r.anchorXZ, y: anchorY(r, opts) })
  }
  return out
}

/** Un-nudged starting point: ring radius ± jitter, sector angle ± jitter (quantised). */
export function basePoint(record: Pick<NodeRecord, 'id' | 'archetype' | 'tags'>): XZ {
  const seed = fnv1a32(record.id)
  const angle =
    sectorAngle(record) + (unitHash(seed, SALT_ANGLE) - 0.5) * ANGULAR_JITTER_FRACTION * SECTOR_WIDTH
  const radius = Math.max(
    minRadiusFor(record.archetype),
    RING_RADIUS[record.archetype] + (unitHash(seed, SALT_RADIUS) * 2 - 1) * RADIAL_JITTER,
  )
  return [quantize(radius * Math.cos(angle)), quantize(radius * Math.sin(angle))]
}

export interface NudgeOptions {
  /** Excluded from `existing` (the node being re-placed or validated). */
  selfId?: string
  /** Seeds the spiral phase so neighbouring nodes nudge in different directions. */
  seed?: number
  /** Candidates closer to the axis than this are skipped. */
  minRadius?: number
  /** Give up (return null) beyond this distance from the start. Default: search to the cap. */
  maxDistance?: number
  /** Required 3D clearance. Default σ + PLACEMENT_MARGIN. */
  spacing?: number
}

/**
 * Deterministic spiral search for the first free spot near `start` at height `y`.
 * Candidate k sits at SPIRAL_STEP·√k along a golden-angle (Vogel) spiral, so the search
 * visits the plane in order of increasing distance with even density. "Free" means ≥ spacing
 * in 3D from every existing anchor, inside MAX_ANCHOR_RADIUS and outside minRadius. The
 * result depends on `existing` only as a set, never on its order.
 */
export function nudgeAnchor(
  start: readonly [number, number],
  y: number,
  existing: readonly PlacedAnchor[],
  opts: NudgeOptions = {},
): XZ | null {
  const spacing = opts.spacing ?? SIGMA + PLACEMENT_MARGIN
  const minRadius = opts.minRadius ?? 0
  const maxDistance = opts.maxDistance ?? Infinity
  const grid = buildGrid(existing, y, spacing, opts.selfId)
  const phase = unitHash(opts.seed ?? 0, SALT_SPIRAL) * TAU

  for (let k = 0; k < MAX_NUDGE_CANDIDATES; k++) {
    const r = SPIRAL_STEP * Math.sqrt(k)
    if (r > maxDistance) return null
    const a = phase + k * GOLDEN_ANGLE
    const x = quantize(start[0] + r * Math.cos(a))
    const z = quantize(start[1] + r * Math.sin(a))
    const rad = Math.hypot(x, z)
    if (rad < minRadius || rad >= MAX_ANCHOR_RADIUS) continue
    if (grid.isFree(x, y, z)) return [x, z]
  }
  return null
}

/**
 * Anchor for a new node: base point from ring, sector and id jitter, then nudged to keep
 * ≥ σ (+ margin) in 3D from `existing` at their heights. Throws only if the search cap is
 * exhausted, which needs hundreds of thousands of nodes on the same date.
 */
export function placeAnchor(
  record: PlacementInput,
  existing: readonly PlacedAnchor[],
  opts: PlacementOptions,
): XZ {
  const found = nudgeAnchor(basePoint(record), anchorY(record, opts), existing, {
    selfId: record.id,
    seed: fnv1a32(record.id),
    minRadius: minRadiusFor(record.archetype),
  })
  if (!found) throw new Error(`placeAnchor: no free anchor for ${record.id}`)
  return found
}

/** True when the normalised tag list changed (order matters: the first tag is primary). */
export function tagsChanged(prev: Pick<NodeRecord, 'tags'>, next: Pick<NodeRecord, 'tags'>): boolean {
  const a = normalizeTags(prev.tags)
  const b = normalizeTags(next.tags)
  return a.length !== b.length || a.some((t, i) => t !== b[i])
}

/**
 * Re-place `next` only if its placement key changed: the primary tag (or, untagged, the id).
 * Secondary-tag edits keep the anchor, so they never undo a drag. Returns `next` itself when
 * the anchor is kept, otherwise a copy with the new anchor. No other node is touched.
 */
export function replaceOnTagChange(
  prev: NodeRecord,
  next: NodeRecord,
  existing: readonly PlacedAnchor[],
  opts: PlacementOptions,
): NodeRecord {
  if (!tagsChanged(prev, next)) return next
  if (primaryTag(prev.tags) === primaryTag(next.tags)) return next
  return { ...next, anchorXZ: placeAnchor(next, existing, opts) }
}

/** Nearest existing anchor in 3D (excluding `selfId`), or null when there is none. */
export function nearestAnchor(
  anchorXZ: readonly [number, number],
  y: number,
  existing: readonly PlacedAnchor[],
  selfId?: string,
): { id: string; distance: number } | null {
  let best: { id: string; distance: number } | null = null
  for (const e of existing) {
    if (e.id === selfId || !isFiniteXZ(e.anchorXZ) || !Number.isFinite(e.y)) continue
    const d = Math.hypot(e.anchorXZ[0] - anchorXZ[0], e.y - y, e.anchorXZ[1] - anchorXZ[1])
    if (!best || d < best.distance || (d === best.distance && e.id < best.id)) best = { id: e.id, distance: d }
  }
  return best
}

function isFiniteXZ(v: readonly [number, number]): boolean {
  return Array.isArray(v) && Number.isFinite(v[0]) && Number.isFinite(v[1])
}

/** Uniform XZ grid over the anchors within `spacing` of height y; cell = spacing, so 3×3 cells suffice. */
function buildGrid(existing: readonly PlacedAnchor[], y: number, spacing: number, selfId?: string) {
  const cells = new Map<string, { x: number; y: number; z: number }[]>()
  const key = (i: number, j: number) => `${i},${j}`
  for (const e of existing) {
    if (e.id === selfId || !isFiniteXZ(e.anchorXZ) || !Number.isFinite(e.y)) continue
    if (Math.abs(e.y - y) >= spacing) continue
    const k = key(Math.floor(e.anchorXZ[0] / spacing), Math.floor(e.anchorXZ[1] / spacing))
    let cell = cells.get(k)
    if (!cell) cells.set(k, (cell = []))
    cell.push({ x: e.anchorXZ[0], y: e.y, z: e.anchorXZ[1] })
  }
  const s2 = spacing * spacing
  return {
    isFree(x: number, py: number, z: number): boolean {
      if (cells.size === 0) return true
      const ci = Math.floor(x / spacing)
      const cj = Math.floor(z / spacing)
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const cell = cells.get(key(ci + di, cj + dj))
          if (!cell) continue
          for (const p of cell) {
            const dx = p.x - x
            const dy = p.y - py
            const dz = p.z - z
            if (dx * dx + dy * dy + dz * dz < s2) return false
          }
        }
      }
      return true
    },
  }
}

// ─── catwalk spurs ───────────────────────────────────────────────────────────────────

export interface HelixParams {
  radius: number
  pitch: number
  phase0: number
}

export const HELIX: Readonly<HelixParams> = { radius: HELIX_RADIUS, pitch: HELIX_PITCH, phase0: HELIX_PHASE0 }

/** Helix angle at height y (unwrapped; one turn per pitch). */
export function helixAngleAt(y: number, helix: HelixParams = HELIX): number {
  return helix.phase0 + (TAU * y) / helix.pitch
}

export interface HelixSpur {
  /** Height of the catwalk turn where the spur attaches (nearest turn to the node). */
  turnY: number
  /** Helix angle at the attachment = the node's polar angle φ, in [0, 2π). */
  attachAngle: number
  /** y − turnY ∈ [−pitch/2, pitch/2]: taken up by a short stair on the pier. */
  stairDY: number
  /** Attachment point on the helix centreline. */
  attachXZ: XZ
  /** Radial length from the helix centreline to the anchor (negative if the anchor is inside the helix). */
  length: number
}

/**
 * Radial spur for a memory: attaches where the helix angle equals the node's angle φ, on the
 * turn nearest the node's height. Because there is one such point per turn, |stairDY| ≤ pitch/2.
 * The nearest turn can lie up to half a pitch outside [0, yMax]; the catwalk builder should
 * extend the helix half a turn past both ends.
 */
export function helixSpur(anchorXZ: readonly [number, number], y: number, helix: HelixParams = HELIX): HelixSpur {
  const phi = nodeAngle(anchorXZ)
  const rel = (phi - helix.phase0) % TAU
  const base = ((rel < 0 ? rel + TAU : rel) / TAU) * helix.pitch
  let turnY = base + Math.round((y - base) / helix.pitch) * helix.pitch
  const half = helix.pitch / 2
  // Floating-point drift at the half-pitch boundary: step to the neighbouring turn.
  if (y - turnY > half) turnY += helix.pitch
  else if (y - turnY < -half) turnY -= helix.pitch
  return {
    turnY,
    attachAngle: phi,
    stairDY: y - turnY,
    attachXZ: [helix.radius * Math.cos(phi), helix.radius * Math.sin(phi)],
    length: radiusOf(anchorXZ) - helix.radius,
  }
}

/** Shortest XZ distance from the segment a→b to the vertical axis through the origin. */
export function segmentDistanceToAxis(a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const len2 = dx * dx + dz * dz
  const t = len2 > 0 ? Math.min(1, Math.max(0, -(a[0] * dx + a[1] * dz) / len2)) : 0
  return Math.hypot(a[0] + t * dx, a[1] + t * dz)
}

/**
 * Clearance between a memory's spur (helix attachment → anchor; the pier stair is vertical
 * at the anchor end, so its footprint lies on the same segment) and the core axis. The core
 * is a vertical cylinder, so the 3D test reduces to this XZ distance.
 */
export function spurClearance(anchorXZ: readonly [number, number], helix: HelixParams = HELIX): number {
  return segmentDistanceToAxis(helixSpur(anchorXZ, 0, helix).attachXZ, anchorXZ)
}

export function spurIntersectsCore(
  anchorXZ: readonly [number, number],
  { coreRadius = CORE_RADIUS, halfWidth = SPUR_HALF_WIDTH }: { coreRadius?: number; halfWidth?: number } = {},
): boolean {
  return spurClearance(anchorXZ) < coreRadius + halfWidth
}

/** Ids of memories whose spur would cut the core (empty for any world placed by placeAnchor). */
export function findCoreIntersections(
  records: readonly Pick<NodeRecord, 'id' | 'archetype' | 'anchorXZ' | 'deletedAt'>[],
): string[] {
  return records
    .filter((r) => r.archetype === 'memory' && r.deletedAt === null && spurIntersectsCore(r.anchorXZ))
    .map((r) => r.id)
}
