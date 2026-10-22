import type Anthropic from '@anthropic-ai/sdk'
import { useWorld } from '../../app/store.ts'
import { addAttachment, addNodes, type NodeDraftInput } from '../../data/repo.ts'
import { parseVault, type VaultFile } from '../../data/obsidian.ts'
import { maxTemporalOrigin } from '../../domain/validate.ts'
import type { Archetype, Embed, Link, NodeRecord, ReferenceDate, TemporalPrecision, WorldSettings } from '../../domain/types.ts'
import { fuzzyMatchFields } from '../../hud/fuzzy.ts'
import { isSemanticReady, searchSemantic } from '../semanticIndex.ts'
import { MAX_ATTACHMENT_BYTES, sniffBlob } from '../../data/attachments.ts'
import { formatBytes, previewBytes } from './preview.ts'
import type { ProposedNote } from './protocol.ts'

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
  tags: string[]
}

const hit = (r: NodeRecord): WorldHit => ({
  id: r.id,
  title: r.title,
  kind: r.archetype,
  date: new Date(r.referenceDate?.epochMs ?? r.temporalOrigin).toISOString().slice(0, 10),
  tags: r.tags,
})

/** Semantic neighbours when the index is on, merged with keyword matches over title, tags and text. */
export async function searchWorld(query: string, limit = 8): Promise<WorldHit[]> {
  const nodes = useWorld.getState().nodes
  const out = new Map<string, WorldHit>()
  if (isSemanticReady()) {
    for (const n of await searchSemantic(query, limit).catch(() => [])) {
      const r = nodes.get(n.id)
      if (r) out.set(r.id, hit(r))
    }
  }
  const ranked: { r: NodeRecord; score: number }[] = []
  for (const r of nodes.values()) {
    const m = fuzzyMatchFields(query, [r.title, r.tags.join(' '), r.contentMd.slice(0, 2000)])
    if (m) ranked.push({ r, score: m.score })
  }
  ranked.sort((a, b) => b.score - a.score)
  for (const { r } of ranked) {
    if (out.size >= limit) break
    out.set(r.id, hit(r))
  }
  return [...out.values()].slice(0, limit)
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
): Promise<{ added: number; lossless: number; unresolved: number; skipped: number; attached: number }> {
  const settings = useWorld.getState().settings
  if (!settings) throw new Error('The world is not ready yet.')
  const visible = folder.filter((f) => !f.path.split('/').some((p) => p.startsWith('.')))
  const md: VaultFile[] = await Promise.all(
    visible.filter((f) => /\.md$/i.test(f.path)).map(async (f) => ({ path: f.path, text: await f.file.text(), lastModified: f.file.lastModified })),
  )
  const byPath = new Map<string, File>()
  const byBase = new Map<string, File>()
  for (const f of visible) {
    if (/\.md$/i.test(f.path)) continue
    byPath.set(f.path.toLowerCase(), f.file)
    byBase.set(f.path.split('/').pop()!.toLowerCase(), f.file)
  }
  const { drafts, files, lossless, unresolved } = parseVault(md, { now })
  const fitted = drafts.map((d) =>
    d.schemaVersion !== undefined
      ? d // exported by this app: already valid for a world, keep it exactly
      : { ...d, ...fitDate(d.temporalOrigin ?? now, d.temporalPrecision ?? 'day', settings, now) },
  )
  const added = await addNodes(fitted, { label: `Imported ${fitted.length} notes from Obsidian` })
  let attached = 0
  for (const rec of added) {
    for (const ref of files.get(rec.id) ?? []) {
      const file = byPath.get(ref.toLowerCase()) ?? byBase.get(ref.split('/').pop()!.toLowerCase())
      if (!file) continue
      await addAttachment(rec.id, file, file.name)
        .then(() => attached++)
        .catch(() => {})
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
