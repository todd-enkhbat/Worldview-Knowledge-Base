import type Anthropic from '@anthropic-ai/sdk'
import { useWorld } from '../../app/store.ts'
import { addAttachment, addNodes, getStore, type NodeDraftInput } from '../../data/repo.ts'
import { parseVault, type VaultFile } from '../../data/obsidian.ts'
import { maxTemporalOrigin } from '../../domain/validate.ts'
import type { Archetype, Embed, Link, NodeRecord, ReferenceDate, TemporalPrecision, WorldSettings } from '../../domain/types.ts'
import { fuzzyMatchFields } from '../../hud/fuzzy.ts'
import { isSemanticReady, searchSemantic } from '../semanticIndex.ts'
import { MAX_ATTACHMENT_BYTES, sniffBlob } from '../../data/attachments.ts'
import { formatBytes, previewBytes } from './preview.ts'
import type { ProposedNote, ReadRecordInput } from './protocol.ts'
import { initializeKnowledge, isKnowledgeNodeAllowed, readKnowledgePassage, searchKnowledge, useKnowledge } from '../../knowledge/index.ts'
import { useWorkspace } from '../../workspace/state.ts'
import type { KnowledgePassage, SearchFilters, SourceKind } from '../../knowledge/types.ts'
import { resolveVaultLink } from '../../knowledge/vault.ts'
import { buildEvidencePacket } from '../../knowledge/contextPacket.ts'
import { artifactContext } from '../../knowledge/artifacts/policy.ts'
import { ARTIFACTS_KV, emptyArtifacts, type ArtifactSnapshot } from '../../knowledge/artifacts/types.ts'

// Turning intake into world records: proposals kept from the chat, Obsidian vaults, files
// and pages as Claude content blocks, and search_world for the model.

// ─── dates ───────────────────────────────────────────────────────────────────────────

export function isoToEpoch(iso: string): number {
  const [y, m = '1', d = '1'] = iso.split('-')
  return Date.UTC(+y, +m - 1, +d)
}

/**
 * Fit a date into the world. The world starts at T0 (nothing can enter your life before it),
 * so an earlier date (Boltzmann's 1844) becomes a display-only reference date and the note
 * enters at T0; a date past the horizon is clamped.
 */
export function fitDate(
  epochMs: number,
  precision: TemporalPrecision,
  settings: Pick<WorldSettings, 'T0'>,
  now: number,
): { temporalOrigin: number; temporalPrecision: TemporalPrecision; referenceDate: ReferenceDate | null } {
  if (epochMs < settings.T0) return { temporalOrigin: settings.T0, temporalPrecision: 'day', referenceDate: { epochMs, precision } }
  const max = maxTemporalOrigin(now)
  return { temporalOrigin: Math.min(epochMs, max), temporalPrecision: precision, referenceDate: null }
}

// ─── proposals ───────────────────────────────────────────────────────────────────────

/**
 * A kept proposal as a node draft. `ids` maps proposal keys already kept (and existing note
 * ids, which map to themselves) to world ids; links to anything else are left for later.
 */
