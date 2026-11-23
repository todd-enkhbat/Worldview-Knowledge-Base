import { afterEach, expect, it, vi } from 'vitest'
import { stopTranscription, transcribe, useTranscriber } from '../../src/ai/transcribe.ts'

afterEach(() => { stopTranscription(); vi.unstubAllGlobals() })
const decoded = { duration: 1, numberOfChannels: 1, sampleRate: 16000, getChannelData: () => new Float32Array(16000) }

it('settles a pending local worker request and ignores late replies after cancellation', async () => {
  const workers: { onmessage?: (event: { data: unknown }) => void; terminate: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal('OfflineAudioContext', class { async decodeAudioData() { return decoded } })
  vi.stubGlobal('Worker', class { terminate = vi.fn(); postMessage = vi.fn(); constructor() { workers.push(this) } })
  const pending = transcribe(new Blob(['original']))
  await vi.waitFor(() => expect(workers[0]?.postMessage).toHaveBeenCalledOnce())
  const rejection = expect(pending).rejects.toThrow('cancelled')
  stopTranscription()
  await rejection
  expect(workers[0].terminate).toHaveBeenCalledOnce()
  workers[0].onmessage?.({ data: { id: 1, type: 'ready', config: 'late model' } })
  expect(useTranscriber.getState()).toMatchObject({ phase: 'idle', config: null })
})

it('never starts a model worker when cancellation happens during browser decoding', async () => {
  let release: (value: typeof decoded) => void = () => {}
  const decodedLater = new Promise<typeof decoded>((resolve) => { release = resolve })
  vi.stubGlobal('OfflineAudioContext', class { decodeAudioData() { return decodedLater } })
  const worker = vi.fn()
  vi.stubGlobal('Worker', worker)
  const pending = transcribe(new Blob(['original']))
  const rejection = expect(pending).rejects.toThrow('cancelled')
  stopTranscription(); release(decoded)
  await rejection
  expect(worker).not.toHaveBeenCalled()
})
