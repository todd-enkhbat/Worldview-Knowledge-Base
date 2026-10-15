import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useApp, useWorld } from '../../src/app/store.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, createNode, initRepo } from '../../src/data/repo.ts'
import type { WorldStore } from '../../src/data/WorldStore.ts'
import type { NodeRecord } from '../../src/domain/types.ts'
import { loadSplatBytes } from '../../src/world/splats/assets.ts'
import { ingestScene, rebuildScene, type IngestProgress } from '../../src/world/splats/ingest/ingest.ts'
import { Y_DOWN_FIX } from '../../src/world/splats/ingest/pose.ts'
import { readSpzHeader } from '../../src/world/splats/ingest/spzRead.ts'

// End to end in node: in-thread transcode (no Worker), no world SparkRenderer (no thumbnail),
// and a crop small enough (< 100k splats) that the interior is its own proxy, so Spark's
// browser-only loader is never needed.

const LION = join(import.meta.dirname, '../../public/fixtures/lion.v3.spz')
const have = existsSync(LION)
const CROP = { min: [-0.1, -0.3, -0.1] as [number, number, number], max: [0.1, 0, 0.1] as [number, number, number] }

let store: WorldStore
let memory: NodeRecord

beforeEach(async () => {
  useWorld.getState().hydrate(null, [])
  useApp.setState({ toasts: [], selectedId: null })
  store = createMemoryStore()
  await initRepo({ store })
  await completeFirstRun({ T0: Date.UTC(1990, 4, 17), start: 'empty' })
  memory = await createNode({ archetype: 'memory', title: 'Lion at the museum', temporalOrigin: Date.UTC(2020, 1, 2) })
})

afterEach(async () => {
  await closeRepo()
})

describe('ingestScene', () => {
  it.skipIf(!have)('stores interior, proxy and the block; progress is monotonic and ends at 1', async () => {
    const progress: IngestProgress[] = []
    const file = new File([readFileSync(LION)], 'lion.v3.spz')
    const r = await ingestScene(memory.id, file, { crop: CROP, worker: false, sparkTimeoutMs: 0, onProgress: (p) => progress.push(p) })

    const block = useWorld.getState().nodes.get(memory.id)!.splat!
    expect(block).toEqual(r.block)
    expect(r.sourceFormat).toBe('spz')
    expect(r.proxyMethod).toBe('copy')
    expect(block.counts.interior).toBeGreaterThan(1000)
    expect(block.counts.interior).toBeLessThan(100_000)
    expect(block.counts.proxy).toBe(block.counts.interior)
    expect(block.crop).toEqual(CROP)
    expect(block.upFix).toEqual(Y_DOWN_FIX)
    expect(block.thumbAssetId).toBeNull()

    const interior = await loadSplatBytes(block.interiorAssetId!)
    expect(await readSpzHeader(interior)).toMatchObject({ version: 3, numPoints: block.counts.interior })
    const metas = (await store.listAssets()).filter((m) => m.nodeId === memory.id)
    expect(metas.map((m) => m.kind).sort()).toEqual(['splat-interior', 'splat-proxy'])

    const fractions = progress.map((p) => p.fraction)
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b))
    expect(progress.at(-1)).toMatchObject({ stage: 'done', fraction: 1 })
    expect(progress.map((p) => p.stage)).toContain('transcode')
  })

  it.skipIf(!have)('a cancelled ingest stores nothing', async () => {
    const controller = new AbortController()
    const file = new File([readFileSync(LION)], 'lion.v3.spz')
    const run = ingestScene(memory.id, file, {
      crop: CROP,
      worker: false,
      sparkTimeoutMs: 0,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.stage === 'analyse') controller.abort()
      },
    })
    await expect(run).rejects.toThrow(/cancelled/)
    expect(useWorld.getState().nodes.get(memory.id)?.splat).toBeUndefined()
    expect((await store.listAssets()).filter((m) => m.nodeId === memory.id)).toEqual([])
  })

  it('refuses a non-memory and garbage before storing anything', async () => {
    const idea = await createNode({ archetype: 'idea', title: 'Entropy' })
    await expect(ingestScene(idea.id, new Blob([new Uint8Array(8)]), { worker: false })).rejects.toThrow(/Only memories/)
    await expect(ingestScene(memory.id, new File(['hello'], 'notes.txt'), { worker: false, sparkTimeoutMs: 0 })).rejects.toThrow(/Unrecognised/)
    expect(await store.listAssets()).toEqual([])
  })

  it.skipIf(!have)('rebuildScene re-derives the proxy for a new crop and keeps the interior', async () => {
    const file = new File([readFileSync(LION)], 'lion.v3.spz')
    const first = (await ingestScene(memory.id, file, { crop: CROP, worker: false, sparkTimeoutMs: 0 })).block
    const tighter = { min: [-0.05, -0.2, -0.05] as [number, number, number], max: [0.05, -0.1, 0.05] as [number, number, number] }
    const next = await rebuildScene(memory.id, { crop: tighter }, { sparkTimeoutMs: 0 })
    expect(next.interiorAssetId).toBe(first.interiorAssetId)
    expect(next.proxyAssetId).not.toBe(first.proxyAssetId)
    expect(next.crop).toEqual(tighter)
    expect(next.counts.interior).toBe(first.counts.interior)
    expect(next.counts.proxy).toBeLessThan(first.counts.proxy)
    expect(await store.getAssetMeta(first.proxyAssetId!)).toBeUndefined()
  })
})
