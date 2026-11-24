import { create } from 'zustand'
import type { WorldStore } from '../data/WorldStore.ts'
import { compareAndSwapWorldState, getStore, getWorldGeneration, isRepoReady, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import { bookValue, createShelfBook, decodeBookshelf, emptyBookshelf, validateShelfBook } from './model.ts'
import { BOOKSHELF_KV, type BookPatch, type BookRevision, type BookshelfImport, type BookshelfSnapshot, type CreateBookInput, type ShelfBook } from './types.ts'
import type { KnowledgeSnapshot } from '../knowledge/types.ts'
import { decodeReading } from '../reading/model.ts'
import { safeBookUrl } from './model.ts'
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
const findBook = (snapshot: BookshelfSnapshot, id: string) => { const book = snapshot.books.find((book) => book.id === id); if (!book) throw new Error('This book or article is no longer available.'); return book }
function retain(snapshot: BookshelfSnapshot, book: ShelfBook, kind: BookRevision['kind'], label: string) { const entry = { id: crypto.randomUUID(), bookId: book.id, recordedAt: Date.now(), kind, label, book: structuredClone(book) }; snapshot.history.push(entry); return entry }
function checkShelves(snapshot: BookshelfSnapshot, book: ShelfBook) { if (book.shelfIds.some((id) => !snapshot.shelves.some((shelf) => shelf.id === id))) throw new Error('A selected collection is unavailable. Your changes are still here.') }
export function createBook(input: CreateBookInput): Promise<ShelfBook> { return mutate((snapshot) => { const book = createShelfBook(input); checkShelves(snapshot, book); snapshot.books.push(book); retain(snapshot, book, 'created', 'Added to your bookshelf'); return book }) }
/** Link retained evidence once, leaving its original bytes, annotations, and topics authoritative. */
export function createBookFromSource(sourceId: string, kind?: ShelfBook['kind']): Promise<ShelfBook> {
  return mutate(async (snapshot, scope) => {
    const [corpus, readingValue] = await Promise.all([scope.store.getKv<KnowledgeSnapshot>('knowledge.v1'), scope.store.getKv('reading.v1')])
    if (!current(scope)) throw changed()
    const source = corpus?.sources.find((source) => source.id === sourceId && !source.deleted && !source.excluded), version = corpus?.versions.find((version) => version.id === source?.currentVersionId)
    if (!source || !version) throw new Error('This retained source is no longer available for your bookshelf.')
    const existing = snapshot.books.find((book) => book.sourceId === sourceId)
    if (existing) return existing
    const reading = decodeReading(readingValue), item = reading.items.find((entry) => entry.sourceId === sourceId), metadata = version.metadata ?? {}
    const rawAuthors = Array.isArray(metadata.authors) ? metadata.authors : typeof metadata.author === 'string' ? [metadata.author] : typeof metadata.byline === 'string' ? [metadata.byline] : []
    const authors = rawAuthors.filter((value): value is string => typeof value === 'string' && !!value.trim()).slice(0, 30).map((value) => value.trim().slice(0, 300))
    const link = typeof metadata.url === 'string' ? metadata.url : typeof metadata.sourceUrl === 'string' ? metadata.sourceUrl : ''
    const derivedYear = typeof metadata.year === 'number' ? metadata.year : version.authoredAt !== null && Number.isFinite(version.authoredAt) ? new Date(version.authoredAt).getUTCFullYear() : null
    const year = derivedYear !== null && Number.isInteger(derivedYear) && derivedYear > 0 && derivedYear < 10000 ? derivedYear : null
    const book = createShelfBook({ title: source.title, authors, kind: kind ?? (metadata.format === 'article' || link ? 'article' : 'book'), format: 'digital', status: item?.status ?? 'unread', url: safeBookUrl(link) ? link : '', isbn: typeof metadata.isbn === 'string' ? metadata.isbn.slice(0, 100) : '', year, finishedAt: item?.readAt ? new Date(item.readAt).toISOString().slice(0, 10) : null, sourceId: source.id, fields: source.tags.length ? [{ id: crypto.randomUUID(), label: 'Topics from the retained source', value: source.tags.join(' · ').slice(0, 20000) }] : [] })
    snapshot.books.push(book); retain(snapshot, book, 'created', 'Added from your retained library'); return book
  })
}
export function updateBook(id: string, patch: BookPatch, expectedUpdatedAt: number): Promise<ShelfBook> {
  return mutate((snapshot) => {
    const original = findBook(snapshot, id)
    if (original.updatedAt !== expectedUpdatedAt) throw new Error('A newer version of these details was saved elsewhere. Your edits are still here; reload the saved version or save a copy.')
    const allowed = new Set(Object.keys(bookValue(original)))
    if (Object.keys(patch).some((key) => !allowed.has(key) && key !== 'sourceId')) throw new Error('This bookshelf update includes unsupported fields.')
    const next = validateShelfBook({ ...original, ...patch })
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
const fold = (name: string) => name.normalize('NFKC').trim().toLocaleLowerCase()
export function createBookCollection(name: string) { return mutate((snapshot) => { const clean = name.trim(); if (!clean || clean.length > 160) throw new Error('Name this collection with 1 to 160 characters.'); const existing = snapshot.shelves.find((entry) => !entry.archivedAt && fold(entry.name) === fold(clean)); if (existing) return existing; const shelf = { id: crypto.randomUUID(), name: clean, createdAt: Date.now(), archivedAt: null }; snapshot.shelves.push(shelf); return shelf }) }
export function renameBookCollection(id: string, name: string) { return mutate((snapshot) => { const clean = name.trim(), shelf = snapshot.shelves.find((shelf) => shelf.id === id); if (!shelf) throw new Error('This collection is unavailable.'); if (!clean || clean.length > 160) throw new Error('Name this collection with 1 to 160 characters.'); if (snapshot.shelves.some((entry) => entry.id !== id && !entry.archivedAt && fold(entry.name) === fold(clean))) throw new Error('A collection already uses this name.'); shelf.name = clean; return shelf }) }
export function archiveBookCollection(id: string, archived = true) { return mutate((snapshot) => { const shelf = snapshot.shelves.find((shelf) => shelf.id === id); if (!shelf) throw new Error('This collection is unavailable.'); shelf.archivedAt = archived ? Date.now() : null; return shelf }) }
/** Imports only add records; matching identities/content never overwrite existing personal edits. */
export function importBookRecords(input: { books: (CreateBookInput & { collectionNames?: string[] })[]; original: { name: string; assetId: string }; errors?: BookshelfImport['errors'] }) {
  return mutate((snapshot) => {
    const added: ShelfBook[] = []; let skipped = 0
    for (const value of input.books) {
      const duplicate = snapshot.books.some((book) => !book.archivedAt && fold(book.title) === fold(value.title) && JSON.stringify(book.authors.map(fold)) === JSON.stringify((value.authors ?? []).map(fold)))
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
    for (const shelf of clean.shelves) {
      const existing = snapshot.shelves.find((entry) => fold(entry.name) === fold(shelf.name) && !!entry.archivedAt === !!shelf.archivedAt)
      if (existing) { shelfIds.set(shelf.id, existing.id); continue }
      const id = snapshot.shelves.some((entry) => entry.id === shelf.id) ? crypto.randomUUID() : shelf.id
      snapshot.shelves.push({ ...shelf, id }); shelfIds.set(shelf.id, id)
    }
    for (const incoming of clean.books) {
      if (snapshot.books.some((book) => book.id === incoming.id || fold(book.title) === fold(incoming.title) && JSON.stringify(book.authors.map(fold)) === JSON.stringify(incoming.authors.map(fold)))) continue
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
