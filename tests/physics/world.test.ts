import { describe, expect, it } from 'vitest'
import { Checkpoints } from '../../src/physics/clock.ts'
import { UNIT, invMassFromMass, tauFromUnit } from '../../src/physics/fixed.ts'
import { overflowSentinel } from '../../src/physics/integrator.ts'
import { AMP_MAX } from '../../src/physics/params.ts'
import { fnv1a32 } from '../../src/physics/rng.ts'
import { spawnNodeState } from '../../src/physics/spawn.ts'
import {
  FREE_BIRTH,
  type PhysicsWorld,
  type WorldRecord,
  activeSlots,
  buildWorld,
  isActive,
  readPoses,
  readState,
  removeRecord,
  runTo,
  stateHashById,
  stepWorld,
  upsertRecord,
  worldHash,
} from '../../src/physics/world.ts'
import { makeRecords, shuffled } from './worldFixture.ts'

const SEED = 0x5eed

/** Per-id integer state of every active record. */
function statesById(w: PhysicsWorld): Map<string, string> {
  const out = new Map<string, string>()
  for (const id of w.slotOf.keys()) {
    const s = readState(w, id)
    if (s) out.set(id, [...s.x, ...s.d].join(','))
  }
  return out
}

function rec(id: string, birthStep: number, anchor: [number, number, number] = [0, 0, 0], mass = 1, temperature = 0.5): WorldRecord {
  return { id, anchor, birthStep, mass, temperature }
}

describe('world: build and record mapping', () => {
  it('assigns slots in input order, clamps births ≥ 0, spawns births ≤ 0 at step 0', () => {
    const recs = [rec('a', -50, [1.5, 2, -3]), rec('b', 0), rec('c', 10.9), rec('d', 600)]
    const w = buildWorld({ records: recs, seed: SEED })
    expect([...w.slotOf.entries()]).toEqual([['a', 0], ['b', 1], ['c', 2], ['d', 3]])
    expect(Array.from(w.birth.subarray(0, 4))).toEqual([0, 0, 10, 600])
    expect(w.birth[4]).toBe(FREE_BIRTH)
    expect(w.sys.birth).toBe(w.birth)
    expect(w.step).toBe(0)
    expect(w.activeCount).toBe(2)
    expect([0, 1, 2, 3, 4].map((s) => isActive(w, s))).toEqual([true, true, false, false, false])
    // Dormant slots hold no state.
    expect(Array.from(w.sys.x.subarray(6, 12))).toEqual([0, 0, 0, 0, 0, 0])
    // Anchor u → Q.19 by Math.round(u·2^19); mass, temperature via the kernel quantisers.
    expect(Array.from(w.sys.anchor.subarray(0, 3))).toEqual([1.5 * UNIT, 2 * UNIT, -3 * UNIT])
    expect(w.sys.invMass[0]).toBe(invMassFromMass(1))
    expect(w.sys.tau[0]).toBe(tauFromUnit(0.5))
    // Spawn = Past-Hypothesis macrostate seeded by fnv1a32(id), T = τ.
    const sp = new Int32Array(6)
    spawnNodeState(fnv1a32('a'), w.sys.tau[0], w.sys.invMass[0], sp)
    expect(Array.from(w.sys.x.subarray(0, 3))).toEqual([0, 1, 2].map((a) => (w.sys.anchor[a] + sp[a]) | 0))
    expect(Array.from(w.sys.d.subarray(0, 3))).toEqual([sp[3], sp[4], sp[5]])
  })

  it('quantises anchors once with round-half-up, never zero-width', () => {
    const lsb = 1 / UNIT
    const w = buildWorld({ records: [rec('q', 0, [2.5 * lsb, -2.5 * lsb, 0.49 * lsb])], seed: SEED })
    expect(Array.from(w.sys.anchor.subarray(0, 3))).toEqual([3, -2, 0])
  })

  it('rejects invalid records and unstable worlds', () => {
    expect(() => buildWorld({ records: [rec('x', 0, [0, 0, 0], 0)], seed: SEED })).toThrow(/mass/)
    expect(() => buildWorld({ records: [rec('x', Number.NaN)], seed: SEED })).toThrow(/birthStep/)
    expect(() => buildWorld({ records: [rec('x', 0, [Number.NaN, 0, 0])], seed: SEED })).toThrow(/anchor/)
    expect(() => buildWorld({ records: [rec('x', 0), rec('x', 1)], seed: SEED })).toThrow(/duplicate/)
    // A = 16 is rejected for a τ = 1, m = 0.25 node (docs/PHYSICS.md § Stability).
    expect(() => buildWorld({ records: [rec('hot', 0, [0, 0, 0], 0.25, 1)], seed: SEED, landscapeAmp: AMP_MAX })).toThrow(/unstable/)
    const w = buildWorld({ records: [], seed: SEED, landscapeAmp: AMP_MAX })
    expect(() => upsertRecord(w, rec('hot', 0, [0, 0, 0], 0.25, 1))).toThrow(/unstable/)
    expect(w.slotOf.size).toBe(0)
  })
})

