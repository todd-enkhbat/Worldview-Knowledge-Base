import { afterEach, describe, expect, it, vi } from 'vitest'
import { readArchive } from '../../src/data/archive.ts'
import {
  AUTO_BACKUP_KV,
  backupAgeDays,
  backupFileName,
  createAutoBackup,
  needsRegrant,
  pruneAutoBackups,
  shouldNag,
} from '../../src/data/autoBackup.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import type { WorldStore } from '../../src/data/WorldStore.ts'
import { SCHEMA_VERSION } from '../../src/domain/types.ts'
import type { WorldSettings } from '../../src/domain/types.ts'

const DAY = 86_400_000
const NOW = new Date(2026, 9, 14, 9, 5).getTime()

function settings(patch: Partial<WorldSettings> = {}): WorldSettings {
  return {
    T0: Date.UTC(1990, 0, 1),
    yPerYear: 12,
    stepsPerYear: 600,
    physicsSeed: 7,
    qualityTier: 'auto',
    firstRunComplete: true,
    lastBackupAt: null,
    autoBackupEnabled: true,
    createdAt: NOW - 10 * DAY,
    schemaVersion: SCHEMA_VERSION,
    ...patch,
  }
}

/** In-memory stand-in for a FileSystemDirectoryHandle from showDirectoryPicker. */
function fakeDir(permission: PermissionState = 'granted') {
  const files = new Map<string, Blob>()
  const dir = {
    kind: 'directory',
    name: 'backups',
    permission,
    files,
    async getFileHandle(name: string) {
      return {
        async createWritable() {
          const parts: Uint8Array[] = []
          return new WritableStream<Uint8Array>({
            write(c) {
              parts.push(c.slice())
            },
            close() {
              files.set(name, new Blob(parts as Uint8Array<ArrayBuffer>[]))
            },
          })
        },
      }
    },
    async *keys() {
      yield* [...files.keys()]
    },
    async removeEntry(name: string) {
      files.delete(name)
    },
    async queryPermission() {
      return dir.permission
    },
  }
  return dir
}

async function storeWithFolder(dir: ReturnType<typeof fakeDir>, s = settings()): Promise<WorldStore> {
  const store = createMemoryStore()
  await store.putSettings(s)
  // memoryStore structured-clones kv values, which would strip the methods of this fake.
  const getKv = store.getKv.bind(store)
  vi.spyOn(store, 'getKv').mockImplementation(async (key: string) => (key === AUTO_BACKUP_KV ? dir : getKv(key)) as never)
  return store
}

afterEach(() => {
  vi.useRealTimers()
})

describe('auto-backup', () => {
  it('debounces to 60 s after the last change, writes a dated zip and records lastBackupAt', async () => {
    vi.useFakeTimers({ now: NOW })
    const dir = fakeDir()
    const store = await storeWithFolder(dir)
    const onBackup = vi.fn()
    const ctl = createAutoBackup({ store, onBackup })

    ctl.notifyChange()
    await vi.advanceTimersByTimeAsync(30_000)
    ctl.notifyChange()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(dir.files.size).toBe(0)
    expect(ctl.pending).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(onBackup).toHaveBeenCalledTimes(1))

    const writtenAt = NOW + 90_000
    const name = backupFileName(writtenAt)
    expect(name).toBe('hyperspace-backup-2026-10-14-0906.zip')
    expect([...dir.files.keys()]).toEqual([name])
    const parsed = await readArchive(dir.files.get(name)!)
    expect(parsed.manifest.settings?.T0).toBe(Date.UTC(1990, 0, 1))
    expect((await store.getSettings())?.lastBackupAt).toBe(writtenAt)
    expect(onBackup.mock.calls[0][0].lastBackupAt).toBe(writtenAt)
  })

  it('runs at least every 10 minutes during continuous activity', async () => {
    vi.useFakeTimers({ now: NOW })
    const dir = fakeDir()
    const store = await storeWithFolder(dir)
    const ctl = createAutoBackup({ store })
    for (let t = 0; t < 11 * 60; t += 30) {
      ctl.notifyChange()
      await vi.advanceTimersByTimeAsync(30_000)
    }
    expect(dir.files.size).toBe(1)
    ctl.cancel()
  })

  it('skips when disabled, without a folder, or when the permission must be re-granted', async () => {
    const off = await storeWithFolder(fakeDir(), settings({ autoBackupEnabled: false }))
    expect(await createAutoBackup({ store: off }).flush()).toEqual({ status: 'skipped', reason: 'disabled' })

    const noFolder = createMemoryStore()
    await noFolder.putSettings(settings())
    expect(await createAutoBackup({ store: noFolder }).flush()).toEqual({ status: 'skipped', reason: 'no-folder' })
    expect(await needsRegrant(noFolder)).toBe(false)

    const prompt = fakeDir('prompt')
    const store = await storeWithFolder(prompt)
    expect(await needsRegrant(store)).toBe(true)
    expect(await createAutoBackup({ store }).flush()).toEqual({ status: 'skipped', reason: 'needs-regrant' })
    expect(prompt.files.size).toBe(0)
  })

  it('keeps only the newest 5 backups and ignores unrelated files', async () => {
    const dir = fakeDir()
    for (let i = 1; i <= 7; i++) dir.files.set(`hyperspace-backup-2026-10-0${i}-1200.zip`, new Blob([]))
    dir.files.set('notes.txt', new Blob([]))
    const removed = await pruneAutoBackups(dir as unknown as FileSystemDirectoryHandle, 5)
    expect(removed.sort()).toEqual(['hyperspace-backup-2026-10-01-1200.zip', 'hyperspace-backup-2026-10-02-1200.zip'])
    expect([...dir.files.keys()]).toHaveLength(6)
    expect(dir.files.has('notes.txt')).toBe(true)
  })

  it('backupAgeDays and shouldNag', () => {
    expect(backupAgeDays({ lastBackupAt: null }, NOW)).toBeNull()
    expect(backupAgeDays({ lastBackupAt: NOW - 2.5 * DAY }, NOW)).toBe(2)
    expect(shouldNag({ lastBackupAt: NOW - 2.9 * DAY, createdAt: 0 }, NOW)).toBe(false)
    expect(shouldNag({ lastBackupAt: NOW - 3 * DAY, createdAt: 0 }, NOW)).toBe(true)
    expect(shouldNag({ lastBackupAt: null, createdAt: NOW - DAY }, NOW)).toBe(false)
    expect(shouldNag({ lastBackupAt: null, createdAt: NOW - 4 * DAY }, NOW)).toBe(true)
  })
})
