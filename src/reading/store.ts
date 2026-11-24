import { create } from 'zustand'
import { compareAndSwapWorldState, getStore, getWorldGeneration, isRepoReady, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import type { WorldStore } from '../data/WorldStore.ts'
import type { KnowledgeSnapshot } from '../knowledge/types.ts'
import { applyReadingHighlight, applyReadingItem, decodeReading, emptyReading, pdfHighlightSchema, readingName, validateReadingHighlightPatch } from './model.ts'
import { READING_KV, type HighlightInput, type ReadingConnection, type ReadingEndpoint, type ReadingHighlight, type ReadingItemPatch, type ReadingPdfHighlight, type ReadingRelation, type ReadingSavedView, type ReadingSnapshot } from './types.ts'
import { useWriting } from '../writing/store.ts'
export * from './types.ts'
export * from './model.ts'

export const useReading = create<ReadingSnapshot & { loaded: boolean; busy: boolean; error: string | null }>()(() => ({ ...emptyReading(), loaded: false, busy: false, error: null }))
let boundStore: WorldStore | null = null, generation = 0
let queue: Promise<unknown> = Promise.resolve()
const cleanup: (() => void)[] = []
interface Scope { store: WorldStore; generation: number; replacement: number }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const scope = (): Scope | null => isRepoReady() ? { store: getStore(), generation, replacement: getWorldGeneration() } : null
const current = (value: Scope) => isRepoReady() && getStore() === value.store && boundStore === value.store && generation === value.generation && getWorldGeneration() === value.replacement
const changed = () => new Error('The active workspace changed. Open this reading item again before saving.')
function publish(snapshot: ReadingSnapshot) { useReading.setState({ ...snapshot, loaded: true, error: null }) }

export function resetReading(): void {
  generation++
  queue = Promise.resolve()
  for (const stop of cleanup.splice(0)) stop()
  boundStore = null
  useReading.setState({ ...emptyReading(), loaded: false, busy: false, error: null })
}
export async function refreshReading(): Promise<void> {
  if (!isRepoReady()) return
  if (boundStore !== getStore()) return initializeReading()
  const active = scope()!
  try {
    const snapshot = decodeReading(await active.store.getKv(READING_KV))
    if (current(active) && snapshot.revision >= useReading.getState().revision) publish(snapshot)
  } catch (error) { if (current(active)) useReading.setState({ error: message(error) }); throw error }
}
export async function initializeReading(): Promise<void> {
  if (!isRepoReady()) return
  const store = getStore()
  if (boundStore !== store) {
    resetReading(); boundStore = store
    cleanup.push(subscribeRepo((change) => {
      if (boundStore !== store || !isRepoReady() || getStore() !== store) return
      if (change.type === 'wipe' || change.type === 'import') { generation++; queue = Promise.resolve(); useReading.setState({ ...emptyReading(), loaded: false, busy: false, error: null }) }
      if (change.type === 'wipe' || change.type === 'import' || change.type === 'kv' && change.keys.includes(READING_KV)) void refreshReading().catch(() => {})
    }))
    cleanup.push(useRepoStatus.subscribe((status) => { if (!status.ready && boundStore === store) resetReading() }))
  }
  await refreshReading()
}

function mutate<T>(change: (snapshot: ReadingSnapshot, corpus: KnowledgeSnapshot) => T): Promise<T> {
  if (!isRepoReady()) return Promise.reject(new Error('Open a workspace before changing reading data.'))
  const initialization = initializeReading()
  void initialization.catch(() => {})
  const requestedStore = getStore(), replacement = getWorldGeneration(), requestedGeneration = generation
  const task = queue.catch(() => {}).then(async () => {
    await initialization
    if (!isRepoReady() || getStore() !== requestedStore || getWorldGeneration() !== replacement || generation !== requestedGeneration) throw changed()
    const active = scope()!
    if (!useRepoStatus.getState().writer) throw new Error('This workspace is read only.')
    if (useRepoStatus.getState().interruptedImport) throw new Error('Finish restore recovery before changing reading data.')
    useReading.setState({ busy: true, error: null })
    try {
      const [snapshot, corpus] = await Promise.all([requestedStore.getKv(READING_KV).then(decodeReading), requestedStore.getKv<KnowledgeSnapshot>('knowledge.v1')])
      if (!current(active)) throw changed()
      const expected = snapshot.revision
      const before = JSON.stringify(snapshot)
      const result = change(snapshot, corpus ?? { schemaVersion: 1, revision: 0, sources: [], versions: [], passages: [], imports: [], proposals: [], jobs: [] })
      if (before === JSON.stringify(snapshot)) return structuredClone(result)
      decodeReading(snapshot)
      snapshot.revision++
      if (!current(active)) throw changed()
      await compareAndSwapWorldState(READING_KV, snapshot, expected)
      if (!current(active)) throw changed()
      publish(snapshot)
      return structuredClone(result)
    } catch (error) {
      if (current(active)) { await refreshReading().catch(() => {}); useReading.setState({ error: message(error) }) }
      throw error
    } finally { if (current(active)) useReading.setState({ busy: false }) }
  })
  queue = task
  return task
}
function sourceOf(corpus: KnowledgeSnapshot, sourceId: string, included = false) {
  const source = corpus.sources.find((entry) => entry.id === sourceId && !entry.deleted && (!included || !entry.excluded))
  if (!source) throw new Error('This source is no longer available for reading.')
  return source
}
function folderOf(snapshot: ReadingSnapshot, id: string) { const item = snapshot.folders.find((entry) => entry.id === id && entry.deletedAt == null); if (!item) throw new Error('This reading folder is no longer available.'); return item }
function topicOf(snapshot: ReadingSnapshot, id: string) { const item = snapshot.topics.find((entry) => entry.id === id); if (!item) throw new Error('This topic is no longer available.'); return item }
const normalized = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase().replace(/[-_\s]+/g, ' ')

export function createFolder(name: string, parentId: string | null = null) {
  return mutate((snapshot) => {
    const clean = readingName(name)
    if (parentId) folderOf(snapshot, parentId)
    const existing = snapshot.folders.find((entry) => entry.deletedAt == null && entry.parentId === parentId && normalized(entry.name) === normalized(clean))
    if (existing) return existing
    const folder = { id: crypto.randomUUID(), name: clean, parentId, createdAt: Date.now(), deletedAt: null }
    snapshot.folders.push(folder); return folder
  })
}
export function renameFolder(id: string, name: string) {
  return mutate((snapshot) => { const folder = folderOf(snapshot, id), clean = readingName(name); if (snapshot.folders.some((entry) => entry.id !== id && entry.deletedAt == null && entry.parentId === folder.parentId && normalized(entry.name) === normalized(clean))) throw new Error('A folder with this name already exists here.'); folder.name = clean; return folder })
}
export function deleteFolder(id: string): Promise<void> {
  return mutate((snapshot) => { const folder = folderOf(snapshot, id); for (const entry of snapshot.items) if (entry.folderId === id) entry.folderId = folder.parentId; for (const child of snapshot.folders) if (child.parentId === id) child.parentId = folder.parentId; folder.deletedAt = Date.now() })
}
export function updateReadingItem(sourceId: string, patch: ReadingItemPatch) { return mutate((snapshot, corpus) => { sourceOf(corpus, sourceId); return applyReadingItem(snapshot, sourceId, patch) }) }
/** A single revision applies the whole filing operation or changes nothing. Originals are untouched. */
export function bulkUpdateReadingItems(sourceIds: string[], patch: ReadingItemPatch, options: { addTopicId?: string } = {}) {
  return mutate((snapshot, corpus) => {
    const ids = [...new Set(sourceIds)]
    if (!ids.length || ids.length > 500) throw new Error('Choose between 1 and 500 files for one filing action.')
    for (const id of ids) {
      if (id.startsWith('writing:')) { if (!useWriting.getState().docs.some((doc) => `writing:${doc.id}` === id && !doc.archivedAt)) throw new Error('A selected writing document is no longer available.') }
      else sourceOf(corpus, id)
    }
    if (options.addTopicId) topicOf(snapshot, options.addTopicId)
    return ids.map((id) => applyReadingItem(snapshot, id, { ...patch, ...(options.addTopicId ? { topicIds: [...new Set([...(snapshot.items.find((item) => item.sourceId === id)?.topicIds ?? []), options.addTopicId])] } : {}) }))
  })
}
export function saveReadingView(input: Omit<ReadingSavedView, 'id' | 'createdAt'>) {
  return mutate((snapshot) => {
    const view = { ...input, name: readingName(input.name), id: crypto.randomUUID(), createdAt: Date.now() }
    if ((snapshot.savedViews?.length ?? 0) >= 100) throw new Error('You have 100 saved views. Remove one before saving another.')
    snapshot.savedViews = [...(snapshot.savedViews ?? []), view]
    return view
  })
}
export function removeReadingView(id: string): Promise<void> { return mutate((snapshot) => { snapshot.savedViews = snapshot.savedViews?.filter((view) => view.id !== id) ?? [] }) }
export function addPdfHighlight(input: Omit<ReadingPdfHighlight, 'id' | 'createdAt' | 'updatedAt' | 'note' | 'color'> & Partial<Pick<ReadingPdfHighlight, 'note' | 'color'>>) {
  return mutate((snapshot, corpus) => {
    sourceOf(corpus, input.sourceId)
    if (!corpus.versions.some((version) => version.id === input.versionId && version.sourceId === input.sourceId)) throw new Error('Reopen the retained PDF version before highlighting it.')
    const now = Date.now(), entry = { ...input, note: input.note ?? '', color: input.color ?? 'yellow', id: crypto.randomUUID(), createdAt: now, updatedAt: now }
    if (!pdfHighlightSchema.safeParse(entry).success) throw new Error('Choose text inside one PDF page before saving a highlight.')
    snapshot.pdfHighlights = [...(snapshot.pdfHighlights ?? []), entry]
    return entry
  })
}
export function updatePdfHighlight(id: string, patch: Pick<Partial<ReadingPdfHighlight>, 'note' | 'color'>) {
  return mutate((snapshot) => { validateReadingHighlightPatch(patch); const entry = snapshot.pdfHighlights?.find((highlight) => highlight.id === id); if (!entry) throw new Error('This PDF highlight is no longer available.'); Object.assign(entry, patch, { updatedAt: Date.now() }); return entry })
}
export function removePdfHighlight(id: string): Promise<void> { return mutate((snapshot) => { snapshot.pdfHighlights = snapshot.pdfHighlights?.filter((entry) => entry.id !== id) ?? [] }) }
export function recordReadingProgress(sourceId: string, input: { progress: number; position?: number }) {
  return mutate((snapshot, corpus) => {
    sourceOf(corpus, sourceId)
    const prior = snapshot.items.find((entry) => entry.sourceId === sourceId)
    return applyReadingItem(snapshot, sourceId, { ...input, progress: Math.max(prior?.progress ?? 0, input.progress), lastOpenedAt: Date.now() })
  })
}
export function addHighlight(input: HighlightInput) { return mutate((snapshot, corpus) => { sourceOf(corpus, input.sourceId); return applyReadingHighlight(snapshot, input, corpus.versions) }) }
export function updateHighlight(id: string, patch: { note?: string; color?: ReadingHighlight['color'] }) {
  return mutate((snapshot) => { validateReadingHighlightPatch(patch); const item = snapshot.highlights.find((entry) => entry.id === id); if (!item) throw new Error('This highlight is no longer available.'); Object.assign(item, patch, { updatedAt: Date.now() }); return item })
}
export function removeHighlight(id: string): Promise<void> { return mutate((snapshot) => { snapshot.highlights = snapshot.highlights.filter((entry) => entry.id !== id) }) }
function noteText(text: string) { const clean = text.trim(); if (!clean || clean.length > 100000) throw new Error('Write a note of 1 to 100,000 characters.'); return clean }
export function addReadingNote(sourceId: string, text: string) {
  return mutate((snapshot, corpus) => { sourceOf(corpus, sourceId); const now = Date.now(), note = { id: crypto.randomUUID(), sourceId, text: noteText(text), createdAt: now, updatedAt: now }; snapshot.notes.push(note); return note })
}
export function updateReadingNote(id: string, text: string) { return mutate((snapshot) => { const note = snapshot.notes.find((entry) => entry.id === id); if (!note) throw new Error('This reading note is no longer available.'); note.text = noteText(text); note.updatedAt = Date.now(); return note }) }
export function removeReadingNote(id: string): Promise<void> { return mutate((snapshot) => { snapshot.notes = snapshot.notes.filter((entry) => entry.id !== id) }) }
export function createTopic(name: string) {
  return mutate((snapshot) => { const clean = readingName(name), existing = snapshot.topics.find((entry) => normalized(entry.name) === normalized(clean)); if (existing) return existing; const topic = { id: crypto.randomUUID(), name: clean, createdAt: Date.now() }; snapshot.topics.push(topic); return topic })
}
export function updateTopic(id: string, patch: string | { name: string }) {
  return mutate((snapshot) => { const item = topicOf(snapshot, id), clean = readingName(typeof patch === 'string' ? patch : patch.name); if (snapshot.topics.some((entry) => entry.id !== id && normalized(entry.name) === normalized(clean))) throw new Error('A topic with this name already exists.'); item.name = clean; return item })
}
export function assignTopics(sourceId: string, topicIds: string[]) { return updateReadingItem(sourceId, { topicIds: [...new Set(topicIds)] }) }
export function connectReading(input: { from: ReadingEndpoint; to: ReadingEndpoint; relation: ReadingRelation }) {
  return mutate((snapshot, corpus) => {
    for (const end of [input.from, input.to]) { if (end.kind === 'source') sourceOf(corpus, end.id, true); else if (end.kind === 'topic') topicOf(snapshot, end.id); else throw new Error('Choose a retained source or saved topic.') }
    if (input.from.kind === input.to.kind && input.from.id === input.to.id) throw new Error('Choose two different items to connect.')
    if (!['related', 'supports', 'contradicts', 'builds-on'].includes(input.relation)) throw new Error('Choose a supported connection relation.')
    const same = (a: ReadingEndpoint, b: ReadingEndpoint) => a.kind === b.kind && a.id === b.id
    const existing = snapshot.connections.find((entry) => entry.relation === input.relation && (same(entry.from, input.from) && same(entry.to, input.to) || input.relation === 'related' && same(entry.from, input.to) && same(entry.to, input.from)))
    if (existing) return existing
    const connection: ReadingConnection = { id: crypto.randomUUID(), ...structuredClone(input), createdAt: Date.now() }
    snapshot.connections.push(connection); return connection
  })
}
export function disconnectReading(id: string): Promise<void> { return mutate((snapshot) => { snapshot.connections = snapshot.connections.filter((entry) => entry.id !== id) }) }
