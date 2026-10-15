// DustSim (stepping, checkpoint ring, seeks, CPU edit rows) against the CPU dust world.
// The backend here evaluates the step shader with GLSL integer semantics (mirror.ts) on
// RGBA arrays, exactly as DustGpu's draws do on the GPU (a 0-step draw for checkpoint
// copies and restores, scissored row patches for edits).

import { describe, expect, it } from 'vitest'
import { DUST_SEGMENT } from '../../src/gpu/dust/alloc.ts'
import {
  DUST_FREE_BIRTH,
  type DustOwner,
  type DustRows,
  type DustWorld,
  createDustWorld,
  dustParticleSeed,
  runDustTo,
  setDustSegment,
} from '../../src/gpu/dust/dustWorld.ts'
import { dustKernelSpec, dustSpawnSpec } from '../../src/gpu/dust/glsl.ts'
import { STYLE_HIDDEN, compareDust } from '../../src/gpu/dust/layout.ts'
import { type DustMirror, makeDustMirror, mirrorDraw } from '../../src/gpu/dust/mirror.ts'
import { type DustBackend, DustSim } from '../../src/gpu/dust/sim.ts'
import { UNIT } from '../../src/physics/fixed.ts'
import { makePhysicsParams } from '../../src/physics/params.ts'
import { fnv1a32 } from '../../src/physics/rng.ts'

const params = makePhysicsParams({ seed: 0x5eed })
const WIDTH = 128 // 2 segments per row

class MirrorBackend implements DustBackend {
  readonly width = WIDTH
  readonly texels: number
  readonly x: Int32Array
  readonly d: Int32Array
  readonly anchor: Int32Array
  readonly meta: Int32Array
  readonly slots = new Map<number, { x: Int32Array; d: Int32Array }>()
  readonly log: string[] = []
  rows = 0
  private readonly m: DustMirror

  constructor(segments: number) {
    this.texels = segments * DUST_SEGMENT
    this.x = new Int32Array(4 * this.texels)
    this.d = new Int32Array(4 * this.texels)
    this.anchor = new Int32Array(4 * this.texels)
    this.meta = new Int32Array(4 * this.texels)
    for (let i = 0; i < this.texels; i++) this.anchor[4 * i + 3] = DUST_FREE_BIRTH
    this.m = makeDustMirror(dustKernelSpec(params), dustSpawnSpec(params))
  }

  private count(): number {
    return Math.min(this.texels, this.rows * WIDTH)
  }

  setRows(rows: number): void {
    this.rows = rows
  }

  draw(from: number, steps: number, backward: boolean): void {
    this.log.push(`draw ${from} ${backward ? '-' : '+'}${steps}`)
    mirrorDraw(this.m, { step: from, steps, backward, births: true }, this.x, this.d, this.anchor, this.meta, this.count())
  }

  saveCheckpoint(slot: number, step: number): void {
    this.log.push(`save ${slot}@${step}`)
    const c = { x: this.x.slice(), d: this.d.slice() }
    mirrorDraw(this.m, { step, steps: 0, backward: false, births: true }, c.x, c.d, this.anchor, this.meta, this.count())
    this.slots.set(slot, c)
  }

  restoreCheckpoint(slot: number, step: number): void {
    this.log.push(`restore ${slot}@${step}`)
    const c = this.slots.get(slot)!
    this.x.set(c.x)
    this.d.set(c.d)
    mirrorDraw(this.m, { step, steps: 0, backward: false, births: true }, this.x, this.d, this.anchor, this.meta, this.count())
  }

  dropCheckpoint(slot: number): void {
    this.slots.delete(slot)
  }

  writeSegment(segment: number, owner: DustOwner | null, style: number): void {
    for (let k = 0; k < DUST_SEGMENT; k++) {
      const o = 4 * (segment * DUST_SEGMENT + k)
      this.anchor[o] = owner ? owner.anchor[0] : 0
      this.anchor[o + 1] = owner ? owner.anchor[1] : 0
      this.anchor[o + 2] = owner ? owner.anchor[2] : 0
      this.anchor[o + 3] = owner ? owner.birth : DUST_FREE_BIRTH
      this.meta[o] = owner ? dustParticleSeed(owner.seed, k) : 0
      this.meta[o + 1] = style
    }
  }

  private patch(x: Int32Array, d: Int32Array, segment: number, rows: DustRows): void {
    x.set(rows.x, 4 * segment * DUST_SEGMENT)
    d.set(rows.d, 4 * segment * DUST_SEGMENT)
  }

  patchLive(segment: number, rows: DustRows): void {
    this.log.push(`patch live ${segment}@${rows.step}`)
    this.patch(this.x, this.d, segment, rows)
  }

  patchCheckpoint(slot: number, segment: number, rows: DustRows): void {
    this.log.push(`patch ${slot} ${segment}@${rows.step}`)
    const c = this.slots.get(slot)!
    this.patch(c.x, c.d, segment, rows)
  }

