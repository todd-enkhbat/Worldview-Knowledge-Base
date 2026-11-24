import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { WorldDb } from '../worldDb.ts'
import type { ChangeBus } from '../changes.ts'
import { listMemoryClients, type MemoryClient, type PublicMemoryClient } from '../memoryAccess.ts'
import { decodeWriting, defaultWritingAppearance, emptyWritingContent, plainTextFromWriting, validateWritingDocument, writingFromPlainText, writingPublicationValue } from '../../src/writing/model.ts'
import type { WritingDocument, WritingNode } from '../../src/writing/types.ts'
import { applyReadingItem, decodeReading } from '../../src/reading/model.ts'
import { normalizeTopicName } from '../../src/reading/topics.ts'
import type { ReadingItemPatch } from '../../src/reading/types.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'
import { bookValue, createShelfBook, decodeBookshelf, validateShelfBook } from '../../src/bookshelf/model.ts'
import type { BookPatch, ShelfBook } from '../../src/bookshelf/types.ts'

export const ASSISTANT_EDITS_KV = 'assistantEdits.v1'
export type AssistantOperation = 'list_writing' | 'read_writing' | 'list_topics' | 'propose_create_writing' | 'propose_update_writing' | 'propose_filing' | 'get_edit_status' | 'list_books' | 'read_book' | 'propose_create_book' | 'propose_update_book'
type ScopedClient = MemoryClient | PublicMemoryClient
export interface AssistantEdit {
  id: string; requestId: string; clientId: string; clientName: string; fingerprint: string
  operation: 'create_writing' | 'update_writing' | 'filing' | 'create_book' | 'update_book'; status: 'pending' | 'applied' | 'rejected'; createdAt: number; decidedAt?: number
  expectedRevision: number; expectedUpdatedAt?: number; baselineHash?: string
  documentId?: string; document?: WritingDocument
  bookId?: string; book?: ShelfBook
  filing?: { sourceId: string; patch: ReadingItemPatch; newTopic?: string; newFolder?: string; baseline: Record<string, unknown> }
  result?: { documentId?: string; sourceId?: string; bookId?: string; revision: number }
}
interface Ledger { schemaVersion: 1; revision: number; entries: AssistantEdit[] }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const fail = (message: string): never => { throw new Error(message) }
const check = (condition: unknown, message: string): void => { if (!condition) fail(message) }
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const text = (value: unknown, maximum = 1000): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum
const keys = (value: Record<string, unknown>, allowed: string[]) => check(Object.keys(value).every((key) => allowed.includes(key)), 'This assistant command contains unsupported fields.')
const emptyCorpus = (): KnowledgeSnapshot => ({ schemaVersion: 1, revision: 0, sources: [], versions: [], passages: [], imports: [], jobs: [], proposals: [] })
export const canEdit = (client: ScopedClient) => !!client.allowCreateWriting || !!client.allowFiling || !!client.writingDocumentIds?.length || !!client.allowCreateBooks || !!client.bookshelfBookIds?.length
const collect = (node: WritingNode, type: string): WritingNode[] => [...(node.type === type ? [node] : []), ...(node.content ?? []).flatMap((child) => collect(child, type))]
const mediaIds = (doc: WritingDocument): Set<string> => new Set([...collect(doc.content, 'writingMedia').map((node) => String(node.attrs?.assetId)), ...(doc.appearance.backgroundAssetId ? [doc.appearance.backgroundAssetId] : [])])

