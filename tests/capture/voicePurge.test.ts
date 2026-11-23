import { afterEach, expect, it } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, emptyTrash, getStore, initRepo, softDelete } from '../../src/data/repo.ts'
import { initializeKnowledge, ingestRetainedSource, resetKnowledge, syncKnowledgeNodes, useKnowledge } from '../../src/knowledge/index.ts'
import { captureVoiceOriginal, type VoiceSnapshot } from '../../src/capture/voiceInbox.ts'
import { useWorld } from '../../src/app/store.ts'
import { referencedWorldAssets } from '../../src/data/worldSnapshot.ts'

afterEach(async () => { resetKnowledge(); await closeRepo() })
it('atomically removes voice receipts with a permanently deleted transcript before deleting original bytes', async () => {
  await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' }); await initializeKnowledge()
  const entry = await captureVoiceOriginal(new Blob(['synthetic audio bytes'], { type: 'audio/wav' }), { name: 'synthetic.wav' })
  const source = await ingestRetainedSource({ externalId: `voice:${entry.hash}`, title: 'Synthetic voice', kind: 'conversation', text: 'Synthetic transcript.', authoredAt: null, messages: [{ text: 'Synthetic transcript.', start: 0, end: 21, role: 'human', authoredAt: null }] }, { originalBlobId: entry.blobId, originalName: entry.name })
  const voice = (await getStore().getKv<VoiceSnapshot>('voiceInbox.v1'))!; voice.entries[0].sourceId = source.id; voice.entries[0].status = 'ready'; voice.revision++; await getStore().putKv('voiceInbox.v1', voice)
  await softDelete(source.nodeId!); await emptyTrash({ confirm: true }); await syncKnowledgeNodes([...useWorld.getState().nodes.values()])
  expect((await getStore().getKv<VoiceSnapshot>('voiceInbox.v1'))?.entries).toEqual([])
  expect(useKnowledge.getState().sources).toEqual([])
  expect(await getStore().getBlob(entry.blobId)).toBeUndefined()
  expect(referencedWorldAssets({ settings: null, nodes: [], events: [], assets: [], kv: { 'voiceInbox.v1': await getStore().getKv('voiceInbox.v1') } })).toEqual(new Set())
})
