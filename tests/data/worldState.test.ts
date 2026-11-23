import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { openIdbStore } from '../../src/data/idbStore.ts'
import { createHttpStore } from '../../src/data/httpStore.ts'
import { withSync, parseChange } from '../../src/data/locks.ts'
import { bytesSink, exportArchive, importArchive } from '../../src/data/archive.ts'
import type { WorldStore } from '../../src/data/WorldStore.ts'
import { startTestEngine } from '../helpers/engine.ts'

const opened: WorldStore[] = []
afterEach(() => { for (const store of opened.splice(0)) store.close() })
const adapters = [
  { name: 'memory', make: async () => createMemoryStore() },
  { name: 'IndexedDB', make: () => openIdbStore({ name: `cas-${crypto.randomUUID()}`, opfsRoot: null }) },
  { name: 'SQLite HTTP', make: async () => createHttpStore({ base: (await startTestEngine()).base }) },
]

describe.each(adapters)('Versioned world state: $name', ({ make }) => {
  it('admits only one concurrent writer for a revision and preserves the winner', async () => {
    const store = await make()
    opened.push(store)
    const attempts = await Promise.all([
      store.compareAndSwapKv('knowledge.v1', { revision: 1, value: 'first' }, 0),
      store.compareAndSwapKv('knowledge.v1', { revision: 1, value: 'second' }, 0),
    ])
    expect(attempts.filter(Boolean)).toHaveLength(1)
    const winner = await store.getKv<{ revision: number; value: string }>('knowledge.v1')
    expect(winner?.value).toBe(attempts[0] ? 'first' : 'second')
    expect(await store.compareAndSwapKv('knowledge.v1', { revision: 2, value: 'updated' }, 1)).toBe(true)
    expect(await store.compareAndSwapKv('knowledge.v1', { revision: 2, value: 'stale' }, 1)).toBe(false)
    expect(await store.getKv('knowledge.v1')).toEqual({ revision: 2, value: 'updated' })
  })

  it('rejects invalid revision jumps without committing them', async () => {
    const store = await make()
    opened.push(store)
    await expect(store.compareAndSwapKv('knowledge.v1', { revision: 9 }, 0)).rejects.toThrow(/revision/)
    expect(await store.getKv('knowledge.v1')).toBeUndefined()
  })

  it('commits a recovery marker in the same reset as clearing the old world', async () => {
    const store = await make()
    opened.push(store)
    await store.putKv('knowledge.v1', { revision: 1 })
    await store.putKv('device.preference', { retained: true })
    await store.resetWithKv('importInProgress', { backupName: 'verified-copy', startedAt: 1 }, ['device.preference'])
    expect(await store.getKv('importInProgress')).toEqual({ backupName: 'verified-copy', startedAt: 1 })
    expect(await store.getKv('device.preference')).toEqual({ retained: true })
    expect(await store.getKv('knowledge.v1')).toBeUndefined()
    expect(await store.getSettings()).toBeNull()
    expect(await store.listNodes()).toEqual([])
  })
})

it('announces only successful state commits and refuses a read-only mutation', async () => {
  const notices: unknown[] = []
  const inner = createMemoryStore()
  const store = withSync(inner, { canWrite: () => true, sync: { post: (change) => notices.push(change) } })
  expect(await store.compareAndSwapKv('knowledge.v1', { revision: 1 }, 0)).toBe(true)
  expect(await store.compareAndSwapKv('knowledge.v1', { revision: 1 }, 0)).toBe(false)
  expect(notices).toEqual([{ type: 'kv', keys: ['knowledge.v1'] }])
  const reader = withSync(inner, { canWrite: () => false })
  await expect(reader.compareAndSwapKv('knowledge.v1', { revision: 2 }, 1)).rejects.toThrow(/read-only/)
  expect(parseChange({ v: 1, change: { type: 'kv', keys: ['knowledge.v1'] } })).toEqual({ type: 'kv', keys: ['knowledge.v1'] })
  expect(parseChange({ v: 1, change: { type: 'kv', keys: 'bad' } })).toBeNull()
})

it('restores corpus versions, original bytes and workspace context through the existing archive', async () => {
  const source = createMemoryStore()
  const corpus = { revision: 1, sources: [{ id: 'source', currentVersionId: 'v2' }], versions: [{ id: 'v1', originalBlobId: 'original' }, { id: 'v2', previousVersionId: 'v1', originalBlobId: 'original' }] }
  await source.putKv('knowledge.v1', corpus)
  await source.putKv('workspace.v1', { query: 'late evidence', sourceIds: ['source'] })
  await source.putKv('chat.v1', { history: [{ role: 'user', content: 'Preserve this discussion' }], cards: { pending: [] } })
  await source.putBlob({ meta: { id: 'original', kind: 'text', bytes: 6, mime: 'application/octet-stream', createdAt: 1, nodeId: null }, data: new Uint8Array([0, 1, 2, 253, 254, 255]) })
  const sink = bytesSink()
  await exportArchive(source, sink)
  const restored = createMemoryStore()
  await importArchive(restored, new Blob([sink.bytes().slice()]), { allowWithoutBackup: true })
  expect(await restored.getKv('knowledge.v1')).toEqual(corpus)
  expect(await restored.getKv('workspace.v1')).toEqual(await source.getKv('workspace.v1'))
  expect(await restored.getKv('chat.v1')).toEqual(await source.getKv('chat.v1'))
  expect(new Uint8Array(await (await restored.getBlob('original'))!.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 253, 254, 255]))
})
