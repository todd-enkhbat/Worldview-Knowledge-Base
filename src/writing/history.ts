import { compareAndSwapWorldState, getStore, getWorldGeneration, isRepoReady } from '../data/repo.ts'
import type { WorldStore } from '../data/WorldStore.ts'
import { validateWritingDocument, writingPublicationValue } from './model.ts'
import type { WritingDocument } from './types.ts'

export const WRITING_HISTORY_KV = 'writingHistory.v1'
export interface WritingRevision { id: string; documentId: string; createdAt: number; label: string; kind: 'automatic' | 'named' | 'restore'; document: WritingDocument }
export interface WritingHistory { schemaVersion: 1; revision: number; entries: WritingRevision[] }
const MAX_BYTES = 32 * 1024 * 1024
const empty = (): WritingHistory => ({ schemaVersion: 1, revision: 0, entries: [] })
const invalid = () => new Error('Saved writing history could not be read. Your drafts and previous versions were preserved.')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export function decodeWritingHistory(value: unknown): WritingHistory {
  if (value === undefined) return empty()
  if (!object(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !Array.isArray(value.entries) || value.entries.length > 10000) throw invalid()
  const seen = new Set<string>()
  const entries = value.entries.map((raw): WritingRevision => {
    if (!object(raw) || typeof raw.id !== 'string' || !raw.id || raw.id.length > 1000 || seen.has(raw.id) || typeof raw.documentId !== 'string' || typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 160 || !Number.isFinite(raw.createdAt) || Number(raw.createdAt) < 0 || !['automatic', 'named', 'restore'].includes(String(raw.kind))) throw invalid()
    seen.add(raw.id)
    const document = validateWritingDocument(raw.document)
    if (document.id !== raw.documentId) throw invalid()
    return { id: raw.id, documentId: raw.documentId, createdAt: Number(raw.createdAt), label: raw.label, kind: raw.kind as WritingRevision['kind'], document }
  })
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_BYTES) throw invalid()
  return { schemaVersion: 1, revision: Number(value.revision), entries }
}
export async function readWritingHistory(store: WorldStore = getStore()): Promise<WritingHistory> { return decodeWritingHistory(await store.getKv(WRITING_HISTORY_KV)) }

/** Called inside the writing command queue, before replacing or archiving a draft. */
export async function retainWritingRevision(document: WritingDocument, options: { store: WorldStore; generation: number; kind: WritingRevision['kind']; label?: string }): Promise<WritingRevision | null> {
  const current = () => isRepoReady() && getStore() === options.store && getWorldGeneration() === options.generation
  if (!current()) throw new Error('The workspace changed before this snapshot could be saved.')
  const snapshot = await readWritingHistory(options.store)
  if (!current()) throw new Error('The workspace changed before this snapshot could be saved.')
  const previous = snapshot.entries.filter((entry) => entry.documentId === document.id).at(-1)
  if (options.kind === 'automatic' && previous && (Date.now() - previous.createdAt < 60000 || JSON.stringify(writingPublicationValue(previous.document)) === JSON.stringify(writingPublicationValue(document)))) return null
  const label = (options.label ?? (options.kind === 'automatic' ? 'Automatic snapshot' : 'Before restoring a version')).trim()
  if (!label || label.length > 160) throw new Error('Name this snapshot with 1 to 160 characters.')
  const entry: WritingRevision = { id: crypto.randomUUID(), documentId: document.id, createdAt: Date.now(), label, kind: options.kind, document: validateWritingDocument(document) }
  snapshot.entries.push(entry)
  // Automatic checkpoints are bounded. Named and restore snapshots are never silently removed.
  const bytes = () => new TextEncoder().encode(JSON.stringify(snapshot)).byteLength
  while (snapshot.entries.filter((item) => item.documentId === document.id).length > 100 || snapshot.entries.length > 10000 || bytes() > MAX_BYTES) {
    const index = snapshot.entries.findIndex((item) => item.kind === 'automatic' && (snapshot.entries.length > 10000 || bytes() > MAX_BYTES || item.documentId === document.id))
    if (index < 0) { if (options.kind === 'automatic') return null; throw new Error('Writing history has reached its storage limit. Export a world backup before adding more named snapshots.') }
    const removed = snapshot.entries.splice(index, 1)[0]
    if (removed.id === entry.id) return null
  }
  decodeWritingHistory(snapshot)
  const expected = snapshot.revision; snapshot.revision++
  if (!current()) throw new Error('The workspace changed before this snapshot could be saved.')
  await compareAndSwapWorldState(WRITING_HISTORY_KV, snapshot, expected)
  if (!current()) throw new Error('The workspace changed after this snapshot was retained. Reopen your document.')
  return entry
}
