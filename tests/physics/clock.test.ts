import { describe, expect, it } from 'vitest'
import { Checkpoints, Scrubber, checkpointKey } from '../../src/physics/clock.ts'
import { PHYSICS_VERSION } from '../../src/physics/params.ts'
import {
  type PhysicsWorld,
  buildWorld,
  readState,
  recordsHashAt,
  runTo,
  settingsHashOf,
  stateHashById,
  stepWorld,
  upsertRecord,
  worldHash,
} from '../../src/physics/world.ts'
import { testRng } from './helpers.ts'
import { makeRecords, shuffled } from './worldFixture.ts'

const SEED = 0x5eed

describe('Scrubber (PLAN § Clock)', () => {
  it('accumulates speed·frameDt/dt and runs trunc(acc) steps, keeping the fraction', () => {
    const s = new Scrubber()
    expect(s.advance(1 / 60, 1)).toEqual({ steps: 1, seek: false })
    expect(s.acc).toBeCloseTo(0, 12)
    expect(s.advance(1 / 60, 0.5).steps).toBe(0)
    expect(s.acc).toBeCloseTo(0.5, 12)
    expect(s.advance(1 / 60, 0.5).steps).toBe(1)
    expect(s.advance(1 / 60, -0.25).steps).toBe(0)
    expect(s.acc).toBeCloseTo(-0.25, 12)
    expect(s.advance(1 / 60, -2)).toEqual({ steps: -2, seek: false })
    expect(s.acc).toBeCloseTo(-0.25, 12)
    expect(Object.is(new Scrubber().advance(1 / 60, -0.5).steps, 0)).toBe(true) // never −0
  })

  it('clamps frameDt to 0.1 s and asks for a seek when |n| > 64', () => {
    const s = new Scrubber()
    expect(s.advance(5, 1)).toEqual({ steps: 6, seek: false }) // 0.1 s · 60
    expect(s.advance(0.1, 10)).toEqual({ steps: 60, seek: false })
    expect(s.advance(0.1, -10)).toEqual({ steps: -60, seek: false })
    expect(s.advance(0.1, 11)).toEqual({ steps: 66, seek: true })
    expect(s.advance(-1, 5)).toEqual({ steps: 0, seek: false })
    expect(s.advance(1 / 60, Number.NaN)).toEqual({ steps: 0, seek: false })
    const custom = new Scrubber({ maxFrameDt: 1, seekThreshold: 10 })
    expect(custom.advance(0.5, 1)).toEqual({ steps: 30, seek: true })
    custom.reset()
    expect(custom.acc).toBe(0)
  })
})

