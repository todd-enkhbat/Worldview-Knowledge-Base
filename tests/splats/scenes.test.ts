import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useApp, useWorld } from '../../src/app/store.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, createNode, initRepo } from '../../src/data/repo.ts'
import {
  SPZ_MIME,
  SceneError,
  attachScene,
  detachScene,
  reframeScene,
  updateScene,
  type SceneAssets,
  type SceneBlockDraft,
} from '../../src/data/scenes.ts'
import type { WorldStore } from '../../src/data/WorldStore.ts'
import type { NodeRecord } from '../../src/domain/types.ts'

const T0 = Date.UTC(1990, 4, 17)
const START = Date.UTC(2026, 9, 14, 12)

/** A memory store that logs writes in order and can be told to fail putNode. */
function loggedStore(): { store: WorldStore; log: string[]; failPutNode: { on: boolean } } {
  const inner = createMemoryStore()
  const log: string[] = []
  const failPutNode = { on: false }
  const store: WorldStore = Object.create(inner) as WorldStore
  store.putBlob = async (input) => {
    log.push(`putBlob:${input.meta.kind}`)
    return inner.putBlob(input)
  }
  store.deleteBlob = async (id) => {
    log.push(`deleteBlob:${id}`)
    return inner.deleteBlob(id)
  }
  store.putNode = async (n) => {
    log.push('putNode')
    if (failPutNode.on) throw new Error('disk full')
    return inner.putNode(n)
  }
  return { store, log, failPutNode }
}

const draft = (over: Partial<SceneBlockDraft> = {}): SceneBlockDraft => ({
  entryPose: { position: [0, 0.5, 2], quaternion: [0, 0, 0, 1] },
  crop: { min: [-1, -1, -1], max: [1, 1, 1] },
  upFix: [1, 0, 0, 0],
  counts: { interior: 200_000, proxy: 100_000 },
  sourceFormat: 'spz',
  ...over,
})

const assets = (tag: number): SceneAssets => ({
  interior: { data: new Uint8Array([1, tag, 1]), mime: SPZ_MIME },
  proxy: { data: new Uint8Array([2, tag]), mime: SPZ_MIME },
  thumb: { data: new Blob([new Uint8Array([3, tag])], { type: 'image/webp' }), mime: 'image/webp' },
})

let h: ReturnType<typeof loggedStore>
let memory: NodeRecord

async function splatAssets(nodeId: string) {
  return (await h.store.listAssets()).filter((m) => m.nodeId === nodeId && m.kind.startsWith('splat-'))
}

beforeEach(async () => {
  useWorld.getState().hydrate(null, [])
  useApp.setState({ toasts: [], selectedId: null })
  h = loggedStore()
  await initRepo({ store: h.store, now: () => START })
  await completeFirstRun({ T0, start: 'empty' })
  memory = await createNode({ archetype: 'memory', title: 'Kitchen, 2019', temporalOrigin: Date.UTC(2019, 5, 1) })
  h.log.length = 0
})

afterEach(async () => {
  await closeRepo()
})