export function proposalToDraft(
  note: ProposedNote,
  id: string,
  ids: ReadonlyMap<string, string>,
  settings: Pick<WorldSettings, 'T0'>,
  now: number,
  model: string,
): NodeDraftInput {
  const links: Link[] = []
  for (const l of note.links) {
    const target = ids.get(l.to)
    if (target && target !== id && !links.some((x) => x.targetId === target)) links.push({ targetId: target, kind: l.kind, createdAt: now })
  }
  const ref = note.source.ref
  const embeds: Embed[] = (note.embeds ?? []).map((e) => ({
    id: crypto.randomUUID(),
    kind: e.kind,
    ...(e.url ? { url: e.url } : {}),
    ...(e.title ? { title: e.title } : {}),
    ...(e.place ? { place: e.place } : {}),
    addedAt: now,
  }))
  // A note drawn from a link keeps the link live even if Claude did not embed it.
  if (ref && /^https?:\/\//.test(ref) && !embeds.some((e) => e.url === ref)) {
    embeds.push({ id: crypto.randomUUID(), kind: youtubeId(ref) ? 'youtube' : 'web', url: ref, addedAt: now })
  }
  return {
    ...(embeds.length ? { embeds } : {}),
    id,
    archetype: note.kind as Archetype,
    title: note.title,
    contentMd: note.body,
    tags: [...new Set(note.tags.map((t) => t.toLowerCase().replace(/\s+/g, '-')))],
    ...fitDate(isoToEpoch(note.date.iso), note.date.precision, settings, now),
    links,
    provenance: {
      source: ref ? (/^https?:\/\//.test(ref) ? 'url' : 'file') : 'chat',
      ...(ref ? { ref } : {}),
      ...(note.source.quote ? { quote: note.source.quote } : {}),
      model,
      keptAt: now,
    },
  }
}

const VIDEO_NAME = /\.(mp4|m4v|mov|webm|mkv|avi)$/i
/** Most of a staged file's text a note keeps as its body when kept without Claude. */
const STAGED_BODY_MAX = 20_000

/**
 * What a staged item says in text (a text file's contents, a dataset or database preview, a
 * transcript), without the <file> wrapper, or '' when it only describes the file for Claude.
 */
export function stagedBody(item: IntakeItem): string {
  if (item.kind === 'image' || item.kind === 'pdf') return ''
  const parts: string[] = []
  for (const b of item.blocks) {
    if (b.type !== 'text') continue
    const inner = b.text.replace(/^<file\b[^>]*>\n?/, '').replace(/\n?<\/file>\s*$/, '').trim()
    // Lines meant for Claude ("…; ask what it is.") are not the file's content.
    const kept = inner
      .split('\n')
      .filter((l) => !/ask what (it is|it shows)\.$/.test(l.trim()))
      .join('\n')
      .trim()
    if (kept) parts.push(kept)
  }
  const text = parts.join('\n\n')
  return text.length > STAGED_BODY_MAX ? `${text.slice(0, STAGED_BODY_MAX)}\n… (shortened; the original is attached)` : text
}

/**
 * A staged file or link kept as it is, without Claude: titled from its name, dated by the
 * file's own date (a guess, so marked uncertain), and a memory when it is a picture or a video.
 */
export function stagedProposal(item: IntakeItem, key: string, now = Date.now()): ProposedNote | null {
  const f = item.file
  if (!f && !item.url) return null
  const visual = item.kind === 'image' || !!f?.type.startsWith('video/') || VIDEO_NAME.test(item.name)
  const title = (f ? f.name.replace(/\.[^.]+$/, '') : item.name).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled'
  const d = new Date(f?.lastModified || now)
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return {
    key,
    kind: visual ? 'memory' : 'document',
    title,
    body: stagedBody(item),
    date: { iso, precision: 'day', certain: false },
    tags: [],
    links: [],
    source: { ref: item.url ?? f?.name },
    ...(f ? { attach: [f.name] } : {}),
  }
}

/** The video id of a YouTube watch, short or embed link, or null. */
export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\.|^m\./, '')
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.searchParams.get('v')) return u.searchParams.get('v')
      const m = /^\/(?:embed|shorts|live)\/([\w-]+)/.exec(u.pathname)
      return m?.[1] ?? null
    }
  } catch {
    // not a URL
  }
  return null
}

// ─── search_world ────────────────────────────────────────────────────────────────────

export interface WorldHit {
  id: string
  title: string
  kind: Archetype
  date: string
  referenceDate: string | null
  tags: string[]
  excerpt: string
  start: number
  end: number
  digest: string
  citationUrl: string
  updatedAt: number
}