  hidden(segment: number): boolean {
    return (this.meta[4 * segment * DUST_SEGMENT + 1] & STYLE_HIDDEN) !== 0
  }
}

function owner(id: string, birth: number, ax: number, ay: number, az: number): DustOwner {
  return { id, anchor: [Math.round(ax * UNIT), Math.round(ay * UNIT), Math.round(az * UNIT)], birth, seed: fnv1a32(id) | 0, style: 4 }
}

/** The reference: a CPU dust world with the same owners, at a given step. */
class Reference {
  readonly w: DustWorld
  private readonly owners = new Map<number, DustOwner | null>()
  constructor(segments: number) {
    this.w = createDustWorld(params, segments * DUST_SEGMENT)
  }
  set(segment: number, o: DustOwner | null): void {
    this.owners.set(segment, o)
  }
  at(step: number): DustWorld {
    // Owners are applied at step 0 and simulated from their births (setDustSegment at the
    // current step does the same thing; this keeps the reference independent of history).
    const w = createDustWorld(params, this.w.texels)
    for (const [s, o] of this.owners) setDustSegment(w, s, o)
    runDustTo(w, step)
    return w
  }
}

function expectSame(sim: DustSim, be: MirrorBackend, ref: Reference, msg: string, skipHidden = false): void {
  const w = ref.at(sim.step)
  const n = be.rows * WIDTH
  for (let s = 0; s < n / DUST_SEGMENT; s++) {
    if (skipHidden && be.hidden(s)) continue
    const o = s * DUST_SEGMENT
    const c = compareDust(
      DUST_SEGMENT,
      w.sys.x.subarray(3 * o, 3 * (o + DUST_SEGMENT)),
      w.sys.d.subarray(3 * o, 3 * (o + DUST_SEGMENT)),
      be.x.subarray(4 * o, 4 * (o + DUST_SEGMENT)),
      be.d.subarray(4 * o, 4 * (o + DUST_SEGMENT)),
    )
    expect(c.identical, `${msg}: segment ${s} at step ${sim.step}`).toBe(true)
  }
}

function setup(segments = 6, opts = {}) {
  const be = new MirrorBackend(segments)
  const sim = new DustSim(be, params, { interval: 100, ring: 3, maxStepsPerDraw: 40, ...opts })
  const ref = new Reference(segments)
  const owners: (DustOwner | null)[] = [
    owner('a', 0, 2, 10, -1),
    owner('b', 120, -5, 60, 3),
    owner('c', 35, 9, 20, 9),
    null,
    owner('e', 260, 0.5, 130, -8),
    owner('f', 999999, 1, 1, 1),
  ]
  sim.setRows(Math.ceil((segments * DUST_SEGMENT) / WIDTH))
  owners.forEach((o, s) => {
    sim.setOwner(s, o)
    ref.set(s, o)
  })
  return { be, sim, ref }
}

function runUntil(sim: DustSim, target: number, budget: number, each?: () => void): number {
  let frames = 0
  for (;;) {
    const f = sim.frame(target, budget)
    frames++
    expect(f.stepsRun).toBeLessThanOrEqual(Math.max(1, budget))
    each?.()
    if (f.caughtUp && f.pending === 0) return frames
    if (frames > 10000) throw new Error('did not converge')
  }
}

