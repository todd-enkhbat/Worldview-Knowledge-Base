import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Transcript } from '../src/ai/transcribe.ts'
import { WHISPER_FILES, WHISPER_MODEL, WHISPER_REVISION, WHISPER_SAMPLE_RATE } from '../src/ai/transcribeConfig.ts'

export const MAX_LOCAL_TRANSCRIPTION_SECONDS = 1800
export const whisperModelRoot = () => resolve(process.env.WORLDVIEW_MODELS_DIR ?? 'data/models')
export interface LocalTranscriptionProgress { stage: 'decode' | 'loading-model' | 'transcribing' }
export interface LocalTranscriptionInput { bytes: Uint8Array; mime: string; language?: string; signal?: AbortSignal; onProgress?: (progress: LocalTranscriptionProgress) => void }
const ffmpegPath = () => process.env.WORLDVIEW_FFMPEG_PATH ?? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(existsSync) ?? 'ffmpeg'
let ffmpegCache: { path: string; available: boolean } | null = null
export function localTranscriptionAvailability() {
  const binary = ffmpegPath()
  if (ffmpegCache?.path !== binary) ffmpegCache = { path: binary, available: spawnSync(binary, ['-version'], { timeout: 3000, stdio: 'ignore' }).status === 0 }
  let modelReady = false
  try {
    const root = join(whisperModelRoot(), WHISPER_MODEL)
    const manifest = JSON.parse(readFileSync(join(root, 'worldview-model.json'), 'utf8')) as { model: string; revision: string; files: { path: string; bytes: number }[] }
    modelReady = manifest.model === WHISPER_MODEL && manifest.revision === WHISPER_REVISION && WHISPER_FILES.every((file) => { const entry = manifest.files.find((entry) => entry.path === file); return !!entry && statSync(join(root, file)).size === entry.bytes })
  } catch { /* setup is an explicit separate operation */ }
  return { available: ffmpegCache.available && modelReady, ffmpeg: ffmpegCache.available, modelReady, model: WHISPER_MODEL, revision: WHISPER_REVISION, dtype: 'q8', maxSeconds: MAX_LOCAL_TRANSCRIPTION_SECONDS }
}

const cancelled = () => new Error('Local transcription cancelled. The original is retained.')
export function decodeLocalMedia(bytes: Uint8Array, signal?: AbortSignal): Promise<Float32Array> {
  if (signal?.aborted) return Promise.reject(cancelled())
  return new Promise((resolveAudio, reject) => {
    const child = spawn(ffmpegPath(), ['-nostdin', '-v', 'error', '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', String(WHISPER_SAMPLE_RATE), '-f', 'f32le', '-t', String(MAX_LOCAL_TRANSCRIPTION_SECONDS + 1 / WHISPER_SAMPLE_RATE), 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []; let size = 0, error = '', done = false
    const finish = (failure?: Error) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (failure) { child.kill('SIGKILL'); reject(failure) } else { const buffer = Buffer.concat(chunks); const audio = new Float32Array(buffer.byteLength / 4); for (let i = 0; i < audio.length; i++) audio[i] = buffer.readFloatLE(i * 4); resolveAudio(audio) } }
    const abort = () => finish(cancelled())
    const timer = setTimeout(() => finish(new Error('Audio decoding timed out. Original retained.')), 120000)
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (failure) => finish(new Error(`Local audio decoder unavailable: ${failure.message}`)))
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_LOCAL_TRANSCRIPTION_SECONDS * WHISPER_SAMPLE_RATE * 4) finish(new Error(`Server transcription supports recordings up to ${MAX_LOCAL_TRANSCRIPTION_SECONDS / 60} minutes. Original retained.`)); else chunks.push(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { if (error.length < 4000) error += chunk.toString('utf8') })
    child.stdin.on('error', () => { /* decoder close reports the bounded error */ })
    child.on('close', (code) => { if (code !== 0) finish(new Error(`This media could not be decoded locally. Original retained.${error ? ` ${error.trim().slice(0, 400)}` : ''}`)); else if (size < WHISPER_SAMPLE_RATE || size % 4) finish(new Error('The original contains no decodable speech segment.')); else finish() })
    child.stdin.end(bytes)
  })
}

