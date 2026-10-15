import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useApp } from '../../src/app/store.ts'
import type { DemonPlan } from '../../src/overlay/demon.ts'
import { DEMON } from '../../src/overlay/demon.ts'
import type { OverlayFields } from '../../src/overlay/fields.ts'
import { HEBB } from '../../src/overlay/hebbian.ts'
import type { NodePlasticity } from '../../src/overlay/hebbian.ts'
import type { PoseTable } from '../../src/world/poses.ts'
import { TAU_MS, applyOverlays, resetOverlayHook } from '../../src/world/time/overlayHook.ts'

const T = Date.UTC(2026, 0, 1)

function table(rows: Record<string, [number, number, number]>): PoseTable {
  const ids = Object.keys(rows)
  const pos = new Float32Array(ids.length * 3)
  const index = new Map<string, number>()
  ids.forEach((id, r) => {
    index.set(id, r)
    pos.set(rows[id], r * 3)
  })
  return { version: 1, index, pos, born: new Uint8Array(ids.length).fill(1) }
}

const np = (y: number): NodePlasticity => ({ e: 0, neglect: 0, y, mist: 0, citadel: 0 })

function fields(t: number, ys: Record<string, number>, plan: DemonPlan = { matches: new Map(), assignments: new Map() }, act: [string, number | null][] = []): OverlayFields {
  return { t, nodes: new Map(Object.entries(ys).map(([k, v]) => [k, np(v)])), synapses: [], plan, activation: new Map(act) }
}

const at = (tb: PoseTable, id: string) => [...tb.pos.subarray(tb.index.get(id)! * 3, tb.index.get(id)! * 3 + 3)]

beforeEach(() => resetOverlayHook())
afterEach(() => useApp.setState({ mode: 'orbit', focusedId: null }))

describe('applyOverlays', () => {
  it('adds the bounded Y offset once, idempotently, and leaves XZ alone', () => {
    const tb = table({ a: [1, 10, 2], b: [5, 20, 6] })
    const f = fields(T, { a: 2, b: -0.5 })
    applyOverlays(tb, T, f)
    expect(at(tb, 'a')).toEqual([1, 12, 2])
    expect(at(tb, 'b')).toEqual([5, 19.5, 6])
    const v = tb.version
    // Paused frame: the writer left the positions alone; the hook must not stack offsets.
    applyOverlays(tb, T + 16, f)
    applyOverlays(tb, T + 32, f)
    expect(at(tb, 'a')).toEqual([1, 12, 2])
    expect(tb.version).toBe(v)
    // The writer rewrites P: the offset rides on the new base.
    tb.pos.set([1.5, 11, 2.5], 0)
    applyOverlays(tb, T + 48, f)
    expect(at(tb, 'a')).toEqual([1.5, 13, 2.5])
    expect(Math.abs(HEBB.Y_MAX)).toBe(2.5)
  })

  it('glides to a new target with the display time constant', () => {
    const tb = table({ a: [0, 10, 0] })
    applyOverlays(tb, T, fields(T, { a: 0 }))
    applyOverlays(tb, T + TAU_MS, fields(T, { a: 1 }))
    expect(at(tb, 'a')[1]).toBeCloseTo(10 + (1 - Math.exp(-1)), 5)
    let t = T + TAU_MS
    for (let i = 0; i < 60; i++) applyOverlays(tb, (t += 100), fields(T, { a: 1 }))
    expect(at(tb, 'a')[1]).toBe(11)
  })

  it('eases demon matches toward their lattice slot in XZ only, r = x + w(t)(s − x)', () => {
    const tb = table({ d: [100, 50, 100], n: [90, 40, 95] })
    const plan: DemonPlan = {
      matches: new Map([['d', { demonId: 'd', candidates: 2, hits: [{ id: 'n', score: 1 }], bitsPerMatch: 1 }]]),
      assignments: new Map([['n', { demonId: 'd', dx: 4, dz: -4, score: 1, rank: 0 }]]),
    }
    const tAct = T
    // Before the activation: w = 0 → untouched.
    applyOverlays(tb, T, fields(T, {}, plan, [['d', tAct]]))
    expect(at(tb, 'n')).toEqual([90, 40, 95])
    // Long after: settled on the slot (smoothing converged), Y untouched.
    let t = T
    for (let i = 0; i < 200; i++) applyOverlays(tb, (t += 50), fields(t, {}, plan, [['d', tAct]]))
    expect(t - tAct).toBeGreaterThan(DEMON.RAMP_MS)
    expect(at(tb, 'n')).toEqual([104, 40, 96])
    expect(at(tb, 'd')).toEqual([100, 50, 100])
  })

  it('holds the offset of the node being flown into until the camera is back out', () => {
    const tb = table({ m: [0, 10, 0], o: [5, 10, 0] })
    applyOverlays(tb, T, fields(T, { m: 0, o: 0 }))
    useApp.setState({ mode: 'interior', focusedId: 'm' })
    let t = T
    for (let i = 0; i < 40; i++) applyOverlays(tb, (t += 100), fields(t, { m: 1.2, o: 1.2 }))
    expect(at(tb, 'm')[1]).toBe(10)
    expect(at(tb, 'o')[1]).toBeCloseTo(11.2, 5)
    useApp.setState({ mode: 'orbit', focusedId: null })
    for (let i = 0; i < 40; i++) applyOverlays(tb, (t += 100), fields(t, { m: 1.2, o: 1.2 }))
    expect(at(tb, 'm')[1]).toBeCloseTo(11.2, 5)
  })

  it('keeps gliding across a slot-layout change (new pose arrays)', () => {
    const t1 = table({ a: [0, 10, 0] })
    applyOverlays(t1, T, fields(T, { a: 2 }))
    expect(at(t1, 'a')[1]).toBe(12)
    // The writer rebuilds the table (an edit): fresh P positions, new rows.
    const t2 = table({ z: [9, 9, 9], a: [0, 10, 0] })
    applyOverlays(t2, T + TAU_MS, fields(T, { a: 0, z: 0 }))
    expect(at(t2, 'a')[1]).toBeCloseTo(10 + 2 * Math.exp(-1), 5)
    expect(at(t2, 'z')).toEqual([9, 9, 9])
  })
})
