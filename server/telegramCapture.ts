import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WorldDb } from './worldDb.ts'
import type { ChangeBus } from './changes.ts'
import { TelegramApi, TelegramApiError, TELEGRAM_DOWNLOAD_LIMIT, validateTelegramToken, type TelegramBot, type TelegramMedia, type TelegramMessage, type TelegramUpdate } from './telegramApi.ts'
import { memoryOriginAllowed, readMemoryBody, sendMemoryJson } from './memoryHttp.ts'
import { diffKnowledgeSnapshots } from '../src/knowledge/storage.ts'
import type { KnowledgeCommitOptions } from '../src/knowledge/storage.ts'
import type { Authorship, ImportReceipt, KnowledgeSnapshot, KnowledgeSource, ParsedSource, SourceVersion } from '../src/knowledge/types.ts'
import { splitPassages } from '../src/knowledge/parsers.ts'
import type { AssetMeta } from '../src/domain/types.ts'
import type { VoiceSnapshot } from '../src/capture/voiceInbox.ts'
import type { Transcript } from '../src/ai/transcribe.ts'

const CONFIG = 'telegram.config.v1', RUNTIME = 'telegram.runtime.v1'
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const empty = (): KnowledgeSnapshot => ({ schemaVersion: 1, revision: 0, sources: [], versions: [], passages: [], imports: [], jobs: [], proposals: [] })
const voiceEmpty = (): VoiceSnapshot => ({ schemaVersion: 1, revision: 0, entries: [] })
const ids = (value: unknown): number[] => {
  if (!Array.isArray(value) || value.length > 32 || value.some((id) => !Number.isSafeInteger(id) || id === 0)) throw new TelegramApiError('Allowlist IDs must be nonzero Telegram integers (up to 32).', 400)
  return [...new Set(value)] as number[]
}
/** Optional environment mistakes fail closed; interactive configuration still reports validation errors. */
export const telegramIds = (value: string | undefined): number[] => { if (!value?.trim()) return []; try { return ids(value.split(/[\s,]+/).filter(Boolean).map(Number)) } catch { return [] } }
interface TelegramConfig { schemaVersion: 1; revision: number; enabled: boolean; token?: string; credentialHash?: string; userIds: number[]; chatIds: number[]; projectId: string | null; ownMessages: boolean; autoTranscribe: boolean; acknowledge: boolean; language: string; bot: TelegramBot | null }
interface Runtime { schemaVersion: 1; revision: number; offset: number; botId: number | null; owner: string | null; leaseUntil: number }
interface TelegramReceipt extends ImportReceipt { telegram: { botId: number; updateId: number; messageId: number; chatId: number; userId: number; sourceId: string; mediaBlobId?: string; mediaHash?: string; mediaMime?: string; mediaName?: string; voiceEntryId?: string; projectId: string | null } }
export interface TelegramOptions {
  db: WorldDb; blobDir: string; bus?: ChangeBus; now?: () => number; fetch?: typeof fetch
  token?: string; allowedUserIds?: readonly number[]; allowedChatIds?: readonly number[]; autoPoll?: boolean
  transcribe?: (input: { bytes: Uint8Array; mime: string; language?: string; signal?: AbortSignal }) => Promise<Transcript>
}
export interface TelegramStatus { configured: boolean; enabled: boolean; phase: 'unconfigured' | 'paused' | 'idle' | 'polling' | 'transcribing' | 'error'; bot: TelegramBot | null; userIds: number[]; chatIds: number[]; projectId: string | null; ownMessages: boolean; autoTranscribe: boolean; acknowledge: boolean; language: string; transcriptionAvailable: boolean; lastPollAt: number | null; lastError: string | null; offset: number; receipts: { id: string; title: string; status: string; createdAt: number; sourceId: string; voiceEntryId?: string; error?: string }[] }

