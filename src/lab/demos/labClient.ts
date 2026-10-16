import { create } from 'zustand'
import { STEPS_PER_SECOND } from '../../physics/fixed.ts'
import type { FromLab, LabEventKind, ToLab } from './labProtocol.ts'
import type { ArrowOptions, ArrowProgress, ArrowResult, GrowthOptions, GrowthResult, LabConfig } from './labSim.ts'

// Main-thread side of the #/lab demos: two lab workers (live world, long jobs) and the
// zustand stores the panels render from. Positions never go through React: the points
// canvas reads livePositions inside useFrame.

/** Cap on the live S(t) history (10 min at 4 Hz). */
const MAX_ENTROPY_POINTS = 2400

export interface LiveEvent {
  readonly kind: LabEventKind
  /** Dynamics run so far, in sim seconds (the plot's x). */
  readonly t: number
}

export interface HomeReport {
  readonly identical: boolean
  readonly hash: string
  readonly h0: string
  readonly perturbed: boolean
}

export interface LiveState {
  ready: boolean
  count: number
  h0: string
  s0: number
  cfg: LabConfig | null
  /** Canonical step and total steps run. */
  n: number
  steps: number
  flipped: boolean
  perturbed: boolean
  speed: number
  homing: boolean
  hash: string
  /** [t (s of dynamics run), S] at ≤ 4 Hz. */
  entropy: [number, number][]
  events: LiveEvent[]
  home: HomeReport | null
  error: string | null
}

const initialLive: LiveState = {
  ready: false,
  count: 0,
  h0: '',
  s0: Number.NaN,
  cfg: null,
  n: 0,
  steps: 0,
  flipped: false,
  perturbed: false,
  speed: 0,
  homing: false,
  hash: '',
  entropy: [],
  events: [],
  home: null,
  error: null,
}

export const useLabLive = create<LiveState>()(() => ({ ...initialLive }))

/**
 * Latest positions from the live worker (xyz world units); `version` bumps per frame.
 * `origin` holds the Past-Hypothesis positions of the current world (the first frame after
 * a reset), so the canvas can colour points by how far they wandered.
 */
export const livePositions = { positions: new Float32Array(0) as Float32Array, version: 0, origin: null as Float32Array | null }
let originPending = true

export type JobKind = 'arrow' | 'growth'

export interface JobState {
  running: boolean
  progress: ArrowProgress | null
  /** Live preview of the running phase's S samples, for the plot. */
  preview: [number, number][]
  error: string | null
}

export interface JobsState {
  arrow: JobState & { result: ArrowResult | null }
  growth: JobState & { result: GrowthResult | null }
}

const idleJob: JobState = { running: false, progress: null, preview: [], error: null }
export const useLabJobs = create<JobsState>()(() => ({
  arrow: { ...idleJob, result: null },
  growth: { ...idleJob, result: null },
}))

function spawn(name: string): Worker {
  return new Worker(new URL('./labWorker.ts', import.meta.url), { type: 'module', name })
}

let live: Worker | null = null
let liveUsers = 0

/** Start (or share) the live lab worker; returns the release. */
export function acquireLive(): () => void {
  liveUsers++
  if (!live) {
    useLabLive.setState({ ...initialLive })
    live = spawn('lab-live')
    live.onmessage = (e: MessageEvent<FromLab>) => onLive(e.data)
    live.onerror = (e) => useLabLive.setState({ error: e.message || 'lab worker failed' })
    live.postMessage({ type: 'init' } satisfies ToLab)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    liveUsers--
    if (liveUsers === 0 && live) {
      live.terminate()
      live = null
    }
  }
}

export function sendLive(msg: ToLab): void {
  live?.postMessage(msg)
}