/** SHA-256 identifies the exact current record, not an unverifiable model-written quote. */
export async function recordDigest(r: Pick<NodeRecord, 'id' | 'title' | 'contentMd' | 'updatedAt'>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([r.id, r.title, r.contentMd, r.updatedAt]))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('')
}

export interface EvidenceCitation {
  citationUrl: string
  title: string
  nodeId?: string
  sourceId?: string
  passageId?: string
  digest?: string
  updatedAt?: number
  versionId?: string
}

export function evidenceScope(): string[] {
  return [...useWorkspace.getState().sourceIds]
}

export function evidenceFilters(): SearchFilters {
  const state = useWorkspace.getState()
  const after = state.authoredAfter ? Date.parse(`${state.authoredAfter}T00:00:00Z`) : NaN
  const before = state.authoredBefore ? Date.parse(`${state.authoredBefore}T23:59:59.999Z`) : NaN
  return {
    aiOnly: true,
    engine: state.retrievalEngine,
    ...(state.sourceIds.length ? { sourceIds: evidenceScope() } : {}),
    ...(state.role && state.role !== 'all' ? { role: state.role } : {}),
    ...(state.sourceKind && state.sourceKind !== 'all' ? { kinds: [state.sourceKind as SourceKind] } : {}),
    ...(Number.isFinite(after) ? { authoredAfter: after } : {}),
    ...(Number.isFinite(before) ? { authoredBefore: before } : {}),
  }
}

function passageInInvestigation(passage: Pick<KnowledgePassage, 'role' | 'authoredAt'>): boolean {
  const filters = evidenceFilters()
  if (filters.role && passage.role !== filters.role) return false
  if (filters.authoredAfter !== undefined && (passage.authoredAt === null || passage.authoredAt < filters.authoredAfter)) return false
  if (filters.authoredBefore !== undefined && (passage.authoredAt === null || passage.authoredAt > filters.authoredBefore)) return false
  return true
}

function liveModelRecord(id: string): boolean {
  const record = useWorld.getState().nodes.get(id)
  return !!record && record.deletedAt === null && isKnowledgeNodeAllowed(id, true)
}

/** Source restrictions apply to generated projections as well as their original passages. */
export function recordAllowedForModel(id: string): boolean {
  if (!liveModelRecord(id)) return false
  const filters = evidenceFilters()
  const knowledge = useKnowledge.getState()
  const sources = knowledge.sources.filter((s) => s.nodeId === id && !s.excluded && !s.deleted && s.aiAllowed && (!filters.sourceIds || filters.sourceIds.includes(s.id)) && (!filters.kinds || filters.kinds.includes(s.kind)))
  if ((filters.sourceIds || filters.kinds) && !sources.length) return false
  if (filters.role || filters.authoredAfter !== undefined || filters.authoredBefore !== undefined) {
    // Reading a whole conversation would otherwise leak turns outside a human-only or
    // dated investigation. Passage tools can select precisely within those sources.
    const passages = knowledge.passages.filter((p) => sources.some((s) => s.id === p.sourceId && s.currentVersionId === p.versionId))
    if (!passages.length || !passages.every(passageInInvestigation)) return false
  }
  return true
}

export function citationAllowed(citation: EvidenceCitation): boolean {
  if (citation.nodeId && !(citation.passageId ? liveModelRecord(citation.nodeId) : recordAllowedForModel(citation.nodeId))) return false
  if (citation.sourceId) {
    const source = useKnowledge.getState().sources.find((s) => s.id === citation.sourceId)
    if (!source || source.excluded || source.deleted || !source.aiAllowed) return false
    if (citation.versionId && citation.versionId !== source.currentVersionId) return false
    const filters = evidenceFilters()
    if (filters.sourceIds && !filters.sourceIds.includes(source.id)) return false
    if (filters.kinds && !filters.kinds.includes(source.kind)) return false
    if (citation.passageId) {
      const passage = useKnowledge.getState().passages.find((p) => p.id === citation.passageId && p.sourceId === source.id && p.versionId === source.currentVersionId)
      if (!passage || !passageInInvestigation(passage)) return false
    }
  }
  if (citation.nodeId && citation.updatedAt !== undefined && useWorld.getState().nodes.get(citation.nodeId)?.updatedAt !== citation.updatedAt) return false
  return !!(citation.nodeId || citation.sourceId)
}

