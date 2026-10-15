import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { bytesSink, exportArchive, importArchive } from '../../src/data/archive.ts'
import type { BackupTarget } from '../../src/data/archive.ts'
import { hashBytes, hashRecords } from '../../src/data/hash.ts'
import { openIdbStore } from '../../src/data/idbStore.ts'
import { buildDemoWorld } from '../../src/data/seed/demo.ts'
import { SCHEMA_VERSION } from '../../src/domain/types.ts'

const T0 = Date.UTC(1990, 4, 17)
const NOW = Date.UTC(2026, 9, 14)

const noopBackup: BackupTarget = {
  async write(_name, fill) {
    await fill(bytesSink())
  },
  async prune() {},
}

describe('archive against the IndexedDB store', () => {
  it('round-trips the demo world and a blob through idbStore (IDB blob backend)', async () => {
    const source = await openIdbStore({ name: `archive-src-${crypto.randomUUID()}`, opfsRoot: null })
    const records = buildDemoWorld(T0, NOW)
    await source.putSettings({
      T0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 1, qualityTier: 'auto', firstRunComplete: true,
      lastBackupAt: null, autoBackupEnabled: false, createdAt: NOW, schemaVersion: SCHEMA_VERSION,
    })
    await source.putNodes(records)
    const bytes = crypto.getRandomValues(new Uint8Array(60_000))
    await source.putBlob({ meta: { id: 'a1', kind: 'image', mime: 'image/png', bytes: bytes.length, createdAt: NOW, nodeId: records[0].id }, data: bytes })
    const sink = bytesSink()
    await exportArchive(source, sink, { now: NOW })

    const target = await openIdbStore({ name: `archive-dst-${crypto.randomUUID()}`, opfsRoot: null })
    await importArchive(target, new Blob([sink.bytes() as Uint8Array<ArrayBuffer>]), { backup: noopBackup, now: NOW })
    expect(await hashRecords(await target.listNodes())).toBe(await hashRecords(records))
    expect(await target.getSettings()).toEqual(await source.getSettings())
    expect(await hashBytes((await target.getBlob('a1'))!)).toBe(await hashBytes(bytes))
    source.close()
    target.close()
  })
})
