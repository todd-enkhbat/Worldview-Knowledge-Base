/// <reference lib="webworker" />
import { env, pipeline, type AutomaticSpeechRecognitionPipeline, type ProgressInfo } from '@huggingface/transformers'
import { WHISPER_MODEL, WHISPER_REVISION } from './transcribeConfig.ts'

// Whisper in a module worker: speech in audio and video becomes text without leaving the
// browser. The model downloads from Hugging Face on first use (then Cache Storage keeps it):
// WebGPU with an fp32 encoder and a q4 decoder where available, else WASM q8. Audio arrives
// already decoded to 16 kHz mono (transcribe.ts).

declare const self: DedicatedWorkerGlobalScope

export { WHISPER_MODEL, WHISPER_REVISION } from './transcribeConfig.ts'

export type TranscribeRequest = { id: number; audio: Float32Array; language?: string }
export type TranscribeReply =
  | { type: 'result'; id: number; text: string; chunks: { start: number; end: number | null; text: string }[] }
  | { type: 'error'; id: number; error: string }
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready'; config: string }

env.allowLocalModels = false

let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null
const files = new Map<string, { loaded: number; total: number }>()

function progress(p: ProgressInfo): void {
  if (p.status !== 'progress') return
  files.set(p.file, { loaded: p.loaded, total: p.total })
  let loaded = 0
  let total = 0
  for (const f of files.values()) {
    loaded += f.loaded
    total += f.total
  }
  self.postMessage({ type: 'progress', loaded, total } satisfies TranscribeReply)
}

async function open(): Promise<AutomaticSpeechRecognitionPipeline> {
  let installed = false
  try {
    const response = await fetch('/api/models/whisper/status', { signal: AbortSignal.timeout(2500) })
    const state = response.ok ? await response.json() as { modelReady?: boolean; model?: string; revision?: string } : null
    installed = state?.modelReady === true && state.model === WHISPER_MODEL && state.revision === WHISPER_REVISION
  } catch { /* Static builds still use the pinned official remote model. */ }
  env.allowLocalModels = installed
  env.allowRemoteModels = !installed
  if (installed) env.localModelPath = `/api/models/${WHISPER_REVISION}/`
  const gpu = (self.navigator as Navigator & { gpu?: unknown }).gpu
  const configs = [
    ...(gpu && !installed ? [{ device: 'webgpu' as const, dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } as const, name: 'webgpu/fp32+q4' }] : []),
    { device: 'wasm' as const, dtype: 'q8' as const, name: 'wasm/q8' },
  ]
  let last: unknown = null
  for (const c of configs) {
    try {
      files.clear()
      const p = (await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
        revision: WHISPER_REVISION,
        device: c.device,
        dtype: c.dtype,
        progress_callback: progress,
      })) as AutomaticSpeechRecognitionPipeline
      await p(new Float32Array(16_000)) // a second of silence: fails fast on missing kernels
      self.postMessage({ type: 'ready', config: c.name } satisfies TranscribeReply)
      return p
    } catch (e) {
      last = e
      console.warn(`[transcribe] ${c.name} unavailable`, e)
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

self.onmessage = async (e: MessageEvent<TranscribeRequest>) => {
  const { id, audio, language } = e.data
  try {
    asr ??= open()
    asr.catch(() => {
      asr = null
    })
    const p = await asr
    const out = (await p(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      ...(language ? { language } : {}),
    })) as { text: string; chunks?: { timestamp: [number, number | null]; text: string }[] }
    const chunks = (out.chunks ?? []).map((c) => ({ start: c.timestamp[0], end: c.timestamp[1], text: c.text.trim() }))
    self.postMessage({ type: 'result', id, text: out.text.trim(), chunks } satisfies TranscribeReply)
  } catch (err) {
    self.postMessage({ type: 'error', id, error: err instanceof Error ? err.message : String(err) } satisfies TranscribeReply)
  }
}