function excerptOf(text: string, query: string, length = 600): { excerpt: string; start: number; end: number } {
  const lower = text.toLocaleLowerCase()
  const terms = [query.trim(), ...query.trim().split(/\s+/)].filter(Boolean)
  let match = -1
  for (const term of terms) {
    match = lower.indexOf(term.toLocaleLowerCase())
    if (match >= 0) break
  }
  const start = Math.max(0, (match < 0 ? 0 : match) - 140)
  const end = Math.min(text.length, start + length)
  return { excerpt: text.slice(start, end), start, end }
}

async function hit(r: NodeRecord, query: string): Promise<WorldHit> {
  const digest = await recordDigest(r)
  return {
    id: r.id,
    title: r.title,
    kind: r.archetype,
    date: new Date(r.temporalOrigin).toISOString().slice(0, 10),
    referenceDate: r.referenceDate ? new Date(r.referenceDate.epochMs).toISOString().slice(0, 10) : null,
    tags: r.tags,
    ...excerptOf(r.contentMd, query),
    digest,
    citationUrl: `#/library?record=${encodeURIComponent(r.id)}&digest=${digest}`,
    updatedAt: r.updatedAt,
  }
}

/** Semantic neighbours when the index is on, merged with keyword matches over title, tags and text. */
export async function searchWorld(query: string, limit = 8): Promise<WorldHit[]> {
  await initializeKnowledge()
  const boundedLimit = Math.min(20, Math.max(1, Math.trunc(limit)))
  const nodes = useWorld.getState().nodes
  const out = new Map<string, NodeRecord>()
  if (isSemanticReady()) {
    for (const n of await searchSemantic(query, boundedLimit).catch(() => [])) {
      const r = nodes.get(n.id)
      if (r && recordAllowedForModel(r.id)) out.set(r.id, r)
    }
  }
  const ranked: { r: NodeRecord; score: number }[] = []
  const phrase = query.trim().toLocaleLowerCase()
  const terms = phrase.split(/\s+/).filter(Boolean)
  for (const r of nodes.values()) {
    if (!recordAllowedForModel(r.id)) continue
    // The title matcher deliberately caps fields at 512 characters. Exact lexical
    // matching scans the whole body instead of silently inheriting that UI limit.
    const m = fuzzyMatchFields(query, [r.title, r.tags.join(' ')])
    const body = r.contentMd.toLocaleLowerCase()
    const all = `${r.title}\n${r.tags.join(' ')}\n${body}`.toLocaleLowerCase()
    const lexical = body.includes(phrase) ? 150 : terms.length && terms.every((term) => all.includes(term)) ? 70 : null
    if (m || lexical !== null) ranked.push({ r, score: Math.max(m?.score ?? -Infinity, lexical ?? -Infinity) })
  }
  ranked.sort((a, b) => b.score - a.score)
  for (const { r } of ranked) {
    if (out.size >= boundedLimit) break
    out.set(r.id, r)
  }
  // Policy or deletion can change while a semantic query or digest is being computed.
  const results = await Promise.all([...out.values()].slice(0, boundedLimit).map((r) => hit(r, query)))
  return results.filter((r) => {
    const current = useWorld.getState().nodes.get(r.id)
    return recordAllowedForModel(r.id) && current?.updatedAt === r.updatedAt && current.contentMd.slice(r.start, r.end) === r.excerpt
  })
}