/** One private connector per world. Only attributed retained evidence enters the corpus. */
export class TelegramCapture {
  private readonly options: TelegramOptions
  private readonly owner = randomUUID()
  private timer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private controller: AbortController | null = null
  private running: Promise<void> | null = null
  private closed = false
  private phase: TelegramStatus['phase'] = 'idle'
  private lastError: string | null = null
  private lastPollAt: number | null = null
  private retryDelay = 10_000
  constructor(options: TelegramOptions) { this.options = options; if (this.config().enabled && options.autoPoll !== false) this.schedule(0) }
  private now() { return this.options.now?.() ?? Date.now() }
  private config(): TelegramConfig { return this.options.db.getKv<TelegramConfig>(CONFIG) ?? { schemaVersion: 1, revision: 0, enabled: false, userIds: [...(this.options.allowedUserIds ?? [])], chatIds: [...(this.options.allowedChatIds ?? [])], projectId: null, ownMessages: false, autoTranscribe: false, acknowledge: false, language: '', bot: null } }
  private runtime(): Runtime { return this.options.db.getKv<Runtime>(RUNTIME) ?? { schemaVersion: 1, revision: 0, offset: 0, botId: null, owner: null, leaseUntil: 0 } }
  private token(config = this.config()) { return config.token || this.options.token || '' }
  status(): TelegramStatus {
    const config = this.config(), corpus = this.options.db.getKv<KnowledgeSnapshot>('knowledge.v1') ?? empty()
    return { configured: !!this.token(config), enabled: config.enabled, phase: !this.token(config) ? 'unconfigured' : !config.enabled ? 'paused' : this.phase, bot: config.bot, userIds: config.userIds, chatIds: config.chatIds, projectId: config.projectId, ownMessages: config.ownMessages, autoTranscribe: config.autoTranscribe, acknowledge: config.acknowledge, language: config.language, transcriptionAvailable: !!this.options.transcribe, lastPollAt: this.lastPollAt, lastError: this.lastError, offset: this.runtime().offset, receipts: corpus.imports.filter((item): item is TelegramReceipt => 'telegram' in item).slice(-30).reverse().map((item) => ({ id: item.id, title: item.title, status: item.status, createdAt: item.createdAt, sourceId: item.telegram.sourceId, voiceEntryId: item.telegram.voiceEntryId, ...(item.errors.length ? { error: item.errors.at(-1) } : {}) })) }
  }
  async probe(token = this.token()): Promise<{ bot: TelegramBot; webhookConfigured: boolean }> {
    const api = new TelegramApi(token, this.options.fetch), [bot, webhook] = await Promise.all([api.call<TelegramBot>('getMe'), api.call<{ url?: string }>('getWebhookInfo')])
    if (!Number.isSafeInteger(bot.id) || !bot.username) throw new TelegramApiError('Telegram returned an invalid bot identity.')
    return { bot: { id: bot.id, username: bot.username, first_name: bot.first_name, is_bot: true }, webhookConfigured: !!webhook.url }
  }
  async discover(): Promise<{ candidates: { userId: number; chatId: number; chatType: string }[] }> {
    const { webhookConfigured } = await this.probe()
    if (webhookConfigured) throw new TelegramApiError('This bot already has a webhook. Use a dedicated bot; existing webhook settings were left unchanged.', 409)
    const updates = await new TelegramApi(this.token(), this.options.fetch).call<TelegramUpdate[]>('getUpdates', { limit: 20, timeout: 0, allowed_updates: ['message', 'edited_message'] })
    const candidates = new Map<string, { userId: number; chatId: number; chatType: string }>()
    for (const update of updates) { const message = update.message ?? update.edited_message; if (message?.from && !message.from.is_bot && Number.isSafeInteger(message.from.id) && Number.isSafeInteger(message.chat.id)) candidates.set(`${message.from.id}:${message.chat.id}`, { userId: message.from.id, chatId: message.chat.id, chatType: message.chat.type }) }
    return { candidates: [...candidates.values()] }
  }
  async configure(input: Record<string, unknown>): Promise<TelegramStatus> {
    if (this.options.db.getKv('importInProgress')) throw new TelegramApiError('Finish workspace recovery before configuring Telegram.', 409)
    const before = this.config(), config = structuredClone(before)
    if (typeof input.token === 'string' && input.token.trim()) { validateTelegramToken(input.token.trim()); config.token = input.token.trim() }
    if (input.userIds !== undefined) config.userIds = ids(input.userIds)
    if (input.chatIds !== undefined) config.chatIds = ids(input.chatIds)
    if (input.projectId !== undefined) { if (input.projectId !== null && (typeof input.projectId !== 'string' || !this.project(input.projectId))) throw new TelegramApiError('Choose an existing saved investigation.', 400); config.projectId = input.projectId as string | null }
    for (const field of ['enabled', 'ownMessages', 'autoTranscribe', 'acknowledge'] as const) if (input[field] !== undefined) { if (typeof input[field] !== 'boolean') throw new TelegramApiError('Connector options must be booleans.', 400); config[field] = input[field] }
    if (input.language !== undefined) { if (typeof input.language !== 'string' || input.language.length > 32 || /[\r\n\0]/.test(input.language)) throw new TelegramApiError('Choose a valid transcription language.', 400); config.language = input.language.trim() }
    if (config.autoTranscribe && !this.options.transcribe) throw new TelegramApiError('Local server transcription is not available.', 409)
    if (config.enabled && (!config.userIds.length || !config.chatIds.length)) throw new TelegramApiError('Choose both an allowed sender and an allowed chat before starting capture.', 400)
    if (config.enabled && !this.options.db.getSettings()?.firstRunComplete) throw new TelegramApiError('Complete workspace setup before starting Telegram capture.', 409)
    const identityChanged = this.token(before) !== this.token(config)
    if (this.token(config) && (config.enabled || identityChanged)) {
      const identity = await this.probe(this.token(config))
      if (identity.webhookConfigured) throw new TelegramApiError('This bot already has a webhook. Use a dedicated bot; existing webhook settings were left unchanged.', 409)
      config.bot = identity.bot
      config.credentialHash = hash(this.token(config))
    }
    if (this.config().revision !== before.revision || this.options.db.getKv('importInProgress')) throw new TelegramApiError('The workspace configuration changed. Refresh before retrying.', 409)
    this.stop()
    config.revision++
    if (!this.options.db.compareAndSwapKv(CONFIG, config, before.revision)) throw new TelegramApiError('Telegram configuration changed. Refresh before retrying.', 409)
    if (identityChanged || before.bot?.id !== config.bot?.id) { const runtime = this.runtime(); this.options.db.compareAndSwapKv(RUNTIME, { ...runtime, revision: runtime.revision + 1, offset: 0, botId: config.bot?.id ?? null, owner: null, leaseUntil: 0 }, runtime.revision) }
    this.lastError = null
    if (config.enabled && this.options.autoPoll !== false) this.schedule(0)
    return this.status()
  }
  disconnect(): void { this.stop(); this.options.db.deleteKv(CONFIG); this.lastError = null }
  close(): void { this.closed = true; this.stop() }
  private stop(): void {
    if (this.timer) clearTimeout(this.timer); this.timer = null
    this.controller?.abort(); this.controller = null
    if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null
    const runtime = this.runtime(); if (runtime.owner === this.owner) this.options.db.compareAndSwapKv(RUNTIME, { ...runtime, revision: runtime.revision + 1, owner: null, leaseUntil: 0 }, runtime.revision)
    this.phase = 'idle'
  }
  private schedule(delay: number): void {
    if (this.closed || this.timer || !this.config().enabled) return
    this.timer = setTimeout(() => { this.timer = null; void this.pollOnce(20).catch(() => {}).finally(() => this.schedule(this.lastError ? this.retryDelay : 500)) }, delay); this.timer.unref?.()
  }
  private lease(): boolean {
    const runtime = this.runtime(), now = this.now()
    if (runtime.owner && runtime.owner !== this.owner && runtime.leaseUntil > now) return false
    return this.options.db.compareAndSwapKv(RUNTIME, { ...runtime, revision: runtime.revision + 1, owner: this.owner, leaseUntil: now + 90_000 }, runtime.revision)
  }
  private active(config: TelegramConfig): boolean { const current = this.config(), runtime = this.runtime(); return !this.closed && current.enabled && current.revision === config.revision && !this.options.db.getKv('importInProgress') && runtime.owner === this.owner && runtime.leaseUntil > this.now() }
  private check(config: TelegramConfig): void { if (!this.active(config)) throw new TelegramApiError('Telegram work stopped because capture, authorization or the workspace changed.', 409) }
  async pollOnce(timeout = 0): Promise<void> {
    if (this.running) return this.running
    const config = this.config()
    if (!config.enabled || !config.userIds.length || !config.chatIds.length) throw new TelegramApiError('Configure allowed senders/chats and start Telegram capture first.', 409)
    if (config.credentialHash !== hash(this.token(config))) throw new TelegramApiError('The Telegram credential changed. Save the connection again to verify its bot identity.', 409)
    if (!this.lease()) throw new TelegramApiError('Another local service is polling this workspace bot. Its lease was preserved.', 409)
    this.controller = new AbortController(); const signal = this.controller.signal
    this.heartbeat = setInterval(() => {
      if (!this.active(config)) return this.controller?.abort()
      const runtime = this.runtime(); this.options.db.compareAndSwapKv(RUNTIME, { ...runtime, revision: runtime.revision + 1, leaseUntil: this.now() + 90_000 }, runtime.revision)
      const voice = this.options.db.getKv<VoiceSnapshot>('voiceInbox.v1')
      if (voice?.entries.some((entry) => entry.processor === 'telegram-server' && entry.status === 'transcribing')) {
        for (const entry of voice.entries) if (entry.processor === 'telegram-server' && entry.status === 'transcribing') entry.processingUntil = this.now() + 90_000
        const revision = voice.revision++; if (this.options.db.compareAndSwapKv('voiceInbox.v1', voice, revision)) this.publishKeys(['voiceInbox.v1'])
      }
    }, 15_000); this.heartbeat.unref?.()
    const action = this.poll(config, Math.max(0, Math.min(20, timeout)), signal).catch((error: unknown) => {
      this.phase = 'error'; this.lastError = error instanceof TelegramApiError ? error.message : 'Telegram capture could not complete. Retained originals and receipts remain available for retry.'
      this.retryDelay = error instanceof TelegramApiError && error.retryAfter ? error.retryAfter * 1000 : 10_000
      throw new TelegramApiError(this.lastError, error instanceof TelegramApiError ? error.status : 500)
    }).finally(() => { if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null; this.controller = null; this.running = null })
    this.running = action; return action
  }
  private async poll(config: TelegramConfig, timeout: number, signal: AbortSignal): Promise<void> {
    this.check(config); this.phase = 'polling'; this.lastError = null
    const api = new TelegramApi(this.token(config), this.options.fetch)
    const bot = config.bot ?? (await api.call<TelegramBot>('getMe', {}, signal))
    if (!Number.isSafeInteger(bot.id)) throw new TelegramApiError('Telegram returned an invalid bot identity.')
    const runtime = this.runtime()
    if (runtime.botId !== null && runtime.botId !== bot.id) throw new TelegramApiError('Bot identity changed. Reconfigure the connector before capturing.', 409)
    for (const receipt of this.corpus().imports.filter((item): item is TelegramReceipt => 'telegram' in item && item.status === 'running' && item.checkpoint === 1)) {
      if (receipt.telegram.botId === bot.id && receipt.telegram.voiceEntryId && config.autoTranscribe && config.userIds.includes(receipt.telegram.userId) && config.chatIds.includes(receipt.telegram.chatId)) {
        try { await this.transcribeReceipt(receipt.id, config, signal) } catch (error) { this.recordTranscriptionFailure(receipt.id, error, config) }
      }
    }
    const updates = await api.call<TelegramUpdate[]>('getUpdates', { offset: runtime.offset, limit: 20, timeout, allowed_updates: ['message', 'edited_message'] }, signal)
    if (!Array.isArray(updates) || updates.length > 100) throw new TelegramApiError('Telegram returned invalid updates.')
    for (const update of [...updates].sort((a, b) => a.update_id - b.update_id)) {
      this.check(config)
      if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new TelegramApiError('Telegram returned an invalid update identity.')
      if (update.update_id < this.runtime().offset) continue
      const message = update.message ?? update.edited_message
      if (message && this.allowed(config, message) && !/^\/(?:start|help)(?:\s|$)/.test(message.text ?? '')) {
        try { await this.capture(update, message, bot, api, config, signal) }
        catch (error) {
          if (!this.active(config) || !(error instanceof TelegramApiError) || error.status === 409 || error.status === 429) throw error
          const latest = this.corpus(), next = structuredClone(latest), failed = next.imports.find((item): item is TelegramReceipt => 'telegram' in item && (item as TelegramReceipt).telegram.botId === bot.id && (item as TelegramReceipt).telegram.updateId === update.update_id)
          if (!failed) throw error
          failed.status = 'failed'; failed.failed = 1; failed.errors = [error.message]; failed.items[0].status = 'failed'; failed.items[0].error = error.message
          this.commit(latest, next, `telegram:${bot.id}:${update.update_id}:capture-failed:${randomUUID()}`)
        }
      }
      this.check(config)
      const previous = this.runtime()
      if (!this.options.db.compareAndSwapKv(RUNTIME, { ...previous, revision: previous.revision + 1, offset: update.update_id + 1, botId: bot.id }, previous.revision)) throw new TelegramApiError('Telegram offset changed. No update was acknowledged twice.', 409)
    }
    this.lastPollAt = this.now(); this.phase = 'idle'
  }
  private allowed(config: TelegramConfig, message: TelegramMessage): boolean { return !!message.from && !message.from.is_bot && Number.isSafeInteger(message.from.id) && config.userIds.includes(message.from.id) && Number.isSafeInteger(message.chat.id) && config.chatIds.includes(message.chat.id) && Number.isSafeInteger(message.message_id) && Number.isFinite(message.date) }
  private project(id: string) { return this.options.db.getKv<{ collections: { id: string; sourceIds: string[]; deletedAt?: number | null }[] }>('collections.v1')?.collections.find((project) => project.id === id && !project.deletedAt) }
  private corpus(): KnowledgeSnapshot { return this.options.db.getKv<KnowledgeSnapshot>('knowledge.v1') ?? empty() }
  private publishKeys(keys: string[]): void { this.options.bus?.publish({ v: 1, from: 'telegram-capture', change: { type: 'kv', keys } }) }
  private commit(before: KnowledgeSnapshot, next: KnowledgeSnapshot, key: string, options: Partial<KnowledgeCommitOptions> = {}): void {
    next.revision = before.revision + 1
    if (!this.options.db.commitKnowledge(diffKnowledgeSnapshots(before, next), { ...options, expectedRevision: before.revision, idempotencyKey: key })) throw new TelegramApiError('The corpus changed while Telegram capture was committing. Retry the retained update.', 409)
    this.publishKeys(['knowledge.v1', ...(options.state ?? []).map((entry) => entry.key)])
  }
  private async original(bytes: Uint8Array, mime: string, prefix: 'knowledge' | 'voice', config: TelegramConfig): Promise<AssetMeta> {
    this.check(config)
    const id = `${prefix}-${hash(bytes)}`, path = join(this.options.blobDir, id)
    await mkdir(this.options.blobDir, { recursive: true })
    if (!existsSync(path)) {
      const temp = `${path}.${randomUUID()}.tmp`; await writeFile(temp, bytes, { mode: 0o600 })
      if (!this.active(config)) { await rm(temp, { force: true }); this.check(config) }
      await rename(temp, path)
    }
    this.check(config)
    return { id, kind: 'file', mime, bytes: bytes.byteLength, createdAt: this.now(), nodeId: null }
  }
  private media(message: TelegramMessage): { media: TelegramMedia; kind: string; mime: string; name: string } | null {
    const entry = message.voice ? { media: message.voice, kind: 'voice', mime: 'audio/ogg', name: 'voice.ogg' } : message.audio ? { media: message.audio, kind: 'audio', mime: 'audio/mpeg', name: 'audio.mp3' } : message.video ? { media: message.video, kind: 'video', mime: 'video/mp4', name: 'video.mp4' } : message.video_note ? { media: message.video_note, kind: 'video', mime: 'video/mp4', name: 'video-note.mp4' } : message.document ? { media: message.document, kind: 'document', mime: 'application/octet-stream', name: 'document' } : null
    if (!entry) return null
    entry.mime = entry.media.mime_type?.slice(0, 150) || entry.mime; entry.name = (entry.media.file_name ?? entry.name).replace(/[\r\n\0/\\]/g, '_').slice(0, 240)
    return entry
  }
  private async capture(update: TelegramUpdate, message: TelegramMessage, bot: TelegramBot, api: TelegramApi, config: TelegramConfig, signal: AbortSignal): Promise<void> {
    const raw = new TextEncoder().encode(JSON.stringify(update))
    if (raw.byteLength > 256 * 1024) throw new TelegramApiError('Telegram update is too large to retain safely.', 413)
    const before = this.corpus(), previous = before.imports.find((receipt): receipt is TelegramReceipt => 'telegram' in receipt && (receipt as TelegramReceipt).telegram.botId === bot.id && (receipt as TelegramReceipt).telegram.updateId === update.update_id)
    if (previous?.status === 'complete' || previous?.status === 'partial') return
    if (previous?.checkpoint === 1) {
      if (config.autoTranscribe && previous.telegram.voiceEntryId) {
        try { await this.transcribeReceipt(previous.id, config, signal) } catch (error) { this.recordTranscriptionFailure(previous.id, error, config) }
      } else {
        const latest = this.corpus(), next = structuredClone(latest), outcome = next.imports.find((item) => item.id === previous.id)
        if (outcome) { outcome.status = 'complete'; this.commit(latest, next, `telegram:${bot.id}:${update.update_id}:recovered`) }
      }
      return
    }
    let receipt = previous
    if (!receipt) {
      const meta = await this.original(raw, 'application/json', 'knowledge', config)
      this.check(config)
      const latest = this.corpus(), next = structuredClone(latest), id = randomUUID(), sourceId = next.sources.find((source) => source.externalId === `telegram:${bot.id}:${message.chat.id}:${message.message_id}`)?.id ?? randomUUID()
      receipt = { id, title: `Telegram · ${bot.username ?? bot.id} · message ${message.message_id}`, createdAt: this.now(), status: 'running', total: 1, saved: 0, unchanged: 0, failed: 0, errors: [], fileBlobIds: [meta.id], checkpoint: 0, items: [{ path: `telegram/${bot.id}/${update.update_id}/update.json`, blobId: meta.id, mime: 'application/json', status: 'queued', sourceIds: [] }], telegram: { botId: bot.id, updateId: update.update_id, messageId: message.message_id, chatId: message.chat.id, userId: message.from!.id, sourceId, projectId: config.projectId } }
      next.imports.push(receipt); this.commit(latest, next, `telegram:${bot.id}:${update.update_id}:receipt`, { assets: [meta] })
    }
    const attached = this.media(message)
    let mediaMeta: AssetMeta | null = null, mediaBytes: Uint8Array | null = null
    if (attached) {
      if (attached.media.file_size !== undefined && attached.media.file_size > TELEGRAM_DOWNLOAD_LIMIT) throw new TelegramApiError('Telegram attachment exceeds its 20 MiB download limit. The raw update receipt is retained.', 413)
      mediaBytes = await api.download(attached.media.file_id, signal); this.check(config)
      mediaMeta = await this.original(mediaBytes, attached.mime, attached.kind === 'document' ? 'knowledge' : 'voice', config)
    }
    this.check(config)
    const latest = this.corpus(), next = structuredClone(latest)
    const stored = next.imports.find((item) => item.id === receipt.id) as TelegramReceipt | undefined
    if (!stored) throw new TelegramApiError('This Telegram receipt was removed during workspace replacement.', 409)
    const externalId = `telegram:${bot.id}:${message.chat.id}:${message.message_id}`
    let source = next.sources.find((source) => source.externalId === externalId)
    if (source && (source.deleted || source.excluded)) throw new TelegramApiError('This Telegram source is excluded or deleted. Capture will not restore it automatically.', 409)
    const text = (message.text ?? message.caption ?? '').trim(), role: Authorship = message.forward_origin ? 'third-party' : config.ownMessages ? 'human' : 'unknown'
    const title = (text.split('\n')[0] || attached?.name || `Telegram message ${message.message_id}`).slice(0, 180)
    if (!source) { source = { id: stored.telegram.sourceId, externalId, title, kind: 'conversation', currentVersionId: '', createdAt: this.now(), updatedAt: this.now(), excluded: false, aiAllowed: true, tags: ['telegram', ...(config.projectId ? [`project:${config.projectId}`] : [])] }; next.sources.push(source) }
    const metadata = { telegram: { botId: bot.id, updateId: update.update_id, messageId: message.message_id, senderId: message.from!.id, chatId: message.chat.id, sentAt: message.date * 1000, editedAt: message.edit_date ? message.edit_date * 1000 : null, forwarded: !!message.forward_origin, forwardOrigin: message.forward_origin ?? null, projectId: config.projectId }, ...(attached ? { mediaKind: attached.kind, capturedAt: this.now(), attribution: role } : {}) }
    const version = this.version(next, source, text, role, mediaMeta?.id ?? stored.items[0].blobId, attached?.name ?? 'telegram-update.json', attached ? null : message.date * 1000, metadata)
    stored.telegram.sourceId = source.id; stored.items[0].sourceIds = [source.id]
    const state: NonNullable<KnowledgeCommitOptions['state']> = []
    if (mediaMeta && attached) {
      stored.fileBlobIds = [...new Set([...stored.fileBlobIds, mediaMeta.id])]
      Object.assign(stored.telegram, { mediaBlobId: mediaMeta.id, mediaHash: hash(mediaBytes!), mediaMime: attached.mime, mediaName: attached.name })
      if (attached.kind !== 'document') {
        const voice = this.options.db.getKv<VoiceSnapshot>('voiceInbox.v1') ?? voiceEmpty(), amended = structuredClone(voice)
        let entry = amended.entries.find((entry) => entry.hash === stored.telegram.mediaHash && entry.externalId === externalId)
        if (!entry) { entry = { id: randomUUID(), hash: stored.telegram.mediaHash!, blobId: mediaMeta.id, name: attached.name, mime: attached.mime, bytes: mediaMeta.bytes, capturedAt: this.now(), language: config.language, attribution: role, aiAllowed: source.aiAllowed, status: 'captured', attempts: 0, sourceId: source.id, externalId }; amended.entries.unshift(entry) }
        stored.telegram.voiceEntryId = entry.id; amended.revision++; state.push({ key: 'voiceInbox.v1', value: amended, expectedRevision: voice.revision })
      }
    }
    if (config.projectId) {
      const collections = this.options.db.getKv<{ schemaVersion: number; revision: number; collections: { id: string; sourceIds: string[]; updatedAt: number; deletedAt?: number | null }[] }>('collections.v1')
      const project = collections?.collections.find((item) => item.id === config.projectId && !item.deletedAt)
      if (!project || !collections) throw new TelegramApiError('The configured Telegram investigation is no longer available.', 409)
      if (!project.sourceIds.includes(source.id)) { project.sourceIds.push(source.id); project.updatedAt = this.now(); const expected = collections.revision++; state.push({ key: 'collections.v1', value: collections, expectedRevision: expected }) }
    }
    const shouldTranscribe = !!stored.telegram.voiceEntryId && config.autoTranscribe
    stored.status = shouldTranscribe ? 'running' : 'complete'; stored.saved = 1; stored.checkpoint = 1; stored.items[0].status = 'saved'; stored.errors = []; stored.failed = 0
    this.commit(latest, next, `telegram:${bot.id}:${update.update_id}:capture:${version.id}`, { assets: mediaMeta ? [mediaMeta] : [], state })
    if (shouldTranscribe) { try { await this.transcribeReceipt(stored.id, config, signal) } catch (error) { this.recordTranscriptionFailure(stored.id, error, config) } }
    if (config.acknowledge) {
      this.check(config)
      try { await api.call('sendMessage', { chat_id: message.chat.id, text: 'Saved to your Worldview record. Original files and the capture receipt are retained.', ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}), reply_parameters: { message_id: message.message_id }, disable_notification: true }, signal) }
      catch (error) { this.check(config); this.lastError = 'The capture was saved, but its Telegram reply could not be delivered. The app receipt is authoritative.'; if (error instanceof TelegramApiError && error.retryAfter) this.retryDelay = error.retryAfter * 1000 }
    }
  }
  private version(snapshot: KnowledgeSnapshot, source: KnowledgeSource, text: string, role: Authorship, originalBlobId: string, originalName: string, authoredAt: number | null, metadata: Record<string, unknown>, chunks?: Transcript['chunks']): SourceVersion {
    const digest = hash(JSON.stringify({ text, role, authoredAt, metadata }))
    const current = snapshot.versions.find((version) => version.id === source.currentVersionId)
    if (current?.contentHash === digest) return current
    const version: SourceVersion = { id: randomUUID(), sourceId: source.id, contentHash: digest, originalBlobId, originalName, text, createdAt: this.now(), authoredAt, origin: 'capture', ...(current ? { previousVersionId: current.id } : {}), metadata }
    const messages = chunks?.length ? (() => { let offset = 0; return chunks.map((chunk) => { const start = text.indexOf(chunk.text.trim(), offset); if (start < 0) return null; offset = start + chunk.text.trim().length; return { text: chunk.text.trim(), start, end: offset, role, authoredAt: null, locator: `Audio ${chunk.start.toFixed(2)}–${chunk.end === null ? 'end' : chunk.end.toFixed(2)}s` } }).filter((item) => item !== null) })() : [{ text, start: 0, end: text.length, role, authoredAt }]
    const parsed: ParsedSource = { externalId: source.externalId, title: source.title, kind: 'conversation', text, messages, authoredAt, metadata }
    snapshot.versions.push(version); snapshot.passages.push(...splitPassages(parsed).map((passage) => ({ ...passage, id: randomUUID(), sourceId: source.id, versionId: version.id, title: source.title })))
    source.currentVersionId = version.id; source.updatedAt = this.now(); return version
  }
  async retry(receiptId: string): Promise<void> {
    if (this.running) { if (this.phase !== 'polling') throw new TelegramApiError('Telegram is already processing an update. Retry when it finishes.', 409); const polling = this.running; this.controller?.abort(); await polling.catch(() => {}) }
    if (this.running) throw new TelegramApiError('Another Telegram retry is already processing. Wait for it to finish.', 409)
    const config = this.config()
    if (!config.enabled || !this.lease()) throw new TelegramApiError('Enable this connector before retrying an authorized receipt.', 409)
    const receipt = this.corpus().imports.find((receipt): receipt is TelegramReceipt => receipt.id === receiptId && 'telegram' in receipt)
    if (!receipt || !config.userIds.includes(receipt.telegram.userId) || !config.chatIds.includes(receipt.telegram.chatId)) throw new TelegramApiError('This retained Telegram capture is no longer authorized.', 403)
    if (config.bot?.id !== receipt.telegram.botId || config.projectId !== receipt.telegram.projectId) throw new TelegramApiError('Reconnect the original bot and investigation before retrying this retained capture.', 403)
    const controller = new AbortController(); this.controller = controller
    this.lastError = null; this.phase = 'idle'
    this.heartbeat = setInterval(() => { if (!this.active(config)) return controller.abort(); const runtime = this.runtime(); this.options.db.compareAndSwapKv(RUNTIME, { ...runtime, revision: runtime.revision + 1, leaseUntil: this.now() + 90_000 }, runtime.revision); const voice = this.options.db.getKv<VoiceSnapshot>('voiceInbox.v1'); if (voice?.entries.some((entry) => entry.processor === 'telegram-server' && entry.status === 'transcribing')) { for (const entry of voice.entries) if (entry.processor === 'telegram-server' && entry.status === 'transcribing') entry.processingUntil = this.now() + 90_000; const revision = voice.revision++; if (this.options.db.compareAndSwapKv('voiceInbox.v1', voice, revision)) this.publishKeys(['voiceInbox.v1']) } }, 15_000); this.heartbeat.unref?.()
    const action = (async () => {
      if (receipt.checkpoint === 0) {
        const raw = await readFile(join(this.options.blobDir, receipt.items[0].blobId), 'utf8')
        const update = JSON.parse(raw) as TelegramUpdate, message = update.message ?? update.edited_message
        if (!message || !this.allowed(config, message) || update.update_id !== receipt.telegram.updateId) throw new TelegramApiError('The retained Telegram original is invalid or outside the current allowlist.', 403)
        await this.capture(update, message, config.bot ?? { id: receipt.telegram.botId }, new TelegramApi(this.token(config), this.options.fetch), config, controller.signal)
      } else await this.transcribeReceipt(receiptId, config, controller.signal)
    })().finally(() => { if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null; this.controller = null; if (this.running === action) this.running = null; if (this.active(config)) this.phase = 'idle' })
    this.running = action; return action
  }
  private recordTranscriptionFailure(id: string, error: unknown, config: TelegramConfig): void {
    this.check(config)
    const latest = this.corpus(), next = structuredClone(latest), outcome = next.imports.find((item): item is TelegramReceipt => item.id === id && 'telegram' in item)
    if (!outcome) throw new TelegramApiError('The Telegram receipt changed before transcription could finish.', 409)
    const voice = this.options.db.getKv<VoiceSnapshot>('voiceInbox.v1') ?? voiceEmpty(), updated = structuredClone(voice), entry = updated.entries.find((entry) => entry.id === outcome.telegram.voiceEntryId)
    const safe = error instanceof TelegramApiError ? error.message : 'Local transcription failed. Retry from the retained original.'
    outcome.status = 'partial'; outcome.failed = 1; outcome.errors = [safe]
    if (entry?.status === 'ready') { outcome.status = 'complete'; outcome.failed = 0; outcome.errors = [] }
    else if (entry) { entry.status = 'failed'; entry.error = safe; entry.attempts++; entry.processor = undefined; entry.processingUntil = undefined }
    updated.revision++; this.commit(latest, next, `telegram:${outcome.telegram.botId}:${outcome.telegram.updateId}:failed:${randomUUID()}`, { state: [{ key: 'voiceInbox.v1', value: updated, expectedRevision: voice.revision }] })
  }
  private async transcribeReceipt(id: string, config: TelegramConfig, signal: AbortSignal): Promise<void> {
    if (!this.options.transcribe) throw new TelegramApiError('Local transcription is not configured.', 409)
    this.check(config)
    const before = this.corpus(), receipt = before.imports.find((receipt): receipt is TelegramReceipt => receipt.id === id && 'telegram' in receipt)
    const source = before.sources.find((source) => source.id === receipt?.telegram.sourceId), voice = this.options.db.getKv<VoiceSnapshot>('voiceInbox.v1') ?? voiceEmpty(), entry = voice.entries.find((entry) => entry.id === receipt?.telegram.voiceEntryId)
    if (!receipt || !source || !entry || source.excluded || source.deleted || !source.aiAllowed || !entry.aiAllowed) throw new TelegramApiError('Transcription is unavailable under the current source and voice access policy.', 403)
    if (config.projectId && !this.project(config.projectId)?.sourceIds.includes(source.id)) throw new TelegramApiError('This source is no longer in the authorized investigation.', 403)
    if (entry.status === 'ready') return
    const bytes = new Uint8Array(await readFile(join(this.options.blobDir, entry.blobId)))
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.hash) throw new TelegramApiError('The retained Telegram voice original is missing or changed. Restore a verified backup.', 409)
    this.check(config); this.phase = 'transcribing'
    const processingCorpus = this.corpus(), processing = structuredClone(processingCorpus), processingVoice = this.options.db.getKv<VoiceSnapshot>('voiceInbox.v1') ?? voiceEmpty(), marked = structuredClone(processingVoice), markedEntry = marked.entries.find((item) => item.id === entry.id)
    if (!markedEntry?.aiAllowed) throw new TelegramApiError('Voice access changed before transcription started.', 403)
    markedEntry.status = 'transcribing'; markedEntry.processor = 'telegram-server'; markedEntry.processingUntil = this.now() + 90_000; marked.revision++
    this.commit(processingCorpus, processing, `telegram:${receipt.telegram.botId}:${receipt.telegram.updateId}:processing:${randomUUID()}`, { state: [{ key: 'voiceInbox.v1', value: marked, expectedRevision: processingVoice.revision }] })
    try {
      const result = await this.options.transcribe({ bytes, mime: entry.mime, language: config.language || undefined, signal })
      this.check(config)
      const latest = this.corpus(), next = structuredClone(latest), activeSource = next.sources.find((item) => item.id === source.id), latestVoice = this.options.db.getKv<VoiceSnapshot>('voiceInbox.v1') ?? voiceEmpty(), updatedVoice = structuredClone(latestVoice), activeEntry = updatedVoice.entries.find((item) => item.id === entry.id)
      const outcome = next.imports.find((item) => item.id === id) as TelegramReceipt | undefined
      if (!activeSource || activeSource.currentVersionId !== source.currentVersionId || activeSource.excluded || activeSource.deleted || !activeSource.aiAllowed || !activeEntry?.aiAllowed || !outcome) throw new TelegramApiError('The source, receipt or access policy changed during transcription. The result was discarded.', 409)
      if (config.projectId && !this.project(config.projectId)?.sourceIds.includes(source.id)) throw new TelegramApiError('The investigation changed during transcription. The result was discarded.', 409)
      const segments = result.chunks.filter((chunk) => chunk.text.trim())
      if (segments.some((chunk) => !Number.isFinite(chunk.start) || chunk.start < 0 || chunk.end !== null && (!Number.isFinite(chunk.end) || chunk.end < chunk.start))) throw new TelegramApiError('The speech model returned invalid time locators.', 422)
      const text = (segments.length ? segments.map((chunk) => chunk.text.trim()).join('\n') : result.text).trim()
      if (!text) throw new TelegramApiError('The speech model found no readable speech. The original remains available.', 422)
      const original = next.versions.find((version) => version.id === source.currentVersionId)
      const metadata = { ...original?.metadata, voiceEntryId: entry.id, voiceHash: entry.hash, capturedAt: entry.capturedAt, attribution: entry.attribution, mediaKind: entry.mime.startsWith('video/') ? 'video' : 'audio', audioChunks: segments.map(({ start, end }) => ({ start, end })), rawTranscript: result.text, transcriber: { engine: 'whisper-local-server' } }
      this.version(next, activeSource, text, entry.attribution, entry.blobId, entry.name, null, metadata, segments)
      activeEntry.status = 'ready'; activeEntry.attempts++; activeEntry.error = undefined; activeEntry.completedAt = this.now(); activeEntry.processor = undefined; activeEntry.processingUntil = undefined; outcome.status = 'complete'; outcome.failed = 0; outcome.errors = []
      updatedVoice.revision++; this.commit(latest, next, `telegram:${receipt.telegram.botId}:${receipt.telegram.updateId}:transcript:${activeSource.currentVersionId}`, { state: [{ key: 'voiceInbox.v1', value: updatedVoice, expectedRevision: latestVoice.revision }] })
    } catch (error) {
      if (!this.active(config)) throw error
      const latest = this.corpus(), next = structuredClone(latest), outcome = next.imports.find((item) => item.id === id), latestVoice = this.options.db.getKv<VoiceSnapshot>('voiceInbox.v1') ?? voiceEmpty(), updatedVoice = structuredClone(latestVoice), activeEntry = updatedVoice.entries.find((item) => item.id === entry.id)
      const safe = error instanceof TelegramApiError ? error.message : 'Local transcription failed. Retry from the retained original.'
      if (outcome) { outcome.status = 'partial'; outcome.failed = 1; outcome.errors = [safe] }
      if (activeEntry?.status === 'ready') { if (outcome) { outcome.status = 'complete'; outcome.failed = 0; outcome.errors = [] } }
      else if (activeEntry) { activeEntry.status = 'failed'; activeEntry.attempts++; activeEntry.error = safe; activeEntry.processor = undefined; activeEntry.processingUntil = undefined }
      updatedVoice.revision++; this.commit(latest, next, `telegram:${receipt.telegram.botId}:${receipt.telegram.updateId}:failed:${randomUUID()}`, { state: [{ key: 'voiceInbox.v1', value: updatedVoice, expectedRevision: latestVoice.revision }] })
    } finally { if (this.active(config)) this.phase = 'polling' }
  }
}

