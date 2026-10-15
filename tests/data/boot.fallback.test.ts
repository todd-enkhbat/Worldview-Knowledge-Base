import { afterEach, describe, expect, it } from 'vitest'
// No fake-indexeddb here on purpose: IndexedDB is missing, so the repo falls back to memory.
import { bootData } from '../../src/app/boot.ts'
import { closeRepo, completeFirstRun, useRepoStatus } from '../../src/data/repo.ts'
import { WRITER_LOCK_NAME, resetWriterLock } from '../../src/data/locks.ts'

afterEach(async () => {
  await closeRepo()
  resetWriterLock()
  globalThis.__wv = undefined
})

describe('boot without IndexedDB', () => {
  it('falls back to a tab-private memory world that is writable even while another tab holds the writer lock', async () => {
    expect(typeof indexedDB).toBe('undefined')
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let acquired!: () => void
    const isHeld = new Promise<void>((r) => (acquired = r))
    // Another tab of the same origin is the writer of the shared (IndexedDB) world.
    const other = navigator.locks.request(WRITER_LOCK_NAME, async () => {
      acquired()
      await held
    })
    await isHeld

    const [a, b] = await Promise.all([bootData(), bootData()])
    expect(a).toBe(b)
    expect(a).toMatchObject({ ready: true, fallback: true, writer: true })
    expect(useRepoStatus.getState().error).toMatch(/lost on reload/)
    expect(typeof globalThis.__wv?.exportArchive).toBe('function')
    await expect(completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })).resolves.toMatchObject({ firstRunComplete: true })

    release()
    await other
  })
})
