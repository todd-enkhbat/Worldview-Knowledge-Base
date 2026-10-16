// The physics worker's message handler, factored out of worker.ts so it runs anywhere
// (node tests drive it directly; worker.ts only wires it to `self` and IndexedDB).
//
// One world, one integer clock. A `target` within ±64 steps of the world is reached by
// single steps (the energy ledger sees each one); anything further, and every edit that
// changed the past, is a seek through Checkpoints.seekTo, cut into small chunks under a
// per-tick time budget so new messages are handled between chunks. While a seek runs the
// host posts stats only: a mid-seek state is not the world at any playhead, so the reader
// keeps its last frame and shows "settling".
//
// Checkpoints (step 0 + every 600) fill in as the world passes them; each new one is
// written to the persistent cache, and the two around any seek target are looked up there
// first (fire and forget: a hit simply becomes the nearest checkpoint of the next chunk).
// Cold start is then "restore the cached checkpoint nearest now, run ≤ 300 steps".

import { CheckpointCache, type KvStore } from './checkpointCache.ts'
import { Checkpoints } from './clock.ts'
import { MIN_ENTROPY_SAMPLES, selectEntropySample, systemEntropy } from './entropy.ts'
import { D_FRAC, UNIT } from './fixed.ts'
import { createPairGrid, gridPairAccumulator } from './grid.ts'
import { type PairAccumulator, overflowSentinel } from './integrator.ts'
import { EnergyLedger } from './ledger.ts'
import {
  type EnergyStats,
  type FrameMsg,
  type FromWorker,
  type SimStats,
  type SlotTable,
  type ToWorker,
  frameTransfer,
} from './workerProtocol.ts'
import {
  type PhysicsWorld,
  type WorldRecord,
  activeSlots,
  buildWorld,
  readPoses,
  removeRecord,
  stepWorld,
  upsertRecord,
} from './world.ts'

export interface HostOptions {
  /** Delivers a message to the main thread (with its zero-copy transfer list). */
  post: (msg: FromWorker, transfer: ArrayBuffer[]) => void
  /** Persistent checkpoint cache; null/absent = memory only. */
  kv?: KvStore | null
  /** Monotonic ms. */
  now?: () => number
  /** Runs the next background tick (setTimeout 0 in the worker). */
  schedule?: (fn: () => void) => void
  /** Runs `fn` after `ms` (the deferred stats refresh of a paused world). */
  delay?: (fn: () => void, ms: number) => void
  /** Work per tick before yielding to the message queue (ms). */
  tickBudgetMs?: number
  /** Steps per seekTo call between deadline checks. */
  seekChunk?: number
  /** Minimum interval between entropy/energy readings (ms). */
  statsIntervalMs?: number
  checkpointEvery?: number
  pairMode?: 'grid' | 'brute'
}

/** |Δ| above this is a seek (PLAN "Clock"). */
export const STEP_THRESHOLD = 64

const D_TO_UNITS = 2 ** -D_FRAC

export class PhysicsHost {
  private readonly post: HostOptions['post']
  private readonly cache: CheckpointCache | null
  private readonly now: () => number
  private readonly schedule: (fn: () => void) => void
  private readonly delay: (fn: () => void, ms: number) => void
  private readonly budget: number
  private readonly chunk: number
  private readonly statsInterval: number
  private readonly every: number
  private readonly pairMode: 'grid' | 'brute'

  private world: PhysicsWorld | null = null
  private ckpts: Checkpoints
  private gen = 0
  private target = 0
  /** A seek is in flight: no frames until it lands on the target. */
  private seeking = false
  private scheduled = false
  private ticking = false
  /** Checkpoint steps already written to the cache (or attempted). */
  private persisted = new Set<number>()
  /** Checkpoint steps already looked up in the cache. */
  private looked = new Set<number>()
  private slotsVersion = 0
  private slotsSent = -1
  private act: Int32Array | null = null
  private ledger: EnergyLedger | null = null
  /** The ledger's own pair grid (the world's is private to world.ts); bit-identical to it. */
  private ledgerPairs: PairAccumulator | null = null
  private statsAt = Number.NEGATIVE_INFINITY
  /** World step and layout of the last reading; a refresh is owed when either moved. */
  private statsStep = Number.NaN
  private statsLayout = -1
  private statsTimer = false
  private S: number | null = null
  private energy: EnergyStats | null = null
  private lastSettling = false

  constructor(opts: HostOptions) {
    this.post = opts.post
    this.cache = opts.kv ? new CheckpointCache(opts.kv) : null
    this.now = opts.now ?? (() => performance.now())
    this.schedule = opts.schedule ?? ((fn) => void setTimeout(fn, 0))
    this.delay = opts.delay ?? ((fn, ms) => void setTimeout(fn, ms))
    this.budget = opts.tickBudgetMs ?? 8
    this.chunk = opts.seekChunk ?? 8
    this.statsInterval = opts.statsIntervalMs ?? 1000
    this.every = opts.checkpointEvery ?? 600
    this.pairMode = opts.pairMode ?? 'grid'
    this.ckpts = new Checkpoints(this.every)
  }