export async function readRecord(input: ReadRecordInput) {
  await initializeKnowledge()
  if (!recordAllowedForModel(input.id)) return { ok: false as const, error: 'not_available', message: 'This record is missing, deleted, outside the selected investigation or excluded from AI use.' }
  const record = useWorld.getState().nodes.get(input.id)!
  const digest = await recordDigest(record)
  if (!recordAllowedForModel(input.id)) return { ok: false as const, error: 'not_available', message: 'This record is no longer available to AI.' }
  if (useWorld.getState().nodes.get(input.id) !== record) return { ok: false as const, error: 'record_changed', message: 'The record changed while being read. Search again before citing it.' }
  if (input.digest && input.digest !== digest) return { ok: false as const, error: 'record_changed', message: 'The record changed after search. Search again before citing its current content.' }
  const offset = Math.min(record.contentMd.length, Math.max(0, Math.trunc(input.offset ?? 0)))
  const end = Math.min(record.contentMd.length, offset + Math.min(8000, Math.max(1, Math.trunc(input.limit ?? 4000))))
  return {
    ok: true as const,
    id: record.id,
    title: record.title,
    kind: record.archetype,
    temporalOrigin: record.temporalOrigin,
    temporalPrecision: record.temporalPrecision,
    referenceDate: record.referenceDate,
    createdAt: record.createdAt,
    provenance: record.provenance ?? null,
    authorship: 'Read provenance and original source roles before attributing this record to the user.',
    text: record.contentMd.slice(offset, end),
    offset,
    end,
    totalLength: record.contentMd.length,
    nextOffset: end < record.contentMd.length ? end : null,
    digest,
    updatedAt: record.updatedAt,
    citationUrl: `#/library?record=${encodeURIComponent(record.id)}&digest=${digest}`,
  }
}

export async function searchPassagesForModel(query: string, limit = 8) {
  await initializeKnowledge()
  const hits = await searchKnowledge(query, { ...evidenceFilters(), limit: Math.min(20, Math.max(1, limit)) })
  return hits.filter((h) => citationAllowed({ sourceId: h.sourceId, nodeId: h.nodeId, passageId: h.id, versionId: h.versionId, title: h.title, citationUrl: '' })).map((h) => ({ ...h, citationUrl: `#/library?passage=${encodeURIComponent(h.id)}` }))
}

export async function readPassageForModel(id: string) {
  await initializeKnowledge()
  const passage = await readKnowledgePassage(id, { aiOnly: true })
  if (!passage || !citationAllowed({ sourceId: passage.sourceId, nodeId: passage.nodeId, passageId: passage.id, versionId: passage.versionId, title: passage.title, citationUrl: '' })) {
    return { ok: false as const, error: 'not_available', message: 'This passage is missing, stale, outside the selected investigation or excluded from AI use.' }
  }
  return { ok: true as const, ...passage, citationUrl: `#/library?passage=${encodeURIComponent(passage.id)}` }
}

export async function readMemoryContextForModel(query: string, maxBytes = 16384) {
  const hits = await searchPassagesForModel(query, 20)
  const artifacts = await getStore().getKv<ArtifactSnapshot>(ARTIFACTS_KV) ?? emptyArtifacts()
  const snapshot = useKnowledge.getState(), filters = evidenceFilters()
  return buildEvidencePacket(query, snapshot, hits, artifactContext(artifacts, snapshot, { sourceIds: filters.sourceIds, aiOnly: true }), { filters, maxBytes })
}

// ─── files and pages as content blocks ───────────────────────────────────────────────

/** Claude reads whole PDFs up to this size; larger ones are kept and described. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024
/** Images over this size (or in a type the API cannot take) are re-encoded for Claude. */
const IMAGE_SEND_BYTES = 3.5 * 1024 * 1024
const IMAGE_MAX_EDGE = 1568
const API_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export type IntakeBlock = Anthropic.ContentBlockParam

