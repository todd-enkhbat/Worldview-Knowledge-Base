import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { useWorld } from '../../src/app/store.ts'
import { eligibleSemanticPassages, mergePassageRanks, pruneCorpusSemantic, searchCorpusSemantic } from '../../src/ai/corpusSemantic.ts'
import { closeRepo, completeFirstRun, createNode, initRepo } from '../../src/data/repo.ts'
import { openIdbStore } from '../../src/data/idbStore.ts'
import { localVectorStore } from '../../src/ai/vectorStore.ts'
import { EMBED_DIM } from '../../src/ai/embedText.ts'
import { useSemantic } from '../../src/ai/semanticIndex.ts'
import type { KnowledgeSnapshot, SearchHit } from '../../src/knowledge/types.ts'

afterEach(async () => { await closeRepo(); useWorld.getState().hydrate(null, []) })

function snapshot(): KnowledgeSnapshot {
  const text = 'The lighthouse budget supports a November launch.'
  return {
    schemaVersion: 1, revision: 1, imports: [], proposals: [], jobs: [],
    sources: [{ id: 'source', externalId: 'id', title: 'Lighthouse', kind: 'document', currentVersionId: 'version', createdAt: 1, updatedAt: 1, excluded: false, aiAllowed: true, tags: [] }],
    versions: [{ id: 'version', sourceId: 'source', contentHash: 'hash', text, createdAt: 1, authoredAt: 42, originalBlobId: 'original', originalName: 'note.md', origin: 'import' }],
    passages: [{ id: 'passage', sourceId: 'source', versionId: 'version', text, title: 'Lighthouse', start: 0, end: text.length, role: 'human', authoredAt: 42 }],
  }
}

it('applies source, version, attribution and date policy before any local model sees passages', () => {
  const corpus = snapshot()
  expect(eligibleSemanticPassages(corpus, { role: 'human', kinds: ['document'], authoredAfter: 42, authoredBefore: 42 })).toHaveLength(1)
  expect(eligibleSemanticPassages(corpus, { role: 'assistant' })).toEqual([])
  expect(eligibleSemanticPassages(corpus, { kinds: ['thought'] })).toEqual([])
  expect(eligibleSemanticPassages(corpus, { sourceIds: [] })).toEqual([])
  expect(eligibleSemanticPassages(corpus, { authoredBefore: 41 })).toEqual([])
  corpus.sources[0].aiAllowed = false
  expect(eligibleSemanticPassages(corpus)).toEqual([])
  corpus.sources[0].aiAllowed = true
  corpus.passages[0].text = 'An invented quotation'
  expect(eligibleSemanticPassages(corpus)).toEqual([])
})

it('fuses keyword precision and semantic recall without duplicate evidence', () => {
  const first = { ...snapshot().passages[0], score: 10 } satisfies SearchHit
  const second = { ...first, id: 'second', text: 'Related phrasing', score: 0.9 }
  const merged = mergePassageRanks([first], [second, first])
  expect(merged.map((hit) => hit.id)).toEqual(['passage', 'second'])
  expect(mergePassageRanks([first], [])).toEqual([first])
})

it('keeps semantic search off without the explicit model opt-in/readiness', async () => {
  expect(await searchCorpusSemantic('launch', snapshot())).toEqual([])
})

it('removes revoked persisted embeddings without loading an inference model', async () => {
  await initRepo({ store: await openIdbStore({ name: `semantic-prune-${crypto.randomUUID()}`, opfsRoot: null }) })
  await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  const node = await createNode({ archetype: 'idea', title: 'Private budget' })
  const settings = useWorld.getState().settings!
  const base = `worldview-passage-vectors:idb:local:${settings.createdAt}:${settings.physicsSeed}:`
  const gpu = localVectorStore(`${base}webgpu/q4`)
  const wasm = localVectorStore(`${base}wasm/q8`)
  const nodeVectors = localVectorStore()
  const vector = new Float32Array(EMBED_DIM)
  await Promise.all([gpu.put('passage', vector, 'hash'), wasm.put('passage', vector, 'hash'), nodeVectors.put(node.id, vector, 'hash')])
  const corpus = snapshot()
  corpus.sources[0].nodeId = node.id
  corpus.sources[0].aiAllowed = false
  expect(useSemantic.getState().phase).toBe('off')
  await pruneCorpusSemantic(corpus)
  expect(await gpu.meta()).toEqual([])
  expect(await wasm.meta()).toEqual([])
  expect((await nodeVectors.meta()).some((meta) => meta.id === node.id)).toBe(false)
  expect(useSemantic.getState().phase).toBe('off')
})