  /** The live world (tests and diagnostics). */
  get current(): PhysicsWorld | null {
    return this.world
  }

  get checkpoints(): Checkpoints {
    return this.ckpts
  }

  /** True while the world is not yet the state at the requested target. */
  get settling(): boolean {
    const w = this.world
    return w !== null && (this.seeking || w.stale || w.step !== this.target)
  }

  handle(msg: ToWorker): void {
    try {
      switch (msg.type) {
        case 'load':
          this.load(msg.gen, msg.records, msg.seed, msg.target)
          break
        case 'target':
          this.target = Math.max(0, Math.round(msg.step))
          break
        case 'edit':
          this.edit(msg.upserts, msg.removes)
          break
        case 'clear-cache':
          void this.cache?.clear()
          this.persisted.clear()
          this.looked.clear()
          return
      }
      this.tick()
    } catch (e) {
      this.fail(e, msg.type === 'load')
    }
  }

  /**
   * One budgeted unit of work toward the target, then a frame (or stats). Re-schedules
   * itself while work remains. Returns true when more work remains.
   */
  tick(): boolean {
    const w = this.world
    if (!w || this.ticking) return false
    this.ticking = true
    let moved = false
    try {
      const deadline = this.now() + this.budget
      while (w.stale || w.step !== this.target) {
        const delta = this.target - w.step
        if (!this.seeking && !w.stale && Math.abs(delta) <= STEP_THRESHOLD) {
          this.stepOnce(w, delta > 0 ? 1 : -1)
        } else {
          if (!this.seeking) this.beginSeek()
          this.ckpts.seekTo(w, this.target, this.chunk)
        }
        moved = true
        if (this.now() >= deadline) break
      }
      if (this.seeking && !w.stale && w.step === this.target) {
        this.seeking = false
        this.act = null
      }
      this.persistNew(w)
      const statsChanged = this.maybeReadStats(w)
      const settling = this.settling
      const settlingChanged = settling !== this.lastSettling
      this.lastSettling = settling
      if (!this.seeking && (moved || this.slotsSent !== this.slotsVersion)) this.postFrame(w)
      else if (moved || statsChanged || settlingChanged) this.postStats(w)
    } finally {
      this.ticking = false
    }
    const more = w.stale || w.step !== this.target
    if (more) this.kick()
    return more
  }

  private kick(): void {
    if (this.scheduled) return
    this.scheduled = true
    this.schedule(() => {
      this.scheduled = false
      try {
        this.tick()
      } catch (e) {
        this.fail(e, false)
      }
    })
  }

  private load(gen: number, records: WorldRecord[], seed: number, target: number): void {
    this.gen = gen
    this.world = null
    this.ckpts = new Checkpoints(this.every)
    this.persisted = new Set()
    this.looked = new Set()
    this.ledger = null
    this.act = null
    this.S = null
    this.energy = null
    this.statsAt = Number.NEGATIVE_INFINITY
    this.statsStep = Number.NaN
    this.target = Math.max(0, Math.round(target))
    const w = buildWorld({ records, seed, pairMode: this.pairMode })
    this.world = w
    this.ledgerPairs = gridPairAccumulator(createPairGrid(w.params.pairSigma, w.sys.count))
    this.slotsVersion++
    this.seeking = false
    this.lastSettling = false
  }