describe('DustSim', () => {
  it('follows the target in budgeted draws that land on every checkpoint boundary', () => {
    const { be, sim, ref } = setup()
    const frames = runUntil(sim, 330, 37, () => expectSame(sim, be, ref, 'forward'))
    expect(frames).toBe(Math.ceil(330 / 37))
    for (const l of be.log.filter((l) => l.startsWith('draw'))) {
      const k = Number(l.split(/[+-]/).pop())
      expect(k).toBeLessThanOrEqual(40)
    }
    expect(sim.checkpointSteps).toEqual([100, 200, 300])
    // Ring of 3: reaching 400 evicts the farthest (100).
    runUntil(sim, 420, 50)
    expect(sim.checkpointSteps).toEqual([200, 300, 400])
    expectSame(sim, be, ref, 'at 420')
  })

  it('seeks by restoring the nearest checkpoint (or step 0) and stepping the rest', () => {
    const { be, sim, ref } = setup()
    runUntil(sim, 420, 1000)
    be.log.length = 0
    const f = sim.frame(215, 1000)
    expect(f.restored).toBe(200)
    expect(be.log[0]).toMatch(/^restore \d@200$/)
    expectSame(sim, be, ref, 'seek back to 215')
    const g = sim.frame(30, 1000)
    expect(g.restored).toBe(0)
    expectSame(sim, be, ref, 'seek back to 30')
    // Forward again: the nearest stored checkpoint is 400 (on the far side), then 13 back.
    const h = sim.frame(387, 1000)
    expect(h.restored).toBe(400)
    expect(h.stepsRun).toBe(13)
    expectSame(sim, be, ref, 'seek forward to 387')
    // A small move steps instead of restoring.
    expect(sim.frame(380, 1000).restored).toBeNull()
    expectSame(sim, be, ref, 'step back to 380')
  })

  it('applies a cheap edit synchronously to the live state and every later checkpoint', () => {
    const { be, sim, ref } = setup()
    runUntil(sim, 350, 1000)
    // Move 'b' (born 120) and re-date it to 250: rows needed at 300 and 350 (≤ syncEditSteps).
    const b2 = owner('b', 250, -6, 61, 4)
    sim.setOwner(1, b2)
    ref.set(1, b2)
    expect(sim.pending).toBe(0)
    expect(be.log.some((l) => l.startsWith('patch live 1@350'))).toBe(true)
    expect(be.log.some((l) => / 1@300$/.test(l) && l.startsWith('patch '))).toBe(true)
    expectSame(sim, be, ref, 'after edit')
    // Every checkpoint is valid: restore each and compare.
    for (const c of [100, 200, 300]) {
      sim.frame(c, 0)
      expect(sim.step).toBe(c)
      expectSame(sim, be, ref, `restored ${c}`)
    }
    // A new owner born in the future of the live state needs no rows at all.
    be.log.length = 0
    const g = owner('g', 5000, 3, 3, 3)
    sim.setOwner(3, g)
    ref.set(3, g)
    expect(be.log.filter((l) => l.startsWith('patch'))).toEqual([])
    runUntil(sim, 333, 1000)
    expectSame(sim, be, ref, 'after future owner')
  })

  it('finishes an expensive edit over several frames, hidden meanwhile, then stays exact', () => {
    const { be, sim, ref } = setup(6, { syncEditSteps: 60, cpuStepsPerFrame: 70 })
    runUntil(sim, 330, 1000)
    // Re-anchor 'a' (born 0): 330 CPU steps > 60 → asynchronous.
    const a2 = owner('a', 0, -3, 11, 2)
    sim.setOwner(0, a2)
    ref.set(0, a2)
    expect(sim.pending).toBe(1)
    expect(be.hidden(0)).toBe(true)
    // Checkpoints after its birth were dropped; none are saved while it is pending.
    expect(sim.checkpointSteps).toEqual([])
    let frames = 0
    while (sim.pending > 0) {
      sim.frame(360, 10)
      expectSame(sim, be, ref, 'pending', true)
      frames++
      expect(frames).toBeLessThan(50)
    }
    expect(frames).toBeGreaterThan(3)
    expect(be.hidden(0)).toBe(false)
    expectSame(sim, be, ref, 'job done')
    runUntil(sim, 520, 1000)
    expectSame(sim, be, ref, 'stepping after the job')
    expect(sim.checkpointSteps).toEqual([400, 500])
    sim.frame(150, 1000)
    expectSame(sim, be, ref, 'seek after the job')
  })

  it('frees and reassigns segments, grows the drawn rows and resets', () => {
    const { be, sim, ref } = setup(8)
    runUntil(sim, 210, 1000)
    sim.setOwner(2, null)
    ref.set(2, null)
    const h = owner('h', 205, 4, 4, 4)
    sim.setOwner(2, h)
    ref.set(2, h)
    sim.setRows(4)
    const i = owner('i', 100, -4, 50, -4)
    sim.setOwner(7, i)
    ref.set(7, i)
    expectSame(sim, be, ref, 'reassigned')
    runUntil(sim, 260, 7)
    expectSame(sim, be, ref, 'stepped')
    sim.reset()
    expect(sim.step).toBe(0)
    expect(sim.checkpointSteps).toEqual([])
    runUntil(sim, 140, 1000)
    expectSame(sim, be, ref, 'after reset')
  })

  it('keeps the live state exact right after owner writes, with no frame in between (paused playhead)', () => {
    const { be, sim, ref } = setup()
    // Fresh owners at step 0, before any frame: unborn segments must already read as spawns.
    expectSame(sim, be, ref, 'setup, no frame')
    runUntil(sim, 300, 1000)
    // Paused at 300: a born segment handed to a future owner, and another freed.
    const late = owner('late', 450, 3, 70, -2)
    sim.setOwner(0, late)
    ref.set(0, late)
    sim.setOwner(2, null)
    ref.set(2, null)
    expectSame(sim, be, ref, 'future owner and free, paused')
    // A future owner whose later checkpoints exist (sync path without a live patch).
    runUntil(sim, 120, 1000)
    const mid = owner('mid', 150, -1, 30, 6)
    sim.setOwner(4, mid)
    ref.set(4, mid)
    expectSame(sim, be, ref, 'future owner below stored checkpoints, paused')
    runUntil(sim, 320, 1000)
    expectSame(sim, be, ref, 'stepped on')
  })

  it('draws at least one step per frame and never crosses below step 0', () => {
    const { be, sim, ref } = setup()
    expect(sim.frame(10, 0).stepsRun).toBe(1)
    expect(sim.frame(-50, 1000).step).toBe(0)
    expectSame(sim, be, ref, 'clamped')
    expect(() => sim.frame(Number.NaN, 1)).toThrow(RangeError)
  })
})
