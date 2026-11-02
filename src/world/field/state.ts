import { MS_PER_YEAR } from '../../domain/constants.ts'
import type { NodeRecord } from '../../domain/types.ts'
import type { XZ } from './layout.ts'

// Time in the field (milestone 2). Time is not a place you climb; it is what the playhead does
// to the world. Everything here is a pure function of the playhead, so scrubbing back restores
// the world exactly (the visible macrostate is a function of t, like the engine's microstate).
//
// A note is born when the playhead passes its date: its grains condense out of a diffuse
// cloud over ~2 months. Then it slowly loses order (its entropy rises): its cloud spreads and
// its rise in the land erodes, toward a floor, unless it is linked into the world (links hold
// order, the way a structure resists diffusion). The terrain is the macrostate: a sum of soft
// bumps, one per born note, that the eye reads as land.

export const YEAR = MS_PER_YEAR
/** Years for a newborn note to condense. */
const CONDENSE_Y = 0.18
/** Years for order to fall by 1/e. */
const ORDER_TAU_Y = 6

export interface NoteState {
  born: boolean
  /** 0 → 1 over the first months after birth. */
  condense: number
  /** 1 = sharp and tall, → floor as it ages; links hold it up. */
  order: number
  /** Grain cloud radius (world units). */
  sigma: number
  /** Height of the note's bump in the land. */
  amp: number
  /** Width of the bump. */
  width: number
}

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * A note at the playhead. `lastTouchMs` is the latest time it was looked at, at or before
 * the playhead (attention.ts): order then decays from that moment instead of from its birth.
 */
export function noteState(rec: NodeRecord, playheadMs: number, degree: number, lastTouchMs = -Infinity): NoteState {
  const age = (playheadMs - rec.temporalOrigin) / YEAR
  const born = age >= 0
  const condense = born ? smoothstep(0, CONDENSE_Y, age) : 0
  const hold = Math.min(1, degree / 6)
  const since = Math.max(0, (playheadMs - Math.max(rec.temporalOrigin, lastTouchMs)) / YEAR)
  const order = born ? 0.3 + 0.7 * (hold * 0.5 + (1 - hold * 0.5) * Math.exp(-since / ORDER_TAU_Y)) : 0
  const mass = rec.thermo?.mass ?? 1
  const sigma = (1.4 + 0.45 * mass) * (1 + 2.2 * (1 - order)) * (1 + 4 * (1 - condense))
  const amp = (3.5 + 2.2 * mass + 1.2 * Math.min(degree, 6)) * condense * (0.45 + 0.55 * order)
  const width = 8 + 2.2 * Math.sqrt(degree + 1)
  return { born, condense, order, sigma, amp, width }
}

export interface Heightfield {
  res: number
  /** World-space square covered: [x0, x0 + size] × [z0, z0 + size]. */
  x0: number
  z0: number
  size: number
  h: Float32Array
}

/** Sum of the born notes' bumps on a res×res grid. */
export function buildHeightfield(
  notes: readonly { xz: XZ; state: NoteState }[],
  extent: { cx: number; cz: number; half: number },
  res = 128,
): Heightfield {
  const size = extent.half * 2
  const x0 = extent.cx - extent.half
  const z0 = extent.cz - extent.half
  const h = new Float32Array(res * res)
  const cell = size / (res - 1)
  for (const { xz, state } of notes) {
    if (!state.born || state.amp <= 0.01) continue
    const w = state.width
    const reach = w * 3
    const i0 = Math.max(0, Math.floor((xz[0] - reach - x0) / cell))
    const i1 = Math.min(res - 1, Math.ceil((xz[0] + reach - x0) / cell))
    const j0 = Math.max(0, Math.floor((xz[1] - reach - z0) / cell))
    const j1 = Math.min(res - 1, Math.ceil((xz[1] + reach - z0) / cell))
    const inv = 1 / (2 * w * w)
    for (let j = j0; j <= j1; j++) {
      const dz = z0 + j * cell - xz[1]
      for (let i = i0; i <= i1; i++) {
        const dx = x0 + i * cell - xz[0]
        h[j * res + i] += state.amp * Math.exp(-(dx * dx + dz * dz) * inv)
      }
    }
  }
  return { res, x0, z0, size, h }
}

/**
 * The land's colour: each born note tints the ground under its bump with its own colour,
 * weighted like the bump, on a res×res RGB grid (0 where no note reaches).
 */
export function buildTint(
  notes: readonly { xz: XZ; state: NoteState; rgb: readonly [number, number, number] }[],
  hf: Pick<Heightfield, 'x0' | 'z0' | 'size'>,
  res = 64,
): Float32Array {
  const acc = new Float32Array(res * res * 4)
  const cell = hf.size / (res - 1)
  for (const { xz, state, rgb } of notes) {
    if (!state.born || state.amp <= 0.01) continue
    const w = state.width * 1.3
    const reach = w * 3
    const i0 = Math.max(0, Math.floor((xz[0] - reach - hf.x0) / cell))
    const i1 = Math.min(res - 1, Math.ceil((xz[0] + reach - hf.x0) / cell))
    const j0 = Math.max(0, Math.floor((xz[1] - reach - hf.z0) / cell))
    const j1 = Math.min(res - 1, Math.ceil((xz[1] + reach - hf.z0) / cell))
    const inv = 1 / (2 * w * w)
    for (let j = j0; j <= j1; j++) {
      const dz = hf.z0 + j * cell - xz[1]
      for (let i = i0; i <= i1; i++) {
        const dx = hf.x0 + i * cell - xz[0]
        const k = state.amp * Math.exp(-(dx * dx + dz * dz) * inv)
        const o = (j * res + i) * 4
        acc[o] += rgb[0] * k
        acc[o + 1] += rgb[1] * k
        acc[o + 2] += rgb[2] * k
        acc[o + 3] += k
      }
    }
  }
  // Normalised colour in rgb, coverage (0…1) in alpha.
  for (let o = 0; o < acc.length; o += 4) {
    const k = acc[o + 3]
    if (k > 1e-4) {
      acc[o] /= k
      acc[o + 1] /= k
      acc[o + 2] /= k
    }
    acc[o + 3] = Math.min(1, k / 4)
  }
  return acc
}

