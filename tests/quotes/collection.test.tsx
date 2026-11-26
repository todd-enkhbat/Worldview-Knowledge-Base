// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createShelfBook, emptyBookshelf } from '../../src/bookshelf/model.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, getStore, initRepo } from '../../src/data/repo.ts'
import { QuoteCapture } from '../../src/quotes/QuoteCapture.tsx'
import QuoteCollection, { BookQuotes } from '../../src/quotes/QuoteCollection.tsx'
import { QUOTES_KV, type QuoteLibrary } from '../../src/quotes/model.ts'
import { quoteScope, saveQuote } from '../../src/quotes/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
const title = 'The same work', editionId = 'OL24M'
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Quotes must open and save locally.') }))
  await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: 1, start: 'empty' })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); await closeRepo()
  vi.unstubAllGlobals()
})
async function press(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent?.trim() === label)
  expect(button?.disabled).toBe(false)
  await act(async () => button!.click())
}
const choice = (titleOrEdition: string) => [...host.querySelectorAll<HTMLButtonElement>('.quote-source-choice')].find(el => el.title.includes(titleOrEdition))!
const field = (label: string) => [...host.querySelectorAll<HTMLLabelElement>('dialog label')].find(el => el.textContent?.includes(label))!.querySelector<HTMLInputElement>('input')!
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const snapshot = async () => (await getStore().getKv<QuoteLibrary>(QUOTES_KV))!
it('links a draft selection to a specific saved edition, then browses and amends its immutable quote', async () => {
  const first = createShelfBook({ title, authors: ['By Author'], year: 1965 }), second = createShelfBook({
    title, authors: ['By Author'], year: 1990, isbn: '9780340000000',
    catalog: { editionLabel: 'Revised 1990', editionId, workId: 'OL17W', publisher: 'Books', language: 'eng', authors: [], coverId: null },
  })
  await getStore().putKv('bookshelves.v1', { ...emptyBookshelf(), revision: 1, books: [first, second] })
  const close = vi.fn(), words = 'the recorded words'
  await act(async () => root.render(<QuoteCapture selection={words} origin={{ kind: 'writing', title: 'My draft', id: 'draft', authorship: 'unknown' }} onClose={close} />))
  expect(host.querySelectorAll('.quote-source-choice')).toHaveLength(2)
  await act(async () => choice('Revised 1990').click())
  expect(host.querySelector('[role=status]')?.textContent).toContain('No retained source linked')
  await press('Save quote')
  expect(close).toHaveBeenCalledOnce()
  const quote = (await snapshot()).quotes[0]
  expect(quote).toMatchObject({
    text: words, origin: { kind: 'writing', id: 'draft' },
    history: [{ source: { bookId: second.id, catalogEditionId: editionId, isbn: second.isbn, title, author: 'By Author', edition: 'Revised 1990' }, verification: { status: 'unlinked' } }],
  })
  await act(async () => root.render(<BookQuotes bookId={first.id} />))
  expect(host.querySelector('a')).toBeNull()
  await act(async () => root.render(<BookQuotes bookId={second.id} />))
  expect(host.querySelector('a')?.getAttribute('href')).toBe('#/quotes?quote=' + quote.id)
  await act(async () => root.render(<QuoteCollection />))
  expect(host.querySelector('blockquote')?.textContent).toBe(words)
  expect(host.querySelector('a[href^="#/bookshelf?book="]')?.getAttribute('href')).toBe('#/bookshelf?book=' + second.id)
  expect(host.querySelector('a[href^="#/write?doc="]')?.getAttribute('href')).toBe('#/write?doc=draft')
  await press('Edit reference')
  await type(field('Page, chapter'), 'p. 12')
  await press('Save reference')
  const history = (await snapshot()).quotes[0].history
  expect(history.map(h => h.source.locator)).toEqual(['', 'p. 12'])
  expect(host.querySelector('summary')?.textContent).toBe('Reference history (2)')
  expect(fetch).not.toHaveBeenCalled()
})
it('refuses a capture when its original workspace was replaced', async () => {
  const scope = quoteScope(), newStore = createMemoryStore()
  await closeRepo(); await initRepo({ store: newStore }); await completeFirstRun({ T0: 1, start: 'empty' })
  await expect(saveQuote(scope, 'old', 'captured', {
    text: 'Old workspace', origin: { id: 'quotes', kind: 'collection', title: 'Quotes' }, source: { title, author: '', edition: '', locator: '' },
  })).rejects.toThrow(/workspace changed/)
  expect(await newStore.getKv(QUOTES_KV)).toBeUndefined()
})

