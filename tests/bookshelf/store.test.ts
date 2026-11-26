import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, getStore, initRepo, useRepoStatus } from '../../src/data/repo.ts'
import { archiveBook, archiveBookCollection, BOOKSHELF_KV, createBook, createBookCollection, createBookFromSource, decodeBookshelf, emptyBookshelf, getBookshelfOriginalReferences, initializeBookshelf, renameBookCollection, resetBookshelf, restoreBookRevision, saveBookSnapshot, saveAttribution, removeAttribution, updateBook, useBookshelf } from '../../src/bookshelf/store.ts'
import { readBookshelfOriginal, uploadBookshelfCover } from '../../src/bookshelf/media.ts'
import { exportBookshelfJSON, importBookshelfFile } from '../../src/bookshelf/portability.ts'

beforeEach(async () => { resetBookshelf(); vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('File', NodeFile); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('The bookshelf must work without network or cloud AI') })); await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: 0, start: 'empty' }); await initializeBookshelf() })
afterEach(async () => { resetBookshelf(); await closeRepo(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('keeps complete editable reading details, custom collections and milestones through reopen and restoration', async () => {
  const collection = await createBookCollection('Questions worth following')
  const book = await createBook({ title: 'A retained book', authors: ['An author', 'Another author'], format: 'both', status: 'reading', rating: 4.5, recommendedBy: 'A friend', notes: 'My original response', isbn: '9781234567890', url: 'https://example.org/book', year: 2024, startedAt: '2026-11-23', shelfIds: [collection.id], fields: [{ id: 'field-one', label: 'Why this matters', value: 'A question about evidence' }] })
  const milestone = await saveBookSnapshot(book.id, 'Before the last chapter')
  const later = await updateBook(book.id, { title: 'My revised title', notes: 'A later thought', status: 'read', finishedAt: '2026-11-24', rating: 5 }, book.updatedAt)
  await expect(updateBook(book.id, { notes: 'Stale edit' }, book.updatedAt)).rejects.toThrow(/newer version/)
  const restored = await restoreBookRevision(book.id, milestone.id, later.updatedAt)
  expect(restored).toMatchObject({ id: book.id, title: book.title, notes: book.notes, rating: 4.5, recommendedBy: 'A friend', fields: book.fields, shelfIds: [collection.id] })
  expect(useBookshelf.getState().history.some((entry) => entry.kind === 'restore' && entry.book.notes === 'A later thought')).toBe(true)
  await archiveBook(book.id, true, restored.updatedAt)
  resetBookshelf(); await initializeBookshelf()
  expect(useBookshelf.getState().books[0].archivedAt).toBeTypeOf('number')
  await archiveBook(book.id, false)
  expect(useBookshelf.getState().books[0]).toMatchObject({ id: book.id, archivedAt: null, authors: book.authors, fields: book.fields })
  await renameBookCollection(collection.id, 'Evidence collection'); await archiveBookCollection(collection.id); await archiveBookCollection(collection.id, false)
  expect(useBookshelf.getState().shelves[0]).toMatchObject({ id: collection.id, name: 'Evidence collection', archivedAt: null })
  expect(await getStore().listNodes()).toEqual([])
  expect(fetch).not.toHaveBeenCalled()
})

it('round trips safe cover originals and full history without overwriting existing edited details on import', async () => {
  const png = new NodeFile([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])], 'cover.png', { type: 'image/png' }) as unknown as File
  const cover = await uploadBookshelfCover(png), book = await createBook({ title: 'An illustrated book', authors: ['An author'], coverAssetId: cover })
  await saveBookSnapshot(book.id, 'Original cover'); await updateBook(book.id, { coverAssetId: null, notes: 'The cover lives in history' }, book.updatedAt)
  expect(getBookshelfOriginalReferences(await getStore().getKv(BOOKSHELF_KV)).has(cover)).toBe(true)
  const json = await exportBookshelfJSON(), exported = JSON.parse(await json.text())
  expect(exported.assets).toHaveLength(1)
  const originalHistory = useBookshelf.getState().history.length
  const imported = await importBookshelfFile(new NodeFile([await json.text()], 'bookshelf.json', { type: 'application/json' }) as unknown as File)
  expect(imported.receipt.skipped).toBe(1); expect(useBookshelf.getState().books[0].notes).toBe('The cover lives in history')
  expect(useBookshelf.getState().history).toHaveLength(originalHistory)
  resetBookshelf(); await closeRepo(); await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: 0, start: 'empty' }); await initializeBookshelf()
  await importBookshelfFile(new NodeFile([await json.text()], 'bookshelf.json', { type: 'application/json' }) as unknown as File)
  expect(useBookshelf.getState().books[0]).toMatchObject({ id: book.id, notes: 'The cover lives in history', coverAssetId: null })
  expect(useBookshelf.getState().history).toHaveLength(originalHistory)
  expect(new Uint8Array(await (await readBookshelfOriginal(cover)).blob.arrayBuffer())).toEqual(new Uint8Array(await png.arrayBuffer()))
  expect(useBookshelf.getState().history.some((entry) => entry.book.coverAssetId === cover)).toBe(true)
})

