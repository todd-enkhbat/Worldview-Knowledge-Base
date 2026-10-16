import { describe, expect, it } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { CHECKPOINT_INDEX_KEY, CheckpointCache } from '../../src/physics/checkpointCache.ts'
import { Checkpoints } from '../../src/physics/clock.ts'
import { buildWorld, runTo, stateHashById, upsertRecord } from '../../src/physics/world.ts'
import { makeRecords, shuffled } from './worldFixture.ts'

const SEED = 0x5eed

describe('checkpoint cache (WorldStore kv)', () => {
  const recs = makeRecords({ n: 150, seed: 6, years: 3, preYears: 1, halfWidth: 8 })

  it('round-trips by id into a world with a different slot layout', async () => {
    const kv = createMemoryStore()
    const cache = new CheckpointCache(kv)
    const a = buildWorld({ records: recs, seed: SEED })
    const ca = new Checkpoints()
    ca.seekTo(a, 1800)
    for (const s of ca.keys()) expect(await cache.persist(a, ca, s)).toBe(true)
    expect(await cache.persist(a, ca, 300)).toBe(false) // no such checkpoint
    expect((await kv.getKv<string[]>(CHECKPOINT_INDEX_KEY))!.length).toBe(4)

    const b = buildWorld({ records: shuffled(recs, 5), seed: SEED })
    const cb = new Checkpoints()
    expect(await cache.hydrateUpTo(b, cb, 1800)).toBe(4)
    expect(cb.keys()).toEqual([0, 600, 1200, 1800])
    expect(cb.seekTo(b, 1750)).toBe(50) // from the hydrated 1800, backwards
    const ref = buildWorld({ records: recs, seed: SEED })
    runTo(ref, 1750)
    expect(stateHashById(b)).toBe(stateHashById(ref))
  })

  it('an edit hides the checkpoints it affects and keeps the earlier ones', async () => {
    const kv = createMemoryStore()
    const cache = new CheckpointCache(kv)
    const a = buildWorld({ records: recs, seed: SEED })
    const ca = new Checkpoints()
    ca.seekTo(a, 1800)
    for (const s of ca.keys()) await cache.persist(a, ca, s)

    const r = recs.find((x) => x.birthStep > 700 && x.birthStep < 1100)!
    const edited = recs.map((x) => (x === r ? { ...x, anchor: [x.anchor[0] + 1, x.anchor[1], x.anchor[2]] as [number, number, number] } : x))
    const b = buildWorld({ records: edited, seed: SEED })
    const cb = new Checkpoints()
    expect(await cache.hydrate(b, cb, 0)).toBe(true)
    expect(await cache.hydrate(b, cb, 600)).toBe(true)
    expect(await cache.hydrate(b, cb, 1200)).toBe(false)
    expect(await cache.hydrate(b, cb, 1800)).toBe(false)
    // Same for an in-place edit of a live world.
    upsertRecord(a, edited.find((x) => x.id === r.id)!)
    expect(cache.keyFor(a, 600)).toBe(cache.keyFor(b, 600))
    expect(cache.keyFor(a, 1200)).toBe(cache.keyFor(b, 1200))
    // Different settings never match.
    const other = buildWorld({ records: recs, seed: SEED + 1 })
    expect(await cache.hydrate(other, new Checkpoints(), 0)).toBe(false)
  })

  it('evicts the oldest entries beyond maxEntries and can be cleared', async () => {
    const kv = createMemoryStore()
    const cache = new CheckpointCache(kv, { maxEntries: 2 })
    const a = buildWorld({ records: recs, seed: SEED })
    const ca = new Checkpoints()
    ca.seekTo(a, 1800)
    await Promise.all(ca.keys().map((s) => cache.persist(a, ca, s)))
    const index = (await kv.getKv<string[]>(CHECKPOINT_INDEX_KEY))!
    expect(index).toEqual([cache.keyFor(a, 1200), cache.keyFor(a, 1800)])
    expect(await kv.getKv(cache.keyFor(a, 0))).toBeUndefined()
    await cache.clear()
    expect(await kv.getKv(cache.keyFor(a, 1800))).toBeUndefined()
    expect(await kv.getKv(CHECKPOINT_INDEX_KEY)).toBeUndefined()
  })
})
