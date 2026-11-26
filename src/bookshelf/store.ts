import { create } from 'zustand'
import type { WorldStore } from '../data/WorldStore.ts'
import { compareAndSwapWorldState, getStore, getWorldGeneration, isRepoReady, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import { bookValue, createShelfBook, decodeBookshelf, emptyBookshelf, validateShelfBook } from './model.ts'
import { BOOKSHELF_KV, type BookAttribution, type BookPatch, type BookRevision, type BookshelfImport, type BookshelfSnapshot, type CreateBookInput, type ShelfBook } from './types.ts'
import type { KnowledgeSnapshot } from '../knowledge/types.ts'
import { decodeReading } from '../reading/model.ts'
import { safeBookUrl } from './model.ts'
import { authorNameKey, editionIsbn } from './catalog.ts'
export * from './types.ts'
export * from './model.ts'

export const useBookshelf = create<BookshelfSnapshot & { loaded: boolean; busy: boolean; error: string | null }>()(() => ({ ...emptyBookshelf(), loaded: false, busy: false, error: null }))
let bound: WorldStore | null = null, epoch = 0, queue: Promise<unknown> = Promise.resolve()
const cleanup: (() => void)[] = []
interface Scope { store: WorldStore; generation: number; epoch: number }
const current = (scope: Scope) => isRepoReady() && getStore() === scope.store && bound === scope.store && getWorldGeneration() === scope.generation && epoch === scope.epoch
const changed = () => new Error('The workspace changed. Reopen this bookshelf before saving.')
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
const publish = (snapshot: BookshelfSnapshot) => useBookshelf.setState({ ...snapshot, loaded: true, error: null })
export function resetBookshelf() { epoch++; bound = null; queue = Promise.resolve(); for (const stop of cleanup.splice(0)) stop(); useBookshelf.setState({ ...emptyBookshelf(), loaded: false, busy: false, error: null }) }
export async function refreshBookshelf(): Promise<void> {
  if (!isRepoReady()) return
  if (bound !== getStore()) return initializeBookshelf()
  const scope = { store: getStore(), generation: getWorldGeneration(), epoch }
  try { const snapshot = decodeBookshelf(await scope.store.getKv(BOOKSHELF_KV)); if (current(scope) && snapshot.revision >= useBookshelf.getState().revision) publish(snapshot) }
  catch (cause) { if (current(scope)) useBookshelf.setState({ error: message(cause) }); throw cause }
}
export async function initializeBookshelf(): Promise<void> {
  if (!isRepoReady()) return
  const store = getStore()
  if (bound !== store) {
    resetBookshelf(); bound = store
    cleanup.push(subscribeRepo((change) => {
      if (!isRepoReady() || getStore() !== store || bound !== store) return
      if (change.type === 'wipe' || change.type === 'import') { epoch++; queue = Promise.resolve(); useBookshelf.setState({ ...emptyBookshelf(), loaded: false, busy: false, error: null }) }
      if (change.type === 'wipe' || change.type === 'import' || change.type === 'kv' && change.keys.includes(BOOKSHELF_KV)) void refreshBookshelf().catch(() => {})
    }))
    cleanup.push(useRepoStatus.subscribe((status) => { if (!status.ready && bound === store) resetBookshelf() }))
  }
  await refreshBookshelf()
}
function mutate<T>(change: (snapshot: BookshelfSnapshot, scope: Scope) => T | Promise<T>): Promise<T> {
  if (!isRepoReady()) return Promise.reject(new Error('Open a workspace before saving to your bookshelf.'))
  const initialization = initializeBookshelf(); void initialization.catch(() => {})
  const scope = { store: getStore(), generation: getWorldGeneration(), epoch }
  const task = queue.catch(() => {}).then(async () => {
    await initialization
    if (!current(scope)) throw changed()
    if (!useRepoStatus.getState().writer) throw new Error('This bookshelf is read only. Open the editing tab to save.')
    if (useRepoStatus.getState().interruptedImport) throw new Error('Finish backup recovery before editing your bookshelf.')
    useBookshelf.setState({ busy: true, error: null })
    try {
      const snapshot = decodeBookshelf(await scope.store.getKv(BOOKSHELF_KV))
      if (!current(scope)) throw changed()
      const before = JSON.stringify(snapshot), expected = snapshot.revision, result = await change(snapshot, scope)
      if (!current(scope)) throw changed()
      if (before !== JSON.stringify(snapshot)) { snapshot.revision++; decodeBookshelf(snapshot); if (!current(scope)) throw changed(); await compareAndSwapWorldState(BOOKSHELF_KV, snapshot, expected); if (!current(scope)) throw changed(); publish(snapshot) }
      return structuredClone(result)
    } catch (cause) { if (current(scope)) { await refreshBookshelf().catch(() => {}); useBookshelf.setState({ error: message(cause) }) } throw cause }
    finally { if (current(scope)) useBookshelf.setState({ busy: false }) }
  })
  queue = task; return task
}
function attributionKey(entry: Omit<BookAttribution, 'id'>) {
  return JSON.stringify([entry.scope, entry.scope === 'edition' ? editionIsbn(entry.isbn) || entry.editionId : [entry.title, entry.author].map(authorNameKey),
    authorNameKey(entry.name), entry.kind, entry.relation, entry.url])
}
export function saveAttribution(entry: Omit<BookAttribution, 'id'>) {
  return mutate(snapshot => {
    const entries = snapshot.attributions ??= []
    const key = attributionKey(entry)
    if (!entries.some(other => attributionKey(other) === key)) entries.push({ ...entry, id: crypto.randomUUID() })
  })
}
export function removeAttribution(id: string) {
  return mutate(snapshot => { snapshot.attributions = snapshot.attributions?.filter(item => item.id !== id) ?? [] })
}
const findBook = (snapshot: BookshelfSnapshot, id: string) => { const book = snapshot.books.find((book) => book.id === id); if (!book) throw new Error('This book or article is no longer available.'); return book }
function retain(snapshot: BookshelfSnapshot, book: ShelfBook, kind: BookRevision['kind'], label: string) { const entry = { id: crypto.randomUUID(), bookId: book.id, recordedAt: Date.now(), kind, label, book: structuredClone(book) }; snapshot.history.push(entry); return entry }
function checkShelves(snapshot: BookshelfSnapshot, book: ShelfBook) { if (book.shelfIds.some((id) => !snapshot.shelves.some((shelf) => shelf.id === id))) throw new Error('A selected collection is unavailable. Your changes are still here.') }
export function createBook(input: CreateBookInput): Promise<ShelfBook> {
  return mutate((snapshot) => {
    const book = createShelfBook(input)
    if (book.catalog) {
      const existing = snapshot.books.find((other) => !other.archivedAt && sameEdition(other, book))
      if (existing) {
        if (!existing.catalog) {
          retain(snapshot, existing, 'edit', 'Before linking catalog edition')
          existing.catalog = book.catalog
          existing.coverAssetId ??= book.coverAssetId
          existing.year ??= book.year
          existing.pages ??= book.pages
          if (!existing.url) existing.url = book.url
          if (!existing.authors.length) existing.authors = book.authors
          existing.updatedAt = Math.max(Date.now(), existing.updatedAt + 1)
        }
        return existing
      }
    }
    checkShelves(snapshot, book)
    snapshot.books.push(book)
    retain(snapshot, book, 'created', 'Added to your bookshelf')
    return book
  })
}
/** Link retained evidence once, leaving its original bytes, annotations, and topics authoritative. */
export function createBookFromSource(sourceId: string, kind?: ShelfBook['kind']): Promise<ShelfBook> {
  return mutate(async (snapshot, scope) => {
    const [corpus, readingValue] = await Promise.all([scope.store.getKv<KnowledgeSnapshot>('knowledge.v1'), scope.store.getKv('reading.v1')])
    if (!current(scope)) throw changed()
    const source = corpus?.sources.find((source) => source.id === sourceId && !source.deleted && !source.excluded), version = corpus?.versions.find((version) => version.id === source?.currentVersionId && version.sourceId === sourceId)
    if (!source || !version) throw new Error('This retained source is no longer available for your bookshelf.')
    const linked = snapshot.books.filter((book) => book.sourceId === sourceId)
    const existing = linked.find((book) => book.sourceVersionId === version.id) ?? linked[0]
    if (existing) return existing
    const reading = decodeReading(readingValue), item = reading.items.find((entry) => entry.sourceId === sourceId), metadata = version.metadata ?? {}
    const rawAuthors = Array.isArray(metadata.authors) ? metadata.authors : typeof metadata.author === 'string' ? [metadata.author] : typeof metadata.byline === 'string' ? [metadata.byline] : []
    const authors = rawAuthors.filter((value): value is string => typeof value === 'string' && !!value.trim()).slice(0, 30).map((value) => value.trim().slice(0, 300))
    const link = typeof metadata.url === 'string' ? metadata.url : typeof metadata.sourceUrl === 'string' ? metadata.sourceUrl : ''
    const derivedYear = typeof metadata.year === 'number' ? metadata.year : version.authoredAt !== null && Number.isFinite(version.authoredAt) ? new Date(version.authoredAt).getUTCFullYear() : null
    const year = derivedYear !== null && Number.isInteger(derivedYear) && derivedYear > 0 && derivedYear < 10000 ? derivedYear : null
    const book = createShelfBook({ title: source.title, authors, kind: kind ?? (metadata.format === 'article' || link ? 'article' : 'book'), format: 'digital', status: item?.status ?? 'unread', url: safeBookUrl(link) ? link : '', isbn: typeof metadata.isbn === 'string' ? metadata.isbn.slice(0, 100) : '', year, finishedAt: item?.readAt ? new Date(item.readAt).toISOString().slice(0, 10) : null, sourceId: source.id, sourceVersionId: version.id, fields: source.tags.length ? [{ id: crypto.randomUUID(), label: 'Topics from the retained source', value: source.tags.join(' · ').slice(0, 20000) }] : [] })
    snapshot.books.push(book); retain(snapshot, book, 'created', 'Added from your retained library'); return book
  })
}
export function attachBookText(bookId: string, sourceId: string, versionId: string, expectedUpdatedAt: number): Promise<ShelfBook> {
  return mutate(async (snapshot, scope) => {
    const book = findBook(snapshot, bookId)
    const corpus = await scope.store.getKv<KnowledgeSnapshot>('knowledge.v1')
    if (!current(scope)) throw changed()
    const source = corpus?.sources.find((entry) => entry.id === sourceId && !entry.deleted && !entry.excluded)
    const version = corpus?.versions.find((entry) => entry.sourceId === sourceId && entry.id === versionId)
    if (!source || !version?.text.trim()) throw new Error('This retained text version is unavailable. Choose a Library version with readable text.')
    if (book.sourceId === sourceId && book.sourceVersionId === versionId) return book
    if (book.updatedAt !== expectedUpdatedAt) throw new Error('This shelf entry changed. Reopen its details before attaching a source.')
    const other = snapshot.books.find((entry) => entry.id !== bookId && !entry.archivedAt && entry.sourceId === sourceId && (!entry.sourceVersionId || entry.sourceVersionId === versionId))
    if (other) throw new Error('This text is already attached to “' + other.title + '”.')
    retain(snapshot, book, 'edit', 'Before attaching retained text')
    book.sourceId = sourceId
    book.sourceVersionId = versionId
    book.updatedAt = Math.max(Date.now(), book.updatedAt + 1)
    return book
  })
}
export function updateBook(id: string, patch: BookPatch, expectedUpdatedAt: number): Promise<ShelfBook> {
  return mutate((snapshot) => {
    const original = findBook(snapshot, id)
    if (original.updatedAt !== expectedUpdatedAt) throw new Error('A newer version of these details was saved elsewhere. Your edits are still here; reload the saved version or save a copy.')
    const allowed = new Set([...Object.keys(bookValue(original)), 'sourceId', 'catalog', 'goodreadsId'])
    if (Object.keys(patch).some((key) => !allowed.has(key))) throw new Error('This bookshelf update includes unsupported fields.')
    const next = validateShelfBook({ ...original, ...patch })
    if (next.catalog && snapshot.books.some((other) => other.id !== id && !other.archivedAt && sameEdition(other, next))) throw new Error('This edition is already on your bookshelf.')
    checkShelves(snapshot, next)
    if (JSON.stringify(bookValue(next)) === JSON.stringify(bookValue(original))) return original
    retain(snapshot, original, 'edit', 'Before editing details')
    next.updatedAt = Math.max(Date.now(), original.updatedAt + 1); Object.assign(original, next); return original
  })
}
export function archiveBook(id: string, archived = true, expectedUpdatedAt?: number): Promise<ShelfBook> {
  return mutate((snapshot) => { const book = findBook(snapshot, id); if (expectedUpdatedAt !== undefined && book.updatedAt !== expectedUpdatedAt) throw new Error('This book changed before it could be moved. Reopen its details.'); if (!!book.archivedAt === archived) return book; retain(snapshot, book, archived ? 'archive' : 'restore', archived ? 'Before moving to Trash' : 'Before restoring from Trash'); book.archivedAt = archived ? Date.now() : null; book.updatedAt = Math.max(Date.now(), book.updatedAt + 1); return book })
}
export function saveBookSnapshot(id: string, label: string) { return mutate((snapshot) => { const clean = label.trim(); if (!clean || clean.length > 160) throw new Error('Name this milestone with 1 to 160 characters.'); return retain(snapshot, findBook(snapshot, id), 'named', clean) }) }
export function restoreBookRevision(id: string, revisionId: string, expectedUpdatedAt: number): Promise<ShelfBook> {
  return mutate((snapshot) => { const book = findBook(snapshot, id); if (book.updatedAt !== expectedUpdatedAt) throw new Error('The details changed before restoration. Compare the latest version first.'); const entry = snapshot.history.find((entry) => entry.id === revisionId && entry.bookId === id); if (!entry) throw new Error('This retained version is unavailable.'); retain(snapshot, book, 'restore', 'Before restoring an earlier version'); Object.assign(book, bookValue(entry.book), { updatedAt: Math.max(Date.now(), book.updatedAt + 1) }); return book })
}
const fold = authorNameKey
export function matchesEdition(book: ShelfBook, kind: ShelfBook['kind'], editionId?: string, incomingIsbn?: string): boolean {
  if (book.kind !== kind) return false
  if (book.catalog && editionId) return book.catalog.editionId === editionId
  const isbn = editionIsbn(book.isbn)
  return !!isbn && isbn === editionIsbn(incomingIsbn)
}
function sameEdition(book: ShelfBook, incoming: CreateBookInput): boolean {
  return matchesEdition(book, incoming.kind ?? 'book', incoming.catalog?.editionId, incoming.isbn)
}
function sameBook(book: ShelfBook, incoming: CreateBookInput): boolean {
  if (book.kind !== (incoming.kind ?? 'book')) return false
  if (book.catalog && incoming.catalog) return book.catalog.editionId === incoming.catalog.editionId
  if (book.sourceId && book.sourceId === incoming.sourceId) return !book.sourceVersionId || !incoming.sourceVersionId || book.sourceVersionId === incoming.sourceVersionId
  if (book.goodreadsId && incoming.goodreadsId) return book.goodreadsId === incoming.goodreadsId
  const isbn = editionIsbn(book.isbn), otherIsbn = editionIsbn(incoming.isbn)
  if (isbn && otherIsbn) return isbn === otherIsbn
  return fold(book.title) === fold(incoming.title) && JSON.stringify(book.authors.map(fold)) === JSON.stringify((incoming.authors ?? []).map(fold))
}
export function createBookCollection(name: string) { return mutate((snapshot) => { const clean = name.trim(); if (!clean || clean.length > 160) throw new Error('Name this collection with 1 to 160 characters.'); const existing = snapshot.shelves.find((entry) => !entry.archivedAt && fold(entry.name) === fold(clean)); if (existing) return existing; const shelf = { id: crypto.randomUUID(), name: clean, createdAt: Date.now(), archivedAt: null }; snapshot.shelves.push(shelf); return shelf }) }
export function renameBookCollection(id: string, name: string) { return mutate((snapshot) => { const clean = name.trim(), shelf = snapshot.shelves.find((shelf) => shelf.id === id); if (!shelf) throw new Error('This collection is unavailable.'); if (!clean || clean.length > 160) throw new Error('Name this collection with 1 to 160 characters.'); if (snapshot.shelves.some((entry) => entry.id !== id && !entry.archivedAt && fold(entry.name) === fold(clean))) throw new Error('A collection already uses this name.'); shelf.name = clean; return shelf }) }
export function archiveBookCollection(id: string, archived = true) { return mutate((snapshot) => { const shelf = snapshot.shelves.find((shelf) => shelf.id === id); if (!shelf) throw new Error('This collection is unavailable.'); shelf.archivedAt = archived ? Date.now() : null; return shelf }) }
/** Imports only add records; matching identities/content never overwrite existing personal edits. */
export function importBookRecords(input: { books: (CreateBookInput & { collectionNames?: string[] })[]; original: { name: string; assetId: string }; errors?: BookshelfImport['errors'] }) {
  return mutate((snapshot) => {
    const added: ShelfBook[] = []; let skipped = 0
    for (const value of input.books) {
      const duplicate = snapshot.books.some((book) => !book.archivedAt && sameBook(book, value))
      if (duplicate) { skipped++; continue }
      const { collectionNames = [], ...details } = value
      const shelfIds = [...(details.shelfIds ?? [])]
      for (const name of collectionNames) { let collection = snapshot.shelves.find((shelf) => !shelf.archivedAt && fold(shelf.name) === fold(name)); if (!collection) { collection = { id: crypto.randomUUID(), name, createdAt: Date.now(), archivedAt: null }; snapshot.shelves.push(collection) } shelfIds.push(collection.id) }
      const book = createShelfBook({ ...details, shelfIds: [...new Set(shelfIds)] }); checkShelves(snapshot, book); snapshot.books.push(book); retain(snapshot, book, 'created', 'Imported into your bookshelf'); added.push(book)
    }
    const receipt: BookshelfImport = { id: crypto.randomUUID(), name: input.original.name, assetId: input.original.assetId, createdAt: Date.now(), added: added.length, skipped, errors: input.errors ?? [] }
    snapshot.imports.push(receipt); return { books: added, receipt }
  })
}
export function mergeBookshelfImport(imported: BookshelfSnapshot, original: { name: string; assetId: string }) {
  return mutate((snapshot) => {
    const clean = decodeBookshelf(imported), shelfIds = new Map<string, string>(), bookIds = new Map<string, string>(), added: ShelfBook[] = []
    const attributions = snapshot.attributions ??= []
    const existingKeys = new Set(attributions.map(attributionKey))
    const existingIds = new Set(attributions.map(item => item.id))
    for (const item of clean.attributions ?? []) {
      const key = attributionKey(item)
      if (existingKeys.has(key)) continue
      const id = existingIds.has(item.id) ? crypto.randomUUID() : item.id
      attributions.push({ ...item, id })
      existingKeys.add(key)
      existingIds.add(id)
    }
    for (const shelf of clean.shelves) {
      const existing = snapshot.shelves.find((entry) => fold(entry.name) === fold(shelf.name) && !!entry.archivedAt === !!shelf.archivedAt)
      if (existing) { shelfIds.set(shelf.id, existing.id); continue }
      const id = snapshot.shelves.some((entry) => entry.id === shelf.id) ? crypto.randomUUID() : shelf.id
      snapshot.shelves.push({ ...shelf, id }); shelfIds.set(shelf.id, id)
    }
    for (const incoming of clean.books) {
      if (snapshot.books.some((book) => book.id === incoming.id || sameBook(book, incoming))) continue
      const book = validateShelfBook({ ...incoming, shelfIds: incoming.shelfIds.map((id) => shelfIds.get(id)!) })
      snapshot.books.push(book); bookIds.set(incoming.id, book.id); added.push(book)
    }
    for (const revision of clean.history) {
      const bookId = bookIds.get(revision.bookId)
      if (!bookId) continue
      const id = snapshot.history.some((entry) => entry.id === revision.id) ? crypto.randomUUID() : revision.id
      snapshot.history.push({ ...revision, id, bookId, book: { ...revision.book, id: bookId, shelfIds: revision.book.shelfIds.map((id) => shelfIds.get(id)!) } })
    }
    for (const book of added) if (!snapshot.history.some((entry) => entry.bookId === book.id)) retain(snapshot, book, 'created', 'Imported into your bookshelf')
    const receipt: BookshelfImport = { id: crypto.randomUUID(), name: original.name, assetId: original.assetId, createdAt: Date.now(), added: added.length, skipped: clean.books.length - added.length, errors: [] }
    snapshot.imports.push(receipt); return { books: added, receipt }
  })
}
