import { create } from 'zustand'
import type { TranscribeReply, TranscribeRequest } from './transcribe.worker.ts'

// Local speech-to-text for audio and video (transcribe.worker.ts). Nothing leaves the browser;
// the first use downloads Whisper base (~80 MB with WebGPU, ~110 MB without) from Hugging Face.

export const SAMPLE_RATE = 16_000
/** Longest recording transcribed in one go (Whisper runs ~realtime/20 on WebGPU, slower on WASM). */
export const MAX_SECONDS = 3 * 60 * 60

export interface Transcript {
  text: string
  chunks: { start: number; end: number | null; text: string }[]
}

export const useTranscriber = create<{ phase: 'idle' | 'loading-model' | 'busy' | 'error'; download: number; config: string | null; error: string | null }>()(() => ({
  phase: 'idle',
  download: 0,
  config: null,
  error: null,
}))

let worker: Worker | null = null
let nextId = 1
let generation = 0
const waiting = new Map<number, { resolve: (t: Transcript) => void; reject: (e: Error) => void }>()

function getWorker(): Worker {
  if (worker) return worker
  const current = new Worker(new URL('./transcribe.worker.ts', import.meta.url), { type: 'module' })
  worker = current
  current.onmessage = (e: MessageEvent<TranscribeReply>) => {
    if (worker !== current) return
    const m = e.data
    if (m.type === 'progress') return void useTranscriber.setState({ phase: 'loading-model', download: m.total > 0 ? m.loaded / m.total : 0 })
    if (m.type === 'ready') return void useTranscriber.setState({ phase: 'busy', config: m.config })
    const w = waiting.get(m.id)
    waiting.delete(m.id)
    if (!waiting.size) useTranscriber.setState({ phase: m.type === 'error' ? 'error' : 'idle', error: m.type === 'error' ? m.error : null })
    if (m.type === 'error') w?.reject(new Error(m.error))
    else w?.resolve({ text: m.text, chunks: m.chunks })
  }
  current.onerror = (error) => {
    if (worker !== current) return
    for (const request of waiting.values()) request.reject(new Error(error.message || 'Local transcription stopped unexpectedly. Original retained.'))
    waiting.clear()
    current.terminate(); worker = null
    useTranscriber.setState({ phase: 'error', config: null, error: error.message || 'Local transcription failed.' })
  }
  return worker
}

/** A restore, account switch or policy revocation must settle pending local inference. */
export function stopTranscription(): void {
  generation++
  worker?.terminate(); worker = null
  for (const request of waiting.values()) request.reject(new Error('Local transcription cancelled. The original is retained.'))
  waiting.clear()
  useTranscriber.setState({ phase: 'idle', download: 0, config: null, error: null })
}

/** Average channels and resample to 16 kHz mono (pure; linear interpolation after a box filter). */
export function toMono16k(channels: Float32Array[], rate: number): Float32Array {
  const n = channels[0]?.length ?? 0
  const mono = new Float32Array(n)
  for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length
  if (rate === SAMPLE_RATE) return mono
  const ratio = rate / SAMPLE_RATE
  const out = new Float32Array(Math.floor(n / ratio))
  const half = Math.max(0, Math.floor(ratio / 2))
  for (let j = 0; j < out.length; j++) {
    const c = j * ratio
    const i0 = Math.floor(c)
    let s = 0
    let k = 0
    for (let i = Math.max(0, i0 - half); i <= Math.min(n - 1, i0 + half); i++, k++) s += mono[i]
    out[j] = k ? s / k : 0
  }
  return out
}

/** Decode an audio or video file's sound to 16 kHz mono. Null when the browser cannot decode it or it has no sound. */
export async function decodeSpeech(blob: Blob): Promise<Float32Array | null> {
  if (typeof AudioContext === 'undefined' && typeof OfflineAudioContext === 'undefined') return null
  try {
    const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE)
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
    if (buf.duration > MAX_SECONDS) throw new Error(`longer than ${MAX_SECONDS / 3600} hours`)
    const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c))
    return toMono16k(channels, buf.sampleRate)
  } catch {
    return null
  }
}

/** Timestamped lines, "[m:ss] text", for a note body. */
export function transcriptMarkdown(t: Transcript): string {
  if (!t.chunks.length) return t.text
  const stamp = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  return t.chunks
    .filter((c) => c.text)
    .map((c) => `[${stamp(c.start)}] ${c.text}`)
    .join('\n')
}

/** Speech in `blob` as text, or null when it has no decodable sound. Downloads Whisper on first use. */
export async function transcribe(blob: Blob, opts: { language?: string } = {}): Promise<Transcript | null> {
  const token = generation
  const audio = await decodeSpeech(blob)
  if (token !== generation) throw new Error('Local transcription cancelled. The original is retained.')
  if (!audio || audio.length < SAMPLE_RATE / 4) return null
  const id = nextId++
  const w = getWorker()
  useTranscriber.setState((s) => ({ phase: s.config ? 'busy' : 'loading-model', error: null }))
  return new Promise<Transcript>((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    w.postMessage({ id, audio, language: opts.language } satisfies TranscribeRequest, [audio.buffer])
  })
}