it('rejects unsafe covers, corrupt snapshots, invalid dates and read-only writes while keeping the saved authority', async () => {
  await expect(uploadBookshelfCover(new NodeFile(['<svg><script/></svg>'], 'cover.png', { type: 'image/png' }) as unknown as File)).rejects.toThrow(/raster|SVG|PNG/)
  await expect(createBook({ title: 'Unsafe URL', url: 'javascript:alert(1)' })).rejects.toThrow(/details/)
  await expect(createBook({ title: 'Invalid date', startedAt: '2026-02-30' })).rejects.toThrow(/details/)
  expect(() => decodeBookshelf({ ...emptyBookshelf(), schemaVersion: 2 })).toThrow(/unsupported/)
  const book = await createBook({ title: 'Keep my details' }), before = await getStore().getKv(BOOKSHELF_KV)
  useRepoStatus.setState({ writer: false })
  await expect(updateBook(book.id, { title: 'Do not save' }, book.updatedAt)).rejects.toThrow(/read only/)
  expect(await getStore().getKv(BOOKSHELF_KV)).toEqual(before)
})

it('honors a competing CAS winner instead of saving a false-success book or history row', async () => {
  const store = getStore(), winning = { ...emptyBookshelf(), revision: 9 }
  store.compareAndSwapKv = async () => { await store.putKv(BOOKSHELF_KV, winning); return false }
  await expect(createBook({ title: 'A losing change' })).rejects.toThrow(/newer changes|revision|changed/)
  expect(await store.getKv(BOOKSHELF_KV)).toEqual(winning)
  expect(useBookshelf.getState().books).toEqual([]); expect(useBookshelf.getState().history).toEqual([])
})