describe('Checkpoints', () => {
  const recs = makeRecords({ n: 200, seed: 4, years: 3, preYears: 1, halfWidth: 8 })

  it('stores step 0 + every 600 with active slots only; nearest either side; invalidateFrom', () => {
    const w = buildWorld({ records: recs, seed: SEED })
    const ck = new Checkpoints()
    expect(ck.seekTo(w, 1900)).toBe(1900)
    expect(ck.keys()).toEqual([0, 600, 1200, 1800])
    const st = ck.get(600)!
    let active600 = 0
    for (let s = 0; s < w.birth.length; s++) if (w.birth[s] <= 600) active600++
    expect(st.slots.length).toBe(active600)
    expect(st.x.length).toBe(3 * active600)
    expect(ck.nearest(899)!.step).toBe(600)
    expect(ck.nearest(900)!.step).toBe(600) // tie → earlier
    expect(ck.nearest(901)!.step).toBe(1200)
    expect(ck.nearest(-50)!.step).toBe(0)
    expect(ck.nearest(99999)!.step).toBe(1800)
    ck.invalidateFrom(1200)
    expect(ck.keys()).toEqual([0, 600])
    ck.invalidateFrom(0)
    expect(ck.nearest(10)).toBeUndefined()
  })

  it('seeks in ≤ every/2 steps when checkpoints exist, in either direction', () => {
    const w = buildWorld({ records: recs, seed: SEED })
    const ck = new Checkpoints()
    ck.seekTo(w, 3600)
    const ref = new Map<number, number>()
    const probe = buildWorld({ records: recs, seed: SEED })
    const targets = [17, 3599, 1500, 299, 300, 301, 2950, 0, 1199, 3000, 2401]
    for (const t of [...targets].sort((a, b) => a - b)) {
      runTo(probe, t)
      ref.set(t, worldHash(probe))
    }
    for (const t of targets) {
      const ran = ck.seekTo(w, t)
      expect(ran).toBeLessThanOrEqual(300)
      expect(w.step).toBe(t)
      expect(worldHash(w)).toBe(ref.get(t))
    }
  })

  it('a checkpoint filled in by backward stepping equals the forward one', () => {
    const w = buildWorld({ records: recs, seed: SEED })
    const fwd = new Checkpoints()
    fwd.seekTo(w, 1800)
    const back = new Checkpoints()
    back.save(w)
    for (let k = 0; k < 1800; k++) {
      stepWorld(w, -1)
      back.maybeSave(w)
    }
    expect(back.keys()).toEqual([0, 600, 1200, 1800])
    for (const s of fwd.keys()) expect(back.get(s)).toEqual(fwd.get(s))
  })

  it('restore refuses a checkpoint whose active set no longer matches, and drops it', () => {
    const w = buildWorld({ records: recs, seed: SEED })
    const ck = new Checkpoints()
    ck.seekTo(w, 1200)
    expect(() => {
      upsertRecord(w, { id: 'early', anchor: [0, 0, 0], birthStep: 100, mass: 1, temperature: 0.2 })
      ck.save(w)
    }).toThrow(/stale/)
    // The caller forgot invalidateFrom(100): restore detects the extra active slot.
    expect(ck.restore(w, 600)).toBe(false)
    expect(ck.has(600)).toBe(false)
    expect(ck.restore(w, 0)).toBe(true)
    expect(w.stale).toBe(false)
  })

  it('progressive recompute: seekTo with a step budget resumes from the live state', () => {
    const w = buildWorld({ records: recs, seed: SEED })
    const ck = new Checkpoints()
    let total = 0
    let calls = 0
    while (w.step !== 2500) {
      total += ck.seekTo(w, 2500, 400)
      calls++
    }
    expect(calls).toBe(7)
    expect(total).toBe(2500)
    const ref = buildWorld({ records: recs, seed: SEED })
    runTo(ref, 2500)
    expect(worldHash(w)).toBe(worldHash(ref))
  })
})

describe('R1: random scrub schedules end where a straight run ends', () => {
  const SMAX = 3000
  const recs = makeRecords({ n: 250, seed: 8, years: 4, preYears: 2, halfWidth: 9 })
  // Reference: the id-ordered hash at every step of one straight forward run.
  const ref = new Uint32Array(SMAX + 1)
  {
    const w = buildWorld({ records: recs, seed: SEED })
    ref[0] = stateHashById(w)
    for (let n = 1; n <= SMAX; n++) {
      stepWorld(w, 1)
      ref[n] = stateHashById(w)
    }
  }
  const SPEEDS = [0.1, 0.5, 1, 2, 5, 10, -0.1, -0.5, -1, -2, -5, -10, 0, 30, -30]

  it('10 schedules of ≤ 2000 frames: random speeds (incl. negative), frame hitches and seeks', () => {
    let totalSteps = 0
    let seeks = 0
    let backwardFrames = 0
    for (let sched = 0; sched < 10; sched++) {
      const rand = testRng(9000 + sched)
      const w: PhysicsWorld = buildWorld({ records: sched % 2 ? shuffled(recs, sched) : recs, seed: SEED })
      const ck = new Checkpoints()
      const scrub = new Scrubber()
      let speed = 1
      const frames = 1000 + (rand() % 1001)
      let mismatches = 0
      for (let f = 0; f < frames; f++) {
        if (rand() % 100 < 3) speed = SPEEDS[rand() % SPEEDS.length]
        // Mostly vsync frames, sometimes a hitch (clamped to 0.1 s by the scrubber).
        const dt = rand() % 50 === 0 ? 0.05 + (rand() % 1000) / 2000 : 1 / 60
        const { steps, seek } = scrub.advance(dt, speed)
        let target = w.step + steps
        let jump = seek
        if (rand() % 200 === 0) {
          target = rand() % (SMAX + 1) // a click on the timeline
          jump = true
        }
        target = Math.max(0, Math.min(SMAX, target))
        if (target < w.step) backwardFrames++
        if (jump) {
          seeks++
          totalSteps += ck.seekTo(w, target)
        } else {
          totalSteps += Math.abs(target - w.step)
          while (w.step !== target) {
            stepWorld(w, target > w.step ? 1 : -1)
            ck.maybeSave(w)
          }
        }
        if (stateHashById(w) !== ref[w.step]) mismatches++
      }
      expect(mismatches, `schedule ${sched}`).toBe(0)
      expect(stateHashById(w)).toBe(ref[w.step])
    }
    expect(seeks).toBeGreaterThan(10)
    expect(backwardFrames).toBeGreaterThan(100)
    expect(totalSteps).toBeGreaterThan(10_000)
  })
})

