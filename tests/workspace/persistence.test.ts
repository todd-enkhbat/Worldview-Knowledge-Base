// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bytesSink, exportArchive } from '../../src/data/archive.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, getStore, handleRemoteChange, importWorld, initRepo, wipeWorld } from '../../src/data/repo.ts'
import { flushWorkspacePersistence, initializeWorkspacePersistence, WORKSPACE_KV } from '../../src/workspace/persistence.ts'
import { restoreWorkspaceContext, setWorkspaceQuery, setWorkspaceSources, useWorkspace } from '../../src/workspace/state.ts'

beforeEach(() => { vi.stubGlobal('Blob', NodeBlob); localStorage.clear(); restoreWorkspaceContext('test-setup') })
afterEach(async () => { await closeRepo(); vi.unstubAllGlobals() })

async function open(store = createMemoryStore()) {
  await initRepo({ store })
  await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  return store
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

async function contextArchive(store: ReturnType<typeof createMemoryStore>) {
  const archived = createMemoryStore()
  await archived.putSettings((await store.getSettings())!)
  await archived.putKv(WORKSPACE_KV, { schemaVersion: 1, context: { query: 'Restored research', sourceIds: ['archived-source'], selectedPassageId: 'archived-passage', lastSection: 'library', readerPositions: { 'archived-passage': 612 }, role: 'human', authoredAfter: '2026-01-01' } })
  const sink = bytesSink()
  await exportArchive(archived, sink)
  return new NodeBlob([sink.bytes().slice()])
}

describe('durable investigation context', () => {
  it('restores a validated backup context on a fresh device and queues changes before later exports', async () => {
    const store = await open()
    await store.putKv(WORKSPACE_KV, { schemaVersion: 1, context: { query: 'Why did we choose this?', sourceIds: ['one'], lastSection: 'library', selectedPassageId: 'quote', readerPositions: { quote: 320 }, returnHash: 'https://example.com/untrusted' } })
    await initializeWorkspacePersistence('fresh-device')
    expect(useWorkspace.getState()).toMatchObject({ query: 'Why did we choose this?', sourceIds: ['one'], lastSection: 'library', selectedPassageId: 'quote', readerPositions: { quote: 320 }, returnHash: '#/today' })
    setWorkspaceQuery('A refined research question')
    setWorkspaceSources(['one', 'two'])
    await flushWorkspacePersistence()
    const saved = await getStore().getKv<{ context: unknown }>(WORKSPACE_KV)
    expect(saved?.context).toMatchObject({ query: 'A refined research question', sourceIds: ['one', 'two'] })
  })

  it('keeps existing device context and ignores a different device’s context update', async () => {
    const store = await open()
    restoreWorkspaceContext('existing-device')
    setWorkspaceQuery('Keep my current investigation')
    await store.putKv(WORKSPACE_KV, { schemaVersion: 1, context: { query: 'An old archived investigation' } })
    await initializeWorkspacePersistence('existing-device')
    expect(useWorkspace.getState().query).toBe('Keep my current investigation')
    await store.putKv(WORKSPACE_KV, { schemaVersion: 1, context: { query: 'Another device’s question' } })
    await handleRemoteChange({ type: 'kv', keys: [WORKSPACE_KV] })
    expect(useWorkspace.getState().query).toBe('Keep my current investigation')
    await handleRemoteChange({ type: 'import' })
    expect(useWorkspace.getState().query).toBe('Keep my current investigation')
  })

  it('adopts an explicitly restored archive on the same device and discards writes queued during replacement', async () => {
    const store = await open()
    restoreWorkspaceContext('same-device')
    setWorkspaceQuery('Existing device question')
    await initializeWorkspacePersistence('same-device')
    await flushWorkspacePersistence()
    const archive = await contextArchive(store)
    const reset = store.resetWithKv.bind(store)
    const entered = deferred<void>()
    const gate = deferred<void>()
    store.resetWithKv = async (...args) => { entered.resolve(); await gate.promise; await reset(...args) }
    const replacing = importWorld(archive, { allowWithoutBackup: true })
    await entered.promise
    setWorkspaceQuery('Old query queued while restore was running')
    gate.resolve()
    await replacing
    await vi.waitFor(() => expect(useWorkspace.getState().query).toBe('Restored research'))
    await flushWorkspacePersistence()
    expect(useWorkspace.getState()).toMatchObject({ sourceIds: ['archived-source'], selectedPassageId: 'archived-passage', readerPositions: { 'archived-passage': 612 }, role: 'human', authoredAfter: '2026-01-01' })
    expect(location.hash).toBe('#/library?passage=archived-passage')
    expect(await store.getKv(WORKSPACE_KV)).toMatchObject({ context: { query: 'Restored research' } })
    expect(JSON.parse(localStorage.getItem('worldview.workspace.v1:same-device')!)).toMatchObject({ query: 'Restored research' })
  })

  it('does not let an initial delayed load overwrite an explicit archive restoration', async () => {
    const store = await open()
    const archive = await contextArchive(store)
    const get = store.getKv.bind(store)
    const staleRead = deferred<unknown>()
    let firstRead = true
    store.getKv = async <T,>(key: string): Promise<T | undefined> => {
      if (key === WORKSPACE_KV && firstRead) { firstRead = false; return await staleRead.promise as T }
      return get<T>(key)
    }
    const startup = initializeWorkspacePersistence('fresh-racing-device')
    await importWorld(archive, { allowWithoutBackup: true })
    await vi.waitFor(() => expect(useWorkspace.getState().query).toBe('Restored research'))
    staleRead.resolve({ schemaVersion: 1, context: { query: 'Stale startup snapshot' } })
    await startup
    await flushWorkspacePersistence()
    expect(useWorkspace.getState().query).toBe('Restored research')
    expect(await store.getKv(WORKSPACE_KV)).toMatchObject({ context: { query: 'Restored research' } })
  })

  it('clears context on wipe and resumes persistence after a new first run', async () => {
    const store = await open()
    await initializeWorkspacePersistence('wipe-device')
    setWorkspaceQuery('Private old question')
    await flushWorkspacePersistence()
    await wipeWorld({ confirm: true })
    expect(useWorkspace.getState()).toMatchObject({ query: '', sourceIds: [], readerPositions: {}, selectedPassageId: null })
    expect(await store.getKv(WORKSPACE_KV)).toBeUndefined()
    await completeFirstRun({ T0: Date.UTC(2000, 0, 1), start: 'empty' })
    setWorkspaceQuery('New world investigation')
    await flushWorkspacePersistence()
    expect(await store.getKv(WORKSPACE_KV)).toMatchObject({ context: { query: 'New world investigation' } })
  })

  it('does not apply an old account’s delayed read after the repository changes', async () => {
    const oldStore = await open()
    const get = oldStore.getKv.bind(oldStore)
    let resolveRead: (value: unknown) => void = () => {}
    oldStore.getKv = async <T,>(key: string): Promise<T | undefined> => key === WORKSPACE_KV ? await new Promise<unknown>((resolve) => { resolveRead = resolve }) as T : get<T>(key)
    const oldLoad = initializeWorkspacePersistence('old-account')
    await closeRepo()
    const newStore = await open()
    await newStore.putKv(WORKSPACE_KV, { schemaVersion: 1, context: { query: 'New account context' } })
    await initializeWorkspacePersistence('new-account')
    resolveRead({ schemaVersion: 1, context: { query: 'Old account secret' } })
    await oldLoad
    await flushWorkspacePersistence()
    expect(useWorkspace.getState().query).toBe('New account context')
    expect(await newStore.getKv(WORKSPACE_KV)).toMatchObject({ context: { query: 'New account context' } })
  })
})
