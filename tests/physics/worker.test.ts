import { describe, expect, it } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { CHECKPOINT_INDEX_KEY } from '../../src/physics/checkpointCache.ts'
import { D_FRAC } from '../../src/physics/fixed.ts'
import { type HostOptions, PhysicsHost } from '../../src/physics/workerHost.ts'
import type { FrameMsg, FromWorker, StatsMsg } from '../../src/physics/workerProtocol.ts'
import {
  type PhysicsWorld,
  type WorldRecord,
  buildWorld,
  readPoses,
  runTo,
  stateHashById,
  worldHash,
} from '../../src/physics/world.ts'
import { makeRecords } from './worldFixture.ts'

// The worker's handler driven directly in node: the same object worker.ts wires to `self`.
// Time is frozen (now = 0, budget 0), so every tick does exactly one unit of work and
// the scheduled continuations run when the test drains them.

const SEED = 0x5eed

function harness(opts: Partial<HostOptions> = {}) {
  const posts: FromWorker[] = []
  const queue: (() => void)[] = []
  const host = new PhysicsHost({
    post: (m) => posts.push(m),
    schedule: (fn) => queue.push(fn),
    delay: (fn) => queue.push(fn),
    now: () => 0,
    tickBudgetMs: 0,
    seekChunk: 64,
    statsIntervalMs: 0,
    ...opts,
  })
  const drain = (max = 1e5) => {
    for (let k = 0; queue.length && k < max; k++) queue.shift()!()
  }
  const frames = () => posts.filter((m): m is FrameMsg => m.type === 'frame')
  const stats = () => posts.filter((m): m is StatsMsg => m.type === 'stats')
  return { host, posts, queue, drain, frames, stats }
}