describe('world: R1 reversibility with births (N = 1k)', () => {
  // Dates span 5 years before T0 (born at step 0) to 10 years after: births every few steps.
  const recs = makeRecords({ n: 1000, seed: 3, years: 10, preYears: 5 })

  it('forward n then back n restores the identical worldHash, n ∈ {1, 600, 6000}', () => {
    const w = buildWorld({ records: recs, seed: SEED })
    const h0 = worldHash(w)
    const a0 = w.activeCount
    for (const n of [1, 600, 6000]) {
      runTo(w, n)
      expect(w.step).toBe(n)
      if (n > 1) expect(w.activeCount).toBeGreaterThan(a0)
      expect(worldHash(w)).not.toBe(h0)
      runTo(w, 0)
      expect(worldHash(w)).toBe(h0)
      expect(w.activeCount).toBe(a0)
    }
    expect(overflowSentinel(w.sys)).toBe(0)
  })

  it('reverses from a mid-run state across births in both directions', () => {
    const w = buildWorld({ records: recs, seed: SEED })
    runTo(w, 1234)
    const h = worldHash(w)
    for (const n of [1, 600]) {
      for (let k = 0; k < n; k++) stepWorld(w, 1)
      for (let k = 0; k < n; k++) stepWorld(w, -1)
      expect(worldHash(w)).toBe(h)
      for (let k = 0; k < n; k++) stepWorld(w, -1)
      for (let k = 0; k < n; k++) stepWorld(w, 1)
      expect(worldHash(w)).toBe(h)
    }
  })

  it('the grid world equals the O(N²) world bit-for-bit', () => {
    const small = makeRecords({ n: 300, seed: 5, years: 2, preYears: 2, halfWidth: 8 })
    const a = buildWorld({ records: small, seed: SEED })
    const b = buildWorld({ records: small, seed: SEED, pairMode: 'brute' })
    for (let k = 0; k < 6; k++) {
      runTo(a, 100 * k)
      runTo(b, 100 * k)
      expect(worldHash(a)).toBe(worldHash(b))
    }
  })
})

describe('world: R2 slot independence', () => {
  it('shuffled insertion order (different slots) gives identical per-id states', () => {
    const recs = makeRecords({ n: 1000, seed: 9, years: 3, preYears: 3 })
    const a = buildWorld({ records: recs, seed: SEED })
    const order = shuffled(recs, 77)
    // Scramble the free-list too: build without 100 records, then insert them back.
    const b = buildWorld({ records: order.slice(100), seed: SEED, capacity: 1000 })
    for (const r of order.slice(0, 100)) {
      const { changedFromStep } = upsertRecord(b, r)
      expect(changedFromStep).toBe(r.birthStep < 0 ? 0 : Math.floor(r.birthStep))
    }
    expect(b.stale).toBe(false)
    expect(b.slotOf.get(recs[0].id)).not.toBe(a.slotOf.get(recs[0].id))
    runTo(a, 1500)
    runTo(b, 1500)
    expect(stateHashById(b)).toBe(stateHashById(a))
    expect(worldHash(b)).not.toBe(worldHash(a)) // slot-ordered hash differs: the slots really moved
    expect(statesById(b)).toEqual(statesById(a))
  })
})

