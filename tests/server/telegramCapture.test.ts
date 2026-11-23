import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TelegramCapture } from '../../server/telegramCapture.ts'
import { TelegramApi, type TelegramUpdate } from '../../server/telegramApi.ts'
import { openWorldDb } from '../../server/worldDb.ts'
import { SCHEMA_VERSION } from '../../src/domain/types.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'
import type { VoiceSnapshot } from '../../src/capture/voiceInbox.ts'
import type { Transcript } from '../../src/ai/transcribe.ts'

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWX', BOT = { id: 123456, username: 'worldview_test_bot', is_bot: true }
const settings = { T0: Date.UTC(1990, 0, 1), yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto' as const, firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: Date.now(), schemaVersion: SCHEMA_VERSION }
const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.restoreAllMocks() })
function update(id: number, extra: Record<string, unknown> = {}): TelegramUpdate { return { update_id: id, message: { message_id: id, date: 1_790_000_000, chat: { id: 11, type: 'private' }, from: { id: 7, is_bot: false }, text: `Synthetic amber orchard decision ${id}.`, ...extra } } }
function fixture(transcribe?: (input: { bytes: Uint8Array; mime: string; signal?: AbortSignal }) => Promise<Transcript>) {
  const dir = mkdtempSync(join(tmpdir(), 'wv-telegram-')), db = openWorldDb(join(dir, 'world.sqlite')); db.putSettings(settings)
  const pending: ReturnType<typeof update>[] = [], calls: { url: string; body: Record<string, unknown> }[] = [], audio = new Uint8Array([1, 2, 3, 4])
  let failedDownload = false, webhook = false
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url), body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>; calls.push({ url: value, body })
    if (value.includes('/file/bot')) { if (failedDownload) return new Response('no', { status: 503 }); return new Response(audio, { headers: { 'content-length': String(audio.length) } }) }
    const method = value.split('/').at(-1)
    const result = method === 'getMe' ? BOT : method === 'getWebhookInfo' ? { url: webhook ? 'https://existing.example/webhook' : '' } : method === 'getUpdates' ? pending.filter((entry) => entry.update_id >= Number(body.offset ?? 0)) : method === 'getFile' ? { file_path: 'voice/test.ogg', file_size: audio.length } : method === 'sendMessage' ? { message_id: 987 } : null
    return new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const service = new TelegramCapture({ db, blobDir: join(dir, 'blobs'), token: TOKEN, fetch: fetcher, autoPoll: false, transcribe })
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }) }, () => service.close())
  const connect = (extra: Record<string, unknown> = {}) => service.configure({ userIds: [7], chatIds: [11], enabled: true, ...extra })
  return { dir, db, service, pending, calls, audio, fetcher, connect, snapshot: () => db.getKv<KnowledgeSnapshot>('knowledge.v1')!, failDownload: (value: boolean) => { failedDownload = value }, setWebhook: (value: boolean) => { webhook = value } }
}

