// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { bytesSink, exportArchive, importArchive } from '../../src/data/archive.ts'
import { closeRepo, completeFirstRun, initRepo, useRepoStatus } from '../../src/data/repo.ts'
import { addInvestigationQuestion, archiveInvestigation, COLLECTIONS_KV, initializeCollections, openInvestigation, removeInvestigationQuestion, renameInvestigation, saveInvestigation, updateInvestigationContext, useCollections, type CollectionsSnapshot } from '../../src/workspace/collections.ts'
import { restoreWorkspaceContext, useWorkspace } from '../../src/workspace/state.ts'

beforeEach(async () => {
  vi.stubGlobal('Blob', NodeBlob)
  localStorage.clear(); restoreWorkspaceContext('collection-test')
})
afterEach(async () => { await closeRepo(); vi.unstubAllGlobals() })
async function open(store = createMemoryStore()) {
  await initRepo({ store })
  await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  await initializeCollections()
  return store
}

describe('named investigations', () => {
  it('retains the exact question and source/date/author filters across reload and reopens them', async () => {
    const store = await open()
    useWorkspace.setState({ query: 'What changed in the storage decision?', sourceIds: ['source-a', 'source-b'], role: 'human', sourceKind: 'claude', authoredAfter: '2026-10-01', authoredBefore: '2026-11-22' })
    const saved = await saveInvestigation('Storage project')
    await closeRepo()
    await initRepo({ store })
    await initializeCollections()
    useWorkspace.setState({ query: '', sourceIds: [], role: 'all', sourceKind: 'all', authoredAfter: '', authoredBefore: '' })
    openInvestigation(saved.id)
    expect(useWorkspace.getState()).toMatchObject({ query: 'What changed in the storage decision?', sourceIds: ['source-a', 'source-b'], role: 'human', sourceKind: 'claude', authoredAfter: '2026-10-01', authoredBefore: '2026-11-22' })
    expect(location.hash).toBe('#/search')
  })

  it('edits open questions and supports recoverable archive/restore without changing the source scope', async () => {
    await open()
    useWorkspace.setState({ query: 'Original question', sourceIds: ['source'] })
    const saved = await saveInvestigation('Original name')
    await addInvestigationQuestion(saved.id, 'What remains unresolved?')
    await addInvestigationQuestion(saved.id, 'What remains unresolved?')
    await addInvestigationQuestion(saved.id, 'What evidence is missing?')
    await renameInvestigation(saved.id, 'Renamed project')
    await removeInvestigationQuestion(saved.id, 'What evidence is missing?')
    openInvestigation(saved.id, 'What remains unresolved?')
    expect(useWorkspace.getState().query).toBe('What remains unresolved?')
    await archiveInvestigation(saved.id)
    expect(() => openInvestigation(saved.id)).toThrow(/no longer available/)
    await archiveInvestigation(saved.id, false)
    expect(useCollections.getState().collections[0]).toMatchObject({ title: 'Renamed project', questions: ['What remains unresolved?'], sourceIds: ['source'], deletedAt: null })
    useWorkspace.setState({ query: 'Updated scope', sourceIds: ['another-source'] })
    await updateInvestigationContext(saved.id)
    expect(useCollections.getState().collections[0]).toMatchObject({ query: 'Updated scope', sourceIds: ['another-source'], questions: ['What remains unresolved?'] })
  })

  it('preserves a concurrent writer’s winning revision and reports a failed save honestly', async () => {
    const store = await open()
    const swap = store.compareAndSwapKv.bind(store)
    const winner: CollectionsSnapshot = { schemaVersion: 1, revision: 1, collections: [{ id: 'remote', title: 'Remote project', query: 'Winning question', sourceIds: [], role: 'all', sourceKind: 'all', authoredAfter: '', authoredBefore: '', questions: [], updatedAt: 1 }] }
    store.compareAndSwapKv = async (key, value, revision) => {
      if (key === COLLECTIONS_KV && revision === 0) { await store.putKv(COLLECTIONS_KV, winner); return false }
      return swap(key, value, revision)
    }
    await expect(saveInvestigation('Losing project')).rejects.toThrow(/no newer changes were overwritten/)
    expect(await store.getKv(COLLECTIONS_KV)).toEqual(winner)
    expect(useCollections.getState().collections.map((item) => item.title)).toEqual(['Remote project'])
    expect(useCollections.getState().error).toContain('no newer changes were overwritten')
  })

  it('refuses writes from a read-only workspace', async () => {
    const store = await open()
    useRepoStatus.setState({ writer: false })
    await expect(saveInvestigation('Must not save')).rejects.toThrow(/read only/)
    expect(await store.getKv(COLLECTIONS_KV)).toBeUndefined()
  })

  it('includes named context and open questions in the world archive', async () => {
    const store = await open()
    useWorkspace.setState({ query: 'Archive evidence', sourceIds: ['source-a'] })
    const item = await saveInvestigation('Recoverable project')
    await addInvestigationQuestion(item.id, 'Can I restore this on a fresh installation?')
    const sink = bytesSink()
    await exportArchive(store, sink)
    const restored = createMemoryStore()
    await importArchive(restored, new NodeBlob([sink.bytes().slice()]), { allowWithoutBackup: true })
    expect(await restored.getKv(COLLECTIONS_KV)).toEqual(await store.getKv(COLLECTIONS_KV))
  })
})
