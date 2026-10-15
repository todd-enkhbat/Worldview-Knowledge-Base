import { afterEach, describe, expect, it } from 'vitest'
// No fake-indexeddb: the page's own boot falls back to a memory world, which is enough to
// check that the bench swaps onto its fixture world and off again.
import { useWorld } from '../../src/app/store.ts'
import { bootData } from '../../src/app/boot.ts'
import { closeRepo, completeFirstRun, isRepoReady } from '../../src/data/repo.ts'
import { resetWriterLock } from '../../src/data/locks.ts'
import { PERF_PHYSICS_SEED, PERF_T0, enterFixtureWorld, exitFixtureWorld, memoryAnchors } from '../../src/lab/perf/fixtureWorld.ts'
import { CameraPath, perfKeyframes } from '../../src/lab/perf/cameraPath.ts'

afterEach(async () => {
  await closeRepo()
  resetWriterLock()
  globalThis.__wv = undefined
})

describe('perf fixture world', () => {
  it('swaps onto a deterministic demo world and back off it', async () => {
    await bootData()
    await completeFirstRun({ T0: Date.UTC(2001, 0, 1), start: 'empty' })
    expect(useWorld.getState().nodes.size).toBe(0)

    const a = await enterFixtureWorld()
    const ws = useWorld.getState()
    expect(ws.settings?.T0).toBe(PERF_T0)
    expect(ws.settings?.physicsSeed).toBe(PERF_PHYSICS_SEED)
    expect(ws.nodes.size).toBe(a.nodes)
    expect(a.memories.length).toBe(4)
    const dates = a.memories.map((m) => m.temporalOrigin)
    expect([...dates].sort((x, y) => x - y)).toEqual(dates)
    const keys = perfKeyframes(memoryAnchors(a), 432)
    expect(() => new CameraPath(keys, 30)).not.toThrow()

    await exitFixtureWorld()
    expect(isRepoReady()).toBe(true)
    expect(useWorld.getState().settings?.T0).not.toBe(PERF_T0)

    // Same constants, same world.
    const b = await enterFixtureWorld()
    expect(b.memories.map((m) => m.id)).toEqual(a.memories.map((m) => m.id))
    expect(memoryAnchors(b)).toEqual(memoryAnchors(a))
    await exitFixtureWorld()
  })
})
