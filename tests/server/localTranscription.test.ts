import { readFile } from 'node:fs/promises'
import { afterAll, expect, it } from 'vitest'
import { closeLocalTranscription, decodeLocalMedia, transcribeLocalMedia } from '../../server/localTranscription.ts'

afterAll(closeLocalTranscription)
it('rejects a cancelled decode before starting local media or model work', async () => {
  const controller = new AbortController(); controller.abort()
  await expect(decodeLocalMedia(new Uint8Array([1]), controller.signal)).rejects.toThrow('cancelled')
  await expect(transcribeLocalMedia({ bytes: new Uint8Array([1]), mime: 'audio/wav', signal: controller.signal })).rejects.toThrow('cancelled')
})
it('rejects empty capture before model loading', async () => {
  await expect(transcribeLocalMedia({ bytes: new Uint8Array(), mime: 'audio/wav' })).rejects.toThrow('128 MiB')
})
it.skipIf(process.env.WORLDVIEW_LIVE_ASR !== '1')('cancels a real native worker and can retry from the same original', async () => {
  const bytes = await readFile('data/live-tests/voice/aurora-live.wav'), controller = new AbortController()
  await expect(transcribeLocalMedia({ bytes, mime: 'audio/wav', language: 'en', signal: controller.signal, onProgress: ({ stage }) => { if (stage === 'loading-model') controller.abort() } })).rejects.toThrow('cancelled')
  const result = await transcribeLocalMedia({ bytes, mime: 'audio/wav', language: 'en' })
  expect(result.text.toLowerCase()).toContain('aurora')
  expect(result.chunks.length).toBeGreaterThan(0)
}, 120000)