export interface IntakeItem {
  name: string
  kind: 'pdf' | 'image' | 'text' | 'page' | 'file'
  bytes: number
  /** What Claude reads: the file itself, a preview, or a description (plus a frame for video). */
  blocks: IntakeBlock[]
  /** The original, kept with the note when Claude attaches it (absent for pages). */
  file?: File
  /** For pages and videos: the link, so a kept note can embed it. */
  url?: string
}

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

const header = (file: File, mime: string, extra = '') =>
  `<file name=${JSON.stringify(file.name)} type=${JSON.stringify(mime || 'unknown')} size=${JSON.stringify(formatBytes(file.size))} original="kept"${extra}>`

/** Re-encode an image as JPEG within IMAGE_MAX_EDGE (HEIC, huge photos). Null if undecodable. */
async function imageForClaude(blob: Blob): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null
  try {
    const bmp = await createImageBitmap(blob)
    const k = Math.min(1, IMAGE_MAX_EDGE / Math.max(bmp.width, bmp.height))
    const canvas = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k))
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    bmp.close()
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
  } catch {
    return null
  }
}

async function imageBlock(blob: Blob, type: string): Promise<IntakeBlock> {
  return { type: 'image', source: { type: 'base64', media_type: type as 'image/png', data: base64(await blob.arrayBuffer()) } }
}

/** Duration and a frame from 10 % in, for video and audio (browser media elements). */
async function mediaProbe(file: File, video: boolean): Promise<{ seconds: number | null; frame: Blob | null }> {
  if (typeof document === 'undefined') return { seconds: null, frame: null }
  const url = URL.createObjectURL(file)
  const el = document.createElement(video ? 'video' : 'audio')
  el.preload = 'metadata'
  el.muted = true
  el.src = url
  const wait = (ev: string) =>
    new Promise<boolean>((res) => {
      const t = setTimeout(() => res(false), 8000)
      el.addEventListener(ev, () => (clearTimeout(t), res(true)), { once: true })
      el.addEventListener('error', () => (clearTimeout(t), res(false)), { once: true })
    })
  try {
    if (!(await wait('loadedmetadata'))) return { seconds: null, frame: null }
    const seconds = Number.isFinite(el.duration) ? el.duration : null
    if (!video || !seconds) return { seconds, frame: null }
    el.currentTime = seconds * 0.1
    if (!(await wait('seeked'))) return { seconds, frame: null }
    const v = el as HTMLVideoElement
    const k = Math.min(1, IMAGE_MAX_EDGE / Math.max(v.videoWidth, v.videoHeight, 1))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(v.videoWidth * k))
    canvas.height = Math.max(1, Math.round(v.videoHeight * k))
    canvas.getContext('2d')!.drawImage(v, 0, 0, canvas.width, canvas.height)
    const frame = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.85))
    return { seconds, frame }
  } finally {
    el.removeAttribute('src')
    URL.revokeObjectURL(url)
  }
}

const minutes = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

/**
 * Any file as what Claude reads plus the original to keep. PDFs and images go in whole (images
 * re-encoded when too big or in a type the API cannot take); text goes in as text; everything
 * else as a preview (datasets, contacts, calendars, zips, Office files), a frame and a duration
 * (video), or a plain description, and Claude asks about the rest.
 */
