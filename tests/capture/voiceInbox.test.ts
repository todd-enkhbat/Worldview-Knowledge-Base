import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, getStore, initRepo, wipeWorld } from '../../src/data/repo.ts'
import { getSourceOriginal, initializeKnowledge, resetKnowledge, setSourcePolicy, useKnowledge } from '../../src/knowledge/index.ts'
import { captureVoiceOriginal, initializeVoiceInbox, setVoicePolicy, transcribeVoice, useVoiceInbox, VOICE_INBOX_KV, voiceOriginal } from '../../src/capture/voiceInbox.ts'
import type { Transcript } from '../../src/ai/transcribe.ts'

beforeEach(async () => {
  await initRepo({ store: createMemoryStore() })
  await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  await initializeKnowledge()
  await initializeVoiceInbox()
})
afterEach(async () => { await closeRepo(); resetKnowledge() })
const recording = () => new File(['original retained audio bytes'], 'Lighthouse.wav', { type: 'audio/wav' })
const transcript: Transcript = { text: 'The lighthouse reserve is eighteen hours.', chunks: [{ start: 65, end: 75, text: 'The lighthouse reserve is eighteen hours.' }] }

it('commits original bytes and a durable receipt before any inference, retaining them after failure', async () => {
  const entry = await captureVoiceOriginal(recording())
  expect((await getStore().getBlob(entry.blobId))?.size).toBe(entry.bytes)
  expect((await getStore().getKv<{ entries: unknown[] }>(VOICE_INBOX_KV))?.entries).toHaveLength(1)
  const failed = vi.fn(async () => { expect((await voiceOriginal(entry.id)).blob.size).toBe(entry.bytes); throw new Error('Model unavailable') })
  await expect(transcribeVoice(entry.id, { transcriber: failed })).rejects.toThrow('Model unavailable')
  expect(useVoiceInbox.getState().entries[0]).toMatchObject({ status: 'failed', attempts: 1 })
  expect(await (await voiceOriginal(entry.id)).blob.text()).toBe('original retained audio bytes')
  expect(useKnowledge.getState().sources).toHaveLength(0)
})

it('retries from the original, preserves timed attribution and does not duplicate captures or completed transcripts', async () => {
  const entry = await captureVoiceOriginal(recording(), { language: 'en', attribution: 'human' })
  expect((await captureVoiceOriginal(recording())).id).toBe(entry.id)
  const run = vi.fn(async () => transcript)
  const sourceId = await transcribeVoice(entry.id, { transcriber: run, model: 'fixture-local' })
  expect(await transcribeVoice(entry.id, { transcriber: run })).toBe(sourceId)
  expect(run).toHaveBeenCalledTimes(1)
  expect(useVoiceInbox.getState().entries).toHaveLength(1)
  const version = useKnowledge.getState().versions.find((item) => item.sourceId === sourceId)!
  expect(version.authoredAt).toBeNull()
  expect(version.metadata).toMatchObject({ language: 'en', voiceHash: entry.hash, transcriber: { config: 'fixture-local' } })
  expect(useKnowledge.getState().passages.find((item) => item.sourceId === sourceId)).toMatchObject({ locator: 'Audio 1:05–1:15', role: 'human', text: transcript.text })
  expect(await (await getSourceOriginal(sourceId))?.blob.text()).toBe('original retained audio bytes')
})

it('does not publish a late transcript after the user revokes transcription access', async () => {
  const entry = await captureVoiceOriginal(recording())
  let started: () => void = () => {}, release: (result: Transcript) => void = () => {}
  const began = new Promise<void>((resolve) => { started = resolve })
  const pending = new Promise<Transcript>((resolve) => { release = resolve })
  const running = transcribeVoice(entry.id, { transcriber: async () => { started(); return pending } })
  await began
  await setVoicePolicy(entry.id, false)
  release(transcript)
  await expect(running).rejects.toThrow('AI access changed')
  expect(useKnowledge.getState().sources).toHaveLength(0)
  expect((await voiceOriginal(entry.id)).blob.size).toBe(entry.bytes)
})

it('rechecks the published source policy before any retry', async () => {
  const entry = await captureVoiceOriginal(recording())
  const run = vi.fn(async () => transcript)
  const sourceId = await transcribeVoice(entry.id, { transcriber: run })
  await setSourcePolicy(sourceId, { aiAllowed: false })
  await expect(transcribeVoice(entry.id, { transcriber: run })).rejects.toThrow('AI access is disabled')
  expect(run).toHaveBeenCalledTimes(1)
})

it('cancels a pending transcript across a whole-world replacement boundary', async () => {
  const entry = await captureVoiceOriginal(recording())
  let started: () => void = () => {}, release: (result: Transcript) => void = () => {}
  const began = new Promise<void>((resolve) => { started = resolve })
  const pending = new Promise<Transcript>((resolve) => { release = resolve })
  const running = transcribeVoice(entry.id, { transcriber: async () => { started(); return pending } })
  await began
  await wipeWorld({ confirm: true })
  release(transcript)
  await expect(running).rejects.toThrow('workspace changed')
  expect(await getStore().getKv(VOICE_INBOX_KV)).toBeUndefined()
  expect(useVoiceInbox.getState().entries).toHaveLength(0)
})

it('recovers an already-published transcript after an interrupted receipt without running the model again', async () => {
  const entry = await captureVoiceOriginal(recording())
  const run = vi.fn(async () => transcript)
  const sourceId = await transcribeVoice(entry.id, { transcriber: run })
  const saved = await getStore().getKv<{ schemaVersion: 1; revision: number; entries: { status: string; sourceId?: string; completedAt?: number }[] }>(VOICE_INBOX_KV)
  saved!.entries[0].status = 'transcribing'; delete saved!.entries[0].sourceId; delete saved!.entries[0].completedAt
  await getStore().putKv(VOICE_INBOX_KV, saved)
  await initializeVoiceInbox()
  expect(useVoiceInbox.getState().entries[0].status).toBe('failed')
  expect(await transcribeVoice(entry.id, { transcriber: run })).toBe(sourceId)
  expect(run).toHaveBeenCalledOnce()
  expect(useKnowledge.getState().sources).toHaveLength(1)
  expect(useKnowledge.getState().versions).toHaveLength(1)
  expect(useVoiceInbox.getState().entries[0]).toMatchObject({ status: 'ready', sourceId })
})