let worker: Worker | null = null, workerRoot = '', nextId = 0, queue: Promise<unknown> = Promise.resolve()
let pending: { id: number; resolve: (value: Transcript) => void; reject: (error: Error) => void; progress?: LocalTranscriptionInput['onProgress'] } | null = null
function closeWorker(error: Error) { const current = worker; worker = null; const request = pending; pending = null; request?.reject(error); if (current) void current.terminate() }
export function closeLocalTranscription(): void { closeWorker(cancelled()) }
function getWorker(): Worker {
  const root = whisperModelRoot()
  if (worker && workerRoot === root) return worker
  if (worker) closeWorker(new Error('Local speech model location changed. Retry from the retained original.'))
  const current = new Worker(new URL('./localTranscriptionWorker.ts', import.meta.url), { workerData: { modelRoot: root }, execArgv: [] }); worker = current; workerRoot = root
  current.unref()
  current.on('message', (reply: { type: 'progress' | 'result' | 'error'; id: number; stage?: LocalTranscriptionProgress['stage']; text?: string; chunks?: Transcript['chunks']; error?: string }) => {
    if (worker !== current || pending?.id !== reply.id) return
    if (reply.type === 'progress') { try { pending.progress?.({ stage: reply.stage! }) } catch { /* reporting cannot cancel retained capture */ }; return }
    const request = pending; pending = null
    if (reply.type === 'error') request.reject(new Error(reply.error ?? 'Local speech model failed.'))
    else request.resolve({ text: reply.text ?? '', chunks: reply.chunks ?? [] })
    current.unref()
  })
  current.on('error', (error) => { if (worker === current) closeWorker(error instanceof Error ? error : new Error(String(error))) })
  current.on('exit', (code) => { if (worker === current) { worker = null; if (pending) { const request = pending; pending = null; request.reject(new Error(`Local speech model stopped (${code}). Original retained.`)) } } })
  return current
}

/** Explicitly invoked local-only inference; the caller retains originals and consent. */
export function transcribeLocalMedia(input: LocalTranscriptionInput): Promise<Transcript> {
  const task = queue.catch(() => {}).then(async () => {
    if (input.signal?.aborted) throw cancelled()
    if (!input.bytes.length || input.bytes.length > 128 * 1024 * 1024) throw new Error('Choose audio/video up to 128 MiB.')
    if (input.language && !/^[a-zA-Z-]{2,32}$/.test(input.language)) throw new Error('Choose a supported speech language code or leave it automatic.')
    const availability = localTranscriptionAvailability()
    if (!availability.ffmpeg) throw new Error('Install FFmpeg or set WORLDVIEW_FFMPEG_PATH before server transcription. Original retained.')
    if (!availability.modelReady) throw new Error('Run node scripts/setup-whisper.ts before server transcription. Original retained.')
    input.onProgress?.({ stage: 'decode' })
    const audio = await decodeLocalMedia(input.bytes, input.signal)
    if (input.signal?.aborted) throw cancelled()
    const current = getWorker(), id = ++nextId
    const result = new Promise<Transcript>((resolveResult, reject) => { pending = { id, resolve: resolveResult, reject, progress: input.onProgress }; current.ref(); current.postMessage({ id, audio, language: input.language }, [audio.buffer as ArrayBuffer]) })
    const abort = () => closeWorker(cancelled())
    input.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => closeWorker(new Error('Local transcription timed out. Original retained.')), 10 * 60 * 1000)
    try { return await result } finally { clearTimeout(timer); input.signal?.removeEventListener('abort', abort) }
  })
  queue = task
  return task
}
