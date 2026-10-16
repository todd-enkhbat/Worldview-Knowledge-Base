// The playback clock and the checkpoint store. The physics state is a pure function of
// (records, settings, step), so the clock only decides WHICH integer step to show; the
// float accumulator never reaches K. Checkpoints are derived data: any of them can be
// dropped and recomputed bit-for-bit.

import { STEPS_PER_SECOND } from './fixed.ts'
import { PHYSICS_VERSION } from './params.ts'
import { type PhysicsWorld, loadState, resetWorld, saveState, stepWorld } from './world.ts'

export interface ScrubberOptions {
  /** Clamp per-frame wall time (s); default 0.1. */
  maxFrameDt?: number
  /** |steps| above this in one frame → seek instead of stepping; default 64. */
  seekThreshold?: number
}

/**
 * PLAN "Clock": clamp frameDt ≤ 0.1 s; acc += speed·frameDt/dt; n = trunc(acc);
 * acc −= n. The caller runs n steps (or seeks when |n| > 64) and renders at
 * X + acc·D (readPoses frac = acc).
 */
export class Scrubber {
  acc = 0
  readonly maxFrameDt: number
  readonly seekThreshold: number

  constructor(opts: ScrubberOptions = {}) {
    this.maxFrameDt = opts.maxFrameDt ?? 0.1
    this.seekThreshold = opts.seekThreshold ?? 64
  }

  advance(frameDtSec: number, speed: number): { steps: number; seek: boolean } {
    const dt = frameDtSec > this.maxFrameDt ? this.maxFrameDt : frameDtSec > 0 ? frameDtSec : 0
    if (Number.isFinite(speed)) this.acc += speed * dt * STEPS_PER_SECOND
    // `|| 0` folds −0 into 0.
    const n = Math.trunc(this.acc) || 0
    this.acc -= n
    return { steps: n, seek: Math.abs(n) > this.seekThreshold }
  }

  reset(): void {
    this.acc = 0
  }
}

/** The active slots of a world at `step`, ascending, with their spawn seeds (to validate slot reuse), X and D. */
export interface CheckpointState {
  readonly step: number
  readonly slots: Int32Array
  readonly seeds: Int32Array
  readonly x: Int32Array
  readonly d: Int32Array
}

/** Cache key: hash(records born ≤ step, settings, PHYSICS_VERSION) plus the step. */
export function checkpointKey(recordsHash: string, settingsHash: string, step: number): string {
  return `physics/ckpt/v${PHYSICS_VERSION}/${settingsHash}/${recordsHash}/${step}`
}

/**
 * In-memory checkpoints: step 0 plus every `every` steps, storing only active slots.
 * seekTo restores the nearest checkpoint on either side of the target (or the live
 * state, or the step-0 state, whichever is closest) and steps the rest, so a seek costs
 * ≤ every/2 steps whenever the checkpoints around the target exist. Passing a multiple
 * of `every` during a seek fills in a missing checkpoint (forward or backward: both
 * directions reach the identical state).
 */
export class Checkpoints {
  readonly every: number
  private readonly map = new Map<number, CheckpointState>()

  constructor(every = 600) {
    if (!(Number.isInteger(every) && every > 0)) throw new RangeError(`checkpoint interval ${every}`)
    this.every = every
  }

  /** Store the state at w.step (any step; normally a multiple of `every`). */
  save(w: PhysicsWorld): void {
    if (w.stale) throw new Error('cannot checkpoint a stale world (an edit changed its past)')
    this.map.set(w.step, saveState(w))
  }

  /** Save when w.step is a multiple of `every` with no checkpoint yet; true if saved. */
  maybeSave(w: PhysicsWorld): boolean {
    if (w.stale || w.step % this.every !== 0 || this.map.has(w.step)) return false
    this.save(w)
    return true
  }

  has(step: number): boolean {
    return this.map.has(step)
  }

  get(step: number): CheckpointState | undefined {
    return this.map.get(step)
  }

  /** Insert an externally loaded checkpoint (e.g. from the persistent cache). */
  put(state: CheckpointState): void {
    this.map.set(state.step, state)
  }

  /** The stored checkpoint closest to target (either side; ties → the earlier one). */
  nearest(target: number): { step: number; state: CheckpointState } | undefined {
    let best: CheckpointState | undefined
    let bestDist = Number.POSITIVE_INFINITY
    for (const [step, state] of this.map) {
      const dist = Math.abs(target - step)
      if (dist < bestDist || (dist === bestDist && best !== undefined && step < best.step)) {
        best = state
        bestDist = dist
      }
    }
    return best && { step: best.step, state: best }
  }

  /** Load the checkpoint at `step` into w. A checkpoint that no longer matches A(step) is dropped. */
  restore(w: PhysicsWorld, step: number): boolean {
    const st = this.map.get(step)
    if (!st) return false
    if (loadState(w, st.step, st.slots, st.seeds, st.x, st.d)) return true
    this.map.delete(step)
    return false
  }

  /** Drop every checkpoint at a step ≥ `step` (pass upsert/remove changedFromStep). */
  invalidateFrom(step: number): void {
    for (const k of [...this.map.keys()]) if (k >= step) this.map.delete(k)
  }

  clear(): void {
    this.map.clear()
  }

  keys(): number[] {
    return [...this.map.keys()].sort((a, b) => a - b)
  }

  /**
   * Bring w to `target` from the closest of: the live state (unless stale), the nearest
   * checkpoint, or a reset to step 0. Runs at most maxSteps steps (call again to
   * continue a progressive recompute: the live state is then the closest start).
   * Returns the number of steps run.
   */
  seekTo(w: PhysicsWorld, target: number, maxSteps = Number.POSITIVE_INFINITY): number {
    if (!Number.isSafeInteger(target)) throw new RangeError(`seek target ${target} is not an integer`)
    for (;;) {
      const live = w.stale ? Number.POSITIVE_INFINITY : Math.abs(target - w.step)
      const ck = this.nearest(target)
      const ckd = ck ? Math.abs(target - ck.step) : Number.POSITIVE_INFINITY
      const zero = Math.abs(target)
      if (live <= ckd && live <= zero) break
      if (ck && ckd <= zero) {
        if (this.restore(w, ck.step)) break
        continue // an invalid checkpoint was dropped; choose again
      }
      resetWorld(w)
      break
    }
    this.maybeSave(w)
    let ran = 0
    while (w.step !== target && ran < maxSteps) {
      stepWorld(w, w.step < target ? 1 : -1)
      ran++
      this.maybeSave(w)
    }
    return ran
  }
}