describe('world: births and spawn regeneration', () => {
  it('regenerates the identical spawn on every forward crossing and clears the slot on the way back', () => {
    const recs = makeRecords({ n: 200, seed: 12, years: 1, preYears: 1, halfWidth: 8 })
    const late = rec('late-node', 300, [0.5, 6, -0.5], 2, 0.9)
    const w = buildWorld({ records: [...recs, late], seed: SEED })
    const slot = w.slotOf.get('late-node')!
    runTo(w, 299)
    expect(readState(w, 'late-node')).toBeUndefined()
    stepWorld(w, 1)
    const sp = new Int32Array(6)
    spawnNodeState(fnv1a32('late-node'), w.sys.tau[slot], w.sys.invMass[slot], sp)
    const born = readState(w, 'late-node')!
    expect(born.d).toEqual([sp[3], sp[4], sp[5]])
    runTo(w, 400)
    const at400 = statesById(w)
    for (let rep = 0; rep < 3; rep++) {
      runTo(w, 299 - 7 * rep)
      expect(isActive(w, slot)).toBe(false)
      expect(Array.from(w.sys.x.subarray(3 * slot, 3 * slot + 3))).toEqual([0, 0, 0])
      expect(Array.from(w.sys.d.subarray(3 * slot, 3 * slot + 3))).toEqual([0, 0, 0])
      runTo(w, 300)
      expect(readState(w, 'late-node')).toEqual(born)
      runTo(w, 400)
      expect(statesById(w)).toEqual(at400)
    }
    // Stepping below step 0 empties the world; coming back regenerates step 0 exactly.
    runTo(w, 0)
    const h0 = worldHash(w)
    stepWorld(w, -1)
    expect(w.activeCount).toBe(0)
    stepWorld(w, 1)
    expect(worldHash(w)).toBe(h0)
  })
})