export function createAssistantEditor(db: WorldDb, options: { now?: () => number; bus?: ChangeBus } = {}) {
  const now = () => options.now?.() ?? Date.now()
  const ledger = (): Ledger => { const value = db.getKv<Ledger>(ASSISTANT_EDITS_KV); if (!value) return { schemaVersion: 1, revision: 0, entries: [] }; check(value.schemaVersion === 1 && integer(value.revision) && Array.isArray(value.entries) && value.entries.length <= 10000, 'Assistant review history is unavailable. Restore a verified backup.'); return value }
  const corpus = () => db.getKv<KnowledgeSnapshot>('knowledge.v1') ?? emptyCorpus()
  const writing = () => decodeWriting(db.getKv('writing.v1'))
  const bookshelf = () => decodeBookshelf(db.getKv('bookshelves.v1'))
  const allowedBook = (book: ShelfBook, client: ScopedClient) => !book.archivedAt && (!!client.bookshelfBookIds?.includes(book.id) || ledger().entries.some((entry) => entry.clientId === client.id && entry.operation === 'create_book' && entry.bookId === book.id && entry.status === 'applied'))
  const allowedSource = (id: string, client: ScopedClient, snapshot = corpus()) => {
    const source = snapshot.sources.find((entry) => entry.id === id)
    if (!source || source.deleted || source.excluded || !source.aiAllowed || client.sourceIds !== null && !client.sourceIds.includes(id)) return false
    if (client.projectId) { const project = db.getKv<{ collections: { id: string; sourceIds: string[]; deletedAt?: number | null }[] }>('collections.v1')?.collections.find((entry) => entry.id === client.projectId && !entry.deletedAt); if (!project?.sourceIds.includes(id)) return false }
    if (source.nodeId) { const node = db.getNode(source.nodeId); if (!node || node.deletedAt !== null || node.corpusExcluded) return false }
    return true
  }
  const allowedDocument = (doc: WritingDocument, client: ScopedClient) => {
    if (doc.archivedAt || !client.writingDocumentIds?.includes(doc.id) && !ledger().entries.some((entry) => entry.clientId === client.id && entry.operation === 'create_writing' && entry.documentId === doc.id && entry.status === 'applied')) return false
    if (doc.sourceId) { const source = corpus().sources.find((entry) => entry.id === doc.sourceId); if (!source || source.deleted || source.excluded || !source.aiAllowed) return false }
    return true
  }
  function currentClient(id: string): PublicMemoryClient { const client = listMemoryClients(db).find((entry) => entry.id === id && !entry.revokedAt && entry.expiresAt > now()); if (!client || client.worldId !== 'local' || !canEdit(client)) return fail('This assistant is no longer authorized. Reject its pending changes or create a fresh scoped connection.'); return client }
  function ready() { check(!db.getKv('importInProgress') && db.getSettings()?.firstRunComplete, 'Finish local workspace setup or recovery before editing through an assistant.') }
  function validateReferences(doc: WritingDocument, client: ScopedClient, before?: WritingDocument) {
    const all = writing().docs.filter((entry) => allowedDocument(entry, client)), allowedMedia = new Set(all.flatMap((entry) => [...mediaIds(entry)]))
    for (const id of mediaIds(doc)) check(allowedMedia.has(id) && !!db.getAssetMeta(id), 'Only retained media already present in permitted writing can be referenced by an assistant.')
    const prior = new Set(before ? collect(before.content, 'writingCitation').map(digest) : [])
    const snapshot = corpus(), reading = decodeReading(db.getKv('reading.v1'))
    for (const node of collect(doc.content, 'writingCitation')) {
      if (prior.has(digest(node))) continue
      const a = node.attrs!, version = snapshot.versions.find((entry) => entry.id === a.versionId && entry.sourceId === a.sourceId)
      check(allowedSource(String(a.sourceId), client, snapshot) && !!version, 'A citation references a source outside this assistant’s permitted evidence scope.')
      check(a.page ? (reading.pdfHighlights ?? []).some((entry) => entry.sourceId === a.sourceId && entry.versionId === a.versionId && entry.page === a.page && entry.quote === a.quote) : version!.text.slice(Number(a.start), Number(a.end)) === a.quote, 'A citation must match its retained source version or an existing page-bound PDF quotation.')
      const source = snapshot.sources.find((source) => source.id === a.sourceId)!
      check(a.sourceTitle === source.title, 'A new citation must use its retained source title.')
      if (a.url !== undefined) { const metadata = version!.metadata ?? {}; const retained = [metadata.url, metadata.sourceUrl, metadata.canonicalUrl].filter((value): value is string => typeof value === 'string'); check(retained.includes(String(a.url)), 'A citation URL must match its retained source provenance.') }
    }
    const topicIds = new Set(reading.topics.map((entry) => entry.id))
    for (const source of snapshot.sources) if (allowedSource(source.id, client, snapshot)) for (const tag of source.tags) topicIds.add(`tag:${normalizeTopicName(tag)}`)
    for (const id of before?.topicIds ?? []) topicIds.add(id)
    for (const id of doc.topicIds ?? []) check(topicIds.has(id), 'Choose an existing permitted topic, or propose creating it through source organization.')
    const priorLinks = new Set(before ? collect(before.content, 'writingTopicLink').map(digest) : [])
    for (const node of collect(doc.content, 'writingTopicLink')) if (!priorLinks.has(digest(node))) check(topicIds.has(String(node.attrs?.topicId)), 'A new topic link must reference an existing permitted topic.')
  }
  function validateBookReferences(book: ShelfBook, client: ScopedClient, before?: ShelfBook) {
    const shelf = bookshelf(), allowed = shelf.books.filter((entry) => allowedBook(entry, client))
    if (book.coverAssetId) check(allowed.some((entry) => entry.coverAssetId === book.coverAssetId) && !!db.getAssetMeta(book.coverAssetId), 'Only covers already present on permitted bookshelf records can be referenced.')
    if (book.sourceId && book.sourceId !== before?.sourceId) check(allowedSource(book.sourceId, client), 'The linked original is outside this assistant’s permitted source scope.')
    const permittedCollections = new Set(allowed.flatMap((entry) => entry.shelfIds))
    const known = new Set(shelf.shelves.filter((entry) => !entry.archivedAt && (client.allowCreateBooks || permittedCollections.has(entry.id))).map((entry) => entry.id))
    for (const id of before?.shelfIds ?? []) known.add(id)
    for (const id of book.shelfIds) check(known.has(id), 'Choose an existing collection for this book or article.')
  }
  function commit(states: { key: string; expected: number; value: { revision: number } }[]) {
    db.tx(() => { ready(); for (const state of states) { check((db.getKv<{ revision?: number }>(state.key)?.revision ?? 0) === state.expected, 'The workspace changed before this action could commit. Review it again.'); check(state.value.revision === state.expected + 1, 'This command has an invalid state revision.') } for (const state of states) db.putKv(state.key, state.value) })
    options.bus?.publish({ v: 1, from: 'assistant-review', change: { type: 'kv', keys: states.map((state) => state.key) } })
  }
  function saveProposal(entry: AssistantEdit, state: Ledger) { check(state.entries.filter((item) => item.status === 'pending').length < 100, 'Review pending assistant changes before adding more.'); const next: Ledger = { ...state, revision: state.revision + 1, entries: [...state.entries, entry] }; check(next.entries.length <= 10000 && Buffer.byteLength(JSON.stringify(next)) <= 16 * 1024 * 1024, 'Assistant audit history reached its local storage limit. Export a verified backup before continuing.'); commit([{ key: ASSISTANT_EDITS_KV, expected: state.revision, value: next }]); return { ok: true, proposalId: entry.id, status: 'pending', reviewRequired: true, reviewUrl: '#/sources?connection=memory', ...(entry.documentId ? { documentId: entry.documentId } : {}), ...(entry.bookId ? { bookId: entry.bookId } : {}) } }
  const receipt = (entry: AssistantEdit) => ({ ok: true, proposalId: entry.id, operation: entry.operation, status: entry.status, createdAt: entry.createdAt, decidedAt: entry.decidedAt, documentId: entry.documentId, bookId: entry.bookId, result: entry.result, reviewRequired: entry.status === 'pending' })

  function operation(name: AssistantOperation, raw: unknown, client: MemoryClient): unknown {
    ready(); check(client.worldId === 'local' && canEdit(client), 'This client has read-only access. Create an explicitly scoped editing connection in Worldview.')
    const input = object(raw) ? raw : {}, snapshot = writing()
    if (name === 'list_books') { keys(input, ['offset', 'limit']); check(client.allowCreateBooks || client.bookshelfBookIds?.length, 'This client has no bookshelf scope.'); const shelf = bookshelf(), books = shelf.books.filter((book) => allowedBook(book, client)), offset = integer(input.offset) ? input.offset : 0, limit = integer(input.limit) ? Math.max(1, Math.min(100, input.limit)) : 40; return { bookshelfRevision: shelf.revision, books: books.slice(offset, offset + limit).map((book) => ({ id: book.id, title: book.title, authors: book.authors, kind: book.kind, status: book.status, rating: book.rating, updatedAt: book.updatedAt })), collections: shelf.shelves.filter((entry) => !entry.archivedAt && (client.allowCreateBooks || books.some((book) => book.shelfIds.includes(entry.id)))).map(({ id, name }) => ({ id, name })), nextOffset: offset + limit < books.length ? offset + limit : null, permissions: { create: !!client.allowCreateBooks }, reviewRequired: true } }
    if (name === 'read_book') { keys(input, ['bookId', 'offset', 'limit']); const shelf = bookshelf(), book = shelf.books.find((book) => book.id === input.bookId); check(book && allowedBook(book, client), 'This bookshelf record is outside the client’s current scope.'); const complete = Buffer.byteLength(JSON.stringify(book)) <= 64 * 1024, offset = integer(input.offset) ? input.offset : 0, limit = integer(input.limit) ? Math.max(1, Math.min(16000, input.limit)) : 8000; return { bookshelfRevision: shelf.revision, complete, book: complete ? book : { id: book!.id, title: book!.title, authors: book!.authors, kind: book!.kind, status: book!.status, rating: book!.rating, updatedAt: book!.updatedAt }, ...(complete ? {} : { notes: book!.notes.slice(offset, offset + limit), offset, nextOffset: offset + limit < book!.notes.length ? offset + limit : null, note: 'Full details exceed the response budget. Use metadata edits or appendNotes rather than replacing incomplete details.' }) } }
    if (name === 'list_writing') { keys(input, ['offset', 'limit']); const offset = integer(input.offset) ? input.offset : 0, limit = integer(input.limit) ? Math.min(100, Math.max(1, input.limit)) : 40, documents = snapshot.docs.filter((doc) => allowedDocument(doc, client)); return { writingRevision: snapshot.revision, documents: documents.slice(offset, offset + limit).map((doc) => ({ id: doc.id, title: doc.title, subtitle: doc.subtitle, format: doc.format, updatedAt: doc.updatedAt, topicIds: doc.topicIds ?? [] })), nextOffset: offset + limit < documents.length ? offset + limit : null, permissions: { create: !!client.allowCreateWriting, filing: !!client.allowFiling }, reviewRequired: true } }
    if (name === 'read_writing') { keys(input, ['documentId', 'offset', 'limit']); const doc = snapshot.docs.find((entry) => entry.id === input.documentId); check(doc && allowedDocument(doc, client), 'This writing is unavailable in this client’s current scope.'); const complete = Buffer.byteLength(JSON.stringify(doc)) <= 64 * 1024, plain = plainTextFromWriting(doc!.content), offset = integer(input.offset) ? input.offset : 0, limit = integer(input.limit) ? Math.max(1, Math.min(16000, input.limit)) : 8000; return { writingRevision: snapshot.revision, document: complete ? doc : { id: doc!.id, title: doc!.title, subtitle: doc!.subtitle, byline: doc!.byline, format: doc!.format, updatedAt: doc!.updatedAt, topicIds: doc!.topicIds ?? [] }, complete, ...(complete ? {} : { text: plain.slice(offset, offset + limit), offset, nextOffset: offset + limit < plain.length ? offset + limit : null, note: 'Rich content exceeds this tool’s response budget. Use appendText or metadata edits rather than replacing an incomplete document.' }) } }
    if (name === 'list_topics') { keys(input, []); const reading = decodeReading(db.getKv('reading.v1')), ids = new Set(snapshot.docs.filter((doc) => allowedDocument(doc, client)).flatMap((doc) => doc.topicIds ?? [])); return { readingRevision: reading.revision, topics: reading.topics.filter((topic) => client.allowFiling || ids.has(topic.id)).map(({ id, name }) => ({ id, name })), folders: client.allowFiling ? reading.folders.filter((folder) => !folder.deletedAt).map(({ id, name }) => ({ id, name })) : [] } }
    if (name === 'get_edit_status') { keys(input, ['proposalId']); const entry = ledger().entries.find((item) => item.id === input.proposalId && item.clientId === client.id); check(entry, 'This assistant change is unavailable.'); return receipt(entry!) }
    check(text(input.requestId, 160) && integer(input.expectedRevision), 'Provide a unique requestId and the exact revision returned by list_writing or list_topics.')
    const state = ledger(), fingerprint = digest({ operation: name, input }), prior = state.entries.find((entry) => entry.clientId === client.id && entry.requestId === input.requestId)
    if (prior) { check(prior.fingerprint === fingerprint, 'This requestId was already used for a different change.'); return receipt(prior) }
    const common = { id: randomUUID(), requestId: String(input.requestId), clientId: client.id, clientName: client.name, fingerprint, status: 'pending' as const, createdAt: now(), expectedRevision: Number(input.expectedRevision) }
    if (name === 'propose_create_book') {
      keys(input, ['requestId', 'expectedRevision', 'book']); const shelf = bookshelf(); check(client.allowCreateBooks && input.expectedRevision === shelf.revision && object(input.book), 'Creating this bookshelf record is not authorized, or its revision changed. Refresh list_books first.')
      const value = input.book as BookPatch; keys(value as Record<string, unknown>, Object.keys(bookValue(createShelfBook({ title: 'Validation template' }))).concat('sourceId'))
      const book = createShelfBook({ ...value, title: typeof value.title === 'string' ? value.title : '' }, now()); validateBookReferences(book, client); return saveProposal({ ...common, operation: 'create_book', bookId: book.id, book }, state)
    }
    if (name === 'propose_update_book') {
      keys(input, ['requestId', 'expectedRevision', 'bookId', 'expectedUpdatedAt', 'patch']); const shelf = bookshelf(), before = shelf.books.find((book) => book.id === input.bookId)
      check(before && allowedBook(before, client) && input.expectedRevision === shelf.revision && input.expectedUpdatedAt === before.updatedAt && object(input.patch), 'This bookshelf record changed or is outside the client’s scope. Refresh read_book first.')
      const patch = { ...(input.patch as Record<string, unknown>) }; keys(patch, Object.keys(bookValue(before!)).concat('sourceId', 'appendNotes')); check(!(patch.appendNotes !== undefined && patch.notes !== undefined), 'Use notes or appendNotes, not both.')
      if (patch.appendNotes !== undefined) { check(typeof patch.appendNotes === 'string' && patch.appendNotes.length <= 64000, 'Append at most 64,000 note characters.'); patch.notes = before!.notes + String(patch.appendNotes); delete patch.appendNotes }
      const book = validateShelfBook({ ...before, ...patch }); validateBookReferences(book, client, before); return saveProposal({ ...common, operation: 'update_book', bookId: book.id, book, expectedUpdatedAt: before!.updatedAt, baselineHash: digest(bookValue(before!)) }, state)
    }
    if (name === 'propose_create_writing') {
      keys(input, ['requestId', 'expectedRevision', 'document']); check(client.allowCreateWriting && input.expectedRevision === snapshot.revision && object(input.document), 'Creating this draft is not authorized, or writing changed. Refresh list_writing first.')
      const value = input.document as Record<string, unknown>; keys(value, ['title', 'subtitle', 'byline', 'format', 'content', 'text', 'appearance', 'topicIds']); check(!(value.text !== undefined && value.content !== undefined), 'Provide plain text or rich content, not both.')
      const timestamp = now(), doc = validateWritingDocument({ id: randomUUID(), title: value.title ?? 'Assistant draft', subtitle: value.subtitle ?? '', byline: value.byline ?? '', format: value.format ?? 'note', content: value.content ?? (typeof value.text === 'string' ? writingFromPlainText(value.text) : emptyWritingContent()), appearance: { ...defaultWritingAppearance(), ...(object(value.appearance) ? value.appearance : {}) }, topicIds: value.topicIds ?? [], createdAt: timestamp, updatedAt: timestamp, archivedAt: null })
      validateReferences(doc, client); return saveProposal({ ...common, operation: 'create_writing', documentId: doc.id, document: doc }, state)
    }
    if (name === 'propose_update_writing') {
      keys(input, ['requestId', 'expectedRevision', 'documentId', 'expectedUpdatedAt', 'patch']); const original = snapshot.docs.find((doc) => doc.id === input.documentId)
      check(original && allowedDocument(original, client) && input.expectedRevision === snapshot.revision && integer(input.expectedUpdatedAt) && input.expectedUpdatedAt === original.updatedAt && object(input.patch), 'This draft changed or is outside the client’s scope. Refresh read_writing before proposing an edit.')
      const patch = { ...(input.patch as Record<string, unknown>) }; keys(patch, ['title', 'subtitle', 'byline', 'format', 'content', 'appearance', 'topicIds', 'appendText']); check(!(patch.appendText !== undefined && patch.content !== undefined), 'Use appendText or content, not both.')
      if (patch.appendText !== undefined) { check(typeof patch.appendText === 'string' && patch.appendText.length <= 64000, 'Append at most 64,000 text characters at once.'); patch.content = { ...original!.content, content: [...(original!.content.content ?? []), ...(writingFromPlainText(String(patch.appendText)).content ?? [])] }; delete patch.appendText }
      const doc = validateWritingDocument({ ...original, ...patch, appearance: { ...original!.appearance, ...(object(patch.appearance) ? patch.appearance : {}) } }); validateReferences(doc, client, original)
      return saveProposal({ ...common, operation: 'update_writing', documentId: doc.id, document: doc, expectedUpdatedAt: original!.updatedAt, baselineHash: digest(writingPublicationValue(original!)) }, state)
    }
    check(name === 'propose_filing', 'Unknown assistant editing operation.'); keys(input, ['requestId', 'expectedRevision', 'sourceId', 'patch', 'newTopic', 'newFolder'])
    const reading = decodeReading(db.getKv('reading.v1')); check(client.allowFiling && input.expectedRevision === reading.revision && text(input.sourceId) && allowedSource(input.sourceId, client) && object(input.patch), 'This source is unavailable, organization is not authorized, or reading data changed. Refresh list_topics first.')
    const patch = input.patch as ReadingItemPatch; keys(patch as Record<string, unknown>, ['folderId', 'status', 'favorite', 'topicIds'])
    check(input.newTopic === undefined || text(input.newTopic, 160), 'Name a topic with at most 160 characters.'); check(input.newFolder === undefined || text(input.newFolder, 160), 'Name a folder with at most 160 characters.')
    // The shared pure command validates folder/topic identities and all field values.
    const preview = structuredClone(reading); applyReadingItem(preview, String(input.sourceId), patch, now()); decodeReading(preview)
    const before = reading.items.find((item) => item.sourceId === input.sourceId)
    const affected = new Set(Object.keys(patch)); if (input.newFolder) affected.add('folderId'); if (input.newTopic) affected.add('topicIds')
    const baseline = Object.fromEntries([...affected].map((key) => [key, before?.[key as keyof typeof before] ?? (key === 'topicIds' ? [] : key === 'favorite' ? false : key === 'status' ? 'unread' : null)]))
    return saveProposal({ ...common, operation: 'filing', filing: { sourceId: String(input.sourceId), patch, baseline, ...(input.newTopic ? { newTopic: String(input.newTopic).trim() } : {}), ...(input.newFolder ? { newFolder: String(input.newFolder).trim() } : {}) } }, state)
  }

  function review(id: string, decision: 'approve' | 'reject') {
    ready(); const state = ledger(), entry = state.entries.find((item) => item.id === id); check(entry, 'This assistant change is unavailable.'); if (entry!.status !== 'pending') return receipt(entry!)
    const next = structuredClone(state), changed = next.entries.find((item) => item.id === id)!
    changed.decidedAt = now(); changed.status = decision === 'approve' ? 'applied' : 'rejected'; next.revision++
    const states: { key: string; expected: number; value: { revision: number } }[] = [{ key: ASSISTANT_EDITS_KV, expected: state.revision, value: next }]
    if (decision === 'approve') {
      const client = currentClient(entry!.clientId)
      if (entry!.operation === 'create_book' || entry!.operation === 'update_book') {
        const shelf = bookshelf(), revision = shelf.revision, before = shelf.books.find((book) => book.id === entry!.bookId)
        if (entry!.operation === 'create_book') check(client.allowCreateBooks && !before, 'This assistant can no longer create that bookshelf record.')
        else check(before && allowedBook(before, client) && before.updatedAt === entry!.expectedUpdatedAt && digest(bookValue(before)) === entry!.baselineHash, 'These book details changed after the proposal. Ask the assistant to refresh its change.')
        const proposed = validateShelfBook(entry!.book); check(proposed.id === entry!.bookId, 'The reviewed book identity does not match its proposed details. Reject this change and request a fresh proposal.'); validateBookReferences(proposed, client, before)
        const saved = validateShelfBook({ ...proposed, updatedAt: Math.max(now(), (before?.updatedAt ?? 0) + 1) })
        if (before) { shelf.history.push({ id: randomUUID(), bookId: before.id, recordedAt: now(), kind: 'edit', label: `Before assistant edit: ${client.name}`.slice(0, 160), book: before }); shelf.books[shelf.books.findIndex((book) => book.id === before.id)] = saved }
        else { shelf.books.push(saved); shelf.history.push({ id: randomUUID(), bookId: saved.id, recordedAt: now(), kind: 'created', label: `Approved assistant addition: ${client.name}`.slice(0, 160), book: saved }) }
        shelf.revision++; decodeBookshelf(shelf); states.push({ key: 'bookshelves.v1', expected: revision, value: shelf }); changed.result = { bookId: saved.id, revision: shelf.revision }
      } else if (entry!.operation === 'filing') {
        const filing = entry!.filing!, reading = decodeReading(db.getKv('reading.v1')), revision = reading.revision
        check(client.allowFiling && allowedSource(filing.sourceId, client), 'This assistant no longer has organization access to that source.')
        const current = reading.items.find((item) => item.sourceId === filing.sourceId)
        for (const [key, value] of Object.entries(filing.baseline)) { const actual = current?.[key as keyof typeof current] ?? (key === 'topicIds' ? [] : key === 'favorite' ? false : key === 'status' ? 'unread' : null); check(JSON.stringify(actual) === JSON.stringify(value), 'This file’s organization changed after the proposal. Ask the assistant to refresh its change.') }
        const patch = structuredClone(filing.patch)
        if (filing.newTopic) { let topic = reading.topics.find((item) => normalizeTopicName(item.name) === normalizeTopicName(filing.newTopic!)); if (!topic) { topic = { id: randomUUID(), name: filing.newTopic, createdAt: now() }; reading.topics.push(topic) } patch.topicIds = [...new Set([...(patch.topicIds ?? current?.topicIds ?? []), topic.id])] }
        if (filing.newFolder) { let folder = reading.folders.find((item) => !item.deletedAt && item.parentId === null && item.name === filing.newFolder); if (!folder) { folder = { id: randomUUID(), name: filing.newFolder, parentId: null, createdAt: now() }; reading.folders.push(folder) } patch.folderId = folder.id }
        applyReadingItem(reading, filing.sourceId, patch, now()); reading.revision++; decodeReading(reading); states.push({ key: 'reading.v1', expected: revision, value: reading }); changed.result = { sourceId: filing.sourceId, revision: reading.revision }
      } else {
        const snapshot = writing(), revision = snapshot.revision, before = snapshot.docs.find((doc) => doc.id === entry!.documentId)
        if (entry!.operation === 'create_writing') check(client.allowCreateWriting && !before, 'This assistant can no longer create that draft.')
        else check(before && allowedDocument(before, client) && before.updatedAt === entry!.expectedUpdatedAt && digest(writingPublicationValue(before)) === entry!.baselineHash, 'This writing changed after the assistant’s proposal. Ask the assistant to refresh its edit.')
        const proposed = validateWritingDocument(entry!.document); check(proposed.id === entry!.documentId, 'The reviewed draft identity does not match its proposed content. Reject this change and request a fresh proposal.'); validateReferences(proposed, client, before)
        const saved = validateWritingDocument({ ...proposed, ...(before ? { sourceId: before.sourceId, publishedUpdatedAt: before.publishedUpdatedAt, publishedFingerprint: before.publishedFingerprint, lastPublishedAt: before.lastPublishedAt } : {}), updatedAt: Math.max(now(), (before?.updatedAt ?? 0) + 1) })
        if (before) {
          const history = db.getKv<{ schemaVersion: 1; revision: number; entries: { id: string; documentId: string; createdAt: number; label: string; kind: string; document: WritingDocument }[] }>('writingHistory.v1') ?? { schemaVersion: 1, revision: 0, entries: [] }
          check(history.schemaVersion === 1 && integer(history.revision) && Array.isArray(history.entries), 'Writing history is unavailable; this draft was preserved.')
          for (const item of history.entries) validateWritingDocument(item.document)
          const previous = history.revision; history.entries.push({ id: randomUUID(), documentId: before.id, createdAt: now(), label: `Before assistant edit: ${client.name}`.slice(0, 160), kind: 'restore', document: before }); history.revision++
          check(history.entries.length <= 10000 && Buffer.byteLength(JSON.stringify(history)) <= 32 * 1024 * 1024, 'Writing recovery history is full. Export a verified backup before approving more edits.'); states.push({ key: 'writingHistory.v1', expected: previous, value: history })
          snapshot.docs[snapshot.docs.findIndex((doc) => doc.id === saved.id)] = saved
        } else snapshot.docs.push(saved)
        snapshot.revision++; decodeWriting(snapshot); states.push({ key: 'writing.v1', expected: revision, value: snapshot }); changed.result = { documentId: saved.id, revision: snapshot.revision }
      }
    }
    commit(states); return receipt(changed)
  }
  function status() { const state = ledger(), current = writing(), shelf = bookshelf(); return { available: true, reviewRequired: true, bridge: { command: process.execPath, args: [fileURLToPath(new URL('../../scripts/memory-mcp-bridge.ts', import.meta.url))] }, revision: state.revision, writingRevision: current.revision, bookshelfRevision: shelf.revision, readingRevision: decodeReading(db.getKv('reading.v1')).revision, entries: [...[...state.entries].reverse().filter((entry) => entry.status === 'pending'), ...[...state.entries].reverse().filter((entry) => entry.status !== 'pending').slice(0, 100)].map((entry) => ({ ...entry, ...(entry.status === 'pending' && entry.documentId ? { currentDocument: current.docs.find((doc) => doc.id === entry.documentId) } : {}), ...(entry.status === 'pending' && entry.bookId ? { currentBook: shelf.books.find((book) => book.id === entry.bookId) } : {}) })) } }
  return { operation, review, status }
}

