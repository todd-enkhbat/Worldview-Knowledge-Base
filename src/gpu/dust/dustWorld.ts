// CPU reference of the GPU dust: the TS kernel (src/physics) over the GPU texel layout,
// with births. Dust has no pairs and its K has no ramp, so every texel evolves on its own
// and n enters only through its birth: the state at step n is spawn(owner) when n ≤ birth,
// else spawn stepped n − birth times. Forward n→n+1 and backward n+1→n act on
// A(n) = {birth ≤ n}, exactly as world.ts does for nodes. Dormant texels hold their spawn
// state (the GPU regenerates it from the anchor/meta textures on every draw), so a forward
// step landing on a birth already finds the regenerated spawn, and a backward step leaving
// it restores the spawn exactly (the leapfrog is a bijection).
//
// This is also the edit path (PLAN "Dust (GPU) → Edits"): computeDustRows runs the same
// kernel for one owner's 64 particles and the result is uploaded into the GPU targets.

import { INT_MAX } from '../../physics/fixed.ts'
import { type ParticleSystem, createSystem, stepBackwardFor, stepForwardFor } from '../../physics/integrator.ts'
import type { PhysicsParams } from '../../physics/params.ts'
import { draw } from '../../physics/rng.ts'
import { spawnDustState } from '../../physics/spawn.ts'
import { DUST_SEGMENT } from './alloc.ts'
import type { DustTexels } from './layout.ts'

/** Birth of a free texel: never active (and so always at its spawn state). */
export const DUST_FREE_BIRTH = INT_MAX

export interface DustOwner {
  readonly id: string
  /** Q.19, quantised exactly like the node world (world.ts quantizeRecord). */
  readonly anchor: readonly [number, number, number]
  /** Integer birth step, 0 ≤ birth ≤ MAX_BIRTH. */
  readonly birth: number
  /** fnv1a32(id) (any i32/u32 bit pattern). */
  readonly seed: number
  /** Render style (archetype index, flags); never read by physics. */
  readonly style: number
}

/** Spawn seed of particle k of an owner's segment: the owner's id hash keyed by k (as in the S2 world). */
export function dustParticleSeed(ownerSeed: number, k: number): number {
  return draw(ownerSeed >>> 0, k) | 0
}

const spawnScratch = new Int32Array(6)

/** Spawn state of one particle: X = anchor + u (wrapping), D. */
export function dustSpawn(params: PhysicsParams, seed: number, ax: number, ay: number, az: number, x: Int32Array, d: Int32Array, o: number): void {
  spawnDustState(seed, params.dustTemp, params.dustInvMass, spawnScratch)
  x[o] = (ax + spawnScratch[0]) | 0
  x[o + 1] = (ay + spawnScratch[1]) | 0
  x[o + 2] = (az + spawnScratch[2]) | 0
  d[o] = spawnScratch[3]
  d[o + 1] = spawnScratch[4]
  d[o + 2] = spawnScratch[5]
}

export interface DustWorld {
  readonly params: PhysicsParams
  readonly texels: number
  /** Dust population (m = 1, τ = 1); sys.birth is the per-texel birth. */
  readonly sys: ParticleSystem
  /** Per-texel spawn seed. */
  readonly seed: Int32Array
  /** Per-texel render style. */
  readonly style: Int32Array
  step: number
}

function spawnTexel(w: DustWorld, i: number): void {
  const o = 3 * i
  const a = w.sys.anchor
  dustSpawn(w.params, w.seed[i], a[o], a[o + 1], a[o + 2], w.sys.x, w.sys.d, o)
}

/** Every texel free (birth = DUST_FREE_BIRTH, seed 0, anchor 0) at its spawn state. */
export function createDustWorld(params: PhysicsParams, texels: number, step = 0): DustWorld {
  if (!Number.isInteger(texels) || texels < 1) throw new RangeError(`dust texels ${texels}`)
  const sys = createSystem(params, texels, 'dust')
  sys.birth.fill(DUST_FREE_BIRTH)
  const w: DustWorld = { params, texels, sys, seed: new Int32Array(texels), style: new Int32Array(texels), step }
  for (let i = 0; i < texels; i++) spawnTexel(w, i)
  return w
}

