// Messages between the main thread (src/world/time/physicsClient.ts) and the physics
// worker (worker.ts → workerHost.ts). Types only, plus the transfer list of a frame: no
// DOM, no runtime state. Records arrive already mapped to WorldRecords (anchor in world
// units, integer birth step), so the worker never sees dates or settings beyond the seed.

import type { WorldRecord } from './world.ts'

/** (Re)build the world from scratch. Any frame of an older `gen` is stale. */
export interface LoadMsg {
  type: 'load'
  gen: number
  records: WorldRecord[]
  seed: number
  /** Opaque key of the settings the records were mapped under (T0, scales, seed). */
  settingsKey: string
  /** Playhead step to bring the world to first. */
  target: number
}

/** The playhead moved: bring the world to `step` (step when |Δ| ≤ 64, else seek). */
export interface TargetMsg {
  type: 'target'
  step: number
}

/** Records changed: upsert/remove, invalidate checkpoints, recompute progressively. */
export interface EditMsg {
  type: 'edit'
  upserts: WorldRecord[]
  removes: string[]
}

/** Drop the persistent checkpoint cache (derived data; safe at any time). */
export interface ClearCacheMsg {
  type: 'clear-cache'
}

export type ToWorker = LoadMsg | TargetMsg | EditMsg | ClearCacheMsg

/** Per-slot record data, sent with a frame only when the slot layout changed. */
export interface SlotTable {
  /** Bumped on every layout change. */
  version: number
  /** Record id per slot (null = free slot). Rows of the pose table are these slots. */
  ids: (string | null)[]
  /** Birth step per slot (FREE_BIRTH for free slots). */
  birth: Int32Array
  /** Anchor per slot, xyz world units (where ghosts render). */
  anchor: Float32Array
}

export interface EnergyStats {
  /** Step the ledger was (re)started at: the origin of E_0 (it moves on every seek). */
  origin: number
  e0: number
  /** E_n − E_0. */
  raw: number
  births: number
  rampWork: number
  /** E_n − E_0 − births − ramp work: stays flat while E jumps at births. */
  ledger: number
}

export interface SimStats {
  /** |A(step)|. */
  activeCount: number
  /** −D_KL of the active nodes (entropy.ts), refreshed ≤ 1 Hz; null while |A| < 5. */
  S: number | null
  /** Birth-compensated energy ledger, refreshed ≤ 1 Hz; null before the first reading. */
  energy: EnergyStats | null
  /** In-memory checkpoints. */
  checkpoints: number
  /** Recompute in progress (after an edit, a load or a long seek). */
  settling: boolean
  /** Tether saturations + impulse-sum wraps seen by K (criterion B: should stay 0). */
  overflowSentinel: number
}

/**
 * The world at `step`. pos is X at frac 0 (world units, xyz per slot; dormant records at
 * their anchor, free slots 0); vel is D in world units per step, so a reader renders at
 * pos + acc·vel. born[slot] = 1 when the slot is active at `step`.
 */
export interface FrameMsg {
  type: 'frame'
  gen: number
  step: number
  pos: Float32Array
  vel: Float32Array
  born: Uint8Array
  slots: SlotTable | null
  stats: SimStats
}

/**
 * Stats without poses: sent while a seek or recompute is in flight (the reader keeps its
 * last frame; intermediate states of a seek are not the world at any playhead).
 */
export interface StatsMsg {
  type: 'stats'
  gen: number
  /** Step the worker is at (mid-seek: neither the old nor the new playhead). */
  step: number
  stats: SimStats
}

export interface ErrorMsg {
  type: 'error'
  gen: number
  message: string
  /** True when the world could not be built or stepped at all (the reader should fall back). */
  fatal: boolean
}

export type FromWorker = FrameMsg | StatsMsg | ErrorMsg

/** Buffers a frame hands over (zero-copy) when posted. */
export function frameTransfer(f: FrameMsg): ArrayBuffer[] {
  const out = [f.pos.buffer, f.vel.buffer, f.born.buffer] as ArrayBuffer[]
  if (f.slots) out.push(f.slots.birth.buffer as ArrayBuffer, f.slots.anchor.buffer as ArrayBuffer)
  return out
}
