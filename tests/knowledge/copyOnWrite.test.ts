import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeRepo, completeFirstRun, getStore, initRepo } from '../../src/data/repo.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { captureThought, ingestRetainedSource, initializeKnowledge, resetKnowledge, useKnowledge, waitForKnowledgeJobs } from '../../src/knowledge/index.ts'

beforeEach(async () => {
  resetKnowledge()
  await initRepo({ store: createMemoryStore() })
  await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  await initializeKnowledge()
})
afterEach(async () => { resetKnowledge(); await closeRepo() })

it('retains identity of unchanged evidence across capture and projection commits', async () => {
  await captureThought('An existing astronomy observation has its own retained evidence.')
  await waitForKnowledgeJobs()
  const before = useKnowledge.getState()
  expect(Object.isFrozen(before.sources[0])).toBe(true)
  expect(Object.isFrozen(before.versions[0])).toBe(true)
  expect(Object.isFrozen(before.passages[0])).toBe(true)
  await captureThought('A new acoustic observation is captured and projected separately.')
  const after = useKnowledge.getState()
  expect(after.sources[0]).toBe(before.sources[0])
  expect(after.versions[0]).toBe(before.versions[0])
  expect(after.passages[0]).toBe(before.passages[0])
  expect(after.sources.at(-1)?.pendingProjection).toBe(false)
  expect(after.versions).toHaveLength(2)
  expect(after.passages).toHaveLength(2)
})

it('owns changed rows before freezing so caller metadata and returned handles remain writable and isolated', async () => {
  const bytes = new TextEncoder().encode('A source with caller-owned nested metadata.'), blobId = crypto.randomUUID()
  await getStore().putBlob({ meta: { id: blobId, kind: 'file', bytes: bytes.length, mime: 'text/plain', createdAt: Date.now(), nodeId: null }, data: bytes })
  const detail = { decision: 'original' }
  const source = await ingestRetainedSource({ externalId: 'test:cow-metadata', title: 'Metadata ownership', kind: 'document', text: new TextDecoder().decode(bytes), authoredAt: null, messages: [], metadata: { detail } }, { originalBlobId: blobId, originalName: 'metadata.txt' })
  expect(Object.isFrozen(detail)).toBe(false)
  expect(Object.isFrozen(source)).toBe(false)
  detail.decision = 'caller changed it'
  source.title = 'Caller changed the returned title'
  source.tags.push('caller-only')
  const state = useKnowledge.getState()
  expect(state.sources[0].title).toBe('Metadata ownership')
  expect(state.sources[0].tags).not.toContain('caller-only')
  expect(state.versions[0].metadata?.detail).toEqual({ decision: 'original' })
})
