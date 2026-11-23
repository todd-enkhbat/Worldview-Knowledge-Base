import { birthStep } from '../domain/time.ts'
import type { WorldSettings } from '../domain/types.ts'

/** Reveal a selected existing record using the same integer births as the pose writer.
 * Future selections never advance history to their birth. */
export function historyStepForRecord(current: number, temporalOrigin: number, settings: Pick<WorldSettings, 'T0' | 'stepsPerYear'>, now: number): number {
  if (!Number.isFinite(temporalOrigin) || temporalOrigin > now) return current
  const required = birthStep(temporalOrigin, settings.T0, settings.stepsPerYear)
  if (current >= required) return current
  return Math.max(current, required, birthStep(now, settings.T0, settings.stepsPerYear))
}