describe('world: edits', () => {
  const base = makeRecords({ n: 300, seed: 21, years: 2, preYears: 1, halfWidth: 8 })

  function fresh(records: WorldRecord[], step: number): PhysicsWorld {
    const w = buildWorld({ records, seed: SEED })
    runTo(w, step)
    return w
  }

  it('returns changedFromStep = min(old, new birth) over the affected node', () => {
    const w = buildWorld({ records: base, seed: SEED })
    runTo(w, 500)
    const r = base.find((x) => x.birthStep > 700)!
    const b = Math.floor(r.birthStep)
    expect(upsertRecord(w, { ...r }).changedFromStep).toBe(Number.POSITIVE_INFINITY) // no-op
    expect(upsertRecord(w, { ...r, anchor: [r.anchor[0] + 1, r.anchor[1], r.anchor[2]] }).changedFromStep).toBe(b)
    expect(upsertRecord(w, { ...r, mass: r.mass * 1.5 }).changedFromStep).toBe(b)
    expect(upsertRecord(w, { ...r, temperature: 0.01 }).changedFromStep).toBe(b)
    expect(upsertRecord(w, { ...r, birthStep: b - 100 }).changedFromStep).toBe(b - 100)
    expect(upsertRecord(w, { ...r, birthStep: b + 50 }).changedFromStep).toBe(b - 100)
    expect(upsertRecord(w, { ...r, birthStep: b + 70 }).changedFromStep).toBe(b + 50)
    expect(w.stale).toBe(false) // every change so far lies after step 500
    expect(upsertRecord(w, rec('new', 820)).changedFromStep).toBe(820)
    expect(upsertRecord(w, rec('new-past', 120)).changedFromStep).toBe(120)
    expect(w.stale).toBe(true)
    expect(removeRecord(w, 'new').changedFromStep).toBe(820)
    expect(removeRecord(w, 'absent').changedFromStep).toBe(Number.POSITIVE_INFINITY)
    expect(w.slotOf.has('new')).toBe(false)
  })

  it('edit + invalidateFrom + seekTo equals a fresh world built from the edited records', () => {
    const target = 1500
    const edits: { name: string; apply: (recs: WorldRecord[]) => WorldRecord[] }[] = [
      { name: 'move anchor (past)', apply: (rs) => rs.map((r, k) => (k === 7 ? { ...r, anchor: [r.anchor[0] + 2, r.anchor[1], r.anchor[2] - 1] as [number, number, number] } : r)) },
      { name: 'birth later', apply: (rs) => rs.map((r, k) => (k === 11 ? { ...r, birthStep: Math.max(0, r.birthStep) + 900 } : r)) },
      { name: 'birth earlier', apply: (rs) => rs.map((r, k) => (k === 13 ? { ...r, birthStep: Math.max(0, r.birthStep - 400) } : r)) },
      { name: 'insert (past)', apply: (rs) => [...rs, rec('inserted', 950, [1, 10, 2], 0.5, 0.7)] },
      { name: 'remove', apply: (rs) => rs.filter((_, k) => k !== 5) },
      { name: 'insert at current step', apply: (rs) => [...rs, rec('now', target, [0, 12, 0])] },
      { name: 'insert future', apply: (rs) => [...rs, rec('future', target + 400, [0, 30, 0])] },
    ]
    const w = buildWorld({ records: base, seed: SEED })
    const ck = new Checkpoints(600)
    ck.seekTo(w, target)
    expect(ck.keys()).toEqual([0, 600, 1200])
    let current = base
    for (const e of edits) {
      const next = e.apply(current)
      const before = new Map(current.map((r) => [r.id, r]))
      const after = new Map(next.map((r) => [r.id, r]))
      let changed = Number.POSITIVE_INFINITY
      for (const r of after.values()) changed = Math.min(changed, upsertRecord(w, r).changedFromStep)
      for (const id of before.keys()) if (!after.has(id)) changed = Math.min(changed, removeRecord(w, id).changedFromStep)
      expect(changed, e.name).toBeLessThan(Number.POSITIVE_INFINITY)
      expect(w.stale, e.name).toBe(changed < target)
      ck.invalidateFrom(changed)
      const ran = ck.seekTo(w, target)
      if (changed >= target) expect(ran, e.name).toBe(0)
      const ref = fresh(next, target)
      expect(stateHashById(w), e.name).toBe(stateHashById(ref))
      expect(statesById(w), e.name).toEqual(statesById(ref))
      current = next
    }
  })

  it('grows capacity on insert without moving slots', () => {
    const recs = makeRecords({ n: 70, seed: 31, years: 1, preYears: 1, halfWidth: 6 })
    const w = buildWorld({ records: recs.slice(0, 64), seed: SEED, capacity: 64 })
    expect(w.sys.count).toBe(64)
    runTo(w, 100)
    const slots = new Map(w.slotOf)
    for (const r of recs.slice(64)) upsertRecord(w, r)
    expect(w.sys.count).toBe(128)
    expect(w.birth).toBe(w.sys.birth)
    for (const [id, s] of slots) expect(w.slotOf.get(id)).toBe(s)
    expect(w.idOf.length).toBe(128)
    const ck = new Checkpoints()
    ck.seekTo(w, 300)
    const ref = buildWorld({ records: recs, seed: SEED })
    runTo(ref, 300)
    expect(stateHashById(w)).toBe(stateHashById(ref))
  })
})

describe('world: read-outs', () => {
  it('readPoses renders X + frac·D for active slots, anchors for dormant records, 0 for free slots', () => {
    const w = buildWorld({ records: [rec('a', 0, [1, 2, 3]), rec('b', 50, [4, 5, 6])], seed: SEED, capacity: 4 })
    runTo(w, 10)
    const out = new Float32Array(12)
    readPoses(w, out, 0.25)
    for (let a = 0; a < 3; a++) expect(out[a]).toBeCloseTo(w.sys.x[a] / UNIT + (0.25 * w.sys.d[a]) / 2 ** 27, 5)
    expect(Array.from(out.subarray(3, 6))).toEqual([4, 5, 6])
    expect(Array.from(out.subarray(6, 12))).toEqual([0, 0, 0, 0, 0, 0])
    expect(Array.from(activeSlots(w))).toEqual([0])
  })
})
