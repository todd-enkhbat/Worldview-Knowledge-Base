import type Anthropic from '@anthropic-ai/sdk'
import { useWorld } from '../../app/store.ts'
import { addNodes, type NodeDraftInput } from '../../data/repo.ts'
import { parseVault, type VaultFile } from '../../data/obsidian.ts'
import { maxTemporalOrigin } from '../../domain/validate.ts'
import type { Archetype, Link, NodeRecord, ReferenceDate, TemporalPrecision, WorldSettings } from '../../domain/types.ts'
import { fuzzyMatchFields } from '../../hud/fuzzy.ts'
import { isSemanticReady, searchSemantic } from '../semanticIndex.ts'
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
  return {
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

export const MAX_FILE_BYTES = 20 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const TEXT_EXT = /\.(md|markdown|txt|csv|tsv|json|html?|xml|ya?ml|org|rst|tex|log)$/i

export type IntakeBlock = Anthropic.ContentBlockParam

export interface IntakeItem {
  name: string
  kind: 'pdf' | 'image' | 'text' | 'page'
  bytes: number
  block: IntakeBlock
}

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** A dropped file as a content block, or an error sentence for the user. */
export async function fileToIntake(file: File): Promise<IntakeItem | { error: string }> {
  if (file.size > MAX_FILE_BYTES) return { error: `${file.name} is over 20 MB; split it or drop a smaller file.` }
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    return {
      name: file.name,
      kind: 'pdf',
      bytes: file.size,
      block: { type: 'document', title: file.name, source: { type: 'base64', media_type: 'application/pdf', data: base64(await file.arrayBuffer()) } },
    }
  }
  if (IMAGE_TYPES.has(file.type)) {
    return {
      name: file.name,
      kind: 'image',
      bytes: file.size,
      block: { type: 'image', source: { type: 'base64', media_type: file.type as 'image/png', data: base64(await file.arrayBuffer()) } },
    }
  }
  if (file.type.startsWith('text/') || TEXT_EXT.test(file.name)) {
    const text = await file.text()
    return { name: file.name, kind: 'text', bytes: file.size, block: { type: 'text', text: `<file name=${JSON.stringify(file.name)}>\n${text}\n</file>` } }
  }
  return { error: `${file.name}: this kind of file can't be read yet (PDF, images, markdown and text work).` }
}

/** A fetched page (server/fetchUrl.ts) as a content block. */
export async function urlToIntake(url: string, f: typeof fetch = fetch): Promise<IntakeItem | { error: string }> {
  try {
    const res = await f('/api/fetch-url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) })
    const body = (await res.json()) as { url: string; title: string; text: string; truncated: boolean } | { error: string }
    if (!res.ok || 'error' in body) return { error: 'error' in body ? body.error : `Could not read ${url}.` }
    return {
      name: body.title,
      kind: 'page',
      bytes: body.text.length,
      block: {
        type: 'text',
        text: `<page url=${JSON.stringify(body.url)} title=${JSON.stringify(body.title)}${body.truncated ? ' truncated="true"' : ''}>\n${body.text}\n</page>`,
      },
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/g

// ─── Obsidian vault import ───────────────────────────────────────────────────────────

/** Import a vault's markdown files as one undoable step. Returns counts for the chat. */
export async function importVault(files: readonly VaultFile[], now = Date.now()): Promise<{ added: number; lossless: number; unresolved: number; skipped: number }> {
  const settings = useWorld.getState().settings
  if (!settings) throw new Error('The world is not ready yet.')
  const { drafts, lossless, unresolved } = parseVault(files, { now })
  const fitted = drafts.map((d) =>
    d.schemaVersion !== undefined
      ? d // exported by this app: already valid for a world, keep it exactly
      : { ...d, ...fitDate(d.temporalOrigin ?? now, d.temporalPrecision ?? 'day', settings, now) },
  )
  const added = await addNodes(fitted, { label: `Imported ${fitted.length} notes from Obsidian` })
  return { added: added.length, lossless, unresolved, skipped: fitted.length - added.length }
}

/** Read every file under a dropped directory entry (webkitGetAsEntry). */
export async function readDirectoryEntry(entry: FileSystemDirectoryEntry): Promise<VaultFile[]> {
  const out: VaultFile[] = []
  const walk = async (dir: FileSystemDirectoryEntry, prefix: string): Promise<void> => {
    const reader = dir.createReader()
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
      if (!batch.length) break
      for (const e of batch) {
        if (e.name.startsWith('.')) continue
        if (e.isDirectory) await walk(e as FileSystemDirectoryEntry, `${prefix}${e.name}/`)
        else if (/\.md$/i.test(e.name)) {
          const file = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej))
          out.push({ path: `${prefix}${e.name}`, text: await file.text(), lastModified: file.lastModified })
        }
      }
    }
  }
  await walk(entry, '')
  return out
}