/** Cookie/account selection belongs to host.ts; local requests also require loopback Host. */
export async function handleTelegramRequest(service: TelegramCapture, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!memoryOriginAllowed(req) || !req.headers['x-wv-client']) return sendMemoryJson(res, 403, { error: 'Open Sources in the authorized workspace to manage Telegram capture.' })
  const action = (req.url ?? '').split('?')[0].split('/').filter(Boolean)[3]
  try {
    if (req.method === 'GET' && !action) return sendMemoryJson(res, 200, service.status())
    if (req.method === 'DELETE' && !action) { service.disconnect(); return sendMemoryJson(res, 200, service.status()) }
    if (req.method !== 'POST') return sendMemoryJson(res, 405, { error: 'Method not allowed.' })
    const body = await readMemoryBody(req)
    if (!action) return sendMemoryJson(res, 200, await service.configure(body))
    if (action === 'probe') return sendMemoryJson(res, 200, await service.probe(typeof body.token === 'string' && body.token.trim() ? body.token.trim() : undefined))
    if (action === 'discover') return sendMemoryJson(res, 200, await service.discover())
    if (action === 'poll') { await service.pollOnce(); return sendMemoryJson(res, 200, service.status()) }
    if (action === 'retry' && typeof body.receiptId === 'string') { await service.retry(body.receiptId); return sendMemoryJson(res, 200, service.status()) }
    return sendMemoryJson(res, 404, { error: 'Unknown Telegram action.' })
  } catch (error) { return sendMemoryJson(res, error instanceof TelegramApiError ? error.status : 400, { error: error instanceof TelegramApiError ? error.message : 'Telegram request could not complete. Check configuration and retry.' }) }
}
