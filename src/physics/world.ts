// A node world with births over the integer kernel: stable slots, the active set
// A(n) = {i : n_i ≤ n}, spawn regeneration on forward birth crossings and edits.
//
// Births. Forward n→n+1 and backward n+1→n both act on A(n). After a forward step lands
// on n+1, every record born at n+1 is (re)spawned from its Past-Hypothesis macrostate
// (seeded by fnv1a32(id)); before a backward step leaves n+1, those records go dormant
// (their state is cleared). The forward crossing regenerates the identical spawn, so
// stepWorld(+1) and stepWorld(−1) are an exact inverse pair with births included.
//
// Integer-only rule: a record's floats are quantised exactly once, at this boundary,
// with correctly rounded IEEE operations (anchor: Math.round(a·2^19), round half toward
// +∞, then ToInt32 — anchors beyond ±4096 u wrap on the torus; mass: invMassFromMass;
// temperature: tauFromUnit; birth: floor, clamped to [0, MAX_BIRTH]). Nothing float
// reaches K, spawn, slots or births after that. Poses and hashes for checkpoints are
// read-outs only.

import { INT_MAX, INV_MASS_FRAC, UNIT, invMassFromMass, tauFromUnit } from './fixed.ts'
import { createPairGrid, gridPairAccumulator } from './grid.ts'
import {
  type PairAccumulator,
  type ParticleSystem,
  accumulatePairsListBruteForce,
  createSystem,
  setParticle,
  stepBackwardFor,
  stepForwardFor,
} from './integrator.ts'
import { AMP_ONE, type PhysicsParams, assertStable, makePhysicsParams } from './params.ts'
import { fnv1a32, fnv1aWords, lowbias32 } from './rng.ts'
import { spawnNode } from './spawn.ts'

export interface WorldRecord {
  id: string
  /** World units. */
  anchor: [number, number, number]
  birthStep: number
  mass: number
  /** τ = T ∈ [0, 1]. */
  temperature: number
}

export interface WorldInput {
  records: WorldRecord[]
  seed: number
  /** Q.8, default AMP_ONE. */
  landscapeAmp?: number
  /** Initial slot capacity (grows by doubling when exceeded). */
  capacity?: number
  /** Pair search: the uniform grid (default) or the O(N²) reference (tests). */
  pairMode?: 'grid' | 'brute'
}

export interface PhysicsWorld {
  /** `capacity` slots; dormant and free slots hold no meaningful state. Re-read after upsertRecord (capacity may grow). */
  readonly sys: ParticleSystem
  /** Stable slot per id (free-list; insert/delete never reorders). */
  readonly slotOf: Map<string, number>
  readonly idOf: (string | null)[]
  /** Birth step per slot (also sys.birth); FREE_BIRTH for free slots. */
  readonly birth: Int32Array
  step: number
  readonly params: PhysicsParams
  /**
   * True when an edit changed the trajectory before `step` (changedFromStep < step):
   * X/D are then not the state at `step` until a restore/seek/resetWorld.
   */
  readonly stale: boolean
  /** |A(step)|. */
  readonly activeCount: number
}

/** Birth of a free slot: never active. */
export const FREE_BIRTH = INT_MAX
/** Births are clamped to [0, MAX_BIRTH] (≈ 1.8 My at 600 steps/year). */
export const MAX_BIRTH = 2 ** 30

interface World extends PhysicsWorld {
  sys: ParticleSystem
  birth: Int32Array
  stale: boolean
  activeCount: number
  /** Spawn seed fnv1a32(id) per slot. */
  seed: Int32Array
  /** A(step) in arbitrary order, and each slot's index in it (−1 = not active). */
  act: Int32Array
  actPos: Int32Array
  birthsAt: Map<number, number[]>
  /** Free slots; pop() yields the lowest initially, then LIFO. */
  free: number[]
  pairs: PairAccumulator
  sortedIds: string[] | null
}

interface QRecord {
  ax: number
  ay: number
  az: number
  invMass: number
  tau: number
  birth: number
  seed: number
}

function quantAnchor(a: number, id: string): number {
  if (!Number.isFinite(a)) throw new RangeError(`record ${id}: non-finite anchor`)
  return Math.round(a * UNIT) | 0
}

