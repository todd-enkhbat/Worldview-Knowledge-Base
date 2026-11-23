import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, getStore, importWorld, initRepo } from '../../src/data/repo.ts'
import { blobSink, exportArchive } from '../../src/data/archive.ts'
import { captureThought, initializeKnowledge, resetKnowledge, searchKnowledge, setSourcePolicy, useKnowledge } from '../../src/knowledge/index.ts'
import { searchPassagesForModel } from '../../src/ai/chat/apply.ts'
import { useWorkspace } from '../../src/workspace/state.ts'

beforeEach(async () => {
  resetKnowledge()
  useWorkspace.setState({ retrievalEngine: 'local', sourceIds: [], role: 'all', sourceKind: 'all', authoredAfter: '', authoredBefore: '' })
  await initRepo({ store: createMemoryStore() })
  await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  await initializeKnowledge()
})
afterEach(async () => { vi.unstubAllGlobals(); resetKnowledge(); useWorkspace.setState({ retrievalEngine: 'local' }); await closeRepo() })

it('requires SQLite explicitly rather than searching a different local service world', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  await expect(searchKnowledge('aurora', { engine: 'qmd-hybrid' })).rejects.toThrow(/SQLite/)
  expect(fetcher).not.toHaveBeenCalled()
})

it('uses QMD for the companion while resolving text and policy against current authoritative passages', async () => {
  await captureThought('Project Aurora selected the copper orchard.')
  const passage = useKnowledge.getState().passages[0]
  getStore().info.kind = 'sqlite' // Exercise delivery with a native-service response and independent in-memory authority.
  const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify({ revision: useKnowledge.getState().revision, hits: [{ ...passage, text: 'forged native text', score: 0.8 }, { ...passage, id: 'invented', score: 1 }], mode: 'hybrid', engine: 'qmd', elapsedMs: 2 })))
  vi.stubGlobal('fetch', fetcher)
  useWorkspace.setState({ retrievalEngine: 'qmd-hybrid' })
  const hits = await searchPassagesForModel('aurora')
  expect(fetcher.mock.calls[0][0]).toBe('/api/qmd/search')
  expect(hits).toHaveLength(1)
  expect(hits[0].text).toBe(passage.text)
  expect(hits[0].text).not.toContain('forged')
  await setSourcePolicy(passage.sourceId, { aiAllowed: false })
  expect(await searchPassagesForModel('aurora')).toEqual([])
})

it('rechecks a permission revoked while the native query is in flight', async () => {
  await captureThought('Aurora budget is three hundred twelve dollars.')
  const passage = useKnowledge.getState().passages[0]
  getStore().info.kind = 'sqlite'
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const fetcher = vi.fn(async () => { await gate; return new Response(JSON.stringify({ revision: 0, hits: [{ ...passage, score: 1 }], elapsedMs: 2 })) })
  vi.stubGlobal('fetch', fetcher)
  const search = searchKnowledge('aurora', { engine: 'qmd-lexical' })
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalled())
  await setSourcePolicy(passage.sourceId, { aiAllowed: false })
  release()
  expect(await search).toEqual([])
})

it('discards an old query across a same-store restore even if the restored corpus has the same revision', async () => {
  await captureThought('Aurora old workspace evidence.')
  const passage = useKnowledge.getState().passages[0]
  const sink = blobSink(); await exportArchive(getStore(), sink)
  getStore().info.kind = 'sqlite'
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const fetcher = vi.fn(async () => { await gate; return new Response(JSON.stringify({ revision: useKnowledge.getState().revision, hits: [{ ...passage, score: 1 }], elapsedMs: 2 })) })
  vi.stubGlobal('fetch', fetcher)
  const search = searchKnowledge('aurora', { engine: 'qmd-lexical' })
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalled())
  getStore().info.kind = 'memory'
  await importWorld(sink.blob(), { allowWithoutBackup: true })
  release()
  expect(await search).toEqual([])
})
