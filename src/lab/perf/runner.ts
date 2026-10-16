import { useApp } from '../../app/store.ts'
import { MS_PER_YEAR } from '../../domain/constants.ts'
import { useSimStats } from '../../world/time/physicsClient.ts'
import { seekPlayhead, stepOfEpoch } from '../../world/time/clock.ts'
import { CameraPath, perfKeyframes } from './cameraPath.ts'
import { type FixtureWorld, PERF_NOW, memoryAnchors, presentY } from './fixtureWorld.ts'
import { type PhaseReport, PerfRecorder, type VsyncEstimate, type Verdict } from './stats.ts'

// The #/lab/perf script, as a state machine stepped from the canvas's first frame
// callback: warm up (shaders, worker cold start), ride the 30 s camera path at 1× from the
// fixed present, then scrub at 10× through the past while the path replays at 3×.

export const PERF_SCRIPT = {
  /** Minimum warm-up (s); then wait for the physics worker, at most warmupMax. */
  warmup: 4,
  warmupMax: 20,
  path: 30,
  scrub: 10,
  scrubSpeed: 10,
  /** The scrub starts this many years before the fixed present. */
  scrubFromYearsBack: 12,
  /** The camera path replays this much faster during the scrub. */
  scrubPathRate: 3,
} as const

export type PerfPhase = 'boot' | 'fixtures' | 'warmup' | 'path' | 'scrub' | 'done' | 'error'
const MEASURED = ['path', 'scrub'] as const
/** Splat stats sampling period during the measured phases (ms). */
const SPLAT_SAMPLE_MS = 500

export interface CanvasInfo {
  cssWidth: number
  cssHeight: number
  dpr: number
  drawingBuffer: [number, number]
  vendor: string | null
  renderer: string | null
  gpuTimer: boolean
}

export interface RendererSnapshot {
  calls: number
  triangles: number
  points: number
  lines: number
  geometries: number
  textures: number
  programs: number
}

export interface PerfReport {
  readonly criterion: 'P'
  readonly version: 1
  readonly date: string
  readonly userAgent: string
  readonly gate: string
  readonly canvas: CanvasInfo
  readonly refresh: VsyncEstimate
  readonly verdict: Verdict
  readonly phases: Record<(typeof MEASURED)[number], PhaseReport>
  readonly all: PhaseReport
  readonly gpu: { readonly timer: string | null; readonly covers: string; readonly disjoint: number }
  readonly renderer: RendererSnapshot | null
  readonly splats: Record<string, unknown> | null
  readonly world: {
    readonly nodes: number
    readonly fixtures: FixtureWorld['fixtures']
    readonly physicsMode: string
    readonly T0: string
    readonly now: string
    readonly physicsSeed: number
    readonly steps: { readonly pathStart: number; readonly scrubStart: number }
  }
  readonly script: typeof PERF_SCRIPT & { readonly camera: string }
  /** Raw per-phase samples (ms, rounded to 0.01): rAF intervals, main-thread work, GPU. */
  readonly samples: Record<string, { readonly interval: number[]; readonly main: number[]; readonly gpu: (number | null)[] }>
}

const r2 = (v: number) => Math.round(v * 100) / 100

export interface PerfRunDeps {
  readonly canvasInfo: () => CanvasInfo
  readonly rendererInfo: () => RendererSnapshot | null
  readonly splatInfo: () => Record<string, unknown> | null
  readonly gpuDisjoint: () => number
}

type Listener = (run: PerfRun) => void

export class PerfRun {
  phase: PerfPhase = 'boot'
  status = 'starting'
  readonly recorder = new PerfRecorder()
  report: PerfReport | null = null
  error: string | null = null
  world: FixtureWorld | null = null
  private path: CameraPath | null = null
  private phaseStart = 0
  private deps: PerfRunDeps | null = null
  private readonly listeners = new Set<Listener>()
  private readonly waiters: ((r: PerfReport) => void)[] = []
  private presentStep = 0
  private scrubStep = 0
  /**
   * Peak splat stats over the measured phases, sampled at 2 Hz: at the end of the run the
   * camera is far from every fixture (impostors only), so the end state alone reads as zero.
   */
  private splatPeak: Record<string, number> = {}
  private splatSampledAt = Number.NEGATIVE_INFINITY

