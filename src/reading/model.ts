import { z } from 'zod'
import type { SourceVersion } from '../knowledge/types.ts'
import type { HighlightInput, ReadingHighlight, ReadingItem, ReadingItemPatch, ReadingSnapshot } from './types.ts'

const id = z.string().min(1).max(1000), time = z.number().finite().nonnegative(), offset = z.number().int().nonnegative()
const name = z.string().min(1).max(160).refine((value) => !!value.trim())
const color = z.enum(['yellow', 'blue', 'rose'])
const endpoint = z.object({ kind: z.enum(['source', 'topic']), id })
const item = z.object({ sourceId: id, folderId: id.nullable(), status: z.enum(['unread', 'reading', 'read']), progress: z.number().min(0).max(1), lastOpenedAt: time.nullable(), readAt: time.nullable(), position: z.number().finite().nonnegative(), favorite: z.boolean(), topicIds: z.array(id).max(10000), activeReadMs: offset.optional(), following: z.boolean().optional(), libraryVisible: z.boolean().optional() })
const highlight = z.object({ id, topicId: id.optional(), sourceId: id, versionId: id, start: offset, end: offset, quote: z.string().min(1).max(1000000), prefix: z.string().max(5000), suffix: z.string().max(5000), note: z.string().max(100000), color, createdAt: time, updatedAt: time }).refine((value) => value.end > value.start && value.quote.length === value.end - value.start)
export const pdfHighlightSchema = z.object({ id, sourceId: id, versionId: id, page: z.number().int().min(1).max(100000), quote: z.string().min(1).max(20000), prefix: z.string().max(5000).optional(), suffix: z.string().max(5000).optional(), rects: z.array(z.object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1), width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1) }).refine((r) => r.x + r.width <= 1.001 && r.y + r.height <= 1.001)).min(1).max(200), note: z.string().max(100000), color, createdAt: time, updatedAt: time })
export const folderSchema = z.object({
  id, name, parentId: id.nullable(), createdAt: time, deletedAt: time.nullable().optional(),
  kind: z.enum(['folder', 'section', 'concept', 'note']).optional(), typeLabel: z.string().max(80).optional(),
  description: z.string().max(20000).optional(), icon: z.string().max(80).optional(),
  iconAssetId: z.string().regex(/^writing-[a-f0-9]{64}$/).nullable().optional(),
  coverAssetId: z.string().regex(/^writing-[a-f0-9]{64}$/).nullable().optional(),
  coverPreset: z.enum(['earth', 'library', 'forest', 'architecture', 'sky', 'none']).optional(),
  coverPosition: z.number().finite().min(0).max(100).optional(), linkedTopicId: id.optional(),
})
const schema = z.object({
  schemaVersion: z.literal(1), revision: offset,
  folders: z.array(folderSchema),
  items: z.array(item), highlights: z.array(highlight),
  notes: z.array(z.object({ id, sourceId: id, text: z.string().min(1).max(100000), createdAt: time, updatedAt: time })),
  topics: z.array(z.object({ id, name, createdAt: time, aliases: z.array(name).max(50).optional(), updatedAt: time.optional() })),
  connections: z.array(z.object({ id, from: endpoint, to: endpoint, relation: z.enum(['related', 'supports', 'contradicts', 'builds-on']), createdAt: time })),
  pdfHighlights: z.array(pdfHighlightSchema).max(100000).optional(),
  savedViews: z.array(z.object({ id, name, query: z.string().max(2000), filter: z.enum(['all', 'reading', 'read', 'highlights', 'favorites', 'articles', 'notes', 'books', 'obsidian', 'documents']), folderId: id.nullable(), topic: z.string().max(1000), view: z.enum(['grid', 'list']), sort: z.enum(['modified', 'opened', 'title']), createdAt: time })).max(100).optional(),
})
export const emptyReading = (): ReadingSnapshot => ({ schemaVersion: 1, revision: 0, folders: [], items: [], highlights: [], notes: [], topics: [], connections: [] })
export function defaultReadingItem(sourceId: string): ReadingItem { return { sourceId, folderId: null, status: 'unread', progress: 0, lastOpenedAt: null, readAt: null, position: 0, favorite: false, topicIds: [] } }
const invalid = () => new Error('Reading data is incomplete or uses an unsupported format. Your saved copy was not changed.')

