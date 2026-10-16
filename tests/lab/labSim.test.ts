import { describe, expect, it } from 'vitest'
import { AMP_ONE } from '../../src/physics/params.ts'
import { type LabConfig, LabSim, arrowOfTime, growthRate, runToEnd } from '../../src/lab/demos/labSim.ts'

// A small lab world (the demos use N = 1000; the S criterion itself runs in test:accept).
const SMALL: LabConfig = { n: 80, halfWidth: 10, height: 12, amp: 6 * AMP_ONE, seed: 3 }

describe('LabSim', () => {
  it('starts in the Past-Hypothesis state at the canonical origin', () => {
    const sim = new LabSim(SMALL)
    expect(sim.count).toBe(80)
    expect(sim.isHome()).toBe(true)
    expect(sim.sample.length).toBe(80)
    expect(Number.isFinite(sim.s0)).toBe(true)
  })

  it('exact reversal: Φⁿ then Φ⁻ⁿ returns the initial hash, and S rises in between', () => {
    const sim = new LabSim(SMALL)
    sim.forward(300)
    expect(sim.n).toBe(300)
    expect(sim.hash()).not.toBe(sim.h0)
    expect(sim.entropy()).toBeGreaterThan(sim.s0)
    sim.backward(300)
    expect(sim.isHome()).toBe(true)
  })

  it('Loschmidt: F∘F = id and flip–forward–flip retraces to the initial state', () => {
    const sim = new LabSim(SMALL)
    sim.forward(240)
    const h = sim.hash()
    sim.flip()
    sim.flip()
    expect(sim.hash()).toBe(h)
    sim.flip()
    expect(sim.flipped).toBe(true)
    expect(sim.n).toBe(240)
    // Forward while flipped lowers the canonical step.
    const { dir, steps } = sim.homeward()
    expect(dir).toBe(1)
    expect(steps).toBe(240)
    sim.forward(240)
    expect(sim.n).toBe(0)
    sim.flip()
    expect(sim.isHome()).toBe(true)
  })

  it('homeward handles every (sign of n, flipped) combination', () => {
    const sim = new LabSim(SMALL)
    sim.backward(50) // before the Past Hypothesis: n < 0
    expect(sim.n).toBe(-50)
    let h = sim.homeward()
    expect(h).toEqual({ dir: 1, steps: 50 })
    sim.flip()
    h = sim.homeward()
    expect(h).toEqual({ dir: -1, steps: 50 })
    sim.backward(50)
    sim.flip()
    expect(sim.isHome()).toBe(true)
  })

  it('a 1-LSB perturbation breaks the return', () => {
    const sim = new LabSim(SMALL)
    sim.forward(600)
    sim.perturb(0, 0, 1)
    sim.backward(600)
    expect(sim.n).toBe(0)
    expect(sim.hash()).not.toBe(sim.h0)
  })

  it('snapshot/restore round-trips the state', () => {
    const sim = new LabSim(SMALL)
    sim.forward(30)
    const snap = sim.snapshot()
    const h = sim.hash()
    sim.forward(30)
    sim.restore(snap)
    expect(sim.hash()).toBe(h)
    expect(sim.n).toBe(30)
  })
})

describe('arrowOfTime (small)', () => {
  it('runs the three branches; the unperturbed control returns bit for bit', () => {
    const r = runToEnd(arrowOfTime({ steps: 900, cfg: SMALL, fineSteps: 120, fineEvery: 6, sampleEvery: 60 }))
    expect(r.n).toBe(80)
    expect(r.controlReturn).toBe(true)
    expect(r.controlHash).toBe(r.h0)
    // The control's S falls back to S0 exactly (same state, same estimator).
    expect(r.sControlEnd).toBe(r.s0)
    expect(r.forward[0][1]).toBe(r.s0)
    expect(r.sFwd).toBeGreaterThan(r.s0)
    expect(Number.isFinite(r.ratio)).toBe(true)
    expect(r.forward.length).toBe(r.perturbed.length)
    expect(r.forward.length).toBe(r.control.length)
    expect(r.sentinel).toBe(0)
  })

  it('yields progress through every phase in order', () => {
    const phases: string[] = []
    const gen = arrowOfTime({ steps: 120, cfg: SMALL, chunk: 60, fineSteps: 0 })
    for (;;) {
      const r = gen.next()
      if (r.done) break
      if (phases[phases.length - 1] !== r.value.phase) phases.push(r.value.phase)
    }
    expect(phases).toEqual(['build', 'forward', 'perturbed', 'control', 'done'])
  })
})

describe('growthRate (small)', () => {
  it('fits a positive growth timescale from the Past-Hypothesis start', () => {
    const r = runToEnd(growthRate({ steps: 600, every: 3, cfg: SMALL }))
    expect(r.series.length).toBe(201)
    expect(r.fit.tau).toBeGreaterThan(0.05)
    expect(r.fit.tau).toBeLessThan(10)
    expect(r.fit.plateau).toBeGreaterThan(r.fit.s0)
  })
})
