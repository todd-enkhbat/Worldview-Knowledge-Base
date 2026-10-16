import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Regression tests for the data-layer review (docs/ARCHITECTURE.md § Data layer).
import { useApp, useWorld } from '../../src/app/store.ts'
import { IMPORT_MARKER_KV, blobSink, bytesSink, exportArchive, importArchive, readArchive, readImportMarker } from '../../src/data/archive.ts'
import type { BackupTarget } from '../../src/data/archive.ts'
import { createAutoBackup, writeAutoBackup } from '../../src/data/autoBackup.ts'
import type { WriterLock } from '../../src/data/locks.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import {
  closeRepo,
  completeFirstRun,
  createNode,
  dismissInterruptedImport,
  emptyTrash,
  handleRemoteChange,
  initRepo,
  moveAnchor,
  softDelete,
  updateNode,
  updateSettings,
  useRepoStatus,
} from '../../src/data/repo.ts'
import type { WorldStore } from '../../src/data/WorldStore.ts'
import { MS_PER_YEAR } from '../../src/domain/constants.ts'
import { SCHEMA_VERSION } from '../../src/domain/types.ts'
import type { AssetMeta, WorldSettings } from '../../src/domain/types.ts'

const T0 = Date.UTC(1990, 4, 17)
const NOW = Date.UTC(2026, 9, 14, 12)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const meta = (id: string, bytes: number): AssetMeta => ({ id, kind: 'image', mime: 'image/png', bytes, createdAt: NOW, nodeId: null })

function settings(): WorldSettings {
  return {
    T0,
    yPerYear: 12,
    stepsPerYear: 600,
    physicsSeed: 7,
    qualityTier: 'auto',
    firstRunComplete: true,
    lastBackupAt: null,
    autoBackupEnabled: true,
    createdAt: NOW,
    schemaVersion: SCHEMA_VERSION,
  }
}

async function storeWithAssets(n: number, size: number): Promise<WorldStore> {
  const store = createMemoryStore()
  await store.putSettings(settings())
  for (let i = 0; i < n; i++) await store.putBlob({ meta: meta(`a${i}`, size), data: new Uint8Array(size).fill(i + 1) })
  return store
}

function noReadBackup(): BackupTarget {
  return {
    async write(_name, fill) {
      await fill(blobSink())
    },
    async prune() {},
  }
}

beforeEach(() => {
  useWorld.getState().hydrate(null, [])
  useApp.setState({ toasts: [], selectedId: null })
})

afterEach(async () => {
  await closeRepo()
  vi.restoreAllMocks()
})

describe('export', () => {
  it('fetches asset bytes one at a time while writing, not all up front', async () => {
    const store = await storeWithAssets(3, 1 << 20)
    const sink = bytesSink()
    const writtenAtFetch: number[] = []
    const getBlob = store.getBlob.bind(store)
    vi.spyOn(store, 'getBlob').mockImplementation(async (id) => {
      writtenAtFetch.push(sink.written)
      return getBlob(id)
    })
    await exportArchive(store, sink, { now: NOW })
    expect(writtenAtFetch).toHaveLength(3)
    // Each fetch happens after the previous asset has been streamed to the sink.
    expect(writtenAtFetch[1]).toBeGreaterThan(writtenAtFetch[0] + (1 << 20))
    expect(writtenAtFetch[2]).toBeGreaterThan(writtenAtFetch[1] + (1 << 20))
  })

  it('keeps manifest counts consistent when a blob turns out missing mid-export', async () => {
    const store = await storeWithAssets(3, 1000)
    const getBlob = store.getBlob.bind(store)
    vi.spyOn(store, 'getBlob').mockImplementation(async (id) => (id === 'a1' ? undefined : getBlob(id)))
    const sink = blobSink()
    const result = await exportArchive(store, sink, { now: NOW })
    expect(result.missingAssets).toEqual(['a1'])
    expect(result.manifest.counts).toMatchObject({ assets: 2, assetBytes: 2000 })
    const parsed = await readArchive(sink.blob())
    expect(parsed.assets.map((a) => a.id)).toEqual(['a0', 'a2'])
  })
})

describe('interrupted import', () => {
  it('leaves a marker naming the backup when the write phase dies, and none after a clean import', async () => {
    const source = await storeWithAssets(2, 500)
    const sink = blobSink()
    await exportArchive(source, sink, { now: NOW })

    const target = createMemoryStore()
    vi.spyOn(target, 'putBlob').mockRejectedValueOnce(new Error('QuotaExceededError'))
    const err = await importArchive(target, sink.blob(), { backup: noReadBackup(), now: NOW }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'import-failed' })
    expect(await readImportMarker(target)).toEqual({ backupName: expect.stringMatching(/^pre-import-/), startedAt: NOW })

    vi.mocked(target.putBlob).mockRestore()
    await importArchive(target, sink.blob(), { backup: noReadBackup(), now: NOW })
    expect(await readImportMarker(target)).toBeNull()
  })

  it('is reported by initRepo and can be dismissed', async () => {
    const store = createMemoryStore()
    await store.putSettings(settings())
    await store.putKv(IMPORT_MARKER_KV, { backupName: 'pre-import-x.zip', startedAt: NOW })
    const status = await initRepo({ store, now: () => NOW })
    expect(status.interruptedImport).toEqual({ backupName: 'pre-import-x.zip', startedAt: NOW })
    expect(status.error).toMatch(/interrupted/)
    await dismissInterruptedImport()
    expect(await store.getKv(IMPORT_MARKER_KV)).toBeUndefined()
    expect(useRepoStatus.getState()).toMatchObject({ interruptedImport: null, error: null })
  })
})