it('links a retained article once and preserves the user’s edited details on subsequent library additions', async () => {
  const { initializeKnowledge, resetKnowledge } = await import('../../src/knowledge/index.ts')
  const { initializeReading, resetReading, updateReadingItem } = await import('../../src/reading/store.ts')
  const { captureArticle } = await import('../../src/reading/captureArticle.ts')
  await initializeKnowledge(); await initializeReading()
  const source = await captureArticle({ title: 'An article worth keeping', url: 'https://example.org/article', text: 'The exact retained article stays in the evidence archive.' })
  await updateReadingItem(source.sourceId, { status: 'read' })
  const book = await createBookFromSource(source.sourceId)
  expect(book).toMatchObject({ sourceId: source.sourceId, kind: 'article', format: 'digital', status: 'read', url: 'https://example.org/article' })
  expect(book.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  const edited = await updateBook(book.id, { title: 'My personal title', notes: 'A recommendation I want to keep' }, book.updatedAt)
  expect(await createBookFromSource(source.sourceId)).toEqual(edited)
  expect(useBookshelf.getState().books).toHaveLength(1)
  expect(await getStore().listNodes()).toEqual([])
  resetReading(); resetKnowledge()
})

it('keeps different editions and articles with identical titles while preserving personal details on edition retries', async () => {
  const catalog = { workId: 'OL1W', editionId: 'OL2M', authors: [{ id: 'OL5A', name: 'A Writer' }], editionLabel: 'First edition', publisher: 'Press', language: 'eng', coverId: null }
  const book = await createBook({ title: 'A story', authors: ['A Writer'], catalog, notes: 'First notes' })
  const same = await createBook({ title: 'Retitled edition', authors: ['A Writer'], catalog })
  const next = await createBook({ title: 'A story', authors: ['A Writer'], catalog: { ...catalog, editionId: 'OL3M' } })
  const csv = 'Book Id,Title,Author,Exclusive Shelf,My Review\n333,Another title,A Writer,read,A note\n444,Another title,A Writer,read,Second edition'
  const file = new NodeFile([csv], 'goodreads_library_export.csv', { type: 'text/csv' }) as unknown as File
  await createBook({ title: 'A story', authors: ['A Writer'], kind: 'article' })
  expect(same.id).toBe(book.id); expect(same.notes).toBe('First notes')
  expect(next.id).not.toBe(book.id)
  expect((await importBookshelfFile(file)).receipt.added).toBe(2)
  expect((await importBookshelfFile(file)).receipt.skipped).toBe(2)
  const historical = await createBook({ title: 'A legacy book' })
  expect((await updateBook(historical.id, { catalog: { ...catalog, editionId: 'OL45M' } }, historical.updatedAt)).catalog?.editionId).toBe('OL45M')
  expect(useBookshelf.getState().books).toHaveLength(6)
})


it('links a selected edition to an existing equivalent ISBN while retaining the original details in history', async () => {
  const original = await createBook({ title: 'Personal title', isbn: '0-14-032724-X', notes: 'Mine', rating: 5 })
  const catalog = { workId: 'OL1W', editionId: 'OL7M', authors: [], editionLabel: 'Paper', publisher: '', language: '', coverId: null }
  const linked = await createBook({ title: 'Catalog title', isbn: '9780140327243', catalog, pages: 145 })
  expect(linked).toMatchObject({ id: original.id, title: 'Personal title', notes: 'Mine', rating: 5, pages: 145, catalog })
  expect(useBookshelf.getState().books).toHaveLength(1)
  expect(useBookshelf.getState().history.at(-1)?.book.catalog).toBeUndefined()
  const invalid = await createBook({ title: 'Mistyped ISBN', isbn: '0140327241' })
  expect(invalid.id).not.toBe(linked.id)
})

it('pins an existing edition to a retained text version and prevents duplicate and stale assignments', async () => {
  const { attachBookText } = await import('../../src/bookshelf/store.ts')
  const db = getStore()
  await db.putKv('knowledge.v1', {
    sources: [{ id: 's1', title: 'Owned text', currentVersionId: 'v2' }, { id: 's2', title: 'Different text', currentVersionId: 'v3' }],
    versions: [{ id: 'v1', sourceId: 's1', text: 'First edition' }, { id: 'v2', sourceId: 's1', text: 'Revised edition' }, { id: 'v3', sourceId: 's2', text: 'Other edition' }, { id: 'v4', sourceId: 's2', text: ' ' }],
  })
  const book = await createBook({ title: 'Catalog edition', notes: 'My notes' }), second = await createBook({ title: 'Other copy' })
  await expect(attachBookText(book.id,'s1','v3',book.updatedAt)).rejects.toThrow(/unavailable/)
  await expect(attachBookText(book.id,'s2','v4',book.updatedAt)).rejects.toThrow(/unavailable/)
  const linked = await attachBookText(book.id,'s1','v1',book.updatedAt)
  expect(linked).toMatchObject({ id: book.id, sourceId: 's1', sourceVersionId: 'v1', notes: 'My notes' })
  expect((await attachBookText(book.id,'s1','v1',book.updatedAt)).updatedAt).toBe(linked.updatedAt)
  await expect(attachBookText(second.id,'s1','v1',second.updatedAt)).rejects.toThrow(/already attached/)
  await expect(attachBookText(book.id,'s1','v2',book.updatedAt)).rejects.toThrow(/changed/)
  expect((await attachBookText(second.id,'s1','v2',second.updatedAt)).id).toBe(second.id)
  expect((await createBookFromSource('s1')).id).toBe(second.id)
  const snapshot = decodeBookshelf(await db.getKv(BOOKSHELF_KV))
  expect(snapshot.books).toHaveLength(2)
  expect(snapshot.history.find((entry) => entry.bookId === book.id && entry.label === 'Before attaching retained text')?.book.sourceVersionId).toBeUndefined()
})

it('keeps an attribution for an unshelved work through duplicate clicks, removal and portable import', async () => {
  const entry = { title: 'New work', author: 'Another author', name: 'Reading Circle', kind: 'Institution' as const,
    relation: 'Recommended' as const, scope: 'work' as const, url: 'https://example.org/list', isbn: '', editionId: '' }
  await Promise.all([saveAttribution(entry), saveAttribution(entry)])
  const saved = useBookshelf.getState().attributions!
  expect(saved).toHaveLength(1)
  expect(useBookshelf.getState().books).toHaveLength(0)
  const exportFile = new NodeFile([await (await exportBookshelfJSON()).text()], 'bookshelf.json', { type: 'application/json' }) as unknown as File
  await removeAttribution(saved[0].id)
  expect(useBookshelf.getState().attributions).toEqual([])
  await importBookshelfFile(exportFile)
  await importBookshelfFile(exportFile)
  expect(useBookshelf.getState().attributions).toEqual(saved)
  expect(useBookshelf.getState().books).toHaveLength(0)
})
