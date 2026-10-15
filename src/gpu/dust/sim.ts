// The dust clock follower: drives a dust backend (the WebGL2 ping-pong, or a CPU mirror
// in tests) toward the playhead step in time-sliced k-step draws, keeps a ring of
// checkpoints every `interval` steps, seeks by restoring the nearest checkpoint (or the
// free step-0 state) and applies edits with CPU-computed rows. Pure logic: it never
// touches WebGL, so tests run it against the GLSL-semantics mirror.
//
// State at step n is a pure function of the segments' owners (dustWorld.ts), so every
// checkpoint and the live state can be recomputed bit for bit; nothing here is persisted.

import type { PhysicsParams } from '../../physics/params.ts'
import { DUST_SEGMENT } from './alloc.ts'
import { DUST_FREE_BIRTH, type DustOwner, type DustRows, DustRowsJob, computeDustRows } from './dustWorld.ts'
import { STYLE_HIDDEN } from './layout.ts'

/** What DustSim needs from a dust state store. Every draw follows dustStepFragmentShader with births on. */
export interface DustBackend {
  /** Texels per row (a multiple of DUST_SEGMENT). */
  readonly width: number
  /** Restrict every later draw and copy to texel rows [0, rows). */
  setRows(rows: number): void
  /** One step-shader draw of the live state, which is at step `from`: `steps` forward or backward. */
  draw(from: number, steps: number, backward: boolean): void
  /** Copy the live state (at `step`) into checkpoint `slot`. */
  saveCheckpoint(slot: number, step: number): void
  /** Make checkpoint `slot` (taken at `step`) the live state; dormant texels are re-spawned. */
  restoreCheckpoint(slot: number, step: number): void
  /** Static inputs of a segment: anchor/birth and meta (per-particle seed, style incl. STYLE_HIDDEN); null frees it. */
  writeSegment(segment: number, owner: DustOwner | null, style: number): void
  /** Overwrite a segment's rows in the live state / in a checkpoint. */
  patchLive(segment: number, rows: DustRows): void
  patchCheckpoint(slot: number, segment: number, rows: DustRows): void
  /** Free a checkpoint slot's storage (optional). */
  dropCheckpoint?(slot: number): void
}

export interface DustSimOptions {
  /** Checkpoint spacing in steps (PLAN: 3000). */
  readonly interval?: number
  /** Checkpoint slots in the ring. */
  readonly ring?: number
  /** Longest shader loop per draw (keeps single draws short on slow GPUs). */
  readonly maxStepsPerDraw?: number
  /** Edits needing ≤ this many CPU kernel steps (×64 particles) are applied synchronously. */
  readonly syncEditSteps?: number
  /** CPU kernel steps per frame for asynchronous edit rows (all jobs together). */
  readonly cpuStepsPerFrame?: number
  /** A seek is worth it when it saves more than this many steps of stepping. */
  readonly restoreCost?: number
}

export interface DustFrame {
  /** Step of the live state after this frame. */
  readonly step: number
  /** Kernel steps drawn this frame (|Δ| summed over draws). */
  readonly stepsRun: number
  readonly draws: number
  /** A checkpoint (or step 0) was restored this frame. */
  readonly restored: number | null
  /** The live state is at the target. */
  readonly caughtUp: boolean
  /** Segments still waiting for CPU rows (hidden). */
  readonly pending: number
}

interface Job {
  readonly owner: DustOwner
  readonly job: DustRowsJob
  readonly style: number
}

/**
 * Follows a target step with a bounded number of kernel steps per frame. Owners are set
 * per segment; the backend's static textures, live state and checkpoints are kept equal
 * to "every owner simulated from its birth" (dustWorld.ts semantics).
 */
export class DustSim {
  readonly interval: number
  readonly ring: number
  readonly maxStepsPerDraw: number
  readonly syncEditSteps: number
  readonly cpuStepsPerFrame: number
  readonly restoreCost: number
  private readonly backend: DustBackend
  private readonly params: PhysicsParams
  private live = 0
  /** checkpoint step → slot */
  private readonly ckpt = new Map<number, number>()
  private readonly freeSlots: number[]
  private readonly owners = new Map<number, DustOwner>()
  private readonly jobs = new Map<number, Job>()
  /** −1 until the first setRows, so it always reaches the backend (whose default may differ). */
  private rows = -1

