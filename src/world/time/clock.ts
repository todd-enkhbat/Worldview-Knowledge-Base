import { type ClockState, useApp } from '../../app/store.ts'
import { FUTURE_YEARS, MS_PER_YEAR } from '../../domain/constants.ts'
import { birthStep, epochAtStep } from '../../domain/time.ts'
import type { WorldSettings } from '../../domain/types.ts'
import { Scrubber } from '../../physics/clock.ts'

// The one playback clock, on the main thread. It owns the integer target step and the
// fractional accumulator; the node worker and the GPU dust both advance to
// getPlayhead().step, and the pose writer renders at X + acc·D. useApp().clock carries
// the user's intent (speed, playing) and a throttled copy of the step for React readers;
// a step written there by anyone else (goToPresent, the Timeline) is taken as a seek.

export interface Playhead {
  /** Integer physics step the world should be at this frame. */
  readonly step: number
  /** Fractional step in (−1, 1): render at X + acc·D. */
  readonly acc: number
  /** The step jumped by more than the seek threshold this frame (restore, don't step). */
  readonly seeking: boolean
}

type ClockSettings = Pick<WorldSettings, 'T0' | 'stepsPerYear'>

/** Step of an epoch under the world settings (≥ 0). */
export function stepOfEpoch(settings: ClockSettings, epochMs: number): number {
  return birthStep(epochMs, settings.T0, settings.stepsPerYear)
}

/** The playhead's upper bound: now + FUTURE_YEARS. */
export function maxStepAt(settings: ClockSettings, now: number): number {
  return stepOfEpoch(settings, now + FUTURE_YEARS * MS_PER_YEAR)
}

export interface ClockAdvance {
  step: number
  acc: number
  /** Playback ran into a bound in its direction of travel: pause. */
  stop: boolean
}

/**
 * Pure clock math for one frame: the Scrubber turns (frameDt, speed) into whole steps and
 * a fractional remainder; the result is clamped to [0, maxStep] (the remainder too, so
 * nothing renders before T0 or past the future horizon).
 */
export function advanceClock(
  scrubber: Scrubber,
  step: number,
  frameDt: number,
  speed: number,
  playing: boolean,
  maxStep: number,
): ClockAdvance {
  let next = step
  const moving = playing && speed !== 0 && Number.isFinite(speed)
  if (moving) next += scrubber.advance(frameDt, speed).steps
  let acc = scrubber.acc
  let stop = false
  if (next > maxStep || (next === maxStep && acc > 0)) {
    next = maxStep
    stop = moving && speed > 0
  } else if (next < 0 || (next === 0 && acc < 0)) {
    next = 0
    stop = moving && speed < 0
  } else {
    return { step: next, acc, stop }
  }
  scrubber.reset()
  acc = 0
  return { step: next, acc, stop }
}

export interface ClockFrameInput {
  /** Frame delta (s); the Scrubber clamps it to 0.1. */
  dt: number
  /** Monotonic seconds, for the publish throttle. */
  time: number
  /** Wall clock (epoch ms): "now" and the future horizon. */
  now: number
  settings: ClockSettings | null
  clock: Pick<ClockState, 'step' | 'speed' | 'playing'>
}

/** Seconds between step publishes into the store while playing. */
const PUBLISH_INTERVAL = 0.1

/**
 * The clock's state machine, free of React and three so it can be tested in node. One
 * instance drives the app (the module singleton below); frame() returns the patch to
 * write into useApp().clock, or null.
 */
export class PlayheadClock {
  readonly playhead = { step: 0, acc: 0, seeking: false }
  readonly scrubber: Scrubber
  /** Last step written into the store; any other value found there is an external seek. */
  private published = Number.NaN
  private publishedAt = Number.NEGATIVE_INFINITY
  private lastFrameStep = 0
  /** Settings the playhead was initialised for; a change (re-layout) re-centres on now. */
  private initKey: string | null = null

  constructor(scrubber = new Scrubber()) {
    this.scrubber = scrubber
  }

  /** Jump to `step` (rounded, ≥ 0); the next frame clamps it to the horizon. */
  seek(step: number): number {
    const s = Number.isFinite(step) ? Math.max(0, Math.round(step)) : 0
    this.playhead.step = s
    this.playhead.acc = 0
    this.scrubber.reset()
    this.published = s
    return s
  }

  /**
   * On first load (or a re-layout) the playhead starts at the present. Returns the new
   * step when it (re)initialised, else null.
   */
  init(settings: ClockSettings, now: number): number | null {
    const key = `${settings.T0}|${settings.stepsPerYear}`
    if (key === this.initKey) return null
    this.initKey = key
    return this.seek(stepOfEpoch(settings, now))
  }

  frame(input: ClockFrameInput): Partial<ClockState> | null {
    const ph = this.playhead
    const { settings, clock } = input
    if (!settings) {
      ph.seeking = false
      return null
    }
    let patch: Partial<ClockState> | null = null
    const init = this.init(settings, input.now)
    if (init !== null) patch = { step: init }
    else if (clock.step !== this.published) this.seek(clock.step)
    const max = maxStepAt(settings, input.now)
    const r = advanceClock(this.scrubber, ph.step, input.dt, clock.speed, clock.playing, max)
    ph.step = r.step
    ph.acc = r.acc
    ph.seeking = Math.abs(ph.step - this.lastFrameStep) > this.scrubber.seekThreshold
    this.lastFrameStep = ph.step
    if (r.stop) patch = { ...patch, playing: false }
    const playing = clock.playing && !r.stop
    if (ph.step !== this.published && (!playing || input.time - this.publishedAt >= PUBLISH_INTERVAL)) {
      patch = { ...patch, step: ph.step }
    }
    if (patch?.step !== undefined) {
      this.published = patch.step
      this.publishedAt = input.time
    }
    return patch
  }
}

const clock = new PlayheadClock()

/** The app's clock instance (driven by usePlayheadClock). */
export function getClock(): PlayheadClock {
  return clock
}

/** The playhead this frame (a live object: read it, never keep its fields across frames). */
export function getPlayhead(): Playhead {
  return clock.playhead
}

/** Epoch (ms) at the rendered playhead, including the fractional step. */
export function playheadEpoch(settings: ClockSettings): number {
  const ph = clock.playhead
  return epochAtStep(ph.step + ph.acc, settings.T0, settings.stepsPerYear)
}

/**
 * Initialise the playhead for these settings now if no frame has yet (the physics client
 * needs the starting step before the first frame). Returns the playhead step.
 */
export function ensurePlayhead(settings: ClockSettings, now = Date.now()): number {
  const s = clock.init(settings, now)
  if (s !== null) useApp.getState().setClock({ step: s })
  return clock.playhead.step
}

/** Move the playhead (Timeline drag, Present). Takes effect on the next frame. */
export function seekPlayhead(step: number): void {
  const s = clock.seek(step)
  useApp.getState().setClock({ step: s })
}