export async function fileToIntake(file: File): Promise<IntakeItem | { error: string }> {
  if (file.size > MAX_ATTACHMENT_BYTES) return { error: `${file.name} is over ${MAX_ATTACHMENT_BYTES >> 20} MB, the most one note can keep.` }
  const { mime, kind } = await sniffBlob(file, file.name)
  const base = { name: file.name, bytes: file.size, file }

  if (mime === 'application/pdf') {
    if (file.size <= MAX_PDF_BYTES) {
      return { ...base, kind: 'pdf', blocks: [{ type: 'document', title: file.name, source: { type: 'base64', media_type: 'application/pdf', data: base64(await file.arrayBuffer()) } }] }
    }
    return { ...base, kind: 'pdf', blocks: [{ type: 'text', text: `${header(file, mime)}\nA PDF too large to read in full here; ask what it is.\n</file>` }] }
  }

  if (kind === 'image') {
    const direct = API_IMAGE_TYPES.has(mime) && file.size <= IMAGE_SEND_BYTES
    const sendable = direct ? file : await imageForClaude(file)
    const blocks: IntakeBlock[] = [{ type: 'text', text: `${header(file, mime)}</file>` }]
    if (sendable) blocks.push(await imageBlock(sendable, direct ? mime : 'image/jpeg'))
    else blocks[0] = { type: 'text', text: `${header(file, mime)}\nAn image this browser cannot decode; ask what it shows.\n</file>` }
    return { ...base, kind: 'image', blocks }
  }

  if (kind === 'text' && !/\.(csv|tsv|json|geojson|ipynb)$/i.test(file.name)) {
    const text = file.size > 2 * 1024 * 1024 ? `${await file.slice(0, 2 * 1024 * 1024).text()}\n… (truncated)` : await file.text()
    return { ...base, kind: 'text', blocks: [{ type: 'text', text: `${header(file, mime)}\n${text}\n</file>` }] }
  }

  if (mime.startsWith('video/') || mime.startsWith('audio/')) {
    const video = mime.startsWith('video/')
    const { seconds, frame } = await mediaProbe(file, video)
    const what = `${video ? 'A video' : 'An audio recording'}${seconds ? ` of ${minutes(seconds)}` : ''}.${video && frame ? ' A frame from 10% in follows.' : ''} You cannot ${video ? 'watch' : 'hear'} the rest: ask what it is.`
    const blocks: IntakeBlock[] = [{ type: 'text', text: `${header(file, mime)}\n${what}\n</file>` }]
    if (frame) blocks.push(await imageBlock(frame, 'image/jpeg'))
    return { ...base, kind: 'file', blocks }
  }

  // Datasets, contacts, calendars, zips, Office files: a preview. Anything else: a description.
  const readable = file.size <= 50 * 1024 * 1024
  const preview = readable ? previewBytes(file.name, mime, new Uint8Array(await file.arrayBuffer())) : null
  const body = preview ?? `A ${mime === 'application/octet-stream' ? 'file' : mime} file that cannot be previewed here; ask what it is.`
  return { ...base, kind: 'file', blocks: [{ type: 'text', text: `${header(file, mime)}\n${body}\n</file>` }] }
}