  constructor(backend: DustBackend, params: PhysicsParams, opts: DustSimOptions = {}) {
    this.backend = backend
    this.params = params
    this.interval = opts.interval ?? 3000
    this.ring = opts.ring ?? 8
    this.maxStepsPerDraw = opts.maxStepsPerDraw ?? 128
    this.syncEditSteps = opts.syncEditSteps ?? 1024
    this.cpuStepsPerFrame = opts.cpuStepsPerFrame ?? 512
    this.restoreCost = opts.restoreCost ?? 32
    if (!(this.interval >= 1) || !(this.ring >= 0) || !(this.maxStepsPerDraw >= 1)) throw new RangeError('bad DustSim options')
    this.freeSlots = Array.from({ length: this.ring }, (_, i) => this.ring - 1 - i)
    // Step 0 is every texel at its spawn state: a 0-step draw from anything.
    this.backend.draw(0, 0, false)
  }

  /** Step of the live state. */
  get step(): number {
    return this.live
  }

  get checkpointSteps(): number[] {
    return [...this.ckpt.keys()].sort((a, b) => a - b)
  }

  get pending(): number {
    return this.jobs.size
  }

  /** Texel rows the draws cover (set by the caller from the allocation's used range). */
  setRows(rows: number): void {
    if (rows === this.rows) return
    this.rows = rows
    this.backend.setRows(rows)
  }

  ownerOf(segment: number): DustOwner | null {
    return this.owners.get(segment) ?? null
  }

  /** Render-only change: the style of an owned segment. */
  setStyle(segment: number, style: number): void {
    const o = this.owners.get(segment)
    if (!o || o.style === style) return
    const next = { ...o, style }
    this.owners.set(segment, next)
    const j = this.jobs.get(segment)
    if (j) this.jobs.set(segment, { ...j, style })
    this.backend.writeSegment(segment, next, j ? style | HIDDEN_FLAG : style)
  }

  /**
   * Give a segment to `owner` (null frees it). The live state and every stored checkpoint
   * past the owner's birth get the owner's rows from the CPU kernel; checkpoints at or
   * before the birth are re-spawned by the restore draw itself. Edits needing more than
   * `syncEditSteps` kernel steps hide the segment and finish over the next frames.
   */
  setOwner(segment: number, owner: DustOwner | null): void {
    const prev = this.owners.get(segment) ?? null
    if (prev === owner || (prev && owner && samePhysics(prev, owner) && prev.style === owner.style)) return
    if (prev && owner && samePhysics(prev, owner)) {
      this.setStyle(segment, owner.style)
      return
    }
    this.jobs.delete(segment)
    if (owner) this.owners.set(segment, owner)
    else this.owners.delete(segment)
    const b = owner ? owner.birth : DUST_FREE_BIRTH
    // Steps whose stored state must change: the live one once born, checkpoints strictly after the birth.
    const later = this.checkpointSteps.filter((c) => c > b)
    const needLive = owner !== null && this.live >= b
    if (!owner || (!needLive && later.length === 0)) {
      this.backend.writeSegment(segment, owner, owner ? owner.style : 0)
      this.respawnLive()
      return
    }
    const last = Math.max(needLive ? this.live : 0, ...later)
    if (last - b <= this.syncEditSteps) {
      this.backend.writeSegment(segment, owner, owner.style)
      const steps = needLive ? [this.live, ...later] : later
      const rows = computeDustRows(owner, steps, this.params)
      let k = 0
      if (needLive) this.backend.patchLive(segment, rows[k++])
      else this.respawnLive()
      for (const c of later) this.backend.patchCheckpoint(this.ckpt.get(c)!, segment, rows[k++])
      return
    }
    // Asynchronous: hidden until the CPU rows reach the live step; later checkpoints are
    // dropped (re-made by the stepping once no job is pending).
    this.backend.writeSegment(segment, owner, owner.style | HIDDEN_FLAG)
    for (const c of later) this.drop(c)
    this.jobs.set(segment, { owner, job: new DustRowsJob(owner, this.params), style: owner.style })
  }

  /**
   * Many owners at once (first load, settings change): write every static input and
   * restart from step 0. Re-stepping on the GPU is far cheaper than CPU rows per owner.
   */
  replaceOwners(changes: Iterable<readonly [number, DustOwner | null]>): void {
    for (const [segment, owner] of changes) {
      this.jobs.delete(segment)
      if (owner) this.owners.set(segment, owner)
      else this.owners.delete(segment)
      this.backend.writeSegment(segment, owner, owner ? owner.style : 0)
    }
    this.reset()
  }

  /** Forget every checkpoint and every pending job; the live state restarts from step 0. */
  reset(): void {
    for (const c of [...this.ckpt.keys()]) this.drop(c)
    for (const [segment, j] of this.jobs) this.backend.writeSegment(segment, j.owner, j.style)
    this.jobs.clear()
    this.backend.draw(0, 0, false)
    this.live = 0
  }