describe('R2: checkpoints are identical across independent runs', () => {
  it('two worlds (different slot layouts, forward vs backward fill) agree per id at every checkpoint', () => {
    const recs = makeRecords({ n: 400, seed: 14, years: 4, preYears: 2, halfWidth: 10 })
    const a = buildWorld({ records: recs, seed: SEED })
    const ca = new Checkpoints()
    ca.seekTo(a, 2400)
    const b = buildWorld({ records: shuffled(recs, 99), seed: SEED })
    const cb = new Checkpoints()
    runTo(b, 2400)
    cb.save(b)
    while (b.step > 0) {
      stepWorld(b, -1)
      cb.maybeSave(b)
    }
    expect(cb.keys()).toEqual(ca.keys())
    for (const step of ca.keys()) {
      const sa = ca.get(step)!
      const sb = cb.get(step)!
      const perId = (st: typeof sa, w: PhysicsWorld): Map<string, string> => {
        const m = new Map<string, string>()
        for (let k = 0; k < st.slots.length; k++) m.set(w.idOf[st.slots[k]]!, [...st.x.subarray(3 * k, 3 * k + 3), ...st.d.subarray(3 * k, 3 * k + 3)].join(','))
        return m
      }
      expect(perId(sb, b)).toEqual(perId(sa, a))
      const key = checkpointKey(recordsHashAt(a, step), settingsHashOf(a), step)
      expect(checkpointKey(recordsHashAt(b, step), settingsHashOf(b), step)).toBe(key)
      expect(key).toContain(`/v${PHYSICS_VERSION}/`)
    }
    // Restoring b's checkpoint into a reproduces a's state.
    ca.restore(a, 1200)
    const viaB = buildWorld({ records: recs, seed: SEED })
    runTo(viaB, 1200)
    expect(stateHashById(a)).toBe(stateHashById(viaB))
    expect(readState(a, recs[0].id)).toEqual(readState(viaB, recs[0].id))
  })

  it('the records hash covers exactly the records born ≤ step', () => {
    const recs = makeRecords({ n: 50, seed: 15, years: 2, preYears: 0 })
    const w = buildWorld({ records: recs, seed: SEED })
    const late = recs.reduce((m, r) => (r.birthStep > m.birthStep ? r : m))
    const b = Math.floor(late.birthStep)
    const before = recordsHashAt(w, b - 1)
    const at = recordsHashAt(w, b)
    upsertRecord(w, { ...late, anchor: [late.anchor[0] + 0.5, late.anchor[1], late.anchor[2]] })
    expect(recordsHashAt(w, b - 1)).toBe(before)
    expect(recordsHashAt(w, b)).not.toBe(at)
    expect(settingsHashOf(buildWorld({ records: [], seed: SEED + 1 }))).not.toBe(settingsHashOf(w))
  })
})

describe('clock guards', () => {
  it('rejects non-integer step targets instead of looping', () => {
    const w = buildWorld({ records: [], seed: SEED })
    expect(() => new Checkpoints().seekTo(w, Number.NaN)).toThrow(RangeError)
    expect(() => runTo(w, 10.5)).toThrow(RangeError)
    expect(() => new Checkpoints(0)).toThrow(RangeError)
  })
})