function onLive(m: FromLab): void {
  switch (m.type) {
    case 'ready':
      originPending = true
      useLabLive.setState({ ready: true, count: m.n, h0: m.h0, s0: m.s0, cfg: m.cfg, entropy: [], events: [], home: null, error: null })
      break
    case 'frame':
      livePositions.positions = m.positions
      livePositions.version++
      if (originPending && m.n === 0 && !m.flipped) {
        livePositions.origin = m.positions.slice()
        originPending = false
      }
      useLabLive.setState({
        n: m.n,
        steps: m.steps,
        flipped: m.flipped,
        perturbed: m.perturbed,
        speed: m.speed,
        homing: m.homing,
        hash: m.hash,
      })
      break
    case 'entropy':
      useLabLive.setState((s) => {
        const next = s.entropy.concat([[m.steps / STEPS_PER_SECOND, m.S]])
        return { entropy: next.length > MAX_ENTROPY_POINTS ? next.slice(next.length - MAX_ENTROPY_POINTS) : next }
      })
      break
    case 'event':
      useLabLive.setState((s) => ({
        events: s.events.concat([{ kind: m.kind, t: m.steps / STEPS_PER_SECOND }]).slice(-64),
        home: m.kind === 'home' || m.kind === 'reset' ? null : s.home,
      }))
      break
    case 'home':
      useLabLive.setState({ home: { identical: m.identical, hash: m.hash, h0: m.h0, perturbed: m.perturbed } })
      break
    case 'error':
      useLabLive.setState({ error: m.message })
      break
    default:
      break
  }
}

// ---------------------------------------------------------------- jobs

let jobs: Worker | null = null
type JobOptions = { arrow: Partial<Omit<ArrowOptions, 'cfg'>>; growth: Partial<Omit<GrowthOptions, 'cfg'>> }
const waiters: { arrow: ((r: ArrowResult) => void)[]; growth: ((r: GrowthResult) => void)[] } = { arrow: [], growth: [] }

function jobWorker(): Worker {
  if (!jobs) {
    jobs = spawn('lab-jobs')
    jobs.onmessage = (e: MessageEvent<FromLab>) => onJob(e.data)
    jobs.onerror = (e) => {
      const error = e.message || 'lab job worker failed'
      useLabJobs.setState((s) => ({ arrow: { ...s.arrow, running: false, error }, growth: { ...s.growth, running: false, error } }))
    }
  }
  return jobs
}

/** Run a long job in the job worker (one at a time: starting one cancels the other). */
export function runJob<K extends JobKind>(job: K, options: JobOptions[K] = {}): Promise<K extends 'arrow' ? ArrowResult : GrowthResult> {
  const w = jobWorker()
  useLabJobs.setState((s) => ({
    arrow: job === 'arrow' ? { ...idleJob, running: true, result: null } : { ...s.arrow, running: false },
    growth: job === 'growth' ? { ...idleJob, running: true, result: null } : { ...s.growth, running: false },
  }))
  const p = new Promise((resolve) => (waiters[job] as ((r: unknown) => void)[]).push(resolve))
  w.postMessage({ type: 'job', job, options } as ToLab)
  return p as Promise<K extends 'arrow' ? ArrowResult : GrowthResult>
}

export function cancelJobs(): void {
  jobs?.postMessage({ type: 'cancel' } satisfies ToLab)
  useLabJobs.setState((s) => ({ arrow: { ...s.arrow, running: false }, growth: { ...s.growth, running: false } }))
}

/** Terminate the job worker (page unmount). */
export function releaseJobs(): void {
  jobs?.terminate()
  jobs = null
  useLabJobs.setState((s) => ({ arrow: { ...s.arrow, running: false }, growth: { ...s.growth, running: false } }))
}

function onJob(m: FromLab): void {
  switch (m.type) {
    case 'progress':
      useLabJobs.setState((s) => {
        const cur = s[m.job]
        const last = m.progress.last
        // The preview restarts with each phase (its t restarts at 0).
        const phaseChanged = cur.progress?.phase !== m.progress.phase
        const preview = last ? (phaseChanged ? [[last[0], last[1]] as [number, number]] : cur.preview.concat([[last[0], last[1]]])) : cur.preview
        return { [m.job]: { ...cur, progress: m.progress, preview } } as Partial<JobsState>
      })
      break
    case 'result': {
      if (m.job === 'arrow') {
        useLabJobs.setState((s) => ({ arrow: { ...s.arrow, running: false, result: m.result } }))
        for (const r of waiters.arrow.splice(0)) r(m.result)
      } else {
        useLabJobs.setState((s) => ({ growth: { ...s.growth, running: false, result: m.result } }))
        for (const r of waiters.growth.splice(0)) r(m.result)
      }
      break
    }
    case 'error':
      useLabJobs.setState((s) => ({
        arrow: s.arrow.running ? { ...s.arrow, running: false, error: m.message } : s.arrow,
        growth: s.growth.running ? { ...s.growth, running: false, error: m.message } : s.growth,
      }))
      break
    default:
      break
  }
}