  /**
   * Advance toward `target` with at most `budget` kernel steps of drawing (≥ 1 when the
   * target differs). Seeks first when a stored checkpoint (or step 0) is cheaper.
   */
  frame(target: number, budget: number): DustFrame {
    if (!Number.isFinite(target)) throw new RangeError(`dust target ${target}`)
    const goal = Math.max(0, Math.round(target))
    this.runJobs()
    let restored: number | null = null
    const dist = Math.abs(goal - this.live)
    if (dist > this.restoreCost) {
      let best = this.live
      let bestCost = dist
      const consider = (c: number) => {
        const cost = Math.abs(goal - c) + this.restoreCost
        if (cost < bestCost) {
          best = c
          bestCost = cost
        }
      }
      consider(0)
      for (const c of this.ckpt.keys()) consider(c)
      if (best !== this.live) {
        if (best === 0) this.restoreZero()
        else this.backend.restoreCheckpoint(this.ckpt.get(best)!, best)
        this.live = best
        restored = best
      }
    }
    let left = Math.max(0, Math.floor(budget))
    if (goal !== this.live && left === 0) left = 1
    let stepsRun = 0
    let draws = 0
    while (this.live !== goal && left > 0) {
      const back = goal < this.live
      let k = Math.min(left, Math.abs(goal - this.live), this.maxStepsPerDraw)
      // Land on every checkpoint boundary on the way, so the ring can be filled.
      const r = ((this.live % this.interval) + this.interval) % this.interval
      const toEdge = back ? (r === 0 ? this.interval : r) : this.interval - r
      k = Math.min(k, toEdge)
      this.backend.draw(this.live, k, back)
      this.live += back ? -k : k
      left -= k
      stepsRun += k
      draws++
      if (this.live % this.interval === 0) this.maybeSave()
    }
    return { step: this.live, stepsRun, draws, restored, caughtUp: this.live === goal, pending: this.jobs.size }
  }

  /**
   * A segment just written as unborn (or freed) still holds its previous occupant's state
   * in the live buffer; the next stepping draw would regenerate it, but a paused playhead
   * never draws, and readbacks (__wv.dustCheck, the lab identity run) must see the pure
   * state now. A 0-step draw re-spawns exactly the texels with birth ≥ the live step.
   */
  private respawnLive(): void {
    this.backend.draw(this.live, 0, false)
  }

  private restoreZero(): void {
    // A 0-step draw at step 0 re-spawns every texel (all births are ≥ 0).
    this.backend.draw(0, 0, false)
  }

  private maybeSave(): void {
    const s = this.live
    if (s <= 0 || this.ring === 0 || this.ckpt.has(s) || this.jobs.size > 0) return
    if (this.freeSlots.length === 0) {
      // Evict the stored checkpoint farthest from here.
      let far = -1
      for (const c of this.ckpt.keys()) if (far < 0 || Math.abs(c - s) > Math.abs(far - s)) far = c
      this.drop(far)
    }
    const slot = this.freeSlots.pop()!
    this.backend.saveCheckpoint(slot, s)
    this.ckpt.set(s, slot)
  }

  private drop(step: number): void {
    const slot = this.ckpt.get(step)
    if (slot === undefined) return
    this.ckpt.delete(step)
    this.freeSlots.push(slot)
    this.backend.dropCheckpoint?.(slot)
  }

  /** Bring pending CPU rows toward the live step; publish the ones that arrive. */
  private runJobs(): void {
    let budget = this.cpuStepsPerFrame
    for (const [segment, j] of this.jobs) {
      if (budget <= 0) break
      const before = j.job.step
      const done = j.job.advance(this.live, budget)
      budget -= Math.abs(j.job.step - before)
      if (!done) continue
      this.backend.writeSegment(segment, j.owner, j.style)
      if (this.live >= j.owner.birth) this.backend.patchLive(segment, j.job.rows())
      this.jobs.delete(segment)
    }
  }
}

/** meta.y bit the renderer uses to hide a segment while its rows are being computed. */
const HIDDEN_FLAG = STYLE_HIDDEN

function samePhysics(a: DustOwner, b: DustOwner): boolean {
  return a.birth === b.birth && a.seed === b.seed && a.anchor[0] === b.anchor[0] && a.anchor[1] === b.anchor[1] && a.anchor[2] === b.anchor[2]
}

/** Texels of a segment, for backends. */
export function segmentTexels(segment: number): { first: number; count: number } {
  return { first: segment * DUST_SEGMENT, count: DUST_SEGMENT }
}
