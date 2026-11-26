import { expect, it } from 'vitest'
import { blobSink, exportArchive, readArchive } from '../../src/data/archive.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { decodeQuotes, emptyLibrary, QUOTES_KV, updateQuote } from '../../src/quotes/model.ts'

it('exports reference history, unverified text and edition links in the portable workspace archive', async () => {
  const store = createMemoryStore(), library = emptyLibrary()
  const origin = { id: 'draft-7', kind: 'writing', title: 'A field study' } as const
  const source = { bookId: 'book-1', title: 'An edition', author: '', edition: 'First printing', locator: 'p. 19' }
  const corpus = { sources: [], versions: [], passages: [] }, input = { text: 'a retained quotation', origin, source }
  updateQuote(library, input, corpus, 1700, 'quote-1', 'captured')
  updateQuote(library, { ...input, source: { ...source, locator: 'p. 20' } }, corpus, 1800, 'quote-1', 'amended')
  await store.putKv(QUOTES_KV, library)
  const sink = blobSink()
  await exportArchive(store, sink)
  expect(decodeQuotes((await readArchive(sink.blob())).kv[QUOTES_KV])).toEqual(library)
  store.close()
})