function reference(records: WorldRecord[], step: number): PhysicsWorld {
  const w = buildWorld({ records, seed: SEED })
  runTo(w, step)
  return w
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('physics worker host: protocol round trip', () => {
  const records = makeRecords({ n: 60, seed: 11, years: 3, preYears: 1, halfWidth: 10 })

  it('load → target: seeks in chunks, posts no mid-seek frames, lands on the straight-run state', () => {
    const h = harness()
    h.host.handle({ type: 'load', gen: 1, records, seed: SEED, settingsKey: 'k', target: 1000 })
    expect(h.host.settling).toBe(true)
    h.drain()
    const w = h.host.current!
    expect(w.step).toBe(1000)
    expect(h.host.settling).toBe(false)
    const ref = reference(records, 1000)
    expect(worldHash(w)).toBe(worldHash(ref))

    // Mid-seek states are stats only; the one frame is the world at the target.
    const frames = h.frames()
    expect(frames.map((f) => f.step)).toEqual([1000])
    expect(h.stats().length).toBeGreaterThan(5)
    expect(h.stats().every((s) => s.stats.settling)).toBe(true)

    const f = frames[0]
    expect(f.gen).toBe(1)
    expect(f.stats.settling).toBe(false)
    expect(f.stats.activeCount).toBe(ref.activeCount)
    expect(f.stats.checkpoints).toBe(2) // steps 0 and 600
    expect(f.stats.overflowSentinel).toBe(0)
    expect(f.slots).not.toBeNull()
    expect(f.slots!.ids).toEqual(ref.idOf)
    const pos = new Float32Array(3 * ref.sys.count)
    readPoses(ref, pos)
    expect(f.pos).toEqual(pos)
    for (let s = 0; s < ref.sys.count; s++) {
      const active = ref.idOf[s] !== null && ref.birth[s] <= 1000
      expect(f.born[s]).toBe(active ? 1 : 0)
      if (active) expect(f.vel[3 * s + 1]).toBe(Math.fround(ref.sys.d[3 * s + 1] * 2 ** -D_FRAC))
    }
    // Ghost rows sit on their anchors.
    const ghost = f.born.findIndex((b, s) => b === 0 && f.slots!.ids[s] !== null)
    expect(ghost).toBeGreaterThanOrEqual(0)
    expect(f.pos[3 * ghost + 1]).toBe(f.slots!.anchor[3 * ghost + 1])
  })

  it('small targets step (frames every tick, ledger advanced) in both directions', () => {
    const h = harness()
    h.host.handle({ type: 'load', gen: 1, records, seed: SEED, settingsKey: 'k', target: 1000 })
    h.drain()
    const origin = h.frames().at(-1)!.stats.energy!.origin
    expect(origin).toBe(1000)
    for (const t of [1001, 1005, 1040, 1030, 990]) {
      h.host.handle({ type: 'target', step: t })
      h.drain()
      expect(h.frames().at(-1)!.step).toBe(t)
      expect(h.host.settling).toBe(false)
    }
    const last = h.frames().at(-1)!
    // Stepping never rebuilt the ledger: same origin, and it stays small across births.
    expect(last.stats.energy!.origin).toBe(origin)
    expect(Number.isFinite(last.stats.energy!.ledger)).toBe(true)
    expect(Math.abs(last.stats.energy!.ledger)).toBeLessThan(0.05 * Math.max(1, last.stats.energy!.e0))
    expect(last.stats.S).not.toBeNull()
    expect(last.slots).toBeNull() // layout unchanged since the first frame
    expect(stateHashById(h.host.current!)).toBe(stateHashById(reference(records, 990)))
  })

  it('stats refresh at most once per interval, and a paused world is owed one', () => {
    let t = 0
    const delayed: (() => void)[] = []
    const h = harness({ now: () => t, statsIntervalMs: 1000, delay: (fn) => delayed.push(fn) })
    h.host.handle({ type: 'load', gen: 1, records, seed: SEED, settingsKey: 'k', target: 700 })
    h.drain()
    const first = h.frames().at(-1)!.stats
    expect(first.energy!.origin).toBe(700)
    const S0 = first.S
    t = 10
    h.host.handle({ type: 'target', step: 760 })
    h.drain()
    expect(h.frames().at(-1)!.step).toBe(760)
    expect(h.frames().at(-1)!.stats.S).toBe(S0) // not re-read yet
    expect(delayed).toHaveLength(1)
    t = 1000
    const n = h.posts.length
    delayed.shift()!()
    const refreshed = h.posts.slice(n).find((m): m is StatsMsg => m.type === 'stats')!
    expect(refreshed.step).toBe(760)
    expect(refreshed.stats.S).not.toBe(S0)
    expect(refreshed.stats.energy!.origin).toBe(700) // advanced step by step, not rebuilt
  })

  it('a far target seeks (restoring checkpoints) and the ledger restarts there', () => {
    const h = harness()
    h.host.handle({ type: 'load', gen: 1, records, seed: SEED, settingsKey: 'k', target: 1300 })
    h.drain()
    h.host.handle({ type: 'target', step: 620 })
    h.drain()
    expect(h.host.current!.step).toBe(620)
    expect(stateHashById(h.host.current!)).toBe(stateHashById(reference(records, 620)))
    expect(h.frames().at(-1)!.stats.energy!.origin).toBe(620)
  })

  it('edit → settle: upserts, inserts and removes recompute to the straight-run state', () => {
    const h = harness()
    h.host.handle({ type: 'load', gen: 1, records, seed: SEED, settingsKey: 'k', target: 1500 })
    h.drain()
    const before = h.posts.length

    const past = records.filter((r) => r.birthStep > 100 && r.birthStep < 1400)
    const changed: WorldRecord = { ...past[0], temperature: 1 - past[0].temperature }
    const added: WorldRecord = { id: 'added-0001', anchor: [3, 12 * 0.9, -4], birthStep: 540, mass: 1.5, temperature: 0.7 }
    const future: WorldRecord = { id: 'added-0002', anchor: [-6, 12 * 4, 2], birthStep: 2400, mass: 1, temperature: 0.2 }
    const removed = past[1].id
    h.host.handle({ type: 'edit', upserts: [changed, added, future], removes: [removed] })
    expect(h.host.settling).toBe(true)

    // The edit posts one hold frame at once: the old trajectory plus the new layout.
    const hold = h.posts[before] as FrameMsg
    expect(hold.type).toBe('frame')
    expect(hold.step).toBe(1500)
    expect(hold.slots!.ids).toContain('added-0001')
    expect(hold.slots!.ids).not.toContain(removed)

    // The playhead moves while the recompute runs; it lands on the newest target.
    h.host.handle({ type: 'target', step: 1520 })
    h.drain()
    const final = records.filter((r) => r.id !== removed).map((r) => (r.id === changed.id ? changed : r))
    final.push(added, future)
    const w = h.host.current!
    expect(w.step).toBe(1520)
    expect(w.stale).toBe(false)
    expect(stateHashById(w)).toBe(stateHashById(reference(final, 1520)))
    const last = h.frames().at(-1)!
    expect(last.step).toBe(1520)
    expect(last.stats.settling).toBe(false)
    // Checkpoints at or after the earliest changed birth were dropped and refilled.
    expect(h.host.checkpoints.keys()).toEqual([0, 600, 1200])
  })

  it('a future-only edit changes nothing in the past: no recompute, one frame', () => {
    const h = harness()
    h.host.handle({ type: 'load', gen: 1, records, seed: SEED, settingsKey: 'k', target: 800 })
    h.drain()
    const hash = worldHash(h.host.current!)
    const n = h.frames().length
    h.host.handle({ type: 'edit', upserts: [{ id: 'later', anchor: [0, 60, 0], birthStep: 3000, mass: 1, temperature: 0.5 }], removes: [] })
    expect(h.host.settling).toBe(false)
    expect(h.queue.length).toBe(0)
    expect(worldHash(h.host.current!)).toBe(hash)
    expect(h.frames().length).toBe(n + 1)
    expect(h.frames().at(-1)!.slots!.ids).toContain('later')
    // A no-op edit (identical record, unknown id) changes no layout and posts no frame.
    const frames = h.frames().length
    h.host.handle({ type: 'edit', upserts: [records[0]], removes: ['not-there'] })
    expect(h.frames().length).toBe(frames)
    expect(h.queue.length).toBe(0)
  })

  it('a bad record is reported without stopping the world; a bad load is fatal', () => {
    const h = harness()
    h.host.handle({ type: 'load', gen: 3, records, seed: SEED, settingsKey: 'k', target: 300 })
    h.drain()
    h.host.handle({ type: 'edit', upserts: [{ id: 'nan', anchor: [Number.NaN, 0, 0], birthStep: 10, mass: 1, temperature: 0.5 }], removes: [] })
    const err = h.posts.find((m) => m.type === 'error')
    expect(err).toMatchObject({ type: 'error', gen: 3, fatal: false })
    expect(h.host.current!.step).toBe(300)

    const b = harness()
    b.host.handle({ type: 'load', gen: 1, records: [records[0], records[0]], seed: SEED, settingsKey: 'k', target: 0 })
    expect(b.posts.at(-1)).toMatchObject({ type: 'error', fatal: true })
    expect(b.host.current).toBeNull()
  })

  it('cold start restores the cached checkpoint nearest the target instead of replaying from 0', async () => {
    const kv = createMemoryStore()
    const a = harness({ kv })
    a.host.handle({ type: 'load', gen: 1, records, seed: SEED, settingsKey: 'k', target: 3100 })
    a.drain()
    await sleep(20)
    const index = (await kv.getKv<string[]>(CHECKPOINT_INDEX_KEY))!
    expect(index.length).toBe(5) // 600 … 3000 (step 0 is never written)

    const b = harness({ kv })
    b.host.handle({ type: 'load', gen: 1, records, seed: SEED, settingsKey: 'k', target: 3100 })
    await sleep(20) // the cache lookup for 3000/3600 resolves
    b.drain()
    expect(b.host.current!.step).toBe(3100)
    expect(stateHashById(b.host.current!)).toBe(stateHashById(reference(records, 3100)))
    // Only step 0 (from the first chunk) and the restored 3000: nothing in between replayed.
    expect(b.host.checkpoints.keys()).toEqual([0, 3000])
  })
})