  subscribe(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private emit(): void {
    for (const l of [...this.listeners]) l(this)
  }

  setStatus(phase: PerfPhase, status: string): void {
    this.phase = phase
    this.status = status
    this.emit()
  }

  fail(e: unknown): void {
    this.error = e instanceof Error ? e.message : String(e)
    this.recorder.phase = null
    this.setStatus('error', this.error)
  }

  /** Resolves with the report when the run finishes. */
  done(): Promise<PerfReport> {
    if (this.report) return Promise.resolve(this.report)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  /** World ready and fixtures attached: start the warm-up on the next frame. */
  begin(world: FixtureWorld, deps: PerfRunDeps): void {
    this.world = world
    this.deps = deps
    this.path = new CameraPath(perfKeyframes(memoryAnchors(world), presentY()), PERF_SCRIPT.path)
    this.presentStep = stepOfEpoch(world.settings, PERF_NOW)
    this.scrubStep = stepOfEpoch(world.settings, PERF_NOW - PERF_SCRIPT.scrubFromYearsBack * MS_PER_YEAR)
    this.phaseStart = Number.NaN
    this.setStatus('warmup', 'warming up')
  }

  /** Called at the very start of every frame (performance.now()). Advances the script. */
  tick(now: number): void {
    if (this.phase !== 'warmup' && this.phase !== 'path' && this.phase !== 'scrub') return
    if (Number.isNaN(this.phaseStart)) {
      this.phaseStart = now
      seekPlayhead(this.presentStep)
      useApp.getState().setClock({ speed: 1, playing: true })
    }
    const t = (now - this.phaseStart) / 1000
    if (this.recorder.phase !== null && now - this.splatSampledAt >= SPLAT_SAMPLE_MS) {
      this.splatSampledAt = now
      const info = this.deps?.splatInfo()
      if (info) {
        for (const [k, v] of Object.entries(info)) {
          if (typeof v === 'number' && Number.isFinite(v)) this.splatPeak[k] = Math.max(this.splatPeak[k] ?? 0, v)
        }
      }
    }
    if (this.phase === 'warmup') {
      const ready = useSimStats.getState().mode !== 'starting'
      if ((t >= PERF_SCRIPT.warmup && ready) || t >= PERF_SCRIPT.warmupMax) {
        this.phaseStart = now
        seekPlayhead(this.presentStep)
        useApp.getState().setClock({ speed: 1, playing: true })
        this.recorder.phase = 'path'
        this.setStatus('path', 'camera path (1×)')
      }
    } else if (this.phase === 'path') {
      if (t >= PERF_SCRIPT.path) {
        this.phaseStart = now
        seekPlayhead(this.scrubStep)
        useApp.getState().setClock({ speed: PERF_SCRIPT.scrubSpeed, playing: true })
        this.recorder.phase = 'scrub'
        this.setStatus('scrub', `scrub (${PERF_SCRIPT.scrubSpeed}×)`)
      }
    } else if (t >= PERF_SCRIPT.scrub) {
      this.recorder.phase = null
      useApp.getState().setClock({ playing: false, speed: 1 })
      this.finish()
    }
  }

  /** Seconds into the current phase (0 before it starts). */
  phaseTime(now: number): number {
    return Number.isNaN(this.phaseStart) ? 0 : (now - this.phaseStart) / 1000
  }

  /** The scripted camera for this frame; false when the script does not drive the camera. */
  camera(now: number, pos: { set(x: number, y: number, z: number): unknown }, target: { set(x: number, y: number, z: number): unknown }): boolean {
    const path = this.path
    if (!path) return false
    const t = this.phaseTime(now)
    if (this.phase === 'warmup') path.at(0, pos, target)
    else if (this.phase === 'path') path.at(t, pos, target)
    else if (this.phase === 'scrub') path.at(Math.min(path.duration, t * PERF_SCRIPT.scrubPathRate), pos, target)
    else if (this.phase === 'done') path.at(path.duration, pos, target)
    else return false
    return true
  }

  private finish(): void {
    const deps = this.deps!
    const world = this.world!
    const r = this.recorder.report(MEASURED)
    const samples: PerfReport['samples'] = {}
    for (const p of MEASURED) {
      samples[p] = {
        interval: this.recorder.frames.filter((f) => f.phase === p).map((f) => r2(f.interval)),
        main: this.recorder.work.filter((w) => w.phase === p).map((w) => r2(w.main)),
        gpu: this.recorder.work.filter((w) => w.phase === p).map((w) => (w.gpu === null ? null : r2(w.gpu))),
      }
    }
    const canvas = deps.canvasInfo()
    this.report = {
      criterion: 'P',
      version: 1,
      date: new Date().toISOString(),
      userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
      gate: 'Safari is the gate; Chrome results are recorded with a waiver for Spark #407. Run at native refresh with the window visible.',
      canvas,
      refresh: r.vsync,
      verdict: r.verdict,
      phases: { path: r.phases.path, scrub: r.phases.scrub },
      all: r.all,
      gpu: {
        timer: canvas.gpuTimer ? 'EXT_disjoint_timer_query_webgl2' : null,
        covers: 'scene render + Spark + post stack; excludes the dust k-step loop (its own ≈ 3.5 ms budget)',
        disjoint: deps.gpuDisjoint(),
      },
      renderer: deps.rendererInfo(),
      splats: { end: deps.splatInfo(), peak: { ...this.splatPeak }, sampleMs: SPLAT_SAMPLE_MS },
      world: {
        nodes: world.nodes,
        fixtures: world.fixtures,
        physicsMode: useSimStats.getState().mode,
        T0: new Date(world.settings.T0).toISOString(),
        now: new Date(PERF_NOW).toISOString(),
        physicsSeed: world.settings.physicsSeed,
        steps: { pathStart: this.presentStep, scrubStart: this.scrubStep },
      },
      script: { ...PERF_SCRIPT, camera: 'establishing shot → each fixture memory in date order → the present' },
      samples,
    }
    this.setStatus('done', r.verdict.pass ? 'done · P met' : 'done · P not met')
    for (const w of this.waiters.splice(0)) w(this.report)
  }
}