describe('Telegram original-first capture', () => {
  it('stays disabled without explicit scope, probes without exposing credentials and preserves existing webhooks', async () => {
    const f = fixture(); expect(f.calls).toEqual([]); expect(f.service.status()).toMatchObject({ configured: true, enabled: false })
    await expect(f.service.configure({ enabled: true })).rejects.toThrow(/both an allowed sender/)
    f.setWebhook(true); await expect(f.connect()).rejects.toThrow(/already has a webhook/)
    expect(f.calls.some((call) => call.url.includes('deleteWebhook'))).toBe(false)
    expect(JSON.stringify(f.service.status())).not.toContain(TOKEN)
  })
  it('imports only an allowed sender/chat, retains exact raw updates, and does not create or move 3D records', async () => {
    const f = fixture(); f.pending.push(update(1), update(2, { from: { id: 8 } }), update(3, { chat: { id: 12, type: 'group' } }))
    await f.connect(); await f.service.pollOnce()
    expect(f.snapshot().sources).toHaveLength(1); expect(f.snapshot().sources[0].nodeId).toBeUndefined(); expect(f.db.listNodes()).toEqual([])
    expect(f.snapshot().passages[0]).toMatchObject({ text: 'Synthetic amber orchard decision 1.', role: 'unknown' })
    const original = f.snapshot().versions[0]; expect(JSON.parse(readFileSync(join(f.dir, 'blobs', original.originalBlobId), 'utf8'))).toEqual(f.pending[0])
    expect(f.service.status().offset).toBe(4); expect(f.calls.filter((call) => call.url.endsWith('sendMessage'))).toEqual([])
    const ids = f.snapshot().passages.map((passage) => passage.id); await f.service.pollOnce(); expect(f.snapshot().passages.map((passage) => passage.id)).toEqual(ids)
  })
  it('keeps explicit human attribution separate from forwarded third-party material and appends edited versions', async () => {
    const f = fixture(); f.pending.push(update(1), update(2, { forward_origin: { type: 'hidden_user', sender_user_name: 'Original speaker' } }))
    await f.connect({ ownMessages: true }); await f.service.pollOnce()
    expect(f.snapshot().passages.map((passage) => passage.role)).toEqual(['human', 'third-party'])
    const source = f.snapshot().sources[0]; f.pending.push({ update_id: 3, message: { ...f.pending[0].message!, text: 'Corrected orchard decision.', edit_date: 1_790_000_100 } }); await f.service.pollOnce()
    expect(f.snapshot().sources[0].id).toBe(source.id); expect(f.snapshot().versions).toHaveLength(3); expect(f.snapshot().versions.at(-1)?.previousVersionId).toBe(source.currentVersionId)
  })
  it('captures audio and receipt before local inference, publishes timed exact text and associates one project atomically', async () => {
    const inference = vi.fn(async (): Promise<Transcript> => {
      const db = f.db, dir = f.dir
      const corpus = db.getKv<KnowledgeSnapshot>('knowledge.v1')!, voice = db.getKv<VoiceSnapshot>('voiceInbox.v1')!
      expect(corpus.imports[0].status).toBe('running'); expect(voice.entries[0].status).toBe('transcribing'); expect(readFileSync(join(dir, 'blobs', voice.entries[0].blobId))).toEqual(Buffer.from([1, 2, 3, 4]))
      return { text: 'Aurora launches December twelve.', chunks: [{ start: 0, end: 3, text: 'Aurora launches' }, { start: 3, end: 6, text: 'December twelve.' }] }
    })
    const f = fixture(inference), db = f.db
    db.putKv('collections.v1', { schemaVersion: 1, revision: 1, collections: [{ id: 'project-a', title: 'Project', query: '', questions: [], sourceIds: [], role: 'all', sourceKind: 'all', authoredAfter: '', authoredBefore: '', updatedAt: 1 }] })
    f.pending.push(update(1, { text: undefined, voice: { file_id: 'audio-one', file_size: 4, mime_type: 'audio/ogg' } }))
    await f.connect({ autoTranscribe: true, projectId: 'project-a' }); await f.service.pollOnce()
    expect(inference).toHaveBeenCalledTimes(1)
    const snapshot = f.snapshot(), voice = db.getKv<VoiceSnapshot>('voiceInbox.v1')!
    expect(voice.entries[0]).toMatchObject({ status: 'ready', sourceId: snapshot.sources[0].id, externalId: `telegram:${BOT.id}:11:1` })
    expect(snapshot.versions).toHaveLength(2); expect(snapshot.versions.at(-1)?.authoredAt).toBeNull()
    const version = snapshot.versions.at(-1)!; expect(version.text).toBe('Aurora launches\nDecember twelve.'); expect(snapshot.passages.every((passage) => snapshot.versions.find((v) => v.id === passage.versionId)?.text.slice(passage.start, passage.end) === passage.text)).toBe(true)
    expect(snapshot.passages.at(-1)?.locator).toContain('Audio'); expect(snapshot.imports[0]).toMatchObject({ status: 'complete', failed: 0 })
    expect(db.getKv<{ collections: { sourceIds: string[] }[] }>('collections.v1')?.collections[0].sourceIds).toEqual([snapshot.sources[0].id]); expect(db.listNodes()).toEqual([])
    await f.service.pollOnce(); expect(inference).toHaveBeenCalledTimes(1)
  })
  it('retains failed downloads for manual retry and continues later authorized messages', async () => {
    const f = fixture(); f.pending.push(update(1, { text: undefined, voice: { file_id: 'voice-one' } }), update(2)); f.failDownload(true)
    await f.connect(); await f.service.pollOnce(); expect(f.service.status().offset).toBe(3)
    expect(f.snapshot().imports[0]).toMatchObject({ status: 'failed', checkpoint: 0 }); expect(f.snapshot().sources).toHaveLength(1)
    f.failDownload(false); await f.service.retry(f.snapshot().imports[0].id)
    expect(f.snapshot().imports[0].status).toBe('complete'); expect(f.snapshot().sources).toHaveLength(2); expect(f.db.getKv<VoiceSnapshot>('voiceInbox.v1')?.entries).toHaveLength(1)
  })
  it('discards late transcription after access revocation and keeps originals available for recovery', async () => {
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve }), inference = vi.fn(async () => { await wait; return { text: 'Late secret transcript', chunks: [] } })
    const f = fixture(inference); f.pending.push(update(1, { text: undefined, voice: { file_id: 'voice-one' } })); await f.connect({ autoTranscribe: true })
    const poll = f.service.pollOnce(); await vi.waitFor(() => expect(inference).toHaveBeenCalled())
    const snapshot = f.snapshot(); snapshot.sources[0].aiAllowed = false; snapshot.revision++; f.db.putKv('knowledge.v1', snapshot)
    release(); await poll
    expect(f.snapshot().versions.every((version) => !version.text.includes('Late secret'))).toBe(true)
    expect(f.db.getKv<VoiceSnapshot>('voiceInbox.v1')?.entries[0]).toMatchObject({ status: 'failed' })
    expect(f.snapshot().imports[0].fileBlobIds.length).toBe(2)
  })
  it('cancels source publication across same-store restore and does not retain bot credentials in portable state', async () => {
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve }), inference = vi.fn(async () => { await wait; return { text: 'Old world words', chunks: [] } })
    const f = fixture(inference); f.pending.push(update(1, { text: undefined, voice: { file_id: 'voice-one' } })); await f.connect({ token: TOKEN, autoTranscribe: true })
    const poll = f.service.pollOnce(); const denied = expect(poll).rejects.toThrow(/workspace|stopped/); await vi.waitFor(() => expect(inference).toHaveBeenCalled())
    const portable = f.db.readWorldSnapshot(['knowledge.v1', 'voiceInbox.v1']); expect(portable.kv['telegram.config.v1']).toBeUndefined(); expect(JSON.stringify(portable)).not.toContain(TOKEN)
    f.db.wipe(); release(); await denied; expect(f.db.getKv('knowledge.v1')).toBeUndefined(); expect(f.service.status().enabled).toBe(false)
  })
  it('redacts transport failures and rejects oversized downloads before accepting their bytes', async () => {
    const badFetch = vi.fn(async () => { throw new Error(`secret at https://api.telegram.org/bot${TOKEN}/getMe`) }) as typeof fetch
    await expect(new TelegramApi(TOKEN, badFetch).call('getMe')).rejects.toThrow('Telegram could not be reached.')
    const getFile = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/big.ogg', file_size: 21 * 1024 * 1024 } }))) as typeof fetch
    await expect(new TelegramApi(TOKEN, getFile).download('large')).rejects.toThrow(/20 MiB/)
  })
  it('allows only one poller lease across local service instances and releases it on close', async () => {
    const f = fixture(); await f.connect(); await f.service.pollOnce()
    const second = new TelegramCapture({ db: f.db, blobDir: join(f.dir, 'blobs'), token: TOKEN, fetch: f.fetcher, autoPoll: false }); cleanup.push(() => second.close())
    await expect(second.pollOnce()).rejects.toThrow(/Another local service/)
    f.service.close(); await second.pollOnce(); expect(second.status().lastPollAt).not.toBeNull()
  })
  it('keeps retries from restoring revoked project or source access', async () => {
    const f = fixture(async () => { throw new Error('model unavailable') }); f.pending.push(update(1, { text: undefined, voice: { file_id: 'voice-one' } })); await f.connect({ autoTranscribe: true }); await f.service.pollOnce()
    const snapshot = f.snapshot(); snapshot.sources[0].excluded = true; snapshot.revision++; f.db.putKv('knowledge.v1', snapshot)
    await expect(f.service.retry(snapshot.imports[0].id)).rejects.toThrow(/access policy/)
    expect(f.snapshot().sources[0].excluded).toBe(true); expect(f.snapshot().versions).toHaveLength(1)
  })
  it('interrupts an idle long poll to retry a retained failure and prevents a competing retry', async () => {
    let failed = true, release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve }), inference = vi.fn(async () => { if (failed) throw new Error('First inference failed'); await held; return { text: 'Recovered voice.', chunks: [] } })
    const f = fixture(inference); f.pending.push(update(1, { text: undefined, voice: { file_id: 'voice-one' } })); await f.connect({ autoTranscribe: true }); await f.service.pollOnce()
    const id = f.snapshot().imports[0].id; failed = false
    vi.mocked(f.fetcher).mockImplementationOnce(async (_url, init) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('poll cancelled')), { once: true }) }))
    const poll = f.service.pollOnce(20); const polled = poll.catch(() => {})
    const retried = f.service.retry(id); await vi.waitFor(() => expect(inference).toHaveBeenCalledTimes(2))
    await expect(f.service.retry(id)).rejects.toThrow(/already processing/)
    release(); await retried; await polled
    expect(f.snapshot().imports[0].status).toBe('complete'); expect(f.db.getKv<VoiceSnapshot>('voiceInbox.v1')?.entries[0].status).toBe('ready'); expect(f.snapshot().versions.at(-1)?.text).toBe('Recovered voice.')
  })
})
