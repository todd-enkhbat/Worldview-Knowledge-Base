import { describe, expect, it } from 'vitest'
import { birthStep, epochAtStep } from '../../src/domain/time.ts'
import { historyStepForRecord } from '../../src/workspace/history.ts'

const settings = { T0: Date.UTC(2000, 0, 1), stepsPerYear: 600 }
const epoch = (step: number) => epochAtStep(step, settings.T0, settings.stepsPerYear)

describe('reader to Explore history handoff', () => {
  it('keeps the canonical birth of a new past record without revealing a nearby future record', () => {
    const now = epoch(18000.3)
    const next = historyStepForRecord(18000, epoch(18000.2), settings, now)
    expect(next).toBe(18000)
    expect(birthStep(epoch(18000.2), settings.T0, settings.stepsPerYear)).toBeLessThanOrEqual(next)
    expect(birthStep(epoch(18000.55), settings.T0, settings.stepsPerYear)).toBeGreaterThan(next)
  })

  it('leaves already covered history unchanged and never jumps backward', () => {
    expect(historyStepForRecord(18010, epoch(1200.2), settings, epoch(18000.3))).toBe(18010)
    expect(historyStepForRecord(18000, epoch(17999.2), settings, epoch(18000.3))).toBe(18000)
  })

  it('keeps a future selection at the current history step, including a date in the same quantization interval', () => {
    const now = epoch(18000.3)
    expect(historyStepForRecord(18000, now + 1, settings, now)).toBe(18000)
    expect(historyStepForRecord(18000, epoch(19000), settings, now)).toBe(18000)
  })

  it('returns a hidden past record to present without deriving spatial position from its date', () => {
    expect(historyStepForRecord(0, epoch(1200.8), settings, epoch(18000))).toBe(18000)
  })
})