/**
 * Grid resolutions for a land `size` world units across: the height grid keeps cells ≤ ~3 u
 * (a rise is ~8–12 u wide), the grain grid keeps grains ≤ ~2.5 u apart, both capped so a
 * huge world stays within budget (512² cells, 560² grains).
 */
export function landResolution(size: number): { height: number; grains: number; tint: number } {
  const height = Math.min(512, Math.max(128, Math.ceil(size / 3)))
  return { height, grains: Math.min(560, Math.max(300, Math.ceil(size / 2.5))), tint: Math.max(64, height >> 1) }
}

/** Bilinear height at a world point (0 outside the grid). */
export function sampleHeight(hf: Heightfield, x: number, z: number): number {
  const fx = ((x - hf.x0) / hf.size) * (hf.res - 1)
  const fz = ((z - hf.z0) / hf.size) * (hf.res - 1)
  if (fx < 0 || fz < 0 || fx > hf.res - 1 || fz > hf.res - 1) return 0
  const i = Math.min(hf.res - 2, Math.floor(fx))
  const j = Math.min(hf.res - 2, Math.floor(fz))
  const u = fx - i
  const v = fz - j
  const a = hf.h[j * hf.res + i]
  const b = hf.h[j * hf.res + i + 1]
  const c = hf.h[(j + 1) * hf.res + i]
  const d = hf.h[(j + 1) * hf.res + i + 1]
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
}

export interface Ripple {
  x: number
  z: number
  /** Years since the birth that sent it (0 … RIPPLE_Y). */
  age: number
  amp: number
}

/** How long a birth's wave travels across the land. */
export const RIPPLE_Y = 1.2

/** The most recent births before the playhead, still rippling outward. */
export function activeRipples(notes: readonly { rec: NodeRecord; xz: XZ }[], playheadMs: number, max = 16): Ripple[] {
  const out: Ripple[] = []
  for (const { rec, xz } of notes) {
    const age = (playheadMs - rec.temporalOrigin) / YEAR
    if (age < 0 || age > RIPPLE_Y) continue
    out.push({ x: xz[0], z: xz[1], age, amp: 1 + 0.6 * (rec.thermo?.mass ?? 1) })
  }
  return out.sort((a, b) => a.age - b.age).slice(0, max)
}

/**
 * The field's entropy (nats): the summed differential entropy of the born notes' clouds,
 * each a 3-D Gaussian of radius σ, ½·3·ln(2πe·σ²) apiece. It grows as notes age and spread,
 * and falls when attention re-condenses them: Boltzmann's S = k log W with W the clouds'
 * coarse-grained volume.
 */
export function fieldEntropy(sigma: ArrayLike<number>, born: ArrayLike<number>): number | null {
  let s = 0
  let n = 0
  for (let i = 0; i < sigma.length; i++) {
    if (!born[i]) continue
    s += 1.5 * Math.log(2 * Math.PI * Math.E * sigma[i] * sigma[i])
    n++
  }
  return n ? s : null
}

/** How far the land lifts a note's cloud above its bump. */
export const lift = (state: NoteState, mass: number) => 2.5 + mass + state.sigma * 0.9

// ─── scenes on the land ──────────────────────────────────────────────────────────────

/** A scene's radius on the land (world units), at full condensation. */
export const SCENE_RADIUS = 9

/**
 * Where a scene note stands: its shell radius (a new scene is readable at once; condensation
 * only firms it up) and its clearing, the land under it raised toward the hills around it
 * (sampled on a ring past its rim) so it stands among its neighbours instead of in a hollow
 * they hide. The land shader levels the ground to this height around the scene.
 */
export function sceneStand(hf: Heightfield, x: number, z: number, condense: number): { radius: number; ground: number } {
  const radius = SCENE_RADIUS * (0.7 + 0.3 * condense)
  let ring = 0
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2
    ring = Math.max(ring, sampleHeight(hf, x + Math.cos(a) * radius * 1.8, z + Math.sin(a) * radius * 1.8))
  }
  return { radius, ground: Math.max(sampleHeight(hf, x, z), 0.8 * ring) }
}

/** A scene note's cloud centre height: inside its scene, so the cloud is the scene unresolved. */
export const sceneCentreY = (stand: { radius: number; ground: number }) => stand.ground + stand.radius * 0.5
/** A scene note's cloud spread: about its scene, however young the note. */
export const sceneSigma = (sigma: number, radius: number) => Math.min(sigma, radius * 0.6)