const listScratch = { list: new Int32Array(0) }

function listOf(n: number): Int32Array {
  if (listScratch.list.length < n) listScratch.list = new Int32Array(n)
  return listScratch.list
}

/** Texels of [first, first + count) with birth ≤ step, into a scratch list. */
function activeIn(w: DustWorld, first: number, count: number, step: number): { list: Int32Array; n: number } {
  const list = listOf(count)
  const b = w.sys.birth
  let n = 0
  for (let i = first; i < first + count; i++) if (b[i] <= step) list[n++] = i
  return { list, n }
}

/**
 * Give `segment` to `owner` (or free it with null) at the world's current step: static
 * inputs first, then the state — the spawn when the owner is not yet past its birth, else
 * the spawn stepped (step − birth) times with the same kernel (the CPU edit rows).
 */
export function setDustSegment(w: DustWorld, segment: number, owner: DustOwner | null): void {
  const first = segment * DUST_SEGMENT
  if (first < 0 || first + DUST_SEGMENT > w.texels) throw new RangeError(`segment ${segment} outside ${w.texels} texels`)
  for (let k = 0; k < DUST_SEGMENT; k++) {
    const i = first + k
    const o = 3 * i
    w.sys.anchor[o] = owner ? owner.anchor[0] | 0 : 0
    w.sys.anchor[o + 1] = owner ? owner.anchor[1] | 0 : 0
    w.sys.anchor[o + 2] = owner ? owner.anchor[2] | 0 : 0
    w.sys.birth[i] = owner ? owner.birth : DUST_FREE_BIRTH
    w.seed[i] = owner ? dustParticleSeed(owner.seed, k) : 0
    w.style[i] = owner ? owner.style : 0
    spawnTexel(w, i)
  }
  if (!owner || owner.birth >= w.step) return
  const all = new Int32Array(DUST_SEGMENT)
  for (let k = 0; k < DUST_SEGMENT; k++) all[k] = first + k
  for (let s = owner.birth; s < w.step; s++) stepForwardFor(w.sys, s, all, DUST_SEGMENT)
}

/** Only the render style of a segment (no physics change). */
export function setDustSegmentStyle(w: DustWorld, segment: number, style: number): void {
  w.style.fill(style, segment * DUST_SEGMENT, (segment + 1) * DUST_SEGMENT)
}

/** One step forward (+1) or backward (−1) of every texel; an exact inverse pair, births included. */
export function stepDustWorld(w: DustWorld, dir: 1 | -1): void {
  if (dir === 1) {
    const { list, n } = activeIn(w, 0, w.texels, w.step)
    stepForwardFor(w.sys, w.step, list, n)
    w.step++
  } else {
    w.step--
    const { list, n } = activeIn(w, 0, w.texels, w.step)
    stepBackwardFor(w.sys, w.step, list, n)
  }
}

export function runDustTo(w: DustWorld, target: number): void {
  if (!Number.isSafeInteger(target)) throw new RangeError(`dust step target ${target}`)
  while (w.step < target) stepDustWorld(w, 1)
  while (w.step > target) stepDustWorld(w, -1)
}

/** The world as GPU texels (width × height ≥ texels): X, D, anchor (w = birth), meta (seed, style). */
export function dustWorldTexels(w: DustWorld, width: number, height: number): DustTexels & { meta: Int32Array } {
  const n = width * height
  if (n < w.texels) throw new RangeError(`${w.texels} texels do not fit ${width}×${height}`)
  const x = new Int32Array(4 * n)
  const d = new Int32Array(4 * n)
  const anchor = new Int32Array(4 * n)
  const meta = new Int32Array(4 * n)
  const { sys } = w
  for (let i = 0; i < w.texels; i++) {
    const o3 = 3 * i
    const o4 = 4 * i
    for (let a = 0; a < 3; a++) {
      x[o4 + a] = sys.x[o3 + a]
      d[o4 + a] = sys.d[o3 + a]
      anchor[o4 + a] = sys.anchor[o3 + a]
    }
    anchor[o4 + 3] = sys.birth[i]
    meta[o4] = w.seed[i]
    meta[o4 + 1] = w.style[i]
  }
  // Texels past the world are free texels too (birth never reached, seed 0).
  for (let i = w.texels; i < n; i++) anchor[4 * i + 3] = DUST_FREE_BIRTH
  return { width, height, x, d, anchor, meta }
}

