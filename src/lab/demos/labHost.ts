import { STEPS_PER_SECOND } from '../../physics/fixed.ts'
import type { FromLab, LabEventKind, ToLab } from './labProtocol.ts'
import { type ArrowProgress, LAB_CONFIG, LabSim, arrowOfTime, growthRate } from './labSim.ts'

// The lab worker's behaviour, free of the worker scope so node tests can drive it.
//
// Live world: a self-scheduling loop runs whole steps at the requested speed (sim seconds
// per wall second), never more than BUDGET_MS of stepping per tick (excess steps are
// dropped, not queued, so a slow machine plays slower instead of spiralling). Positions go
// out at ≤ 30 Hz, S(t) at ≤ 4 Hz (one estimate is a few ms at N = 1000). "Home" runs the
// dynamics back to the canonical origin at an accelerated speed, un-flips, and reports
// whether the hash equals the initial one.
//
// Jobs: the arrow-of-time and growth-rate generators are advanced in ≤ JOB_SLICE_MS slices
// so a cancel (or a new job) is seen between slices.

const BUDGET_MS = 12
/** Delay between live-loop turns: ~one display frame of slack, not a busy spin. */
const TICK_MS = 6
const FRAME_INTERVAL_MS = 1000 / 30
const ENTROPY_INTERVAL_MS = 250
const JOB_SLICE_MS = 40
const PROGRESS_INTERVAL_MS = 100
/** Homing takes at most ~HOME_SECONDS of wall time (and runs at ≥ 20× real time). */
const HOME_SECONDS = 4
const HOME_MIN_SPEED = 20

export interface LabHostDeps {
  post: (msg: FromLab, transfer?: Transferable[]) => void
  /** Schedules the next tick (worker: setTimeout 0). */
  schedule?: (fn: () => void, ms: number) => unknown
  now?: () => number
}

const hex = (h: number) => `0x${(h >>> 0).toString(16).padStart(8, '0')}`

export class LabHost {
  private readonly post: LabHostDeps['post']
  private readonly schedule: NonNullable<LabHostDeps['schedule']>
  private readonly now: () => number
  private sim: LabSim | null = null
  private speed = 0
  private homing = false
  private perturbed = false
  private steps = 0
  private carry = 0
  private lastTick = 0
  private lastFrame = Number.NEGATIVE_INFINITY
  private lastEntropy = Number.NEGATIVE_INFINITY
  private loopScheduled = false
  private job: Generator<ArrowProgress, unknown, void> | null = null
  private jobKind: 'arrow' | 'growth' | null = null
  private jobSeq = 0
  private lastProgress = Number.NEGATIVE_INFINITY

  constructor(deps: LabHostDeps) {
    this.post = deps.post
    this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    this.now = deps.now ?? (() => performance.now())
  }

