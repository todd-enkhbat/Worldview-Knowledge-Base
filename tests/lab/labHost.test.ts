import { describe, expect, it } from 'vitest'
import { AMP_ONE } from '../../src/physics/params.ts'
import { LabHost } from '../../src/lab/demos/labHost.ts'
import type { FromLab } from '../../src/lab/demos/labProtocol.ts'
import type { LabConfig } from '../../src/lab/demos/labSim.ts'

const SMALL: LabConfig = { n: 60, halfWidth: 10, height: 12, amp: 6 * AMP_ONE, seed: 5 }

function harness() {
  const out: FromLab[] = []
  const queue: (() => void)[] = []
  let clock = 0
  const host = new LabHost({
    post: (m) => out.push(m),
    schedule: (fn) => queue.push(fn),
    now: () => clock,
  })
  /** Run scheduled callbacks, advancing the clock `ms` per callback, until `until` or the cap. */
  const pump = (until: () => boolean, ms = 16, cap = 5000) => {
    for (let i = 0; i < cap && queue.length > 0 && !until(); i++) {
      clock += ms
      queue.shift()!()
    }
  }
  const last = <T extends FromLab['type']>(type: T) => out.filter((m) => m.type === type).pop() as Extract<FromLab, { type: T }> | undefined
  return { host, out, pump, last, queue }
}

describe('LabHost (live world)', () => {
  it('init posts ready, a frame and an S sample', () => {
    const { host, last } = harness()
    host.handle({ type: 'init', cfg: SMALL })
    const ready = last('ready')!
    expect(ready.n).toBe(60)
    const frame = last('frame')!
    expect(frame.positions.length).toBe(180)
    expect(frame.n).toBe(0)
    expect(frame.hash).toBe(ready.h0)
    expect(last('entropy')!.S).toBe(ready.s0)
  })

  it('plays at the requested speed in whole steps', () => {
    const { host, pump, last } = harness()
    host.handle({ type: 'init', cfg: SMALL })
    host.handle({ type: 'speed', speed: 1 })
    let ticks = 0
    pump(() => ++ticks > 60, 1000 / 60)
    host.handle({ type: 'speed', speed: 0 })
    pump(() => false)
    const f = last('frame')!
    // ≈ 60 ticks at 1/60 s, one step each (fractional carry may shift one step).
    expect(f.steps).toBeGreaterThanOrEqual(58)
    expect(f.steps).toBeLessThanOrEqual(61)
    expect(f.n).toBe(f.steps)
  })

  it('reverse to 0 after a flip returns the bit-identical initial state', () => {
    const { host, pump, last } = harness()
    host.handle({ type: 'init', cfg: SMALL })
    host.handle({ type: 'speed', speed: 10 })
    let ticks = 0
    pump(() => ++ticks > 30)
    host.handle({ type: 'flip' })
    host.handle({ type: 'speed', speed: 2 })
    ticks = 0
    pump(() => ++ticks > 10)
    host.handle({ type: 'home' })
    pump(() => last('home') !== undefined)
    const home = last('home')!
    expect(home.identical).toBe(true)
    expect(home.hash).toBe(home.h0)
    const f = last('frame')!
    expect(f.n).toBe(0)
    expect(f.flipped).toBe(false)
    expect(f.homing).toBe(false)
  })

  it('a 1-LSB nudge makes the return differ', () => {
    const { host, pump, last } = harness()
    host.handle({ type: 'init', cfg: SMALL })
    host.handle({ type: 'speed', speed: 10 })
    let ticks = 0
    pump(() => ++ticks > 60)
    host.handle({ type: 'perturb' })
    host.handle({ type: 'home' })
    pump(() => last('home') !== undefined)
    const home = last('home')!
    expect(home.perturbed).toBe(true)
    expect(home.identical).toBe(false)
  })
})

describe('LabHost (jobs)', () => {
  it('runs the growth job in slices and posts progress then the result', () => {
    const { host, pump, out, last } = harness()
    host.handle({ type: 'job', job: 'growth', options: { steps: 180, every: 6, chunk: 30, cfg: SMALL } })
    pump(() => last('result') !== undefined, 50)
    const r = last('result')!
    expect(r.job).toBe('growth')
    expect(out.some((m) => m.type === 'progress')).toBe(true)
  })

  it('cancel stops a running job', () => {
    const { host, pump, queue, last } = harness()
    host.handle({ type: 'job', job: 'arrow', options: { steps: 6000, cfg: SMALL } })
    pump(() => true) // nothing run yet
    host.handle({ type: 'cancel' })
    pump(() => false)
    expect(queue.length).toBe(0)
    expect(last('result')).toBeUndefined()
  })
})
