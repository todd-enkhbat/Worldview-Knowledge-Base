import { MS_PER_YEAR, STEPS_PER_YEAR, Y_PER_YEAR } from './constants.ts'
import type { TemporalPrecision } from './types.ts'

/** Fractional years from T0 to T (both epoch ms). */
export function yearsSince(T: number, T0: number): number {
  return (T - T0) / MS_PER_YEAR
}

/** World-space height of an epoch: Y(T) = Y_PER_YEAR · years(T − T0). */
export function yOf(T: number, T0: number, yPerYear = Y_PER_YEAR): number {
  return yPerYear * yearsSince(T, T0)
}

/** Inverse of yOf. */
export function epochAtY(y: number, T0: number, yPerYear = Y_PER_YEAR): number {
  return T0 + (y / yPerYear) * MS_PER_YEAR
}

/** Integer physics step at which a node born at T becomes active. Always ≥ 0. */
export function birthStep(T: number, T0: number, stepsPerYear = STEPS_PER_YEAR): number {
  return Math.max(0, Math.round(yearsSince(T, T0) * stepsPerYear))
}

/** Epoch represented by an integer (or fractional) physics step. */
export function epochAtStep(step: number, T0: number, stepsPerYear = STEPS_PER_YEAR): number {
  return T0 + (step / stepsPerYear) * MS_PER_YEAR
}

export function stepAtEpoch(T: number, T0: number, stepsPerYear = STEPS_PER_YEAR): number {
  return yearsSince(T, T0) * stepsPerYear
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** MM.DD.YYYY in UTC, the typography used on memory tesseracts. */
export function formatDotDate(epochMs: number): string {
  const d = new Date(epochMs)
  return `${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}.${d.getUTCFullYear()}`
}

/** Human date honouring the stored precision. */
export function formatByPrecision(epochMs: number, precision: TemporalPrecision): string {
  const d = new Date(epochMs)
  const y = d.getUTCFullYear()
  switch (precision) {
    case 'year':
      return String(y)
    case 'month':
      return `${y}-${pad(d.getUTCMonth() + 1)}`
    case 'day':
      return `${y}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    case 'minute':
      return `${y}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  }
}

/** Truncate an epoch to the start of its precision bucket (UTC). */
export function truncateToPrecision(epochMs: number, precision: TemporalPrecision): number {
  const d = new Date(epochMs)
  switch (precision) {
    case 'year':
      return Date.UTC(d.getUTCFullYear(), 0, 1)
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
    case 'day':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    case 'minute':
      return Math.floor(epochMs / 60_000) * 60_000
  }
}
