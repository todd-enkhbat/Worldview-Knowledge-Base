import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { useApp, useWorld } from '../../src/app/store.ts'
import { IMPORT_MARKER_KV, blobSink, readArchive } from '../../src/data/archive.ts'
import { BACKUP_DB_NAME, defaultBackupTarget, idbBackupTarget, readAnyBackup } from '../../src/data/backupTargets.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import {
  closeRepo,
  completeFirstRun,
  createNode,
  exportWorld,
  importWorld,
  initRepo,
  recoverInterruptedImport,
  useRepoStatus,
} from '../../src/data/repo.ts'

const T0 = Date.UTC(1990, 4, 17)

afterEach(async () => {
  await closeRepo()
  indexedDB.deleteDatabase(BACKUP_DB_NAME)
})

describe('IndexedDB pre-import backups (no writable OPFS, e.g. older Safari)', () => {
  it('stores, prunes newest-first and reads back', async () => {
    let t = 0
    const target = idbBackupTarget({ dbName: 'bt-unit', now: () => ++t })
    for (const name of ['b1', 'b2', 'b3', 'b4']) {
      await target.write(name, async (sink) => {
        await sink.write(new TextEncoder().encode(name))
        await sink.close()
      })
    }
    await target.prune(3)
    expect(await target.read!('b1')).toBeUndefined()
    expect(await (await target.read!('b4'))!.text()).toBe('b4')
    expect(await readAnyBackup('b3', 'bt-unit')).toBeInstanceOf(Blob)
  })

  it('is the default target here, so importWorld takes its backup without being told, and an interrupted import can be recovered from it', async () => {
    expect(await defaultBackupTarget()).not.toBeNull()
    useWorld.getState().hydrate(null, [])
    useApp.setState({ toasts: [], selectedId: null })
    const store = createMemoryStore()
    await initRepo({ store })
    await completeFirstRun({ T0, start: 'empty' })
    await createNode({ archetype: 'idea', title: 'Before import' })
    const sink = blobSink()
    await exportWorld(sink, { markBackup: false })
    const archive = sink.blob()

    const result = await importWorld(archive)
    expect(result.backupName).toMatch(/^pre-import-/)
    const backup = await readAnyBackup(result.backupName!)
    expect((await readArchive(backup!)).nodes.map((n) => n.title)).toEqual(['Before import'])

    // Simulate a tab that died mid-import: partial world plus the marker.
    await store.wipe()
    await store.putKv(IMPORT_MARKER_KV, { backupName: result.backupName, startedAt: 1 })
    await closeRepo()
    await initRepo({ store })
    expect(useRepoStatus.getState().interruptedImport?.backupName).toBe(result.backupName)
    expect(await recoverInterruptedImport()).toBe(true)
    expect([...useWorld.getState().nodes.values()].map((n) => n.title)).toEqual(['Before import'])
    expect(useRepoStatus.getState()).toMatchObject({ interruptedImport: null, error: null })
  })
})
