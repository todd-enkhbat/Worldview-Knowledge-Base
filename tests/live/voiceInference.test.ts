import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { localTranscriptionAvailability, transcribeLocalMedia, closeLocalTranscription } from '../../server/localTranscription.ts'
import { createHttpStore } from '../../src/data/httpStore.ts'
import { closeRepo, completeFirstRun, getStore, initRepo } from '../../src/data/repo.ts'
import { getSourceOriginal, initializeKnowledge, readKnowledgePassage, resetKnowledge, searchKnowledge, useKnowledge } from '../../src/knowledge/index.ts'
import { captureVoiceOriginal, initializeVoiceInbox, transcribeVoice, useVoiceInbox, voiceOriginal } from '../../src/capture/voiceInbox.ts'
import { startTestEngine } from '../helpers/engine.ts'
import { WHISPER_MODEL, WHISPER_REVISION } from '../../src/ai/transcribeConfig.ts'

afterEach(async () => { closeLocalTranscription(); await closeRepo(); resetKnowledge() })

it.skipIf(process.env.WORLDVIEW_LIVE_ASR !== '1')('transcribes real synthetic speech through retained originals, SQLite HTTP, citations and restart', async () => {
  expect(localTranscriptionAvailability().available).toBe(true)
  const bytes = await readFile('data/live-tests/voice/aurora-live.wav')
  const originalHash = createHash('sha256').update(bytes).digest('hex')
  const engine = await startTestEngine(), store = createHttpStore({ base: engine.base })
  await initRepo({ store }); await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' }); await initializeKnowledge()
  const entry = await captureVoiceOriginal(new File([bytes], 'Synthetic Aurora voice.wav', { type: 'audio/wav' }), { language: 'en', attribution: 'unknown' })
  expect(entry.hash).toBe(originalHash)
  expect((await voiceOriginal(entry.id)).blob.size).toBe(bytes.byteLength)
  let calls = 0
  const stages: string[] = [], started = performance.now()
  const transcriber = async (blob: Blob) => { calls++; expect(await getStore().getBlob(entry.blobId)).toBeDefined(); return transcribeLocalMedia({ bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type, language: 'en', onProgress: (event) => stages.push(event.stage) }) }
  const sourceId = await transcribeVoice(entry.id, { transcriber, model: `${WHISPER_MODEL}@${WHISPER_REVISION}/cpu/q8` })
  const elapsedMs = performance.now() - started
  const corpus = useKnowledge.getState(), source = corpus.sources.find((source) => source.id === sourceId)!, version = corpus.versions.find((version) => version.id === source.currentVersionId)!
  const actual = version.text.toLocaleLowerCase()
  expect(actual).toContain('aurora'); expect(actual).toMatch(/december\s+12/); expect(actual).toContain('312'); expect(actual).toContain('synthetic speech'); expect(actual).toContain('integration test')
  const passages = corpus.passages.filter((passage) => passage.sourceId === sourceId)
  expect(passages.length).toBeGreaterThan(0)
  for (const passage of passages) { expect(passage.role).toBe('unknown'); expect(passage.authoredAt).toBeNull(); expect(passage.locator).toMatch(/^Audio /); expect(version.text.slice(passage.start, passage.end)).toBe(passage.text); expect((await readKnowledgePassage(passage.id))?.text).toBe(passage.text) }
  const chunks = version.metadata?.audioChunks as { start: number; end: number | null }[]
  expect(chunks.length).toBeGreaterThan(0)
  for (const chunk of chunks) { expect(chunk.start).toBeGreaterThanOrEqual(0); if (chunk.end !== null) { expect(chunk.end).toBeGreaterThanOrEqual(chunk.start); expect(chunk.end).toBeLessThanOrEqual(11) } }
  expect((await searchKnowledge('312', { sourceIds: [sourceId], aiOnly: true })).map((hit) => hit.sourceId)).toContain(sourceId)
  expect(await searchKnowledge('312', { sourceIds: [sourceId], role: 'human' })).toEqual([])
  expect(await searchKnowledge('312', { sourceIds: [sourceId], authoredAfter: 1 })).toEqual([])
  const original = (await getSourceOriginal(sourceId))!
  expect(createHash('sha256').update(new Uint8Array(await original.blob.arrayBuffer())).digest('hex')).toBe(originalHash)
  expect((await captureVoiceOriginal(new File([bytes], 'Duplicate.wav', { type: 'audio/wav' }))).id).toBe(entry.id)
  expect(await transcribeVoice(entry.id, { transcriber })).toBe(sourceId); expect(calls).toBe(1)
  await closeRepo(); resetKnowledge(); await initRepo({ store: createHttpStore({ base: engine.base }) }); await initializeKnowledge(); await initializeVoiceInbox()
  expect(useVoiceInbox.getState().entries[0]).toMatchObject({ id: entry.id, sourceId, status: 'ready' })
  expect(await transcribeVoice(entry.id, { transcriber })).toBe(sourceId); expect(calls).toBe(1)
  expect(useKnowledge.getState().versions).toHaveLength(1)
  for (const passage of passages) expect(await readKnowledgePassage(passage.id)).toMatchObject({ id: passage.id, versionId: version.id, text: passage.text })
  const report = { measuredAt: new Date().toISOString(), node: process.version, model: WHISPER_MODEL, revision: WHISPER_REVISION, dtype: 'q8', runtime: 'native CPU worker + FFmpeg decode', fixture: { generator: 'macOS Samantha, synthetic speech, 150 words/min', bytes: bytes.byteLength, sha256: originalHash, expected: 'Project Aurora decided to launch on December twelve. The copper orchard budget is three hundred twelve dollars. This is synthetic speech for an integration test.' }, actualTranscript: version.text, audioChunks: chunks, stages, elapsedMs, originalVerifiedBeforeInference: true, originalVerifiedAfterInference: true, exactCitations: passages.map(({ id, versionId, start, end, locator, role, authoredAt }) => ({ id, versionId, start, end, locator, role, authoredAt })), duplicateInferenceCalls: calls, restartPreservedIdentity: true, dateNumberPhraseChecks: ['Aurora', 'December 12', '312', 'synthetic speech', 'integration test'], limitations: ['Synthetic speech from one speaker; not general transcription accuracy.', 'The recognizer wrote copper-orchored for copper orchard; source text retains the actual model output.', 'Browser WASM path is verified separately by UI testing.'], personalDataUsed: false }
  await mkdir('docs/evaluations', { recursive: true }); await writeFile('docs/evaluations/live-voice-2026-11-23.json', JSON.stringify(report, null, 2) + '\n')
}, 120000)
