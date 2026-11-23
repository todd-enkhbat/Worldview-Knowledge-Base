import { afterEach, expect, it } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, getStore, initRepo } from '../../src/data/repo.ts'
import { captureVoiceOriginal, initializeVoiceInbox, useVoiceInbox, type VoiceSnapshot } from '../../src/capture/voiceInbox.ts'

afterEach(async () => { await closeRepo() })
it('preserves a live server transcription and exposes retry after its lease expires', async () => {
  await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  const entry = await captureVoiceOriginal(new Blob(['voice bytes'], { type: 'audio/ogg' }), { name: 'telegram.ogg' })
  let snapshot = (await getStore().getKv<VoiceSnapshot>('voiceInbox.v1'))!
  snapshot.entries[0] = { ...snapshot.entries[0], externalId: 'telegram:bot:chat:1', status: 'transcribing', processor: 'telegram-server', processingUntil: Date.now() + 60_000 }; snapshot.revision++; await getStore().putKv('voiceInbox.v1', snapshot)
  await initializeVoiceInbox(); expect(useVoiceInbox.getState().entries[0].status).toBe('transcribing')
  snapshot = (await getStore().getKv<VoiceSnapshot>('voiceInbox.v1'))!; snapshot.entries[0].processingUntil = Date.now() - 1; snapshot.revision++; await getStore().putKv('voiceInbox.v1', snapshot)
  await initializeVoiceInbox(); expect(useVoiceInbox.getState().entries[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('interrupted') })
  expect(await getStore().getBlob(entry.blobId)).toBeDefined()
})
it('deduplicates original bytes while preserving independent manual and Telegram provenance', async () => {
  await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  const file = new Blob(['same audio bytes'], { type: 'audio/ogg' }), telegram = await captureVoiceOriginal(file, { name: 'forward.ogg', attribution: 'third-party' })
  const snapshot = (await getStore().getKv<VoiceSnapshot>('voiceInbox.v1'))!; snapshot.entries[0].externalId = 'telegram:bot:chat:1'; snapshot.revision++; await getStore().putKv('voiceInbox.v1', snapshot)
  const manual = await captureVoiceOriginal(file, { name: 'my-copy.ogg', attribution: 'human' })
  expect(manual.id).not.toBe(telegram.id); expect(manual.blobId).toBe(telegram.blobId); expect(manual.attribution).toBe('human'); expect(manual.externalId).toBeUndefined()
})
