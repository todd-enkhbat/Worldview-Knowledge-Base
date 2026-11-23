// Real local OGG decoding and Whisper inference through the Telegram intake contract.
// Transport is a deterministic Telegram fixture; no Telegram credential/network is used.
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { TelegramCapture } from '../server/telegramCapture.ts'
import { localTranscriptionAvailability, transcribeLocalMedia, closeLocalTranscription } from '../server/localTranscription.ts'
import { openWorldDb } from '../server/worldDb.ts'
import { SCHEMA_VERSION } from '../src/domain/types.ts'
import { makeNodeDraft } from '../src/domain/validate.ts'
import type { KnowledgeSnapshot } from '../src/knowledge/types.ts'
import type { VoiceSnapshot } from '../src/capture/voiceInbox.ts'

const input = resolve(process.argv[2] ?? 'data/live-tests/voice/aurora-live.ogg'), bytes = new Uint8Array(await readFile(input)), available = localTranscriptionAvailability()
if (!available.available) throw new Error('Run the pinned Whisper model setup and install ffmpeg before this live local inference check.')
const dir = await mkdtemp(join(tmpdir(), 'worldview-telegram-asr-')), db = openWorldDb(join(dir, 'world.sqlite')), began = performance.now()
const bot = { id: 700001, username: 'synthetic_transport_bot', is_bot: true }, token = '700001:SYNTHETIC_LOCAL_TRANSPORT_ONLY'
const update = { update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000), from: { id: 41, is_bot: false }, chat: { id: 41, type: 'private' }, voice: { file_id: 'synthetic-ogg', file_size: bytes.length, mime_type: 'audio/ogg' } } }
const transport = async (url: string | URL | Request, init?: RequestInit) => {
  const path = String(url), body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
  if (path.includes('/file/bot')) return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
  const value = path.endsWith('/getMe') ? bot : path.endsWith('/getWebhookInfo') ? { url: '' } : path.endsWith('/getUpdates') ? Number(body.offset ?? 0) <= 1 ? [update] : [] : path.endsWith('/getFile') ? { file_path: 'voice/synthetic.ogg', file_size: bytes.length } : null
  return new Response(JSON.stringify({ ok: true, result: value }), { headers: { 'content-type': 'application/json' } })
}
const service = new TelegramCapture({ db, blobDir: join(dir, 'blobs'), token, fetch: transport as typeof fetch, autoPoll: false, transcribe: transcribeLocalMedia })
try {
  db.putSettings({ T0: Date.UTC(1990, 0, 1), yPerYear: 12, stepsPerYear: 600, physicsSeed: 41, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: Date.now(), schemaVersion: SCHEMA_VERSION })
  const spatial = makeNodeDraft('idea', { title: 'Preserved synthetic 3D reference', anchorXZ: [123, 45], fieldAnchorXZ: [456, 78] })
  db.putNodes([spatial]); const before = JSON.stringify(db.listNodes())
  await service.configure({ enabled: true, userIds: [41], chatIds: [41], ownMessages: true, autoTranscribe: true, acknowledge: false, language: 'en' })
  await service.pollOnce()
  const corpus = db.getKv<KnowledgeSnapshot>('knowledge.v1')!, voice = db.getKv<VoiceSnapshot>('voiceInbox.v1')!, version = corpus.versions.find((version) => version.id === corpus.sources[0].currentVersionId)!
  const original = new Uint8Array(await readFile(join(dir, 'blobs', voice.entries[0].blobId)))
  const exactCitations = corpus.passages.every((passage) => corpus.versions.find((version) => version.id === passage.versionId)?.text.slice(passage.start, passage.end) === passage.text)
  const findings = { recordedAt: new Date().toISOString(), telegramTransport: 'simulated fixture (real Bot API credentials not available)', speechInference: 'real local ffmpeg and pinned q8 Whisper', model: available.model, revision: available.revision, node: process.version, elapsedMs: Math.round(performance.now() - began), originalBytes: bytes.length, originalSha256: createHash('sha256').update(original).digest('hex'), originalMatchesInput: Buffer.from(original).equals(Buffer.from(bytes)), transcript: version.text, timedPassages: corpus.passages.map((passage) => ({ id: passage.id, sourceId: passage.sourceId, versionId: passage.versionId, role: passage.role, locator: passage.locator, text: passage.text })), exactCitations, voiceReady: voice.entries[0].status === 'ready', receiptComplete: corpus.imports[0].status === 'complete', worldRecordsUnchanged: JSON.stringify(db.listNodes()) === before, checks: { aurora: /aurora/i.test(version.text), december12: /december\s+(?:12|twelve)/i.test(version.text), amount312: /(?:\$?312|three hundred(?: and)? twelve)/i.test(version.text), lexicalSearch: db.searchKnowledge('Aurora December', { aiOnly: true }).hits.length > 0 } }
  if (!findings.originalMatchesInput || !findings.exactCitations || !findings.voiceReady || !findings.receiptComplete || !findings.worldRecordsUnchanged || Object.values(findings.checks).some((value) => !value)) throw new Error(`Telegram → original → real local ASR → exact citation check failed: ${JSON.stringify(findings)}`)
  await mkdir('docs/evaluations', { recursive: true }); await writeFile('docs/evaluations/telegram-local-voice-2026-11-23.json', JSON.stringify(findings, null, 2) + '\n')
  console.log(JSON.stringify({ ok: true, telegramTransport: findings.telegramTransport, speechInference: findings.speechInference, elapsedMs: findings.elapsedMs, timedPassages: findings.timedPassages.length, worldRecordsUnchanged: true, report: 'docs/evaluations/telegram-local-voice-2026-11-23.json' }))
} finally { service.close(); closeLocalTranscription(); db.close(); await rm(dir, { recursive: true, force: true }) }
