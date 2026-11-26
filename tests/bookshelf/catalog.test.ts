import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { handleBookCatalog } from '../../server/bookCatalog.ts'
async function lookup(path: string, method = 'GET') {
  let status = 0, body: unknown
  await handleBookCatalog({ method } as IncomingMessage, {
    writeHead(code: number) { status = code },
    end(value: string | Buffer) { body = typeof value === 'string' ? JSON.parse(value) : value },
  } as ServerResponse, new URL('/api/book-catalog/' + path, 'http://localhost'))
  return { status, body }
}
afterEach(() => vi.unstubAllGlobals())
it('returns matching work, author and edition identities for an ISBN and caches the public lookup', async () => {
  const upstream = vi.fn(async (url: URL) => {
    expect(url.hostname).toBe('openlibrary.org')
    expect(url.searchParams.get('q')).toBe('isbn:9780140327243')
    return Response.json({ docs: [{ key: '/works/OL8125760W', title: 'Hatchet', author_name: ['Gary Paulsen'], author_key: ['OL1A'], editions: { docs: [{ key: '/books/OL2040701M' }] } }, { key: 'broken' }] })
  })
  vi.stubGlobal('fetch', upstream)
  const result = await lookup('search?q=978-0140327243')
  expect(result.body).toMatchObject({ works: [{ id: 'OL8125760W', title: 'Hatchet', authors: [{ name: 'Gary Paulsen', id: 'OL1A' }], preferredEdition: 'OL2040701M' }] })
  expect(await lookup('search?q=978-0140327243')).toEqual(result)
  expect(upstream).toHaveBeenCalledTimes(1)
})
it('keeps edition-specific publisher, ISBN and cover, paginates and rejects another work’s suggested edition', async () => {
  const row = { key: '/books/OL81M', title: 'A work in translation', edition_name: 'Second edition', publish_date: 'March 1991', publishers: ['Printer'], languages: [{ key: '/languages/fre' }], covers: [-1, 45], isbn_13: ['9780140327243'], number_of_pages: 122, works: [{ key: '/works/OL2W' }] }
  vi.stubGlobal('fetch', vi.fn(async (url: URL) => Response.json(url.pathname.startsWith('/books/') ? row : { entries: Array(20).fill(row), size: 21 })))
  const editions = await lookup('editions?work=OL2W')
  expect(editions.body).toMatchObject({ nextOffset: 20 })
  expect((editions.body as { editions: unknown[] }).editions[0]).toMatchObject({ id: 'OL81M', publisher: 'Printer', isbn: '9780140327243', language: 'fre', pages: 122, year: 1991, coverId: 45 })
  expect((await lookup('editions?work=OL3W&edition=OL81M')).body).toEqual({ editions: [], nextOffset: null })
})
it('follows a verified Archive cover redirect, rejects unrelated hosts, and never fetches arbitrary URL inputs', async () => {
  const upstream = vi.fn(async (url: URL) => {
    if (url.hostname === 'ia801234.us.archive.org') return new Response(Uint8Array.from([255,216,255,224]))
    if (url.hostname === 'archive.org') return new Response(null, { status: 302, headers: { location: 'https://ia801234.us.archive.org/view_archive.php?archive=/8/items/l_covers_0001/l_covers_0001_01.zip&file=0000000123-L.jpg' } })
    return new Response(null, { status: 302, headers: { location: url.pathname.includes('123-') ? 'https://archive.org/download/l_covers_0001/000123-L.jpg' : 'https://unrelated.example/download/l_covers_0001/000333-L.jpg' } })
  })
  vi.stubGlobal('fetch', upstream)
  expect((await lookup('cover?id=123')).body).toEqual(Buffer.from([255,216,255,224]))
  expect((await lookup('cover?id=333')).status).toBe(502)
  expect((await lookup('cover?id=https://example.com')).status).toBe(400)
  expect((await lookup('search?q=A', 'POST')).status).toBe(405)
  expect(upstream.mock.calls.some(([url]) => url.hostname === 'unrelated.example')).toBe(false)
})