export const assistantTools = [
  ['list_writing', 'List only writing drafts explicitly permitted to this client; returns the current writingRevision.'],
  ['read_writing', 'Read a permitted draft with its updatedAt and writingRevision. Large documents return a bounded excerpt and complete:false; do not replace incomplete rich content.'],
  ['list_topics', 'Read permitted organization metadata and the current readingRevision.'],
  ['propose_create_writing', 'Propose a new local draft. Requires create permission, unique requestId, expectedRevision, and document. Nothing is applied until the user approves it in Worldview.'],
  ['propose_update_writing', 'Propose an edit to a permitted draft. Requires unique requestId, exact expectedRevision and expectedUpdatedAt, and patch. appendText safely preserves a large existing document. The user reviews and approves before application.'],
  ['propose_filing', 'Propose folder/topic/status/favorite changes to an authorized source. Optional newTopic/newFolder creates local taxonomy only. Requires requestId and current reading expectedRevision; user approval is required.'],
  ['list_books', 'List only bookshelf records explicitly permitted to this client, with bookshelfRevision and permitted collection names.'],
  ['read_book', 'Read permitted book/article details with updatedAt and bookshelfRevision. Oversized details return complete:false; preserve incomplete fields using appendNotes or metadata patches.'],
  ['propose_create_book', 'Propose adding a book or article. Requires explicit create-books permission, requestId, expectedRevision and book metadata. User approval is required.'],
  ['propose_update_book', 'Propose editing a permitted book/article with exact expectedRevision and expectedUpdatedAt. Existing metadata and originals are preserved; user approval is required.'],
  ['get_edit_status', 'Read the status of one proposal made by this client. Applied results identify the resulting document/source and revision.'],
].map(([name, description]) => ({ name, description, inputSchema: { type: 'object' as const, properties: { requestId: { type: 'string', maxLength: 160 }, expectedRevision: { type: 'integer', minimum: 0 }, expectedUpdatedAt: { type: 'integer', minimum: 0 }, documentId: { type: 'string', maxLength: 1000 }, proposalId: { type: 'string', maxLength: 1000 }, sourceId: { type: 'string', maxLength: 1000 }, bookId: { type: 'string', maxLength: 1000 }, book: { type: 'object' }, document: { type: 'object' }, patch: { type: 'object' }, newTopic: { type: 'string', maxLength: 160 }, newFolder: { type: 'string', maxLength: 160 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 16000 } }, additionalProperties: false }, annotations: { readOnlyHint: !name.startsWith('propose_'), destructiveHint: false, idempotentHint: true, openWorldHint: false } }))