/** The one float → integer conversion of a record. */
export function quantizeRecord(r: WorldRecord): QRecord {
  const { id } = r
  if (!(r.mass > 0) || !Number.isFinite(r.mass)) throw new RangeError(`record ${id}: mass must be finite and > 0`)
  if (!Number.isFinite(r.temperature)) throw new RangeError(`record ${id}: non-finite temperature`)
  if (Number.isNaN(r.birthStep)) throw new RangeError(`record ${id}: NaN birthStep`)
  const b = Math.floor(r.birthStep)
  return {
    ax: quantAnchor(r.anchor[0], id),
    ay: quantAnchor(r.anchor[1], id),
    az: quantAnchor(r.anchor[2], id),
    invMass: invMassFromMass(r.mass),
    tau: tauFromUnit(r.temperature),
    birth: b < 0 ? 0 : b > MAX_BIRTH ? MAX_BIRTH : b,
    seed: fnv1a32(id) | 0,
  }
}

function writeRecord(w: World, slot: number, q: QRecord): void {
  const o = 3 * slot
  w.sys.anchor[o] = q.ax
  w.sys.anchor[o + 1] = q.ay
  w.sys.anchor[o + 2] = q.az
  setParticle(w.sys, slot, q.invMass, q.tau, q.birth)
  w.seed[slot] = q.seed
  let list = w.birthsAt.get(q.birth)
  if (!list) w.birthsAt.set(q.birth, (list = []))
  list.push(slot)
}

function forgetBirth(w: World, slot: number, birth: number): void {
  const list = w.birthsAt.get(birth)
  if (!list) return
  const k = list.indexOf(slot)
  if (k >= 0) list.splice(k, 1)
  if (list.length === 0) w.birthsAt.delete(birth)
}

function clearState(w: World, slot: number): void {
  w.sys.x.fill(0, 3 * slot, 3 * slot + 3)
  w.sys.d.fill(0, 3 * slot, 3 * slot + 3)
}

/** Add to A and write the spawn macrostate. */
function activate(w: World, slot: number): void {
  if (w.actPos[slot] < 0) {
    w.actPos[slot] = w.activeCount
    w.act[w.activeCount++] = slot
  }
  spawnNode(w.sys, slot, w.seed[slot])
}

/** Remove from A (swap-remove) and clear the state. */
function deactivate(w: World, slot: number): void {
  const p = w.actPos[slot]
  if (p >= 0) {
    const last = w.act[--w.activeCount]
    w.act[p] = last
    w.actPos[last] = p
    w.actPos[slot] = -1
  }
  clearState(w, slot)
}

function allocArrays(cap: number): { seed: Int32Array; act: Int32Array; actPos: Int32Array } {
  return { seed: new Int32Array(cap), act: new Int32Array(cap), actPos: new Int32Array(cap).fill(-1) }
}

function grow(w: World, minCap: number): void {
  const old = w.sys
  let cap = Math.max(64, old.count)
  while (cap < minCap) cap *= 2
  if (cap === old.count) return
  const sys = createSystem(old.params, cap, 'node')
  sys.pairs = old.pairs
  sys.x.set(old.x)
  sys.d.set(old.d)
  sys.anchor.set(old.anchor)
  sys.invMass.set(old.invMass)
  sys.tau.set(old.tau)
  sys.lcoef.set(old.lcoef)
  sys.birth.fill(FREE_BIRTH)
  sys.birth.set(old.birth)
  sys.saturations = old.saturations
  sys.impulseWraps = old.impulseWraps
  const a = allocArrays(cap)
  a.seed.set(w.seed)
  a.act.set(w.act)
  a.actPos.set(w.actPos)
  // Called only when the free-list is empty: the lowest new slot pops first.
  for (let s = cap - 1; s >= old.count; s--) w.free.push(s)
  for (let s = old.count; s < cap; s++) w.idOf.push(null)
  w.sys = sys
  w.birth = sys.birth
  w.seed = a.seed
  w.act = a.act
  w.actPos = a.actPos
}

/** ω_max·dt gate over every occupied slot, with `slot` (if ≥ 0) replaced by (invMass, tau). */
function checkStable(w: World, invMass: number, tau: number, slot: number): void {
  const ims: number[] = [invMass]
  const taus: number[] = [tau]
  for (let s = 0; s < w.sys.count; s++) {
    if (s === slot || w.idOf[s] === null) continue
    ims.push(w.sys.invMass[s])
    taus.push(w.sys.tau[s])
  }
  assertStable(w.params, ims, taus)
}

