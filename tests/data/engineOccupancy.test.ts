import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { adoptServerDefault, hasWorldData } from '../../src/data/engine.ts'
import { DB_NAME, openIdbStore } from '../../src/data/idbStore.ts'

afterEach(async () => {
  vi.unstubAllGlobals()
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(DB_NAME); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error) })
})

it('counts unfinished ingestion, conversations, original-only and event-only workspaces as occupied', async () => {
  for (const key of ['knowledge.v1', 'chat.v1', 'workspace.v1', 'collections.v1']) {
    const store = createMemoryStore()
    expect(await hasWorldData(store)).toBe(false)
    await store.putKv(key, { retained: true })
    expect(await hasWorldData(store)).toBe(true)
  }
  const originals = createMemoryStore()
  await originals.putBlob({ meta: { id: 'only-original', kind: 'file', mime: 'application/pdf', bytes: 3, createdAt: 1, nodeId: null }, data: new Uint8Array([1, 2, 3]) })
  expect(await hasWorldData(originals)).toBe(true)
  const events = createMemoryStore()
  await events.appendEvent({ id: 'retained-event', kind: 'inspect', nodeId: 'previous-record', t: 1 })
  expect(await hasWorldData(events)).toBe(true)
})

it('never silently adopts the server over a browser ledger that has no settings or nodes yet', async () => {
  const preferences = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => preferences.get(key) ?? null, setItem: (key: string, value: string) => preferences.set(key, value), removeItem: (key: string) => preferences.delete(key) })
  const store = await openIdbStore({ opfsRoot: null })
  await store.putKv('knowledge.v1', { revision: 1, imports: [{ status: 'partial', original: 'retained' }] })
  store.close()
  expect(await adoptServerDefault({ engine: 'sqlite', ok: true, embeddingDim: 512, refine: false })).toBe('idb')
  expect(preferences.has('hyperspace.engine')).toBe(false)
})