describe('auto-backup', () => {
  it('removes the empty file a failed backup created, so pruning cannot count it', async () => {
    const files = new Map<string, Blob>()
    const dir = {
      async getFileHandle(name: string, o?: { create?: boolean }) {
        if (!files.has(name)) {
          if (!o?.create) throw new DOMException('missing', 'NotFoundError')
          files.set(name, new Blob([]))
        }
        return { createWritable: async () => new WritableStream<Uint8Array>() }
      },
      async removeEntry(name: string) {
        files.delete(name)
      },
    } as unknown as FileSystemDirectoryHandle
    const store = createMemoryStore()
    vi.spyOn(store, 'listNodes').mockRejectedValue(new Error('disk error'))
    await expect(writeAutoBackup(store, dir, NOW)).rejects.toThrow('disk error')
    expect([...files.keys()]).toEqual([])
  })

  it('runs each backup through the exclusive runner', async () => {
    let calls = 0
    const exclusive = <T,>(fn: () => Promise<T>): Promise<T> => {
      calls++
      return fn()
    }
    const ab = createAutoBackup({ store: createMemoryStore(), exclusive })
    await expect(ab.flush()).resolves.toEqual({ status: 'skipped', reason: 'no-settings' })
    expect(calls).toBe(1)
  })
})

describe('repo', () => {
  it('concurrent initRepo calls share one open', async () => {
    let resolveReady!: (v: boolean) => void
    const onChange = vi.fn(() => () => {})
    const lock: WriterLock = {
      isWriter: true,
      supported: true,
      ready: new Promise<boolean>((r) => (resolveReady = r)),
      onChange,
      release() {},
    }
    const store = createMemoryStore()
    const listNodes = vi.spyOn(store, 'listNodes')
    const both = Promise.all([initRepo({ store, lock }), initRepo({ store, lock })])
    resolveReady(true)
    const [a, b] = await both
    expect(a).toEqual(b)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(listNodes).toHaveBeenCalledTimes(1)
  })

  it('first run writes the settings row last, so a failure never leaves a finished first run behind', async () => {
    const store = createMemoryStore()
    await initRepo({ store, now: () => NOW })
    vi.spyOn(store, 'putSettings').mockRejectedValueOnce(new Error('quota'))
    await expect(completeFirstRun({ T0, start: 'demo' })).rejects.toThrow('quota')
    expect(await store.getSettings()).toBeNull()
    expect(await store.listNodes()).toEqual([])
    expect(useWorld.getState().nodes.size).toBe(0)

    vi.spyOn(store, 'putNodes').mockRejectedValueOnce(new Error('quota'))
    await expect(completeFirstRun({ T0, start: 'demo' })).rejects.toThrow('quota')
    expect(await store.getSettings()).toBeNull()

    await completeFirstRun({ T0, start: 'demo' })
    expect((await store.listNodes()).length).toBeGreaterThan(20)
  })

  it('applies remote changes in arrival order even when reads finish out of order', async () => {
    const store = createMemoryStore()
    await initRepo({ store, now: () => NOW })
    await completeFirstRun({ T0, start: 'empty' })
    const n = await createNode({ archetype: 'idea', title: 'v1' })

    const getNode = store.getNode.bind(store)
    let first = true
    vi.spyOn(store, 'getNode').mockImplementation(async (id) => {
      const v = await getNode(id)
      if (first) {
        first = false
        await sleep(20)
      }
      return v
    })
    const p1 = handleRemoteChange({ type: 'nodes', ids: [n.id] })
    await store.putNode({ ...n, title: 'v2' })
    const p2 = handleRemoteChange({ type: 'nodes', ids: [n.id] })
    await Promise.all([p1, p2])
    expect(useWorld.getState().nodes.get(n.id)?.title).toBe('v2')
  })

  it('a purge that fails part-way reloads the mirror from the store', async () => {
    const store = createMemoryStore()
    await initRepo({ store, now: () => NOW })
    await completeFirstRun({ T0, start: 'empty' })
    const a = await createNode({ archetype: 'idea', title: 'A' })
    const b = await createNode({ archetype: 'idea', title: 'B' })
    await softDelete(a.id)
    await softDelete(b.id)
    const deleteNode = store.deleteNode.bind(store)
    let calls = 0
    vi.spyOn(store, 'deleteNode').mockImplementation(async (id) => {
      if (++calls === 2) throw new Error('disk error')
      return deleteNode(id)
    })
    await expect(emptyTrash({ confirm: true })).rejects.toThrow('disk error')
    const stored = new Set((await store.listNodes()).map((r) => r.id))
    expect(stored.size).toBe(1)
    expect(new Set(useWorld.getState().trash.keys())).toEqual(stored)
  })

  it('refuses a yPerYear change that would bring anchors closer than σ', async () => {
    const store = createMemoryStore()
    await initRepo({ store, now: () => NOW })
    await completeFirstRun({ T0, start: 'empty' })
    const date = T0 + 20 * MS_PER_YEAR
    const a = await createNode({ archetype: 'idea', title: 'A', temporalOrigin: date })
    const b = await createNode({ archetype: 'idea', title: 'B', temporalOrigin: date + 0.3 * MS_PER_YEAR })
    // Same XZ, 3.6 u apart in Y at 12 u/year: legal.
    await moveAnchor(b.id, a.anchorXZ)
    await expect(updateSettings({ yPerYear: 6 })).rejects.toThrow(/closer than σ/)
    expect((await store.getSettings())?.yPerYear).toBe(12)
    await expect(updateSettings({ yPerYear: 13 })).resolves.toMatchObject({ yPerYear: 13 })
    // Ordinary edits are unaffected.
    await expect(updateNode(a.id, { title: 'A2' })).resolves.toMatchObject({ title: 'A2' })
  })
})