/** Build the world at step 0: every record with birthStep ≤ 0 spawned. */
export function buildWorld(input: WorldInput): PhysicsWorld {
  const params = makePhysicsParams({ seed: input.seed, landscapeAmp: input.landscapeAmp ?? AMP_ONE })
  const qs = input.records.map(quantizeRecord)
  assertStable(
    params,
    qs.map((q) => q.invMass),
    qs.map((q) => q.tau),
  )
  const n = input.records.length
  const cap = Math.max(n, input.capacity ?? Math.max(64, n + (n >> 2)), 1)
  const sys = createSystem(params, cap, 'node')
  sys.birth.fill(FREE_BIRTH)
  const grid = createPairGrid(params.pairSigma, cap)
  const w: World = {
    sys,
    slotOf: new Map(),
    idOf: new Array<string | null>(cap).fill(null),
    birth: sys.birth,
    step: 0,
    params,
    stale: false,
    activeCount: 0,
    ...allocArrays(cap),
    birthsAt: new Map(),
    free: [],
    pairs: input.pairMode === 'brute' ? accumulatePairsListBruteForce : gridPairAccumulator(grid),
    sortedIds: null,
  }
  for (let s = cap - 1; s >= n; s--) w.free.push(s)
  for (let k = 0; k < n; k++) {
    const id = input.records[k].id
    if (w.slotOf.has(id)) throw new Error(`duplicate record id ${id}`)
    w.slotOf.set(id, k)
    w.idOf[k] = id
    writeRecord(w, k, qs[k])
  }
  resetWorld(w)
  return w
}

/** Reset to the step-0 state (a pure function of the records): needs no checkpoint. */
export function resetWorld(world: PhysicsWorld): void {
  const w = world as World
  w.activeCount = 0
  w.actPos.fill(-1)
  w.sys.x.fill(0)
  w.sys.d.fill(0)
  w.step = 0
  for (let s = 0; s < w.sys.count; s++) if (w.birth[s] <= 0) activate(w, s)
  w.stale = false
}

export function isActive(w: PhysicsWorld, slot: number): boolean {
  return w.birth[slot] <= w.step
}

/** One step forward (+1) or backward (−1); an exact inverse pair, births included. */
export function stepWorld(world: PhysicsWorld, dir: 1 | -1): void {
  const w = world as World
  if (dir === 1) {
    stepForwardFor(w.sys, w.step, w.act, w.activeCount, w.pairs)
    w.step++
    const born = w.birthsAt.get(w.step)
    if (born) for (let k = 0; k < born.length; k++) activate(w, born[k])
  } else {
    const born = w.birthsAt.get(w.step)
    if (born) for (let k = 0; k < born.length; k++) deactivate(w, born[k])
    w.step--
    stepBackwardFor(w.sys, w.step, w.act, w.activeCount, w.pairs)
  }
}

/** Step until w.step === target (either direction). */
export function runTo(w: PhysicsWorld, target: number): void {
  if (!Number.isSafeInteger(target)) throw new RangeError(`step target ${target} is not an integer`)
  while (w.step < target) stepWorld(w, 1)
  while (w.step > target) stepWorld(w, -1)
}

const hashScratch = new Int32Array(7)

/** fnv1a32 over (slot, X, D) of the active slots in slot order. */
export function worldHash(w: PhysicsWorld): number {
  const { x, d } = w.sys
  const b = w.birth
  let h: number | undefined
  for (let s = 0; s < b.length; s++) {
    if (b[s] > w.step) continue
    const o = 3 * s
    hashScratch[0] = s
    hashScratch[1] = x[o]
    hashScratch[2] = x[o + 1]
    hashScratch[3] = x[o + 2]
    hashScratch[4] = d[o]
    hashScratch[5] = d[o + 1]
    hashScratch[6] = d[o + 2]
    h = fnv1aWords(hashScratch, 4, h)
  }
  return h ?? fnv1aWords([])
}

function sortedIds(w: World): string[] {
  if (w.sortedIds === null) w.sortedIds = [...w.slotOf.keys()].sort()
  return w.sortedIds
}

/** Slot-independent state hash: fnv1a32 over (fnv1a32(id), X, D) of the active records in id order. */
export function stateHashById(world: PhysicsWorld): number {
  const w = world as World
  const { x, d } = w.sys
  let h: number | undefined
  for (const id of sortedIds(w)) {
    const s = w.slotOf.get(id)!
    if (w.birth[s] > w.step) continue
    const o = 3 * s
    hashScratch[0] = w.seed[s]
    hashScratch[1] = x[o]
    hashScratch[2] = x[o + 1]
    hashScratch[3] = x[o + 2]
    hashScratch[4] = d[o]
    hashScratch[5] = d[o + 1]
    hashScratch[6] = d[o + 2]
    h = fnv1aWords(hashScratch, 4, h)
  }
  return h ?? fnv1aWords([])
}

const hex8 = (v: number): string => (v >>> 0).toString(16).padStart(8, '0')

