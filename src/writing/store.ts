import { decodeBookshelf } from '../bookshelf/model.ts'
import { BOOKSHELF_KV } from '../bookshelf/types.ts'
import { decodeReading } from '../reading/model.ts'
import { READING_KV } from '../reading/types.ts'
import { create } from 'zustand'
import { compareAndSwapWorldState, getStore, getWorldGeneration, isRepoReady, retainWorldBlob, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import type { WorldStore } from '../data/WorldStore.ts'
import { ingestRetainedSource, initializeKnowledge, knowledgeHash } from '../knowledge/index.ts'
import type { KnowledgeSnapshot } from '../knowledge/types.ts'
import { decodeWriting, defaultWritingAppearance, emptyWriting, emptyWritingContent, plainTextFromWriting, validateWritingDocument, writingAssetIds, writingPublicationValue } from './model.ts'
import { WRITING_KV, type CreateWritingInput, type WritingDocument, type WritingDocumentPatch, type WritingSnapshot } from './types.ts'
import { readWritingHistory, retainWritingRevision } from './history.ts'
import { sourceWritingContent, sourceWritingDocument } from './sourceMarkdown.ts'
import { writingAuthorshipMessages } from './authorship.ts'
export * from './types.ts'
export * from './model.ts'

export const useWriting = create<WritingSnapshot & { loaded: boolean; busy: boolean; error: string | null }>()(() => ({ ...emptyWriting(), loaded: false, busy: false, error: null }))
let boundStore: WorldStore | null = null, epoch = 0, queue: Promise<unknown> = Promise.resolve()
const cleanup: (() => void)[] = []
interface Scope { store: WorldStore; epoch: number; generation: number }
const current = (scope: Scope) => isRepoReady() && getStore() === scope.store && boundStore === scope.store && epoch === scope.epoch && getWorldGeneration() === scope.generation
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const changed = () => new Error('The active workspace changed. Reopen this writing before saving.')
const emptyCorpus = (): KnowledgeSnapshot => ({ schemaVersion: 1, revision: 0, sources: [], versions: [], passages: [], imports: [], jobs: [], proposals: [] })
function publish(snapshot: WritingSnapshot) { useWriting.setState({ ...snapshot, loaded: true, error: null }) }
export function resetWriting(): void { epoch++; queue = Promise.resolve(); boundStore = null; for (const stop of cleanup.splice(0)) stop(); useWriting.setState({ ...emptyWriting(), loaded: false, busy: false, error: null }) }
export async function refreshWriting(): Promise<void> {
  if (!isRepoReady()) return
  if (boundStore !== getStore()) return initializeWriting()
  const scope = { store: getStore(), epoch, generation: getWorldGeneration() }
  try { const snapshot = decodeWriting(await scope.store.getKv(WRITING_KV)); if (current(scope) && snapshot.revision >= useWriting.getState().revision) publish(snapshot) }
  catch (error) { if (current(scope)) useWriting.setState({ error: message(error) }); throw error }
}
export async function initializeWriting(): Promise<void> {
  if (!isRepoReady()) return
  const store = getStore()
  if (boundStore !== store) {
    resetWriting(); boundStore = store
    cleanup.push(subscribeRepo((change) => {
      if (!isRepoReady() || boundStore !== store || getStore() !== store) return
      if (change.type === 'wipe' || change.type === 'import') { epoch++; queue = Promise.resolve(); useWriting.setState({ ...emptyWriting(), loaded: false, busy: false, error: null }) }
      if (change.type === 'wipe' || change.type === 'import' || change.type === 'kv' && change.keys.includes(WRITING_KV)) void refreshWriting().catch(() => {})
    }))
    cleanup.push(useRepoStatus.subscribe((status) => { if (!status.ready && boundStore === store) resetWriting() }))
  }
  await refreshWriting()
}
function mutate<T>(change: (snapshot: WritingSnapshot, corpus: KnowledgeSnapshot, scope: Scope) => T | Promise<T>): Promise<T> {
  if (!isRepoReady()) return Promise.reject(new Error('Open a workspace before saving your writing.'))
  const initialization = initializeWriting(); void initialization.catch(() => {})
  const requested = { store: getStore(), epoch, generation: getWorldGeneration() }
  const task = queue.catch(() => {}).then(async () => {
    await initialization
    if (!current(requested)) throw changed()
    if (!useRepoStatus.getState().writer) throw new Error('This workspace is read only.')
    if (useRepoStatus.getState().interruptedImport) throw new Error('Finish restore recovery before changing your writing.')
    useWriting.setState({ busy: true, error: null })
    try {
      const [snapshot, corpus] = await Promise.all([requested.store.getKv(WRITING_KV).then(decodeWriting), requested.store.getKv<KnowledgeSnapshot>('knowledge.v1')])
      if (!current(requested)) throw changed()
      const before = JSON.stringify(snapshot), expected = snapshot.revision
      const result = await change(snapshot, corpus ?? emptyCorpus(), requested)
      if (!current(requested)) throw changed()
      if (JSON.stringify(snapshot) !== before) { decodeWriting(snapshot); snapshot.revision++; await compareAndSwapWorldState(WRITING_KV, snapshot, expected); if (!current(requested)) throw changed(); publish(snapshot) }
      return structuredClone(result)
    } catch (error) { if (current(requested)) { await refreshWriting().catch(() => {}); useWriting.setState({ error: message(error) }) }; throw error }
    finally { if (current(requested)) useWriting.setState({ busy: false }) }
  })
  queue = task; return task
}
const documentOf = (snapshot: WritingSnapshot, id: string) => { const doc = snapshot.docs.find((entry) => entry.id === id); if (!doc) throw new Error('This writing is no longer available.'); return doc }
export function newWritingDraft(input: CreateWritingInput = {}, id: string = crypto.randomUUID()): WritingDocument {
  const now = Date.now()
  return validateWritingDocument({ id, title: input.title ?? 'Untitled writing', subtitle: input.subtitle ?? '', byline: input.byline ?? '', format: input.format ?? 'note', content: input.content ?? emptyWritingContent(), appearance: { ...defaultWritingAppearance(), ...input.appearance }, createdAt: now, updatedAt: now, ...(input.basedOnSourceId ? { basedOnSourceId: input.basedOnSourceId } : {}), ...(input.applicationId?{applicationId:input.applicationId}:{}), ...(input.chapter ? {chapter:input.chapter}:{}), ...(input.bookEditionId ? { bookEditionId: input.bookEditionId } : {}), ...(input.topicIds ? { topicIds: input.topicIds } : {}), archivedAt: null })
}
async function ensureBook(scope: Scope, id: string) {
  const shelf = decodeBookshelf(await scope.store.getKv(BOOKSHELF_KV))
  if (!shelf.books.some(book => book.id === id && book.archivedAt === null)) throw new Error('This bookshelf edition is unavailable.')
}
export function createWritingDocument(input: CreateWritingInput = {}, draftId?: string): Promise<WritingDocument> {
  return mutate(async (snapshot, corpus, scope) => {
    const doc = newWritingDraft(input, draftId)
    if (snapshot.docs.some(entry => entry.id === doc.id)) throw new Error('This note already exists. Reopen its saved version.')
    if (doc.bookEditionId) await ensureBook(scope, doc.bookEditionId)
    if (doc.basedOnSourceId) { const source = corpus.sources.find((entry) => entry.id === doc.basedOnSourceId && !entry.deleted); if (!source) throw new Error('This source is no longer available to copy.'); doc.baseVersionId = source.currentVersionId }
    snapshot.docs.push(doc); return doc
  })
}
export const conceptNoteId = (topicId: string) => 'concept-note:' + topicId

/** The concept's permanent ID keeps its editable note stable through renames and restores. */
export function openConceptNote(topicId: string, restoreArchived = false): Promise<WritingDocument> {
  return mutate(async (snapshot, _corpus, scope) => {
    const reading = decodeReading(await scope.store.getKv(READING_KV))
    const topic = reading.topics.find(entry => entry.id === topicId)
    if (!topic) throw new Error('This concept is no longer available.')
    const id = conceptNoteId(topic.id), existing = snapshot.docs.find(entry => entry.id === id)
    if (existing) {
      if (existing.archivedAt !== null && !restoreArchived) throw new Error('Your concept note is in Trash. Restore it to continue writing.')
      existing.archivedAt = null
      return existing
    }
    const note = newWritingDraft({ title: topic.name, topicIds: [topic.id] }, id)
    snapshot.docs.push(note)
    return note
  })
}
export function updateWritingDocument(id: string, patch: WritingDocumentPatch, options: { expectedUpdatedAt?: number } = {}): Promise<WritingDocument> {
  return mutate(async (snapshot, _corpus, scope) => {
    if (!patch || Object.keys(patch).some((key) => !['title', 'subtitle', 'byline', 'format', 'content', 'appearance', 'topicIds', 'applicationId', 'chapter', 'bookEditionId'].includes(key))) throw new Error('This writing update includes unsupported fields.')
    const original = documentOf(snapshot, id)
    if (options.expectedUpdatedAt !== undefined && options.expectedUpdatedAt !== original.updatedAt) throw new Error('This writing changed elsewhere. Your current draft was not overwritten; compare it with the saved revision.')
    const next = validateWritingDocument({ ...original, ...patch, appearance: { ...original.appearance, ...patch.appearance } })
    if (next.bookEditionId && next.bookEditionId !== original.bookEditionId) await ensureBook(scope, next.bookEditionId)
    if (JSON.stringify(writingPublicationValue(next)) !== JSON.stringify(writingPublicationValue(original))) {
      await retainWritingRevision(original, { ...scope, kind: 'automatic' })
      next.updatedAt = Math.max(Date.now(), original.updatedAt + 1)
      const fields = (Object.keys(patch) as (keyof WritingDocumentPatch)[]).filter(field => JSON.stringify(next[field]) !== JSON.stringify(original[field]))
      if (fields.length) (snapshot.edits ??= []).push({ documentId: id, at: next.updatedAt, fields })
    }
    Object.assign(original, next); return original
  })
}
export function archiveWritingDocument(id: string, archived = true): Promise<WritingDocument> { return mutate(async (snapshot, _corpus, scope) => { const doc = documentOf(snapshot, id); if (archived && !doc.archivedAt) await retainWritingRevision(doc, { ...scope, kind: 'automatic', label: 'Before moving to Trash' }); doc.archivedAt = archived ? Date.now() : null; return doc }) }
export function saveWritingSnapshot(id: string, label: string) { return mutate(async (snapshot, _corpus, scope) => retainWritingRevision(documentOf(snapshot, id), { ...scope, kind: 'named', label })) }
export function restoreWritingRevision(id: string, revisionId: string, expectedUpdatedAt: number): Promise<WritingDocument> {
  return mutate(async (snapshot, _corpus, scope) => {
    const doc = documentOf(snapshot, id)
    if (doc.updatedAt !== expectedUpdatedAt) throw new Error('This draft changed before restoration. Reopen history and compare the latest draft.')
    const history = await readWritingHistory(scope.store), revision = history.entries.find((entry) => entry.id === revisionId && entry.documentId === id)
    if (!revision) throw new Error('This snapshot is no longer available.')
    await retainWritingRevision(doc, { ...scope, kind: 'restore' })
    Object.assign(doc, writingPublicationValue(revision.document), {applicationId:revision.document.applicationId,chapter:revision.document.chapter, bookEditionId: revision.document.bookEditionId ?? null, topicIds: revision.document.topicIds ?? [], updatedAt: Math.max(Date.now(), doc.updatedAt + 1) })
    return doc
  })
}
export function restoreWritingPublishedVersion(id: string, versionId: string, expectedUpdatedAt: number): Promise<WritingDocument> {
  return mutate(async (snapshot, corpus, scope) => {
    const doc = documentOf(snapshot, id), version = corpus.versions.find((entry) => entry.id === versionId && entry.sourceId === doc.sourceId)
    if (doc.updatedAt !== expectedUpdatedAt) throw new Error('This draft changed before restoration. Reopen history and compare the latest draft.')
    if (!version || version.metadata?.writingDocumentId !== id) throw new Error('This retained writing version is unavailable.')
    const metadata = version.metadata
    const restored = validateWritingDocument({ ...doc, title: metadata.title ?? doc.title, subtitle: metadata.subtitle ?? '', byline: metadata.byline ?? '', format: metadata.writingFormat ?? doc.format, content: metadata.content, appearance: metadata.appearance, chapter:metadata.chapter,applicationId:metadata.applicationId,topicIds: metadata.topicIds ?? [], bookEditionId: metadata.bookEditionId ?? null })
    await retainWritingRevision(doc, { ...scope, kind: 'restore' })
    Object.assign(doc, writingPublicationValue(restored), { topicIds: restored.topicIds ?? [], updatedAt: Math.max(Date.now(), doc.updatedAt + 1) })
    return doc
  })
}
export function duplicateWritingDocument(id: string): Promise<WritingDocument> {
  return mutate((snapshot, corpus) => {
    const original = documentOf(snapshot, id), sourceId = original.sourceId ?? original.basedOnSourceId
    const doc = newWritingDraft({ ...writingPublicationValue(original), title: `${original.title || 'Untitled writing'} (copy)`.slice(0, 300), ...(sourceId ? { basedOnSourceId: sourceId } : {}) })
    if (sourceId) doc.baseVersionId = corpus.sources.find((entry) => entry.id === sourceId)?.currentVersionId ?? original.baseVersionId
    snapshot.docs.push(doc); return doc
  })
}
export function createWritingFromSource(sourceId: string): Promise<WritingDocument> {
  return mutate((snapshot, corpus) => {
    const source = corpus.sources.find((entry) => entry.id === sourceId && !entry.deleted && !entry.excluded), version = corpus.versions.find((entry) => entry.id === source?.currentVersionId)
    if (!source || !version) throw new Error('This source is no longer available to copy.')
    const existing = snapshot.docs.find((entry) => !entry.archivedAt && (entry.sourceId === sourceId || entry.basedOnSourceId === sourceId || version.metadata?.format === 'writing' && version.metadata.writingDocumentId === entry.id))
    if (existing) return sourceWritingDocument(existing,corpus.sources,corpus.versions)
    const doc = newWritingDraft({ title: source.title, content: sourceWritingContent(source,version,undefined,corpus), basedOnSourceId: source.id })
    doc.baseVersionId = version.id; snapshot.docs.push(doc); return doc
  })
}
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])); return value }
export function writingPublicationFingerprint(doc: WritingDocument): Promise<string> {
  const { bookEditionId, ...value } = writingPublicationValue(doc)
  return knowledgeHash(JSON.stringify(canonical(bookEditionId ? { ...value, bookEditionId } : value)))
}
/** An explicit publication retains rich originals before adding an immutable human source version. */
export function publishWritingDocument(id: string): Promise<{ sourceId: string; versionId: string }> {
  return mutate(async (snapshot, corpus, scope) => {
    const doc = documentOf(snapshot, id)
    if (doc.archivedAt !== null) throw new Error('Restore this writing before saving it to Library.')
    const text = plainTextFromWriting(doc.content)
    if (!text.trim()) throw new Error('Write something before saving this document to Library.')
    const fingerprint = await writingPublicationFingerprint(doc)
    if (!current(scope)) throw changed()
    let source = corpus.sources.find((entry) => entry.externalId === `writing:${doc.id}`)
    if (source?.deleted || source?.excluded) throw new Error('Restore this writing’s Library source before publishing another revision.')
    let version = corpus.versions.find((entry) => entry.id === source?.currentVersionId)
    if (!source || !version || version.metadata?.writingFingerprint !== fingerprint) {
      const bytes = new TextEncoder().encode(JSON.stringify({ format: 'worldview-writing.v1', document: doc }))
      const blobId = `knowledge-${await knowledgeHash(bytes)}`
      if (!current(scope)) throw changed()
      await retainWorldBlob({ meta: { id: blobId, kind: 'file', mime: 'application/json', bytes: bytes.byteLength, createdAt: Date.now(), nodeId: null }, data: bytes }, { store: scope.store, generation: scope.generation, shouldWrite: () => current(scope) })
      if (!current(scope)) throw changed()
      const latestDraft = decodeWriting(await scope.store.getKv(WRITING_KV))
      if (!current(scope)) throw changed()
      if (latestDraft.revision !== snapshot.revision) throw new Error('This writing changed while its original was being retained. Your newer draft and retained original are safe; review the saved version before publishing.')
      await initializeKnowledge()
      if (!current(scope)) throw changed()
      source = await ingestRetainedSource({ externalId: `writing:${doc.id}`, title: doc.title.trim() || 'Untitled writing', kind: 'document', text, authoredAt: doc.updatedAt, messages: writingAuthorshipMessages(doc.content, doc.updatedAt), metadata: { format: 'writing', writingDocumentId: doc.id, writingFingerprint: fingerprint, writingAssetIds: writingAssetIds(doc), title: doc.title, subtitle: doc.subtitle, byline: doc.byline, writingFormat: doc.format, content: doc.content, appearance: doc.appearance, ...(doc.chapter?{chapter:doc.chapter}:{}),...(doc.applicationId?{applicationId:doc.applicationId}:{}),...(doc.bookEditionId ? { bookEditionId: doc.bookEditionId } : {}), ...(doc.topicIds ? { topicIds: doc.topicIds } : {}), ...(doc.basedOnSourceId ? { basedOnSourceId: doc.basedOnSourceId, baseVersionId: doc.baseVersionId } : {}) } }, { originalBlobId: blobId, originalName: `${doc.title || 'Untitled writing'}.writing.json`, project: false, shouldWrite: () => current(scope) && useWriting.getState().revision === snapshot.revision })
      if (!current(scope)) throw changed()
      const latest = await scope.store.getKv<KnowledgeSnapshot>('knowledge.v1')
      if (!current(scope)) throw changed()
      version = latest?.versions.find((entry) => entry.id === source!.currentVersionId)
      if (!version) throw new Error('The Library source was retained but its version could not be reopened. Your draft is safe; retry saving.')
    }
    doc.sourceId = source.id; doc.publishedFingerprint = fingerprint; doc.publishedUpdatedAt = doc.updatedAt; doc.lastPublishedAt = Date.now()
    return { sourceId: source.id, versionId: version.id }
  })
}