  handle(msg: ToLab): void {
    try {
      switch (msg.type) {
        case 'init':
          this.init(msg.cfg)
          break
        case 'speed':
          this.ensure()
          this.homing = false
          this.speed = Number.isFinite(msg.speed) ? msg.speed : 0
          this.event(this.speed < 0 ? 'reverse' : 'forward')
          this.wake()
          break
        case 'flip':
          this.ensure().flip()
          this.event('flip')
          this.sendFrame(true)
          this.sendEntropy(true)
          break
        case 'home':
          this.ensure()
          this.homing = true
          this.event('home')
          this.wake()
          break
        case 'perturb':
          this.ensure().perturb(0, 0, 1)
          this.perturbed = true
          this.event('perturb')
          this.sendFrame(true)
          break
        case 'job':
          this.startJob(msg.job, msg.options ?? {})
          break
        case 'cancel':
          this.job = null
          this.jobKind = null
          this.jobSeq++
          break
      }
    } catch (e) {
      this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  private ensure(): LabSim {
    if (!this.sim) this.init()
    return this.sim!
  }

  private init(cfg = LAB_CONFIG): void {
    const sim = new LabSim(cfg)
    this.sim = sim
    this.speed = 0
    this.homing = false
    this.perturbed = false
    this.steps = 0
    this.carry = 0
    this.post({ type: 'ready', n: sim.count, h0: hex(sim.h0), s0: sim.s0, cfg })
    this.event('reset')
    this.sendFrame(true)
    this.sendEntropy(true)
  }

  private event(kind: LabEventKind): void {
    const sim = this.sim
    if (sim) this.post({ type: 'event', kind, steps: this.steps, n: sim.n })
  }

  private wake(): void {
    if (this.loopScheduled) return
    this.loopScheduled = true
    this.lastTick = this.now()
    this.schedule(() => this.tick(), TICK_MS)
  }

  /** One loop turn of the live world (public for tests). */
  tick(): void {
    this.loopScheduled = false
    const sim = this.sim
    if (!sim || (!this.homing && this.speed === 0)) return
    const t = this.now()
    const dtWall = Math.min(0.25, Math.max(0, (t - this.lastTick) / 1000))
    this.lastTick = t
    if (this.homing) this.homeTick(sim, dtWall)
    else {
      const due = this.speed * STEPS_PER_SECOND * dtWall + this.carry
      const want = Math.trunc(due)
      this.carry = due - want
      const ran = this.runSteps(sim, Math.abs(want), want < 0 ? -1 : 1, t)
      if (ran < Math.abs(want)) this.carry = 0
    }
    this.sendFrame(false)
    this.sendEntropy(false)
    if (this.homing || this.speed !== 0) {
      this.loopScheduled = true
      this.schedule(() => this.tick(), TICK_MS)
    }
  }

  private homeTick(sim: LabSim, dtWall: number): void {
    const { dir, steps } = sim.homeward()
    if (steps > 0) {
      const speed = Math.max(HOME_MIN_SPEED, Math.abs(sim.n) / STEPS_PER_SECOND / HOME_SECONDS)
      const want = Math.min(steps, Math.max(1, Math.round(speed * STEPS_PER_SECOND * dtWall)))
      this.runSteps(sim, want, dir, this.now())
      if (sim.homeward().steps > 0) return
    }
    if (sim.flipped) sim.flip()
    this.homing = false
    this.speed = 0
    this.carry = 0
    const h = sim.hash()
    this.post({ type: 'home', identical: h === sim.h0, hash: hex(h), h0: hex(sim.h0), perturbed: this.perturbed, steps: this.steps })
    this.sendFrame(true)
    this.sendEntropy(true)
  }

  /** Up to `count` steps of Φ (dir 1) or Φ⁻¹ (dir −1) within the tick budget. */
  private runSteps(sim: LabSim, count: number, dir: 1 | -1, t0: number): number {
    let ran = 0
    while (ran < count) {
      if (dir > 0) sim.forward(1)
      else sim.backward(1)
      ran++
      this.steps++
      if ((ran & 7) === 0 && this.now() - t0 > BUDGET_MS) break
    }
    return ran
  }

  private sendFrame(force: boolean): void {
    const sim = this.sim
    if (!sim) return
    const t = this.now()
    if (!force && t - this.lastFrame < FRAME_INTERVAL_MS) return
    this.lastFrame = t
    const positions = sim.positions()
    this.post(
      {
        type: 'frame',
        positions,
        n: sim.n,
        steps: this.steps,
        flipped: sim.flipped,
        perturbed: this.perturbed,
        speed: this.speed,
        homing: this.homing,
        hash: hex(sim.hash()),
      },
      [positions.buffer],
    )
  }

  private sendEntropy(force: boolean): void {
    const sim = this.sim
    if (!sim) return
    const t = this.now()
    if (!force && t - this.lastEntropy < ENTROPY_INTERVAL_MS) return
    this.lastEntropy = t
    this.post({ type: 'entropy', steps: this.steps, n: sim.n, S: sim.entropy() })
  }

  private startJob(kind: 'arrow' | 'growth', options: object): void {
    this.jobKind = kind
    this.job = kind === 'arrow' ? arrowOfTime(options) : growthRate(options)
    this.lastProgress = Number.NEGATIVE_INFINITY
    const seq = ++this.jobSeq
    this.schedule(() => this.jobTick(seq), 0)
  }

  /** Advance the running job by one slice (public for tests). */
  jobTick(seq = this.jobSeq): void {
    const gen = this.job
    const kind = this.jobKind
    if (!gen || !kind || seq !== this.jobSeq) return
    const t0 = this.now()
    try {
      for (;;) {
        const r = gen.next()
        if (r.done) {
          this.job = null
          this.jobKind = null
          if (kind === 'arrow') this.post({ type: 'result', job: 'arrow', result: r.value as never })
          else this.post({ type: 'result', job: 'growth', result: r.value as never })
          return
        }
        const t = this.now()
        if (t - this.lastProgress >= PROGRESS_INTERVAL_MS) {
          this.lastProgress = t
          this.post({ type: 'progress', job: kind, progress: r.value })
        }
        if (t - t0 > JOB_SLICE_MS) break
      }
    } catch (e) {
      this.job = null
      this.jobKind = null
      this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
      return
    }
    this.schedule(() => this.jobTick(seq), 0)
  }
}