/** A fetched page or video (server/fetchUrl.ts) as a content block. */
export async function urlToIntake(url: string, f: typeof fetch = fetch): Promise<IntakeItem | { error: string }> {
  try {
    const res = await f('/api/fetch-url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) })
    const body = (await res.json()) as { url: string; title: string; text: string; truncated: boolean; kind?: 'youtube' | 'web' } | { error: string }
    if (!res.ok || 'error' in body) return { error: 'error' in body ? body.error : `Could not read ${url}.` }
    const tag = body.kind === 'youtube' ? 'video' : 'page'
    return {
      name: body.title,
      kind: 'page',
      bytes: body.text.length,
      url: body.url,
      blocks: [
        {
          type: 'text',
          text: `<${tag} url=${JSON.stringify(body.url)} title=${JSON.stringify(body.title)}${body.truncated ? ' truncated="true"' : ''}>\n${body.text}\n</${tag}>`,
        },
      ],
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/g

// ─── folders and Obsidian vaults ─────────────────────────────────────────────────────

/** Every file in a folder, with its path inside it. */
export interface FolderFile {
  path: string
  file: File
}

/** A folder is a vault when it has an .obsidian folder or is mostly markdown. */
export function isVault(files: readonly FolderFile[]): boolean {
  if (files.some((f) => f.path.startsWith('.obsidian/'))) return true
  const visible = files.filter((f) => !f.path.split('/').some((p) => p.startsWith('.')))
  const md = visible.filter((f) => /\.md$/i.test(f.path)).length
  return md > 0 && md >= visible.length / 2
}

/**
 * Import a vault as one undoable step, with no Claude. Files a note embeds or links
 * (![[photo.jpg]], [[paper.pdf]], or attachments/<note>/ from an export here) are attached.
 */
export async function importVault(
  folder: readonly FolderFile[],
  now = Date.now(),
  opts: { shouldWrite?: () => boolean } = {},
): Promise<{ added: number; lossless: number; unresolved: number; skipped: number; attached: number }> {
  const active = () => opts.shouldWrite?.() !== false
  if (!active()) return { added: 0, lossless: 0, unresolved: 0, skipped: 0, attached: 0 }
  const settings = useWorld.getState().settings
  if (!settings) throw new Error('The world is not ready yet.')
  const visible = folder.filter((f) => !f.path.split('/').some((p) => p.startsWith('.')))
  const md: VaultFile[] = await Promise.all(
    visible.filter((f) => /\.md$/i.test(f.path)).map(async (f) => ({ path: f.path, text: await f.file.text(), lastModified: f.file.lastModified })),
  )
  if (!active()) return { added: 0, lossless: 0, unresolved: 0, skipped: 0, attached: 0 }
  const byPath = new Map<string, File>()
  const attachmentCandidates: { id: string; path: string }[] = []
  for (const f of visible) {
    if (/\.md$/i.test(f.path)) continue
    byPath.set(f.path.toLowerCase(), f.file)
    attachmentCandidates.push({ id: f.path, path: f.path })
  }
  const { drafts, files, lossless, unresolved } = parseVault(md, { now })
  const fitted = drafts.map((d) =>
    d.schemaVersion !== undefined
      ? d // exported by this app: already valid for a world, keep it exactly
      : { ...d, ...fitDate(d.temporalOrigin ?? now, d.temporalPrecision ?? 'day', settings, now) },
  )
  const added = await addNodes(fitted, { label: `Imported ${fitted.length} notes from Obsidian`, shouldWrite: active })
  if (!active()) return { added: added.length, lossless, unresolved, skipped: fitted.length - added.length, attached: 0 }
  let attached = 0
  for (const rec of added) {
    for (const ref of files.get(rec.id) ?? []) {
      if (!active()) return { added: added.length, lossless, unresolved, skipped: fitted.length - added.length, attached }
      const fromPath = rec.provenance?.source === 'obsidian' ? rec.provenance.ref ?? `${rec.title}.md` : `${rec.title}.md`
      const resolution = resolveVaultLink(fromPath, ref, attachmentCandidates)
      const file = resolution.status === 'resolved' ? byPath.get(resolution.path.toLowerCase()) : undefined
      if (!file) continue
      await addAttachment(rec.id, file, file.name, { shouldWrite: active })
        .then(() => attached++)
        .catch(() => {})
      if (!active()) return { added: added.length, lossless, unresolved, skipped: fitted.length - added.length, attached }
    }
  }
  return { added: added.length, lossless, unresolved, skipped: fitted.length - added.length, attached }
}

/** Read every file under a dropped directory entry (webkitGetAsEntry), hidden ones included. */
export async function readDirectoryEntry(entry: FileSystemDirectoryEntry): Promise<FolderFile[]> {
  const out: FolderFile[] = []
  const walk = async (dir: FileSystemDirectoryEntry, prefix: string): Promise<void> => {
    const reader = dir.createReader()
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
      if (!batch.length) break
      for (const e of batch) {
        if (e.name === '.DS_Store' || e.name === '.git' || e.name === 'node_modules') continue
        if (e.isDirectory) await walk(e as FileSystemDirectoryEntry, `${prefix}${e.name}/`)
        else out.push({ path: `${prefix}${e.name}`, file: await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej)) })
      }
    }
  }
  await walk(entry, '')
  return out
}