// ---- edit rows: one owner's segment on the CPU ----

/** RGBA rows (stride 4, w = 0) of one segment: what uploadRows writes into a GPU target. */
export interface DustRows {
  readonly step: number
  readonly x: Int32Array
  readonly d: Int32Array
}

/**
 * The state of one owner's 64 particles, steppable toward any step in bounded slices
 * (forward or backward: the kernel is reversible), for edits computed off the frame
 * budget. Steps ≤ birth are the spawn state.
 */
export class DustRowsJob {
  readonly owner: DustOwner
  private readonly params: PhysicsParams
  private readonly sys: ParticleSystem
  private readonly list: Int32Array
  private cur: number

  constructor(owner: DustOwner, params: PhysicsParams) {
    this.owner = owner
    this.params = params
    this.sys = createSystem(params, DUST_SEGMENT, 'dust')
    this.list = new Int32Array(DUST_SEGMENT)
    for (let k = 0; k < DUST_SEGMENT; k++) {
      this.list[k] = k
      for (let a = 0; a < 3; a++) this.sys.anchor[3 * k + a] = owner.anchor[a] | 0
    }
    this.cur = owner.birth
    this.respawn()
  }

  /** The step the job's state represents. */
  get step(): number {
    return this.cur
  }

  private respawn(): void {
    const [ax, ay, az] = this.owner.anchor
    for (let k = 0; k < DUST_SEGMENT; k++) {
      dustSpawn(this.params, dustParticleSeed(this.owner.seed, k), ax | 0, ay | 0, az | 0, this.sys.x, this.sys.d, 3 * k)
    }
  }

  /** Step toward `target`, at most `maxSteps` kernel steps; true once the state is at `target`. */
  advance(target: number, maxSteps = Number.POSITIVE_INFINITY): boolean {
    const b = this.owner.birth
    if (target <= b) {
      if (this.cur > b) this.respawn()
      this.cur = target
      return true
    }
    if (this.cur < b) {
      this.respawn()
      this.cur = b
    }
    let budget = maxSteps
    while (this.cur < target && budget-- > 0) stepForwardFor(this.sys, this.cur++, this.list, DUST_SEGMENT)
    while (this.cur > target && budget-- > 0) stepBackwardFor(this.sys, --this.cur, this.list, DUST_SEGMENT)
    return this.cur === target
  }

  /** The current state as RGBA rows. */
  rows(): DustRows {
    const x = new Int32Array(4 * DUST_SEGMENT)
    const d = new Int32Array(4 * DUST_SEGMENT)
    for (let k = 0; k < DUST_SEGMENT; k++) {
      for (let a = 0; a < 3; a++) {
        x[4 * k + a] = this.sys.x[3 * k + a]
        d[4 * k + a] = this.sys.d[3 * k + a]
      }
    }
    return { step: this.cur, x, d }
  }
}

/**
 * The rows of one owner's segment at each of `steps` (any order, duplicates allowed), in
 * one CPU pass: the PLAN's edit path ("the worker computes the edited node's dust rows on
 * the CPU"). Cost: 64 particles × (max(steps) − birth) kernel steps.
 */
export function computeDustRows(owner: DustOwner, steps: readonly number[], params: PhysicsParams): DustRows[] {
  const order = steps.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s)
  const out = new Array<DustRows>(steps.length)
  const job = new DustRowsJob(owner, params)
  for (const { s, i } of order) {
    if (!Number.isSafeInteger(s) || s < 0) throw new RangeError(`dust rows step ${s}`)
    job.advance(s)
    out[i] = job.rows()
  }
  return out
}