  private edit(upserts: WorldRecord[], removes: string[]): void {
    const w = this.world
    if (!w) return
    let from = Number.POSITIVE_INFINITY
    const errors: string[] = []
    for (const r of upserts) {
      try {
        from = Math.min(from, upsertRecord(w, r).changedFromStep)
      } catch (e) {
        // One bad record (e.g. one the stability gate rejects) must not stop the world.
        errors.push(`${r.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    for (const id of removes) from = Math.min(from, removeRecord(w, id).changedFromStep)
    if (errors.length) this.post({ type: 'error', gen: this.gen, message: errors.join('; '), fatal: false }, [])
    // +∞: every upsert was a no-op and every remove missed; nothing to recompute.
    if (from === Number.POSITIVE_INFINITY) return
    this.ckpts.invalidateFrom(from)
    for (const s of [...this.persisted]) if (s >= from) this.persisted.delete(s)
    for (const s of [...this.looked]) if (s >= from) this.looked.delete(s)
    this.slotsVersion++
    this.act = null
    this.ledger = null
    // A stale world still holds the old trajectory at the shown step plus the edited slots
    // in their spawn state: show that while the recompute runs, rather than nothing.
    // (Mid-seek the world is at no shown step, so the reader just keeps its last frame.)
    if (w.stale && !this.seeking) this.postFrame(w)
  }

  private stepOnce(w: PhysicsWorld, dir: 1 | -1): void {
    stepWorld(w, dir)
    this.ckpts.maybeSave(w)
    if (this.ledger) {
      const act = this.activeList(w)
      this.ledger.advance(w.sys, w.step, act, act.length)
    }
  }

  private beginSeek(): void {
    this.seeking = true
    this.ledger = null
    this.act = null
    this.lookUp(this.target)
  }

  /** Ask the cache for the checkpoints on either side of `step` (async; hits land in ckpts). */
  private lookUp(step: number): void {
    const cache = this.cache
    const w = this.world
    if (!cache || !w) return
    const lo = Math.floor(step / this.every) * this.every
    const gen = this.gen
    const ckpts = this.ckpts
    for (const s of [lo, lo + this.every]) {
      if (s === 0 || this.looked.has(s) || ckpts.has(s)) continue
      this.looked.add(s)
      cache
        .hydrate(w, ckpts, s)
        .then((hit) => {
          if (hit && gen === this.gen && this.settling) this.kick()
        })
        .catch(() => undefined)
    }
  }

  private persistNew(w: PhysicsWorld): void {
    const cache = this.cache
    if (!cache) return
    for (const s of this.ckpts.keys()) {
      // Step 0 is a pure function of the records (resetWorld): never worth a write.
      if (s === 0 || this.persisted.has(s)) continue
      this.persisted.add(s)
      cache.persist(w, this.ckpts, s).catch(() => undefined)
    }
  }

  /** A(step), cached; the set only changes at birth crossings (count changes) or edits. */
  private activeList(w: PhysicsWorld): Int32Array {
    if (!this.act || this.act.length !== w.activeCount) this.act = activeSlots(w)
    return this.act
  }

  /** Entropy and the energy ledger at ≤ 1/statsInterval, only at a settled target. */
  private maybeReadStats(w: PhysicsWorld): boolean {
    if (this.seeking || w.stale || w.step !== this.target) return false
    if (w.step === this.statsStep && this.slotsVersion === this.statsLayout) return false
    const t = this.now()
    const wait = this.statsAt + this.statsInterval - t
    if (wait > 0) {
      // Paused right after a move: no further tick would come, so owe one.
      if (!this.statsTimer) {
        this.statsTimer = true
        this.delay(() => {
          this.statsTimer = false
          this.tick()
        }, wait)
      }
      return false
    }
    this.statsAt = t
    this.statsStep = w.step
    this.statsLayout = this.slotsVersion
    const act = this.activeList(w)
    if (!this.ledger) this.ledger = new EnergyLedger(w.sys, w.step, act, act.length, this.ledgerPairs ?? undefined)
    // read() leaves sys.kick = K_n of A(n): the entropy then uses the synchronised velocity.
    const r = this.ledger.read(w.sys, act, act.length)
    this.energy = {
      origin: this.ledger.origin,
      e0: r.e0,
      raw: r.raw,
      births: r.births,
      rampWork: r.rampWork,
      ledger: r.ledger,
    }
    if (w.activeCount < MIN_ENTROPY_SAMPLES) this.S = null
    else {
      const sample = selectEntropySample(w.idOf, (s) => w.birth[s] <= w.step)
      const S = systemEntropy(w.sys, sample, w.sys.kick).S
      this.S = Number.isFinite(S) ? S : null
    }
    return true
  }

  private stats(w: PhysicsWorld): SimStats {
    return {
      activeCount: w.activeCount,
      S: this.S,
      energy: this.energy,
      checkpoints: this.ckpts.keys().length,
      settling: this.settling,
      overflowSentinel: overflowSentinel(w.sys),
    }
  }

  private slotTable(w: PhysicsWorld): SlotTable {
    const cap = w.sys.count
    const anchor = new Float32Array(3 * cap)
    const a = w.sys.anchor
    for (let s = 0; s < cap; s++) {
      if (w.idOf[s] === null) continue
      const o = 3 * s
      anchor[o] = a[o] / UNIT
      anchor[o + 1] = a[o + 1] / UNIT
      anchor[o + 2] = a[o + 2] / UNIT
    }
    return { version: this.slotsVersion, ids: w.idOf.slice(), birth: w.birth.slice(), anchor }
  }

  private postFrame(w: PhysicsWorld): void {
    const cap = w.sys.count
    const pos = new Float32Array(3 * cap)
    readPoses(w, pos, 0)
    const vel = new Float32Array(3 * cap)
    const born = new Uint8Array(cap)
    const d = w.sys.d
    for (let s = 0; s < cap; s++) {
      if (w.idOf[s] === null || w.birth[s] > w.step) continue
      born[s] = 1
      const o = 3 * s
      vel[o] = d[o] * D_TO_UNITS
      vel[o + 1] = d[o + 1] * D_TO_UNITS
      vel[o + 2] = d[o + 2] * D_TO_UNITS
    }
    const slots = this.slotsSent === this.slotsVersion ? null : this.slotTable(w)
    this.slotsSent = this.slotsVersion
    const msg: FrameMsg = { type: 'frame', gen: this.gen, step: w.step, pos, vel, born, slots, stats: this.stats(w) }
    this.post(msg, frameTransfer(msg))
  }

  private postStats(w: PhysicsWorld): void {
    this.post({ type: 'stats', gen: this.gen, step: w.step, stats: this.stats(w) }, [])
  }

  private fail(e: unknown, fatal: boolean): void {
    const message = e instanceof Error ? e.message : String(e)
    if (fatal) this.world = null
    this.post({ type: 'error', gen: this.gen, message, fatal }, [])
  }
}
