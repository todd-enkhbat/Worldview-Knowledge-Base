import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installDevApi, registerDevApi } from '../../src/app/devApi.ts'
import { useApp, useWorld } from '../../src/app/store.ts'
import { blobSink } from '../../src/data/archive.ts'
import type { BackupTarget } from '../../src/data/archive.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { addAttachment, closeRepo, initRepo, logEvent, softDelete } from '../../src/data/repo.ts'

const T0 = Date.UTC(1990, 4, 17)

function memoryBackup(): BackupTarget & { names: string[] } {
  const names: string[] = []
  return {
    names,
    async write(name, fill) {
      await fill(blobSink())
      names.push(name)
    },
    async prune() {},
  }
}

beforeEach(async () => {
  useWorld.getState().hydrate(null, [])
  useApp.setState({ toasts: [], selectedId: null })
  await initRepo({ store: createMemoryStore() })
})

afterEach(async () => {
  await closeRepo()
  globalThis.__wv = undefined
})

describe('window.__wv (U0 harness)', () => {
  it('export → wipe → import leaves record hashes identical', async () => {
    const wv = installDevApi({ force: true })!
    expect(globalThis.__wv).toBe(wv)

    const added = await wv.seedDemo(T0)
    expect(added).toBeGreaterThanOrEqual(28)
    const [first, second] = wv.list()
    await addAttachment(first.id, new Blob(['a field note']), 'note.txt')
    await logEvent('inspect', first.id)
    await softDelete(second.id)

    const hash = await wv.recordHashes()
    const statsBefore = await wv.stats()
    expect(statsBefore).toMatchObject({ trash: 1, events: 1, assets: 1, live: added - 1 })
    expect(statsBefore.byArchetype.demon).toBe(2)

    const exported = await wv.exportArchive()
    expect(exported.recordsHash).toBe(hash)
    expect(exported.hash).toMatch(/^[0-9a-f]{64}$/)

    await wv.wipe()
    expect(wv.list()).toEqual([])
    expect((await wv.stats()).live).toBe(0)
    expect(wv.getState().world.settings).toBeNull()

    const backup = memoryBackup()
    const result = await wv.importArchive(exported.bytes, { backup })
    expect(result.nodes).toBe(added)
    expect(backup.names).toHaveLength(1)
    expect(await wv.recordHashes()).toBe(hash)
    expect(await wv.stats()).toEqual(statsBefore)
    expect(wv.getState().world.settings?.T0).toBe(T0)
    expect(wv.list().length).toBe(added - 1)
  })

  it('registerDevApi adds commands before or after install, but not over core ones', async () => {
    const flyIn = vi.fn()
    registerDevApi('flyIn', flyIn)
    const wv = installDevApi({ force: true })!
    expect(wv.flyIn).toBe(flyIn)
    const flyOut = vi.fn()
    registerDevApi('flyOut', flyOut)
    expect(globalThis.__wv?.flyOut).toBe(flyOut)
    expect(() => registerDevApi('wipe', vi.fn())).toThrow(/core/)
  })
})
