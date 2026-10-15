import { describe, expect, it } from 'vitest'
import { FUTURE_YEARS, MS_PER_YEAR, STEPS_PER_YEAR } from '../../src/domain/constants.ts'
import { Scrubber } from '../../src/physics/clock.ts'
import { PlayheadClock, advanceClock, maxStepAt, stepOfEpoch } from '../../src/world/time/clock.ts'
import { axisAt, fractionOfStep, stepAtFraction, yearTicks } from '../../src/world/time/timeScale.ts'

const T0 = Date.UTC(1990, 0, 1)
const settings = { T0, stepsPerYear: STEPS_PER_YEAR }
const NOW = T0 + 30 * MS_PER_YEAR

describe('clock math (pure)', () => {
  it('maps epochs to steps on the physics clock and bounds the future', () => {
    expect(stepOfEpoch(settings, T0)).toBe(0)
    expect(stepOfEpoch(settings, T0 - MS_PER_YEAR)).toBe(0) // before T0 clamps
    expect(stepOfEpoch(settings, NOW)).toBe(30 * STEPS_PER_YEAR)
    expect(maxStepAt(settings, NOW)).toBe((30 + FUTURE_YEARS) * STEPS_PER_YEAR)
  })

  it('1× plays 60 steps per second; the fraction carries between frames', () => {
    const s = new Scrubber()
    let step = 1000
    for (let f = 0; f < 60; f++) step = advanceClock(s, step, 1 / 60, 1, true, 1e6).step
    expect(step).toBe(1060)
    const r = advanceClock(s, step, 1 / 120, 1, true, 1e6) // half a step
    expect(r.step).toBe(1060)
    expect(r.acc).toBeCloseTo(0.5, 12)
    expect(advanceClock(s, r.step, 1 / 120, 1, true, 1e6).step).toBe(1061)
  })

  it('10× is 600 steps (a year) per second; frameDt clamps at 0.1 s', () => {
    const s = new Scrubber()
    let step = 0
    for (let f = 0; f < 60; f++) step = advanceClock(s, step, 1 / 60, 10, true, 1e6).step
    expect(step).toBe(STEPS_PER_YEAR)
    // A 2 s hitch counts as 0.1 s: 60 steps at 10×, not 1200.
    expect(advanceClock(s, step, 2, 10, true, 1e6).step).toBe(STEPS_PER_YEAR + 60)
  })

  it('negative speeds scrub backwards with acc in (−1, 0]', () => {
    const s = new Scrubber()
    const r = advanceClock(s, 500, 0.025, -1, true, 1e6) // 1.5 steps back
    expect(r.step).toBe(499)
    expect(r.acc).toBeCloseTo(-0.5, 12)
  })

  it('paused or zero speed does not move', () => {
    const s = new Scrubber()
    expect(advanceClock(s, 42, 1 / 60, 5, false, 1e6)).toEqual({ step: 42, acc: 0, stop: false })
    expect(advanceClock(s, 42, 1 / 60, 0, true, 1e6)).toEqual({ step: 42, acc: 0, stop: false })
  })

  it('clamps at both ends and stops playback heading into a bound', () => {
    const s = new Scrubber()
    const end = advanceClock(s, 995, 0.1, 10, true, 1000)
    expect(end).toEqual({ step: 1000, acc: 0, stop: true })
    expect(s.acc).toBe(0)
    const start = advanceClock(s, 3, 0.1, -10, true, 1000)
    expect(start).toEqual({ step: 0, acc: 0, stop: true })
    // Paused beyond the horizon (e.g. a seek past it) clamps without "stopping".
    expect(advanceClock(s, 5000, 1 / 60, 1, false, 1000)).toEqual({ step: 1000, acc: 0, stop: false })
  })
})