it.each([true, false])('checks exactly the edition attachment when it is retained (%s), even after a newer source revision', async retained => {
  const words = 'same words in later versions', pinned = 'earlier', current = 'later'
  const store = getStore()
  const book = createShelfBook({ title, sourceId: 'source', sourceVersionId: pinned })
  await store.putKv('bookshelves.v1', { ...emptyBookshelf(), revision: 1, books: [book] })
  await store.putKv('knowledge.v1', {
    sources: [{ id: 'source', title, currentVersionId: current }],
    versions: [...(retained ? [{ id: pinned, sourceId: 'source', text: words, contentHash: 'earlier-hash', createdAt: 1 }] : []), { id: current, sourceId: 'source', text: words, contentHash: 'later-hash', createdAt: 2 }],
    passages: [],
  })
  await act(async () => root.render(<QuoteCapture selection={words} origin={{ kind: 'writing', title: 'My draft', id: 'draft' }} onClose={() => {}} />))
  await act(async () => choice(title).click())
  const version = host.querySelector('select')!
  expect(version.value).toBe(pinned); expect(version.disabled).toBe(true)
  expect(host.querySelector('[role=status]')?.textContent).toContain(retained ? 'Exact text match' : 'Version text unavailable')
  await press('Save quote')
  const revision = (await snapshot()).quotes[0].history[0]
  expect(revision.source).toMatchObject({ bookId: book.id, sourceId: 'source', versionId: pinned })
  expect(revision.verification.status).toBe(retained ? 'exact' : 'unavailable')
  expect(revision.verification.contentHash).toBe(retained ? 'earlier-hash' : undefined)
})

it('opens with the linked review edition selected and ready to save while preserving the exact words', async () => {
  const review = createShelfBook({ title: 'Reviewed work', authors: ['Author'] })
  const later = createShelfBook({ title: 'Recently added' })
  await getStore().putKv('bookshelves.v1', { ...emptyBookshelf(), revision: 1, books: [later, review] })
  const words = '  A passage\non two lines.  ', saved = vi.fn()
  await act(async () => root.render(<QuoteCapture selection={words} origin={{ kind: 'writing', title: 'My review', id: 'draft' }} initialSource={{ bookId: review.id }} onClose={() => {}} onSaved={saved} />))
  expect(choice(review.title).getAttribute('aria-pressed')).toBe('true')
  expect(host.querySelector('dialog textarea')?.getAttribute('readonly')).not.toBeNull()
  expect(host.querySelector<HTMLDetailsElement>('dialog details')?.open).toBe(false)
  expect(host.querySelector('dialog footer')?.contains(host.querySelector('button[type=submit]'))).toBe(true)
  await press('Save quote')
  expect(saved).toHaveBeenCalledWith(expect.any(String), words)
  expect((await snapshot()).quotes[0].history[0].source.bookId).toBe(review.id)
})

it('shows saved article choices and permits a single URL as a manual article citation', async () => {
  const article = createShelfBook({ title: 'A saved essay', kind: 'article', authors: ['A Writer'] })
  const book = createShelfBook({ title: 'My book' })
  await getStore().putKv('bookshelves.v1', { ...emptyBookshelf(), revision: 1, books: [article, book] })
  const origin = { kind: 'writing', title: 'Notes', id: 'draft' } as const
  await act(async () => root.render(<QuoteCapture key="shelf" selection="Quoted words." origin={origin} onClose={() => {}} />))
  await press('Articles')
  expect(choice(book.title)).toBeUndefined()
  await act(async () => choice(article.title).click())
  await press('Save quote')
  expect((await snapshot()).quotes[0].history[0].source).toMatchObject({ bookId: article.id, title: article.title, author: 'A Writer' })
  await act(async () => root.render(<QuoteCapture key="manual" selection="From the site." origin={origin} onClose={() => {}} />))
  await press('Enter manually')
  const url = 'https://example.org/writing/passage'
  await type(field('Source title or article URL'), url)
  await press('Save quote')
  const ref = (await snapshot()).quotes[0].history[0]
  expect(ref).toMatchObject({ source: { title: url, url }, verification: { status: 'unlinked' } })
  await act(async () => root.render(<QuoteCollection />))
  expect(host.querySelector('a[target="_blank"]')?.getAttribute('href')).toBe(url)
})

it('keeps editions beyond the initial set accessible without typing and searchable by ISBN', async () => {
  const books = Array.from({ length: 12 }, (_, i) => createShelfBook({ title: 'Book ' + (i + 1), isbn: 'unique-' + (i + 1) }, i + 1))
  await getStore().putKv('bookshelves.v1', { ...emptyBookshelf(), revision: 1, books })
  await act(async () => root.render(<QuoteCapture selection="words" origin={{ kind: 'collection', title: 'Quotes', id: 'quotes' }} onClose={() => {}} />))
  expect(host.querySelectorAll('.quote-source-choice')).toHaveLength(6)
  await press('Show more books (6)')
  expect(host.querySelectorAll('.quote-source-choice')).toHaveLength(12)
  await type(host.querySelector('input[aria-label="Find in Books"]')!, 'unique-5')
  expect(host.querySelectorAll('.quote-source-choice')).toHaveLength(1)
  await act(async () => choice('Book 5').click())
  await press('Save quote')
  expect((await snapshot()).quotes[0].history[0].source.isbn).toBe('unique-5')
})