/**
 * 64-bit hex hash of the integer physics inputs (id, anchor, 1/m, τ, birth) of every
 * record born ≤ step, in id order: the records part of a checkpoint cache key. A
 * checkpoint at `step` depends on exactly these records, so edits of later-born
 * records leave its key unchanged.
 */
export function recordsHashAt(world: PhysicsWorld, step: number): string {
  const w = world as World
  let h1 = 0x811c9dc5
  let h2 = lowbias32(0x5eed)
  const mix = (v: number): void => {
    h1 = Math.imul(h1 ^ (v & 0xffff), 0x01000193)
    h1 = Math.imul(h1 ^ (v >>> 16), 0x01000193)
    h2 = lowbias32((h2 ^ v) + 0x9e3779b9)
  }
  let count = 0
  for (const id of sortedIds(w)) {
    const s = w.slotOf.get(id)!
    if (w.birth[s] > step) continue
    count++
    mix(id.length)
    for (let k = 0; k < id.length; k++) mix(id.charCodeAt(k))
    const o = 3 * s
    mix(w.sys.anchor[o])
    mix(w.sys.anchor[o + 1])
    mix(w.sys.anchor[o + 2])
    mix(w.sys.invMass[s])
    mix(w.sys.tau[s])
    mix(w.birth[s])
  }
  mix(count)
  return hex8(h1) + hex8(h2)
}

/** Hex hash of the world settings that shape the kernel (seed, landscape amplitude). */
export function settingsHashOf(w: PhysicsWorld): string {
  return hex8(fnv1aWords([w.params.seed | 0, w.params.landscapeAmp | 0]))
}

/** Bring a slot's live state in line with an edit; mark stale if the past changed. */
function syncEditedSlot(w: World, slot: number, changedFromStep: number): void {
  if (w.birth[slot] <= w.step) activate(w, slot)
  else deactivate(w, slot)
  // A birth exactly at `step` is spawned on landing and has not yet acted on anyone, so
  // writing (or clearing) it here is exact; an earlier change alters the trajectory.
  if (changedFromStep < w.step) w.stale = true
}

function sameRecord(w: World, slot: number, q: QRecord): boolean {
  const o = 3 * slot
  const a = w.sys.anchor
  return (
    a[o] === q.ax &&
    a[o + 1] === q.ay &&
    a[o + 2] === q.az &&
    w.sys.invMass[slot] === q.invMass &&
    w.sys.tau[slot] === q.tau &&
    w.birth[slot] === q.birth
  )
}

/**
 * Insert or edit a record. Slots are stable (free-list). changedFromStep is the first
 * step whose state the edit can change: the new birth for an insert, min(old, new birth)
 * for a change of anchor/birth/mass/temperature, +Infinity for a no-op. Checkpoints at
 * steps ≥ changedFromStep are invalid. The live state is fixed in place when
 * changedFromStep ≥ step, else marked stale.
 */
export function upsertRecord(world: PhysicsWorld, r: WorldRecord): { slot: number; changedFromStep: number } {
  const w = world as World
  const q = quantizeRecord(r)
  let slot = w.slotOf.get(r.id)
  let changedFromStep: number
  if (slot === undefined) {
    checkStable(w, q.invMass, q.tau, -1)
    if (w.free.length === 0) grow(w, w.sys.count + 1)
    slot = w.free.pop()!
    w.slotOf.set(r.id, slot)
    w.idOf[slot] = r.id
    w.sortedIds = null
    writeRecord(w, slot, q)
    changedFromStep = q.birth
  } else {
    if (sameRecord(w, slot, q)) return { slot, changedFromStep: Number.POSITIVE_INFINITY }
    checkStable(w, q.invMass, q.tau, slot)
    const oldBirth = w.birth[slot]
    forgetBirth(w, slot, oldBirth)
    writeRecord(w, slot, q)
    changedFromStep = Math.min(oldBirth, q.birth)
  }
  syncEditedSlot(w, slot, changedFromStep)
  return { slot, changedFromStep }
}

/** Remove a record and free its slot (state cleared). changedFromStep = its birth (+Infinity if absent). */
export function removeRecord(world: PhysicsWorld, id: string): { changedFromStep: number } {
  const w = world as World
  const slot = w.slotOf.get(id)
  if (slot === undefined) return { changedFromStep: Number.POSITIVE_INFINITY }
  const oldBirth = w.birth[slot]
  forgetBirth(w, slot, oldBirth)
  deactivate(w, slot)
  w.sys.anchor.fill(0, 3 * slot, 3 * slot + 3)
  setParticle(w.sys, slot, 1 << INV_MASS_FRAC, 0, FREE_BIRTH)
  w.seed[slot] = 0
  w.idOf[slot] = null
  w.slotOf.delete(id)
  w.sortedIds = null
  w.free.push(slot)
  if (oldBirth < w.step) w.stale = true
  return { changedFromStep: oldBirth }
}