describe('PlayheadClock', () => {
  const frame = (c: PlayheadClock, clock: { step: number; speed: number; playing: boolean }, time: number, dt = 1 / 60) =>
    c.frame({ dt, time, now: NOW, settings, clock })

  it('starts at the present and publishes it', () => {
    const c = new PlayheadClock()
    const patch = frame(c, { step: 0, speed: 1, playing: false }, 0)
    expect(patch).toEqual({ step: 30 * STEPS_PER_YEAR })
    expect(c.playhead.step).toBe(30 * STEPS_PER_YEAR)
    expect(c.playhead.seeking).toBe(true) // 0 → now is a seek for the dust
    expect(frame(c, { step: 30 * STEPS_PER_YEAR, speed: 1, playing: false }, 0.016)).toBeNull()
    expect(c.playhead.seeking).toBe(false)
  })

  it('without settings it holds at 0 and publishes nothing', () => {
    const c = new PlayheadClock()
    expect(c.frame({ dt: 1 / 60, time: 0, now: NOW, settings: null, clock: { step: 0, speed: 1, playing: true } })).toBeNull()
    expect(c.playhead.step).toBe(0)
  })

  it('throttles step publishes while playing and publishes exactly on pause', () => {
    const c = new PlayheadClock()
    let store = { step: 0, speed: 1, playing: true }
    const apply = (p: ReturnType<PlayheadClock['frame']>) => {
      if (p) store = { ...store, ...p }
      return p
    }
    apply(frame(c, store, 0))
    const start = store.step
    let publishes = 0
    for (let f = 1; f <= 60; f++) if (apply(frame(c, store, f / 60))?.step !== undefined) publishes++
    expect(c.playhead.step).toBe(start + 60)
    expect(publishes).toBeGreaterThanOrEqual(9)
    expect(publishes).toBeLessThanOrEqual(11)
    store = { ...store, playing: false }
    apply(frame(c, store, 61 / 60))
    expect(store.step).toBe(c.playhead.step)
  })

  it('takes a step written by someone else as a seek', () => {
    const c = new PlayheadClock()
    let store = { step: 0, speed: 1, playing: false }
    const p = frame(c, store, 0)
    store = { ...store, ...p }
    store = { ...store, step: 1234 } // e.g. the Timeline or goToPresent
    expect(frame(c, store, 0.1)).toBeNull()
    expect(c.playhead).toEqual({ step: 1234, acc: 0, seeking: true })
    store = { ...store, step: 1240 }
    frame(c, store, 0.2)
    expect(c.playhead.seeking).toBe(false) // 6 steps: the dust steps, it does not seek
  })

  it('pauses at the future horizon', () => {
    const c = new PlayheadClock()
    const max = maxStepAt(settings, NOW)
    let store = { step: 0, speed: 10, playing: true }
    store = { ...store, ...frame(c, store, 0) }
    store = { ...store, step: max - 5 }
    const p = frame(c, store, 0.1, 0.1)
    expect(p).toMatchObject({ playing: false, step: max })
    expect(c.playhead).toMatchObject({ step: max, acc: 0 })
  })

  it('re-centres on now when T0 changes (re-layout)', () => {
    const c = new PlayheadClock()
    frame(c, { step: 0, speed: 1, playing: false }, 0)
    const T1 = T0 + 10 * MS_PER_YEAR
    const p = c.frame({ dt: 1 / 60, time: 1, now: NOW, settings: { T0: T1, stepsPerYear: STEPS_PER_YEAR }, clock: { step: 18000, speed: 1, playing: false } })
    expect(p).toEqual({ step: 20 * STEPS_PER_YEAR })
  })
})

describe('timeline axis', () => {
  it('ticks every 1 January from after T0 to the horizon, labels thinned', () => {
    const ticks = yearTicks(settings, NOW)
    expect(ticks[0].year).toBe(1991)
    expect(ticks.at(-1)!.year).toBe(new Date(NOW + FUTURE_YEARS * MS_PER_YEAR).getUTCFullYear())
    expect(ticks[0].step).toBe(stepOfEpoch(settings, Date.UTC(1991, 0, 1)))
    for (let k = 1; k < ticks.length; k++) expect(ticks[k].step - ticks[k - 1].step).toBeGreaterThanOrEqual(599)
    const labels = ticks.filter((t) => t.label)
    expect(labels.length).toBeLessThanOrEqual(12)
    expect(labels.every((t) => t.year % 5 === 0)).toBe(true) // 35 years → every 5
    expect(yearTicks({ T0: NOW - 2 * MS_PER_YEAR, stepsPerYear: STEPS_PER_YEAR }, NOW).every((t) => t.label)).toBe(true)
  })

  it('maps steps to [0, 1] and back', () => {
    const { maxStep, presentStep } = axisAt(settings, NOW)
    expect(presentStep).toBe(30 * STEPS_PER_YEAR)
    expect(fractionOfStep(presentStep, maxStep)).toBeCloseTo(30 / 35, 12)
    expect(stepAtFraction(fractionOfStep(1234, maxStep), maxStep)).toBe(1234)
    expect(stepAtFraction(-0.2, maxStep)).toBe(0)
    expect(stepAtFraction(1.5, maxStep)).toBe(maxStep)
    expect(fractionOfStep(5, 0)).toBe(0)
  })
})