describe('attachScene', () => {
  it('writes the three blobs first and the record last, each blob owned by the node', async () => {
    const rec = await attachScene(memory.id, draft(), assets(1))
    expect(h.log).toEqual(['putBlob:splat-interior', 'putBlob:splat-proxy', 'putBlob:splat-thumb', 'putNode'])
    const s = rec.splat!
    expect(s.interiorAssetId && s.proxyAssetId && s.thumbAssetId).toBeTruthy()
    expect(useWorld.getState().nodes.get(memory.id)?.splat).toEqual(s)
    expect((await h.store.getNode(memory.id))?.splat).toEqual(s)
    const metas = await splatAssets(memory.id)
    expect(metas.map((m) => m.kind).sort()).toEqual(['splat-interior', 'splat-proxy', 'splat-thumb'])
    expect(metas.find((m) => m.kind === 'splat-thumb')?.mime).toBe('image/webp')
    expect(new Uint8Array(await (await h.store.getBlob(s.interiorAssetId!))!.arrayBuffer())).toEqual(new Uint8Array([1, 1, 1]))
  })

  it('replacing a scene deletes the old blobs only after the new record commits', async () => {
    const first = (await attachScene(memory.id, draft(), assets(1))).splat!
    h.log.length = 0
    const second = (await attachScene(memory.id, draft({ sourceFormat: 'ply' }), assets(2))).splat!
    const putNodeAt = h.log.indexOf('putNode')
    const deletes = h.log.filter((l) => l.startsWith('deleteBlob:')).map((l) => l.slice('deleteBlob:'.length))
    expect(new Set(deletes)).toEqual(new Set([first.interiorAssetId, first.proxyAssetId, first.thumbAssetId]))
    expect(h.log.findIndex((l) => l.startsWith('deleteBlob:'))).toBeGreaterThan(putNodeAt)
    const left = (await splatAssets(memory.id)).map((m) => m.id).sort()
    expect(left).toEqual([second.interiorAssetId, second.proxyAssetId, second.thumbAssetId].sort())
  })

  it('cleans up its blobs and leaves the record untouched when the record write fails', async () => {
    h.failPutNode.on = true
    await expect(attachScene(memory.id, draft(), assets(1))).rejects.toThrow(/disk full/)
    expect(await splatAssets(memory.id)).toEqual([])
    expect(useWorld.getState().nodes.get(memory.id)?.splat).toBeUndefined()
    expect((await h.store.getNode(memory.id))?.splat).toBeUndefined()
  })

  it('keeps the previous scene intact when a replacement fails', async () => {
    const first = (await attachScene(memory.id, draft(), assets(1))).splat!
    h.failPutNode.on = true
    await expect(attachScene(memory.id, draft(), assets(2))).rejects.toThrow()
    expect(useWorld.getState().nodes.get(memory.id)?.splat).toEqual(first)
    expect((await splatAssets(memory.id)).map((m) => m.id).sort()).toEqual([first.interiorAssetId, first.proxyAssetId, first.thumbAssetId].sort())
  })

  it('refuses non-memories before writing anything', async () => {
    const idea = await createNode({ archetype: 'idea', title: 'Entropy' })
    h.log.length = 0
    await expect(attachScene(idea.id, draft(), assets(1))).rejects.toThrow(SceneError)
    expect(h.log).toEqual([])
  })

  it('rejects an invalid block and removes the blobs it wrote', async () => {
    await expect(attachScene(memory.id, draft({ crop: { min: [1, 1, 1], max: [0, 2, 2] } }), assets(1))).rejects.toThrow(/crop/)
    expect(await splatAssets(memory.id)).toEqual([])
    expect(h.log).not.toContain('putNode')
  })

  it('needs the interior; proxy and thumbnail are optional', async () => {
    await expect(attachScene(memory.id, draft(), { proxy: assets(1).proxy })).rejects.toThrow(/interior/)
    const rec = await attachScene(memory.id, draft(), { interior: assets(1).interior })
    expect(rec.splat).toMatchObject({ proxyAssetId: null, thumbAssetId: null })
  })

  it('sweeps orphaned splat blobs of the node (an ingest that died mid-way)', async () => {
    await h.store.putBlob({
      meta: { id: 'orphan', kind: 'splat-proxy', mime: SPZ_MIME, bytes: 1, createdAt: START, nodeId: memory.id },
      data: new Uint8Array([9]),
    })
    await h.store.putBlob({
      meta: { id: 'other-node', kind: 'splat-proxy', mime: SPZ_MIME, bytes: 1, createdAt: START, nodeId: 'someone-else' },
      data: new Uint8Array([9]),
    })
    await attachScene(memory.id, draft(), assets(1))
    expect(await h.store.getAssetMeta('orphan')).toBeUndefined()
    expect(await h.store.getAssetMeta('other-node')).toBeDefined()
  })

  it('serialises concurrent attaches on one node: the last one wins and nothing leaks', async () => {
    const [a, b] = await Promise.all([attachScene(memory.id, draft(), assets(1)), attachScene(memory.id, draft(), assets(2))])
    const final = useWorld.getState().nodes.get(memory.id)!.splat!
    expect(final).toEqual(b.splat)
    expect(a.splat!.interiorAssetId).not.toBe(final.interiorAssetId)
    expect((await splatAssets(memory.id)).map((m) => m.id).sort()).toEqual([final.interiorAssetId, final.proxyAssetId, final.thumbAssetId].sort())
  })
})

describe('updateScene / detachScene', () => {
  it('updateScene changes numbers without touching blobs', async () => {
    const first = (await attachScene(memory.id, draft(), assets(1))).splat!
    h.log.length = 0
    const rec = await updateScene(memory.id, { crop: null, upFix: [0, 0, 0, 1] })
    expect(rec.splat).toEqual({ ...first, crop: null, upFix: [0, 0, 0, 1] })
    expect(h.log).toEqual(['putNode'])
  })

  it('updateScene can swap the thumbnail; the old one goes after the record', async () => {
    const first = (await attachScene(memory.id, draft(), assets(1))).splat!
    h.log.length = 0
    const rec = await updateScene(memory.id, {}, { thumb: assets(5).thumb })
    expect(rec.splat!.thumbAssetId).not.toBe(first.thumbAssetId)
    expect(rec.splat!.interiorAssetId).toBe(first.interiorAssetId)
    expect(h.log).toEqual(['putBlob:splat-thumb', 'putNode', `deleteBlob:${first.thumbAssetId}`])
  })

  it('updateScene on a memory without a scene fails before writing', async () => {
    await expect(updateScene(memory.id, { crop: null }, { thumb: assets(1).thumb })).rejects.toThrow(/no volumetric scene/)
    expect(h.log).toEqual([])
  })

  it('reframeScene saves crop, up-fix and entry pose as numbers and validates them', async () => {
    const first = (await attachScene(memory.id, draft(), assets(1))).splat!
    h.log.length = 0
    const entryPose = { position: [1, 2, 3] as [number, number, number], quaternion: [0, 1, 0, 0] as [number, number, number, number] }
    const rec = await reframeScene(memory.id, { crop: { min: [0, 0, 0], max: [1, 2, 3] }, upFix: [0, 0, 0, 1], entryPose })
    expect(rec.splat).toEqual({ ...first, crop: { min: [0, 0, 0], max: [1, 2, 3] }, upFix: [0, 0, 0, 1], entryPose })
    expect(h.log).toEqual(['putNode'])
    await expect(reframeScene(memory.id, { upFix: [0, 0, 0, 0] })).rejects.toThrow(/upFix/)
    await expect(reframeScene(memory.id, { crop: { min: [0, 0, 0], max: [0, 1, 1] } })).rejects.toThrow(/crop/)
    expect(useWorld.getState().nodes.get(memory.id)?.splat?.upFix).toEqual([0, 0, 0, 1])
  })

  it('detachScene clears node.splat and deletes the blobs', async () => {
    await attachScene(memory.id, draft(), assets(1))
    const rec = await detachScene(memory.id)
    expect(rec.splat).toBeUndefined()
    expect(useWorld.getState().nodes.get(memory.id)?.splat).toBeUndefined()
    expect(await splatAssets(memory.id)).toEqual([])
  })
})