/**
 * Positions in world units, xyz per slot, rendered at X + frac·D (frac ∈ (−1, 1) is the
 * clock's fractional step). Dormant records are written at their anchor (ghosts), free
 * slots as 0. Writes min(capacity, out.length / 3) slots. Float read-out only.
 */
export function readPoses(w: PhysicsWorld, out: Float32Array, frac = 0): void {
  const { x, d, anchor } = w.sys
  const n = Math.min(w.sys.count, Math.floor(out.length / 3))
  const fd = frac / 2 ** 27
  for (let s = 0; s < n; s++) {
    const o = 3 * s
    if (w.birth[s] <= w.step) {
      out[o] = x[o] / UNIT + fd * d[o]
      out[o + 1] = x[o + 1] / UNIT + fd * d[o + 1]
      out[o + 2] = x[o + 2] / UNIT + fd * d[o + 2]
    } else if (w.idOf[s] !== null) {
      out[o] = anchor[o] / UNIT
      out[o + 1] = anchor[o + 1] / UNIT
      out[o + 2] = anchor[o + 2] / UNIT
    } else {
      out[o] = 0
      out[o + 1] = 0
      out[o + 2] = 0
    }
  }
}

/** Integer state (X Q.19, D Q.27) of an active record, or undefined (absent or dormant). */
export function readState(w: PhysicsWorld, id: string): { x: [number, number, number]; d: [number, number, number] } | undefined {
  const s = w.slotOf.get(id)
  if (s === undefined || w.birth[s] > w.step) return undefined
  const { x, d } = w.sys
  const o = 3 * s
  return { x: [x[o], x[o + 1], x[o + 2]], d: [d[o], d[o + 1], d[o + 2]] }
}

/** Active slots (a copy, ascending). */
export function activeSlots(world: PhysicsWorld): Int32Array {
  const w = world as World
  return w.act.slice(0, w.activeCount).sort()
}

/** Spawn seed fnv1a32(id) of a slot (0 for free slots). */
export function slotSeed(world: PhysicsWorld, slot: number): number {
  return (world as World).seed[slot]
}

/**
 * Overwrite the live state with (step, X, D) of exactly the slots in `slots` — which
 * must be A(step), ascending, with matching spawn seeds — clearing every other slot. Returns false (world untouched) on a
 * mismatch. Used by checkpoint restore.
 */
export function loadState(
  world: PhysicsWorld,
  step: number,
  slots: Int32Array,
  seeds: Int32Array,
  x: Int32Array,
  d: Int32Array,
): boolean {
  const w = world as World
  let expected = 0
  for (let s = 0; s < w.sys.count; s++) if (w.birth[s] <= step) expected++
  if (expected !== slots.length) return false
  for (let k = 0; k < slots.length; k++) {
    const s = slots[k]
    if (s < 0 || s >= w.sys.count || w.birth[s] > step || w.seed[s] !== seeds[k]) return false
    if (k > 0 && s <= slots[k - 1]) return false // ascending ⇒ no duplicates
  }
  w.activeCount = 0
  w.actPos.fill(-1)
  w.sys.x.fill(0)
  w.sys.d.fill(0)
  for (let k = 0; k < slots.length; k++) {
    const s = slots[k]
    w.actPos[s] = w.activeCount
    w.act[w.activeCount++] = s
    w.sys.x.set(x.subarray(3 * k, 3 * k + 3), 3 * s)
    w.sys.d.set(d.subarray(3 * k, 3 * k + 3), 3 * s)
  }
  w.step = step
  w.stale = false
  return true
}

/** Snapshot of A(step): slots ascending with their seeds, X and D. */
export function saveState(world: PhysicsWorld): { step: number; slots: Int32Array; seeds: Int32Array; x: Int32Array; d: Int32Array } {
  const w = world as World
  const slots = activeSlots(w)
  const n = slots.length
  const seeds = new Int32Array(n)
  const x = new Int32Array(3 * n)
  const d = new Int32Array(3 * n)
  for (let k = 0; k < n; k++) {
    const s = slots[k]
    seeds[k] = w.seed[s]
    x.set(w.sys.x.subarray(3 * s, 3 * s + 3), 3 * k)
    d.set(w.sys.d.subarray(3 * s, 3 * s + 3), 3 * k)
  }
  return { step: w.step, slots, seeds, x, d }
}
