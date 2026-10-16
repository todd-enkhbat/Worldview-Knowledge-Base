import { FUTURE_YEARS, MS_PER_YEAR } from '../../domain/constants.ts'
import type { WorldSettings } from '../../domain/types.ts'
import { maxStepAt, stepOfEpoch } from './clock.ts'

// The Timeline's axis: steps 0 (T0) … maxStep (now + 5 y) mapped linearly onto [0, 1].
// Pure, so the tick layout is testable without a DOM.

type ScaleSettings = Pick<WorldSettings, 'T0' | 'stepsPerYear'>

export interface YearTick {
  year: number
  /** Step of 1 January (UTC) of `year`. */
  step: number
  /** Print the year here (every `every` years, so labels never crowd). */
  label: boolean
}

const LABEL_EVERY = [1, 2, 5, 10, 20, 25, 50, 100]

/** Ticks on 1 January of every year after T0 up to the horizon, labels thinned to ≤ maxLabels. */
export function yearTicks(settings: ScaleSettings, now: number, maxLabels = 12): YearTick[] {
  const first = new Date(settings.T0).getUTCFullYear() + 1
  const last = new Date(now + FUTURE_YEARS * MS_PER_YEAR).getUTCFullYear()
  const count = Math.max(0, last - first + 1)
  const every = LABEL_EVERY.find((k) => count / k <= maxLabels) ?? 100
  const out: YearTick[] = []
  for (let y = first; y <= last; y++) {
    out.push({ year: y, step: stepOfEpoch(settings, Date.UTC(y, 0, 1)), label: y % every === 0 })
  }
  return out
}

/** Position of a step on the axis, in [0, 1]. */
export function fractionOfStep(step: number, maxStep: number): number {
  if (!(maxStep > 0)) return 0
  return Math.min(1, Math.max(0, step / maxStep))
}

/** The integer step under an axis position. */
export function stepAtFraction(f: number, maxStep: number): number {
  return Math.round(Math.min(1, Math.max(0, f)) * maxStep)
}

/** The axis bounds and the present, at wall-clock `now`. */
export function axisAt(settings: ScaleSettings, now: number): { maxStep: number; presentStep: number } {
  return { maxStep: maxStepAt(settings, now), presentStep: stepOfEpoch(settings, now) }
}