it('offers retained personal articles, hides earlier library examples, and keeps their original evidence for existing references', async () => {
  const retained = { id: 'web', kind: 'document', title: 'An article I saved', currentVersionId: 'web-v1', updatedAt: 2 }
  const earlier = { id: 'old', kind: 'legacy', title: 'Earlier sample', currentVersionId: 'old-v1', updatedAt: 1 }
  const versions = [retained, earlier].map(s => ({
    id: s.currentVersionId, sourceId: s.id, text: 'Exact quotation', contentHash: s.id, createdAt: 1,
    metadata: { format: 'article', author: 'Byline' },
  }))
  await getStore().putKv('knowledge.v1', { sources: [retained, earlier], versions, passages: [] })
  const origin = { kind: 'collection', id: 'quotes', title: 'Quotes' } as const
  await act(async () => root.render(<QuoteCapture key="article" selection="Exact quotation" origin={origin} onClose={() => {}} />))
  await press('Articles')
  expect(choice(earlier.title)).toBeUndefined()
  await act(async () => choice(retained.title).click())
  expect(host.querySelector('[role=status]')?.textContent).toContain('Exact text match')
  await press('Save quote')
  expect((await snapshot()).quotes[0].history[0].source).toMatchObject({ sourceId: 'web', versionId: 'web-v1', author: 'Byline' })
  await act(async () => root.render(<QuoteCapture key="prior" selection="Exact quotation" origin={origin} initialSource={{ title: earlier.title, sourceId: earlier.id, versionId: earlier.currentVersionId }} onClose={() => {}} />))
  expect(choice(earlier.title)).toBeUndefined()
  expect(host.querySelector('footer')?.textContent).toContain(earlier.title)
  expect(host.querySelector('[role=status]')?.textContent).toContain('Exact text match')
})

it('saves an article with its reference pending in one choice and completes it later without changing the quote', async () => {
  const words = '  Exact article words.  ', shelf = createShelfBook({ title: 'Named essay', kind: 'article', authors: ['Original Author'] })
  await getStore().putKv('bookshelves.v1', { ...emptyBookshelf(), revision: 1, books: [shelf] })
  const origin = { kind: 'writing', id: 'draft', title: 'My essay' } as const
  await act(async () => root.render(<QuoteCapture selection={words} origin={origin} onClose={() => {}} />))
  await press('Articles')
  expect(host.querySelector('button[type=submit]')?.hasAttribute('disabled')).toBe(false)
  expect(host.querySelector('.quote-capture-footer')?.textContent).toContain('Article · reference pending')
  expect(choice(shelf.title).getAttribute('aria-pressed')).toBe('false')
  await press('Save quote')
  const captured = (await snapshot()).quotes[0]
  expect(captured.text).toBe(words)
  expect(captured.history[0].source).toMatchObject({ kind: 'article', title: '', referenceStatus: 'pending' })
  expect(captured.history[0].source.sourceId).toBeUndefined(); expect(captured.history[0].source.bookId).toBeUndefined()
  expect(captured.history[0].verification.status).toBe('unlinked')
  await act(async () => root.render(<QuoteCollection />))
  expect(host.querySelector('.quote-card')?.textContent).toContain('Article · reference pending')
  expect(host.querySelector('.quote-card')?.textContent).toContain('No retained source linked')
  await press('Edit reference')
  await act(async () => choice(shelf.title).click())
  await press('Save reference')
  const completed = (await snapshot()).quotes[0]
  expect(completed).toMatchObject({ id: captured.id, text: words, origin, history: [
    { source: { kind: 'article', referenceStatus: 'pending', title: '' } },
    { source: { kind: 'article', referenceStatus: 'identified', title: shelf.title, bookId: shelf.id } },
  ] })
  expect(await getStore().getKv('knowledge.v1')).toBeUndefined()
})
it('still requires actual words when the article reference is deferred', async () => {
  await act(async () => root.render(<QuoteCapture selection="" origin={{ kind: 'collection', id: 'quotes', title: 'Quotes' }} onClose={() => {}} />))
  await press('Articles')
  expect(host.querySelector('button[type=submit]')?.hasAttribute('disabled')).toBe(true)
  expect(await getStore().getKv(QUOTES_KV)).toBeUndefined()
})
