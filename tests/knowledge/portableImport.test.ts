import { afterEach, beforeEach, expect, it } from 'vitest'
import { useWorld } from '../../src/app/store.ts'
import { closeRepo, completeFirstRun, getStore, initRepo, unlink, updateNode } from '../../src/data/repo.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { importKnowledgeFiles, initializeKnowledge, readKnowledgePassage, resetKnowledge, setSourcePolicy, useKnowledge } from '../../src/knowledge/index.ts'
import { portableKnowledge, type PortableKnowledge } from '../../src/knowledge/portability.ts'
import { COLLECTIONS_KV, initializeCollections, useCollections, type SavedInvestigation } from '../../src/workspace/collections.ts'

async function fresh() { resetKnowledge(); await closeRepo(); await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' }); await initializeKnowledge(); await initializeCollections() }
beforeEach(fresh)
afterEach(async () => { resetKnowledge(); await closeRepo() })
const textFile = (path: string, text: string) => new File([text], path, { type: 'text/markdown' })
const portableFile = (value: PortableKnowledge) => new File([JSON.stringify(value)], 'worldview-sources.json', { type: 'application/json' })

it('imports the exact source, version, passage, policy and collection identities into a fresh corpus and remains idempotent', async () => {
  await importKnowledgeFiles([textFile('Lighthouse.md', 'Earlier reserve: twelve hours.')])
  await importKnowledgeFiles([textFile('Lighthouse.md', 'Current reserve: eighteen hours. 😀')])
  const source = useKnowledge.getState().sources[0]
  await setSourcePolicy(source.id, { aiAllowed: false })
  const collection: SavedInvestigation = { id: crypto.randomUUID(), title: 'Reserve audit', sourceIds: [source.id], query: 'reserve', role: 'all', sourceKind: 'all', authoredAfter: '', authoredBefore: '', questions: ['What changed?'], updatedAt: 2 }
  const portable = portableKnowledge(useKnowledge.getState(), [collection], { includeHistory: true })
  const evidenceIds = portable.sources[0].passages.map((passage) => passage.id)
  await fresh()
  expect(await importKnowledgeFiles([portableFile(portable)])).toMatchObject({ status: 'complete', saved: 1 })
  expect(useKnowledge.getState().sources[0]).toMatchObject({ id: source.id, nodeId: source.nodeId, currentVersionId: source.currentVersionId, aiAllowed: false, createdAt: source.createdAt })
  expect(useKnowledge.getState().versions.map((version) => version.id)).toEqual(portable.sources[0].versions.map((version) => version.id))
  expect(useKnowledge.getState().passages.map((passage) => passage.id)).toEqual(evidenceIds)
  for (const passage of portable.sources[0].passages) expect(await readKnowledgePassage(passage.id, { includeHistory: true })).toMatchObject({ text: passage.text, role: passage.role, start: passage.start, end: passage.end })
  expect(useCollections.getState().collections).toEqual([collection])
  expect(await getStore().getKv(COLLECTIONS_KV)).toMatchObject({ collections: [collection] })
  expect(await importKnowledgeFiles([portableFile(portable)])).toMatchObject({ status: 'complete', unchanged: 1 })
  expect(useKnowledge.getState().versions).toHaveLength(2)
  expect(useWorld.getState().nodes.size).toBe(1)
  expect(useKnowledge.getState().versions.every((version) => version.metadata?.portableIdentity === undefined && version.metadata?.portablePassages === undefined && version.metadata?.portableInvestigations === undefined)).toBe(true)
})

it('refuses source UUID collisions before any source from the portable batch is written', async () => {
  await importKnowledgeFiles([textFile('Existing.md', 'The existing record survives.')])
  const portable = portableKnowledge(useKnowledge.getState(), [])
  portable.sources[0].source.externalId = 'document:Different.md'
  portable.sources[0].source.nodeId = crypto.randomUUID()
  for (const passage of portable.sources[0].passages) passage.nodeId = portable.sources[0].source.nodeId
  const before = useKnowledge.getState().versions.map((version) => version.id)
  const result = await importKnowledgeFiles([portableFile(portable)])
  expect(result.status).toBe('failed')
  expect(result.errors.join(' ')).toContain('UUID')
  expect(useKnowledge.getState().sources).toHaveLength(1)
  expect(useKnowledge.getState().versions.map((version) => version.id)).toEqual(before)
})

it('creates explicit vault links, tracks manual removals, and preserves pinned coordinates and birth dates through updates', async () => {
  const files = [textFile('Read.md', 'Read [[Work/Plan#Budget|the plan]] and [[Missing]].'), textFile('Work/Plan.md', '# Budget\nThe reserve is eighteen hours.')]
  expect((await importKnowledgeFiles(files)).status).toBe('complete')
  const reader = useKnowledge.getState().sources.find((source) => source.title === 'Read')!
  const plan = useKnowledge.getState().sources.find((source) => source.externalId.endsWith('Work/Plan.md'))!
  expect(useWorld.getState().nodes.get(reader.nodeId!)?.links).toContainEqual(expect.objectContaining({ targetId: plan.nodeId }))
  await updateNode(reader.nodeId!, { fieldAnchorXZ: [34, -19] }, { keepAnchor: true })
  const pin = useWorld.getState().nodes.get(reader.nodeId!)!
  await unlink(reader.nodeId!, plan.nodeId!)
  await importKnowledgeFiles([textFile('Read.md', 'Updated [[Work/Plan#Budget|the plan]].')])
  const after = useWorld.getState().nodes.get(reader.nodeId!)!
  expect(after.links).toEqual([])
  expect(after.fieldAnchorXZ).toEqual(pin.fieldAnchorXZ)
  expect(after.anchorXZ).toEqual(pin.anchorXZ)
  expect(after.temporalOrigin).toBe(pin.temporalOrigin)
  expect(after.createdAt).toBe(pin.createdAt)
  expect(useKnowledge.getState().sources.find((source) => source.id === reader.id)?.vaultGraph?.suppressedTargets).toContain(plan.id)
})
