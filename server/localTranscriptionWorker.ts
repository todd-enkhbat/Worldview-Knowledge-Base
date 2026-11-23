import { parentPort, workerData } from 'node:worker_threads'
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import { WHISPER_MODEL, WHISPER_REVISION } from '../src/ai/transcribeConfig.ts'

env.allowLocalModels = true
env.allowRemoteModels = false
env.useFSCache = false
env.localModelPath = (workerData as { modelRoot: string }).modelRoot
let model: Promise<AutomaticSpeechRecognitionPipeline> | null = null
parentPort!.on('message', async (request: { id: number; audio: Float32Array; language?: string }) => {
  try {
    parentPort!.postMessage({ type: 'progress', id: request.id, stage: 'loading-model' })
    model ??= pipeline('automatic-speech-recognition', WHISPER_MODEL, { revision: WHISPER_REVISION, local_files_only: true, device: 'cpu', dtype: 'q8' }) as Promise<AutomaticSpeechRecognitionPipeline>
    model.catch(() => { model = null })
    const asr = await model
    parentPort!.postMessage({ type: 'progress', id: request.id, stage: 'transcribing' })
    const result = await asr(request.audio, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true, task: 'transcribe', ...(request.language ? { language: request.language } : {}) }) as { text: string; chunks?: { timestamp: [number, number | null]; text: string }[] }
    parentPort!.postMessage({ type: 'result', id: request.id, text: result.text.trim(), chunks: (result.chunks ?? []).map((chunk) => ({ start: chunk.timestamp[0], end: chunk.timestamp[1], text: chunk.text.trim() })) })
  } catch (error) { parentPort!.postMessage({ type: 'error', id: request.id, error: error instanceof Error ? error.message : String(error) }) }
})