/** Historical anchors are decoded without requiring their source to remain current. */
export function decodeReading(value: unknown): ReadingSnapshot {
  if (value === undefined) return emptyReading()
  const result = schema.safeParse(value)
  if (!result.success) throw invalid()
  const snapshot = result.data
  for (const rows of [snapshot.folders, snapshot.highlights, snapshot.notes, snapshot.topics, snapshot.connections, snapshot.pdfHighlights ?? [], snapshot.savedViews ?? []]) if (new Set(rows.map((row) => row.id)).size !== rows.length) throw invalid()
  if (new Set(snapshot.items.map((row) => row.sourceId)).size !== snapshot.items.length) throw invalid()
  const folders = new Map(snapshot.folders.map((folder) => [folder.id, folder])), topics = new Set(snapshot.topics.map((topic) => topic.id))
  for (const folder of snapshot.folders) {
    if (folder.linkedTopicId && !topics.has(folder.linkedTopicId)) throw invalid()
    const visited = new Set([folder.id]); let parent = folder.parentId
    while (parent) { if (visited.has(parent) || !folders.has(parent)) throw invalid(); visited.add(parent); parent = folders.get(parent)!.parentId }
  }
  for (const entry of snapshot.items) if (entry.folderId && (!folders.has(entry.folderId) || folders.get(entry.folderId)!.deletedAt != null) || entry.topicIds.some((topic) => !topics.has(topic)) || new Set(entry.topicIds).size !== entry.topicIds.length) throw invalid()
  if (snapshot.highlights.some(entry => entry.topicId && !topics.has(entry.topicId))) throw invalid()
  for (const connection of snapshot.connections) if (connection.from.kind === connection.to.kind && connection.from.id === connection.to.id || [connection.from, connection.to].some((end) => end.kind === 'topic' && !topics.has(end.id))) throw invalid()
  return snapshot
}

export function readingName(value: string): string { const result = value.trim(); if (!name.safeParse(result).success) throw new Error('Choose a name of 1 to 160 characters.'); return result }

/** Shared browser/server command: mutates one detached snapshot, never source text. */
export function applyReadingItem(snapshot: ReadingSnapshot, sourceId: string, patch: ReadingItemPatch, now = Date.now()): ReadingItem {
  id.parse(sourceId)
  if (!item.omit({ sourceId: true }).partial().strict().safeParse(patch).success) throw new Error('Reading progress or item details are invalid.')
  const original = snapshot.items.find((entry) => entry.sourceId === sourceId)
  const next = { ...(original ?? defaultReadingItem(sourceId)), ...patch, sourceId }
  if (patch.status === 'unread') { next.progress = 0; next.readAt = null }
  else if (patch.status === 'read') { next.progress = 1; next.readAt ??= now }
  else if (patch.status === 'reading') next.readAt = null
  else if (patch.progress !== undefined) {
    if (next.progress >= .9) { next.status = 'read'; next.readAt ??= now }
    else if (next.progress > 0 && next.status === 'unread') next.status = 'reading'
  }
  const parsed = item.safeParse(next)
  if (!parsed.success) throw new Error('Reading progress or item details are invalid.')
  if (next.folderId && !snapshot.folders.some((folder) => folder.id === next.folderId && folder.deletedAt == null)) throw new Error('Choose an available reading folder.')
  if (patch.folderId) {
    let folder = snapshot.folders.find(folder => folder.id === patch.folderId)
    while (folder) {
      if (folder.linkedTopicId) next.topicIds = [...next.topicIds, folder.linkedTopicId]
      folder = snapshot.folders.find(entry => entry.id === folder!.parentId)
    }
  }
  next.topicIds = [...new Set(next.topicIds)]
  if (next.topicIds.some((topicId) => !snapshot.topics.some((topic) => topic.id === topicId))) throw new Error('A selected topic is no longer available.')
  if (original) Object.assign(original, parsed.data, { topicIds: next.topicIds })
  else snapshot.items.push({ ...parsed.data, topicIds: next.topicIds })
  return snapshot.items.find((entry) => entry.sourceId === sourceId)!
}

export function applyReadingHighlight(snapshot: ReadingSnapshot, input: HighlightInput, versions: readonly Pick<SourceVersion, 'id' | 'sourceId' | 'text'>[], now = Date.now()): ReadingHighlight {
  const next: ReadingHighlight = { id: crypto.randomUUID(), ...input, prefix: input.prefix ?? '', suffix: input.suffix ?? '', note: input.note ?? '', color: input.color ?? 'yellow', createdAt: now, updatedAt: now }
  if (!highlight.safeParse(next).success) throw new Error('Choose a nonempty, valid source selection before highlighting.')
  const version = versions.find((entry) => entry.id === input.versionId && entry.sourceId === input.sourceId)
  if (!version || input.end > version.text.length || version.text.slice(input.start, input.end) !== input.quote) throw new Error('This selection no longer matches its retained source version. Open the source and select it again.')
  if (input.prefix && !version.text.slice(0, input.start).endsWith(input.prefix) || input.suffix && !version.text.slice(input.end).startsWith(input.suffix)) throw new Error('The selection context does not match its retained source version.')
  const existing = snapshot.highlights.find((entry) => entry.sourceId === input.sourceId && entry.versionId === input.versionId && entry.start === input.start && entry.end === input.end)
  if (existing) return existing
  snapshot.highlights.push(next)
  return next
}

export function validateReadingHighlightPatch(patch: { note?: string; color?: ReadingHighlight['color'] }): void {
  if (!z.object({ note: z.string().max(100000).optional(), color: color.optional() }).strict().safeParse(patch).success) throw new Error('The highlight comment or color is invalid.')
}
