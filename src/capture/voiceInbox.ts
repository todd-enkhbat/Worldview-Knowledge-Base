import { create } from 'zustand'
import { compareAndSwapWorldState, getStore, getWorldGeneration, isRepoReady, retainWorldBlob, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import type { WorldStore } from '../data/WorldStore.ts'
import { stopTranscription, transcribe, useTranscriber, type Transcript } from '../ai/transcribe.ts'
import { WHISPER_MODEL, WHISPER_REVISION } from '../ai/transcribeConfig.ts'
import { ingestRetainedSource } from '../knowledge/index.ts'
import type { Authorship, KnowledgeSnapshot, ParsedSource } from '../knowledge/types.ts'

export const VOICE_INBOX_KV = 'voiceInbox.v1'
export const MAX_VOICE_BYTES = 128 * 1024 * 1024
export interface VoiceEntry {
  id: string; hash: string; blobId: string; name: string; mime: string; bytes: number; capturedAt: number
  language: string; attribution: Authorship; aiAllowed: boolean
  status: 'captured' | 'transcribing' | 'ready' | 'failed'; attempts: number; error?: string; sourceId?: string; completedAt?: number
  /** Connector provenance remains distinct even when two messages share audio bytes. */
  externalId?: string
  processor?: 'browser' | 'telegram-server'
  processingUntil?: number
}
export interface VoiceSnapshot { schemaVersion: 1; revision: number; entries: VoiceEntry[] }
const empty = (): VoiceSnapshot => ({ schemaVersion: 1, revision: 0, entries: [] })
export const useVoiceInbox = create<VoiceSnapshot & { loaded: boolean; busy: boolean; error: string | null }>()(() => ({ ...empty(), loaded: false, busy: false, error: null }))
let binding: WorldStore | null = null
let generation = 0
let queue: Promise<unknown> = Promise.resolve()
const cleanup: (() => void)[] = []
const running = new Set<string>()
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const hashBlob = async (blob: Blob) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
export const voiceExternalId = (entry: Pick<VoiceEntry, 'hash' | 'externalId'>): string => entry.externalId ?? `voice:${entry.hash}`
const active = (store: WorldStore, token: number) => isRepoReady() && getStore() === store && token === generation
const serverProcessingLive = (entry: VoiceEntry) => entry.processor === 'telegram-server' && Number.isFinite(entry.processingUntil) && entry.processingUntil! > Date.now() && entry.processingUntil! <= Date.now() + 120_000

function decode(value: unknown): VoiceSnapshot {
  if (value === undefined) return empty()
  const snapshot = value as VoiceSnapshot
  if (!snapshot || snapshot.schemaVersion !== 1 || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !Array.isArray(snapshot.entries)) throw new Error('The voice inbox uses an unsupported format. Originals were left untouched.')
  const ids = new Set<string>()
  for (const entry of snapshot.entries) {
    if (!entry || typeof entry.id !== 'string' || ids.has(entry.id) || !/^[a-f\d]{64}$/i.test(entry.hash) || typeof entry.blobId !== 'string' || typeof entry.name !== 'string' || typeof entry.mime !== 'string' || !Number.isFinite(entry.bytes) || entry.bytes < 0 || !Number.isFinite(entry.capturedAt) || !Number.isInteger(entry.attempts) || entry.attempts < 0 || typeof entry.aiAllowed !== 'boolean' || typeof entry.language !== 'string' || entry.externalId !== undefined && (typeof entry.externalId !== 'string' || !entry.externalId || entry.externalId.length > 1000) || !['human', 'assistant', 'third-party', 'unknown'].includes(entry.attribution) || !['captured', 'transcribing', 'ready', 'failed'].includes(entry.status)) throw new Error('A voice inbox receipt is incomplete. Originals were left untouched.')
    ids.add(entry.id)
  }
  return structuredClone(snapshot)
}

export async function refreshVoiceInbox(): Promise<void> {
  if (!isRepoReady()) return
  const store = getStore(), token = generation
  const snapshot = decode(await store.getKv(VOICE_INBOX_KV))
  if (active(store, token) && binding === store) useVoiceInbox.setState({ ...snapshot, loaded: true })
}

export async function initializeVoiceInbox(): Promise<void> {
  if (!isRepoReady()) return
  const store = getStore()
  if (binding !== store) {
    for (const stop of cleanup.splice(0)) stop()
    generation++; binding = store; running.clear()
    useVoiceInbox.setState({ ...empty(), loaded: false, busy: false, error: null })
    cleanup.push(subscribeRepo((change) => {
      if (change.type === 'wipe' || change.type === 'import') { generation++; running.clear(); stopTranscription(); useVoiceInbox.setState({ ...empty(), loaded: false, busy: false, error: null }) }
      if (change.type === 'wipe' || change.type === 'import' || change.type === 'kv' && change.keys.includes(VOICE_INBOX_KV)) void refreshVoiceInbox().catch((error) => useVoiceInbox.setState({ error: message(error) }))
    }))
    cleanup.push(useRepoStatus.subscribe((next) => {
      if (!next.ready && binding === store) { generation++; binding = null; running.clear(); stopTranscription(); for (const stop of cleanup.splice(0)) stop(); useVoiceInbox.setState({ ...empty(), loaded: false, busy: false, error: null }) }
    }))
  }
  await refreshVoiceInbox()
  const interrupted = useVoiceInbox.getState().entries.filter((entry) => entry.status === 'transcribing' && !running.has(entry.id) && !serverProcessingLive(entry))
  if (interrupted.length && useRepoStatus.getState().writer && !useRepoStatus.getState().interruptedImport) await mutate((snapshot) => {
    for (const entry of snapshot.entries) if (entry.status === 'transcribing' && !running.has(entry.id) && !serverProcessingLive(entry)) { entry.status = 'failed'; entry.processor = undefined; entry.processingUntil = undefined; entry.error = 'Transcription was interrupted. Retry from the retained original.' }
  })
}

function mutate<T>(change: (snapshot: VoiceSnapshot) => T, scope?: { store: WorldStore; token: number }): Promise<T> {
  if (!isRepoReady()) return Promise.reject(new Error('Open the workspace before using the voice inbox.'))
  const store = scope?.store ?? getStore(), token = scope?.token ?? generation
  const task = queue.catch(() => {}).then(async () => {
    if (!active(store, token)) throw new Error('The active workspace changed. The previous operation was cancelled.')
    if (!useRepoStatus.getState().writer || useRepoStatus.getState().interruptedImport) throw new Error('Finish recovery and open an editable workspace before changing the voice inbox.')
    const snapshot = decode(await store.getKv(VOICE_INBOX_KV))
    if (!active(store, token)) throw new Error('The active workspace changed.')
    const expected = snapshot.revision, result = change(snapshot)
    snapshot.revision++
    await compareAndSwapWorldState(VOICE_INBOX_KV, snapshot, expected)
    if (active(store, token)) useVoiceInbox.setState({ ...snapshot, loaded: true, error: null })
    return structuredClone(result)
  })
  queue = task
  return task
}

/** Save and acknowledge original bytes and a receipt before decoding or inference. */
export async function captureVoiceOriginal(file: Blob, opts: { name?: string; language?: string; attribution?: Authorship } = {}): Promise<VoiceEntry> {
  await initializeVoiceInbox()
  if (!isRepoReady() || !useRepoStatus.getState().writer || useRepoStatus.getState().interruptedImport) throw new Error('Open an editable workspace and finish recovery before capturing voice.')
  if (!file.size || file.size > MAX_VOICE_BYTES) throw new Error('Choose a nonempty audio or video file up to 128 MiB.')
  const store = getStore(), token = generation, worldGeneration = getWorldGeneration()
  const hash = await hashBlob(file)
  if (!active(store, token)) throw new Error('The active workspace changed before capture completed.')
  const prior = decode(await store.getKv(VOICE_INBOX_KV)).entries.find((entry) => entry.hash === hash && !entry.externalId)
  if (prior) return prior
  const name = (opts.name ?? (file as Partial<File>).name ?? 'voice.webm').replace(/[\r\n\0]/g, '').slice(0, 240) || 'voice.webm'
  const mime = file.type || (/\.(mp4|mov|webm)$/i.test(name) ? 'video/mp4' : 'application/octet-stream')
  const blobId = `voice-${hash}`
  await retainWorldBlob({ meta: { id: blobId, kind: 'file', mime, bytes: file.size, createdAt: Date.now(), nodeId: null }, data: file }, { store, generation: worldGeneration, shouldWrite: () => active(store, token) })
  if (!active(store, token)) throw new Error('Original retained, but the active workspace changed before its receipt could be committed.')
  return mutate((snapshot) => {
    const existing = snapshot.entries.find((entry) => entry.hash === hash && !entry.externalId)
    if (existing) return existing
    const entry: VoiceEntry = { id: crypto.randomUUID(), hash, blobId, name, mime, bytes: file.size, capturedAt: Date.now(), language: (opts.language ?? '').slice(0, 32), attribution: opts.attribution ?? 'unknown', aiAllowed: true, status: 'captured', attempts: 0 }
    snapshot.entries.unshift(entry)
    return entry
  }, { store, token })
}

export async function voiceOriginal(id: string): Promise<{ blob: Blob; name: string }> {
  await initializeVoiceInbox()
  const store = getStore(), token = generation
  const entry = decode(await store.getKv(VOICE_INBOX_KV)).entries.find((item) => item.id === id)
  if (!entry) throw new Error('This voice receipt is no longer available.')
  const blob = await store.getBlob(entry.blobId)
  if (!blob || blob.size !== entry.bytes || await hashBlob(blob) !== entry.hash) throw new Error('The retained original is missing or changed. Restore it from a verified backup.')
  if (!active(store, token)) throw new Error('The active workspace changed.')
  return { blob, name: entry.name }
}

export async function setVoicePolicy(id: string, aiAllowed: boolean): Promise<void> {
  await mutate((snapshot) => { const entry = snapshot.entries.find((item) => item.id === id); if (!entry) throw new Error('Voice receipt not found.'); entry.aiAllowed = aiAllowed })
  if (!aiAllowed && running.has(id)) stopTranscription()
}

async function allowed(entry: VoiceEntry, store: WorldStore, token: number): Promise<boolean> {
  if (!active(store, token) || !entry.aiAllowed) return false
  const snapshot = await store.getKv<KnowledgeSnapshot>('knowledge.v1')
  const source = snapshot?.sources.find((source) => source.id === entry.sourceId || source.externalId === voiceExternalId(entry))
  return active(store, token) && (!source || !source.deleted && !source.excluded && source.aiAllowed)
}

export async function transcribeVoice(id: string, opts: { transcriber?: typeof transcribe; model?: string } = {}): Promise<string> {
  await initializeVoiceInbox()
  const store = getStore(), token = generation
  if (running.has(id)) throw new Error('This original is already being transcribed.')
  let entry = decode(await store.getKv(VOICE_INBOX_KV)).entries.find((item) => item.id === id)
  if (!entry) throw new Error('Voice receipt not found.')
  if (!await allowed(entry, store, token)) throw new Error('AI access is disabled for this voice source.')
  if (entry.status === 'ready' && entry.sourceId) return entry.sourceId
  // Publishing the immutable transcript and acknowledging its inbox receipt are
  // separate commits. Recover a successful publish after an interrupted receipt.
  const knowledge = await store.getKv<KnowledgeSnapshot>('knowledge.v1')
  const recovered = knowledge?.sources.find((source) => source.externalId === voiceExternalId(entry!) && !source.deleted && !source.excluded && source.aiAllowed)
  if (recovered && knowledge?.versions.some((version) => version.id === recovered.currentVersionId && version.metadata?.voiceHash === entry!.hash)) {
    await mutate((snapshot) => { const item = snapshot.entries.find((row) => row.id === id)!; item.status = 'ready'; item.sourceId = recovered.id; item.completedAt = Date.now(); item.error = undefined }, { store, token })
    return recovered.id
  }
  running.add(id)
  const scope = { store, token }
  try {
    entry = await mutate((snapshot) => { const item = snapshot.entries.find((row) => row.id === id)!; item.status = 'transcribing'; item.processor = 'browser'; item.processingUntil = undefined; item.attempts++; item.error = undefined; return item }, scope)
    const { blob } = await voiceOriginal(id)
    const result: Transcript | null = await (opts.transcriber ?? transcribe)(blob, { language: entry.language || undefined })
    if (!active(store, token)) throw new Error('The workspace changed while transcription was running. The original remains retained.')
    const latest = decode(await store.getKv(VOICE_INBOX_KV)).entries.find((item) => item.id === id)
    if (!latest || !await allowed(latest, store, token)) throw new Error('AI access changed while transcription was running. Its output was not published.')
    if (!result?.text.trim()) throw new Error('No decodable speech was returned. The original is retained; retry with a browser-supported audio format.')
    const chunks = result.chunks.filter((chunk) => chunk.text.trim())
    if (chunks.some((chunk) => !Number.isFinite(chunk.start) || chunk.start < 0 || chunk.end !== null && (!Number.isFinite(chunk.end) || chunk.end < chunk.start))) throw new Error('Transcription returned invalid timestamps. Original retained.')
    const segments = chunks.length ? chunks : [{ start: 0, end: null, text: result.text }]
    let text = ''
    const messages = segments.map((chunk, index) => {
      if (text) text += '\n'
      const start = text.length; text += chunk.text.trim()
      return { id: `audio:${entry!.hash}:${index}`, text: text.slice(start), start, end: text.length, role: entry!.attribution, authoredAt: null }
    })
    const existingSource = knowledge?.sources.find((source) => source.id === entry!.sourceId || source.externalId === voiceExternalId(entry!))
    const originMetadata = knowledge?.versions.find((version) => version.id === existingSource?.currentVersionId)?.metadata ?? {}
    const parsed: ParsedSource = { externalId: voiceExternalId(entry), title: entry.name.replace(/\.[^.]+$/, ''), kind: 'document', text, messages, authoredAt: null, metadata: { ...originMetadata, mediaKind: entry.mime.startsWith('video/') ? 'video' : 'audio', voiceEntryId: entry.id, voiceHash: entry.hash, capturedAt: entry.capturedAt, language: entry.language || 'auto', attribution: entry.attribution, transcriber: { engine: 'whisper-local', model: WHISPER_MODEL, revision: WHISPER_REVISION, config: opts.model ?? useTranscriber.getState().config ?? 'unknown' }, audioChunks: segments.map(({ start, end }) => ({ start, end })), rawTranscript: result.text } }
    const source = await ingestRetainedSource(parsed, { originalBlobId: entry.blobId, originalName: entry.name, origin: 'capture', aiGenerated: true, shouldWrite: () => active(store, token) && useVoiceInbox.getState().entries.find((item) => item.id === id)?.aiAllowed === true })
    await mutate((snapshot) => { const item = snapshot.entries.find((row) => row.id === id)!; item.status = 'ready'; item.sourceId = source.id; item.completedAt = Date.now(); item.error = undefined }, scope)
    return source.id
  } catch (error) {
    if (active(store, token)) await mutate((snapshot) => { const item = snapshot.entries.find((row) => row.id === id); if (item) { item.status = 'failed'; item.error = message(error) } }, scope).catch(() => {})
    throw error
  } finally { if (active(store, token)) running.delete(id) }
}
