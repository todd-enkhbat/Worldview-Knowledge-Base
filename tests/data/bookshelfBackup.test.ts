import { describe, expect, it } from 'vitest'
import { unzipSync, zipSync } from 'fflate'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { createShelfBook, emptyBookshelf } from '../../src/bookshelf/model.ts'
import { blobSink, exportArchive, readArchive } from '../../src/data/archive.ts'
import { exportDirectoryBundle, readDirectoryBundle, type BundleReader, type BundleWriter } from '../../src/data/directoryBundle.ts'
import { hashBytes } from '../../src/data/hash.ts'

const files = (): BundleReader & BundleWriter => {
  const retained = new Map<string, Blob>()
  return { exists: async (path) => retained.has(path), remove: async (path) => { retained.delete(path) }, write: async (path, data) => { retained.set(path, new Blob([data.slice()])) }, read: async (path) => { const value = retained.get(path); if (!value) throw new Error(`Missing ${path}`); return value } }
}

describe('bookshelf backup originals and history', () => {
  it.each(['archive', 'directory'])('preserves previous covers and import receipts in %s backups', async (format) => {
    const store = createMemoryStore(), bytes = new TextEncoder().encode('retained original'), digest = await hashBytes(bytes)
    const cover = `bookshelf-cover-${digest}`, imported = `bookshelf-file-${digest}`
    const book = createShelfBook({ title: 'My reading', notes: 'Current version' }, 1)
    await store.putKv('bookshelves.v1', { ...emptyBookshelf(), revision: 2, books: [book], history: [{ id: 'before', bookId: book.id, recordedAt: 1, kind: 'edit', label: 'Before changing the cover', book: { ...book, coverAssetId: cover } }], imports: [{ id: 'import', name: 'reading.csv', assetId: imported, createdAt: 1, added: 1, skipped: 0, errors: [] }] })
    for (const id of [cover, imported]) await store.putBlob({ meta: { id, kind: 'file', bytes: bytes.length, mime: 'application/octet-stream', createdAt: 1, nodeId: null }, data: bytes })
    if (format === 'archive') {
      const sink = blobSink(); await exportArchive(store, sink)
      const result = await readArchive(sink.blob())
      expect(result.kv['bookshelves.v1']).toMatchObject({ revision: 2, books: [{ title: 'My reading' }], history: [{ book: { coverAssetId: cover } }] })
      const archive = unzipSync(new Uint8Array(await sink.blob().arrayBuffer()))
      archive[`assets/${cover}`] = new TextEncoder().encode('changed cover')
      await expect(readArchive(new Blob([zipSync(archive)]))).rejects.toThrow(/SHA-256/)
    } else {
      const bundle = files(); await exportDirectoryBundle(store, bundle)
      const result = await readDirectoryBundle(bundle)
      expect(result.kv['bookshelves.v1']).toMatchObject({ revision: 2 })
      expect(result.assets.some((asset) => asset.id === cover)).toBe(true)
      expect(result.assets.some((asset) => asset.id === imported)).toBe(true)
    }
    store.close()
  })

  it('retains covers referenced only by an assistant review proposal', async () => {
    const store = createMemoryStore(), bytes = new TextEncoder().encode('cover retained in proposed edit'), digest = await hashBytes(bytes), cover = `bookshelf-cover-${digest}`
    const proposed = createShelfBook({ title: 'Proposed book', coverAssetId: cover }, 1)
    await store.putKv('assistantEdits.v1', { schemaVersion: 1, revision: 1, entries: [{ id: 'pending-book', operation: 'create_book', status: 'pending', book: proposed }] })
    await store.putBlob({ meta: { id: cover, kind: 'file', bytes: bytes.length, mime: 'image/png', createdAt: 1, nodeId: null }, data: bytes })
    const sink = blobSink(); await exportArchive(store, sink)
    const archive = unzipSync(new Uint8Array(await sink.blob().arrayBuffer()))
    expect(archive[`assets/${cover}`]).toEqual(bytes)
    delete archive[`assets/${cover}`]
    await expect(readArchive(new Blob([zipSync(archive)]))).rejects.toThrow()
    store.close()
  })

  it('refuses to silently omit a retained bookshelf cover', async () => {
    const store = createMemoryStore()
    const book = createShelfBook({ title: 'Missing original', coverAssetId: `bookshelf-cover-${'a'.repeat(64)}` }, 1)
    await store.putKv('bookshelves.v1', { ...emptyBookshelf(), revision: 1, books: [book] })
    await expect(exportArchive(store, blobSink())).rejects.toThrow()
    await expect(exportDirectoryBundle(store, files())).rejects.toThrow()
    store.close()
  })
})
