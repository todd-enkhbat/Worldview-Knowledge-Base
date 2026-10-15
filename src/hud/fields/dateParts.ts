import { truncateToPrecision } from '../../domain/time.ts'
import type { TemporalPrecision } from '../../domain/types.ts'

// Calendar arithmetic for DateField. Everything is UTC, matching domain/time.ts (formatting,
// truncation and the tesseract typography all read UTC), so a date never shifts by a day
// when the viewer's timezone changes.

export interface UtcParts {
  year: number
  /** 1–12 */
  month: number
  day: number
  hour: number
  minute: number
}

export const PRECISIONS: readonly TemporalPrecision[] = ['year', 'month', 'day', 'minute']

const RANK: Record<TemporalPrecision, number> = { year: 0, month: 1, day: 2, minute: 3 }

/** Does `precision` show the `part` control (e.g. 'day' shows year, month and day)? */
export function shows(precision: TemporalPrecision, part: TemporalPrecision): boolean {
  return RANK[precision] >= RANK[part]
}

export function splitUtc(epochMs: number): UtcParts {
  const d = new Date(epochMs)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  }
}

export function daysInMonth(year: number, month: number): number {
  const d = new Date(0)
  d.setUTCFullYear(year, month, 0) // day 0 of the next month = last day of this one
  return d.getUTCDate()
}

/** Parts → epoch. The day is clamped to the month (31 Feb → 28/29 Feb) rather than rolling over. */
export function joinUtc(p: UtcParts): number {
  const d = new Date(0)
  const month = Math.min(12, Math.max(1, Math.trunc(p.month)))
  d.setUTCFullYear(Math.trunc(p.year), month - 1, Math.min(Math.max(1, Math.trunc(p.day)), daysInMonth(p.year, month)))
  d.setUTCHours(Math.trunc(p.hour), Math.trunc(p.minute), 0, 0)
  return d.getTime()
}

/** truncateToPrecision, safe for years < 100 too (Date.UTC maps 0–99 to 1900–1999). */
export function truncate(epochMs: number, precision: TemporalPrecision): number {
  const p = splitUtc(epochMs)
  if (p.year >= 100) return truncateToPrecision(epochMs, precision)
  return joinUtc({
    year: p.year,
    month: shows(precision, 'month') ? p.month : 1,
    day: shows(precision, 'day') ? p.day : 1,
    hour: shows(precision, 'minute') ? p.hour : 0,
    minute: shows(precision, 'minute') ? p.minute : 0,
  })
}

export function clampEpoch(v: number, min?: number, max?: number): number {
  if (min !== undefined && v < min) return min
  if (max !== undefined && v > max) return max
  return v
}

/**
 * The stored value for a set of parts: truncated to the precision bucket, then clamped into
 * [min, max]. Clamping after truncation matters at the low edge: "1990" at year precision
 * with T0 = 15 Jun 1990 is stored as T0 itself, i.e. "sometime in 1990, not before T0".
 */
export function composeDate(parts: UtcParts, precision: TemporalPrecision, min?: number, max?: number): number {
  return clampEpoch(truncate(joinUtc(parts), precision), min, max)
}

/** Re-bucket an existing value when only the precision changes. */
export function withPrecision(value: number, precision: TemporalPrecision, min?: number, max?: number): number {
  return clampEpoch(truncate(value, precision), min, max)
}

export const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const

export const pad2 = (n: number) => String(n).padStart(2, '0')
