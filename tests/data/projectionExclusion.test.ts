import { afterEach, expect, it } from 'vitest'
import { useWorld } from '../../src/app/store.ts'
import { closeRepo, completeFirstRun, createNode, getStore, initRepo, rehydrate, updateNode } from '../../src/data/repo.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { semanticAllowedNodeIds } from '../../src/ai/semanticPolicy.ts'

afterEach(async () => { await closeRepo(); useWorld.getState().hydrate(null, []) })

it('hides an excluded projection without treating it as deleted and restores its original identity/pin', async () => {
  await initRepo({ store: createMemoryStore() })
  await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  const record = await createNode({ archetype: 'idea', title: 'Retained private source', contentMd: 'Original wording', fieldAnchorXZ: [12, 23] })
  await updateNode(record.id, { corpusExcluded: true }, { keepAnchor: true })
  expect(useWorld.getState().nodes.has(record.id)).toBe(false)
  expect(useWorld.getState().trash.has(record.id)).toBe(false)
  expect(useWorld.getState().excluded.get(record.id)?.deletedAt).toBeNull()
  expect((await getStore().getNode(record.id))?.contentMd).toBe('Original wording')
  await rehydrate()
  expect(useWorld.getState().excluded.has(record.id)).toBe(true)
  await updateNode(record.id, { corpusExcluded: false }, { keepAnchor: true })
  expect(useWorld.getState().nodes.get(record.id)?.fieldAnchorXZ).toEqual([12, 23])
  expect(useWorld.getState().excluded.size).toBe(0)
})

it('applies AI exclusions before local semantic indexing and keeps ordinary records eligible', async () => {
  await initRepo({ store: createMemoryStore() })
  await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  const a = await createNode({ archetype: 'idea', title: 'AI permitted' })
  const b = await createNode({ archetype: 'idea', title: 'AI excluded' })
  const c = await createNode({ archetype: 'idea', title: 'Corpus excluded' })
  expect([...semanticAllowedNodeIds([a, b, { ...c, corpusExcluded: true }], [{ nodeId: b.id, aiAllowed: false }])]).toEqual([a.id])
})
