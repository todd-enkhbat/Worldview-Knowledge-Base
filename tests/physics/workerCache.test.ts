import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { CHECKPOINT_INDEX_KEY } from '../../src/physics/checkpointCache.ts'
import { openCheckpointKv } from '../../src/physics/worker.ts'
import { PhysicsHost } from '../../src/physics/workerHost.ts'
import { buildWorld, runTo, stateHashById } from '../../src/physics/world.ts'
import { makeRecords } from './worldFixture.ts'

// The worker's own IndexedDB checkpoint cache ('hyperspace-cache'), through fake-indexeddb.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('worker checkpoint cache (IndexedDB)', () => {
  it('is a working KvStore that keeps Int32Arrays', async () => {
    const kv = openCheckpointKv('hyperspace-cache-test-1')!
    expect(await kv.getKv('missing')).toBeUndefined()
    await kv.putKv('a', { x: Int32Array.of(1, -2, 3) })
    const v = await kv.getKv<{ x: Int32Array }>('a')
    expect(v!.x).toBeInstanceOf(Int32Array)
    expect([...v!.x]).toEqual([1, -2, 3])
    await kv.deleteKv('a')
    expect(await kv.getKv('a')).toBeUndefined()
  })

  it('a second host cold-starts from checkpoints the first one wrote', async () => {
    const records = makeRecords({ n: 40, seed: 5, years: 2, preYears: 1, halfWidth: 8 })
    const run = (name: string) => {
      const queue: (() => void)[] = []
      const host = new PhysicsHost({
        post: () => undefined,
        kv: openCheckpointKv(name),
        schedule: (fn) => queue.push(fn),
        delay: () => undefined,
        now: () => 0,
        tickBudgetMs: 0,
        seekChunk: 64,
      })
      const drain = () => {
        while (queue.length) queue.shift()!()
      }
      return { host, drain }
    }
    const a = run('hyperspace-cache-test-2')
    a.host.handle({ type: 'load', gen: 1, records, seed: 7, settingsKey: 'k', target: 1250 })
    a.drain()
    await sleep(50)
    const kv = openCheckpointKv('hyperspace-cache-test-2')!
    expect((await kv.getKv<string[]>(CHECKPOINT_INDEX_KEY))!.length).toBe(2) // 600, 1200

    const b = run('hyperspace-cache-test-2')
    b.host.handle({ type: 'load', gen: 1, records, seed: 7, settingsKey: 'k', target: 1250 })
    await sleep(50)
    b.drain()
    expect(b.host.checkpoints.keys()).toEqual([0, 1200])
    const ref = buildWorld({ records, seed: 7 })
    runTo(ref, 1250)
    expect(stateHashById(b.host.current!)).toBe(stateHashById(ref))
  })
})
