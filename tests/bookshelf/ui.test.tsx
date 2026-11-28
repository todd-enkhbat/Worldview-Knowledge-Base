// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { TextEncoder as NodeTextEncoder } from 'node:util'
import { act, useEffect, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, initRepo } from '../../src/data/repo.ts'
import Bookshelf from '../../src/bookshelf/Bookshelf.tsx'
import { createBook, initializeBookshelf, resetBookshelf, useBookshelf } from '../../src/bookshelf/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement
function Harness() { const [hash, setHash] = useState(location.hash); useEffect(() => { const changed = () => setHash(location.hash); window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed) }, []); return <div className="knowledge-workbench" data-theme="light"><Bookshelf hash={hash} /></div> }
beforeEach(async () => {
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() })
  vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('TextEncoder', class extends NodeTextEncoder { override encode(value?: string) { return new Uint8Array(super.encode(value)) } })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Bookshelf UI stays local') }))
  history.replaceState(null, '', '/#/bookshelf'); resetBookshelf()
  await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: 0, start: 'empty' }); await initializeBookshelf()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetBookshelf(); await closeRepo(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function render() { await act(async () => root.render(<Harness />)) }
function button(text: string) { const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === text); if (!found) throw new Error(`Missing button: ${text}`); return found }
async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check() && Date.now() < deadline) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(check(), host.textContent).toBe(true)
}

it('starts honestly empty and adds a customized book with its recommender and own details through the real editor', async () => {
  await render(); expect(useBookshelf.getState().books).toEqual([])
  expect(host.textContent).toContain('No books yet')
  await act(async () => button('Add a book').click()); await until(() => !!host.querySelector('dialog'))
  await act(async () => button('Identify my copy · enter details or add a cover').click())
  await input(host.querySelector<HTMLInputElement>('input[placeholder="The title you want to keep"]')!, 'A deliberate reading choice')
  await input(host.querySelector<HTMLInputElement>('input[placeholder="Separate multiple authors with a semicolon"]')!, 'An author; A collaborator')
  await input(host.querySelector<HTMLInputElement>('input[placeholder="A person, a conversation, a place you found it"]')!, 'My reading group')
  await input(host.querySelector<HTMLTextAreaElement>('textarea[placeholder="What stayed with you? What would you return to?"]')!, 'A reason to return to this book.')
  await act(async () => button('Add to Wishlist').click()); await until(() => useBookshelf.getState().books.length === 1 && location.hash.includes('book='))
  expect(useBookshelf.getState().books[0]).toMatchObject({ title: 'A deliberate reading choice', authors: ['An author', 'A collaborator'], recommendedBy: 'My reading group', notes: 'A reason to return to this book.', status: 'wish' })
  expect(host.querySelector('.book-object-front strong')?.textContent).toBe('A deliberate reading choice')
  expect(host.textContent).toContain('Recommended by My reading group')
})

it('keeps books and articles separate, filters reading stages and protects an unsaved note when closing details', async () => {
  const book = await createBook({ title: 'A book on the shelf', status: 'reading' })
  await createBook({ title: 'An article in the archive', kind: 'article', format: 'digital', status: 'read' })
  await render()
  expect([...host.querySelectorAll('.bookshelf-volume-details > button')].map((button) => button.textContent)).toEqual(['A book on the shelf'])
  await act(async () => button('Articles').click())
  expect([...host.querySelectorAll('.bookshelf-volume-details > button')].map((button) => button.textContent)).toEqual(['An article in the archive'])
  await act(async () => button('Books').click())
  await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="Open details for ${book.title}"]`)!.click()); await until(() => !!host.querySelector('dialog'))
  await act(async () => button('Edition details').click())
  await input(host.querySelector<HTMLTextAreaElement>('textarea[placeholder="What stayed with you? What would you return to?"]')!, 'An unsaved observation worth keeping')
  await act(async () => host.querySelector('dialog')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(host.querySelector('.bookshelf-conflict')?.textContent).toContain('Keep your changes before leaving?')
  expect(host.querySelector<HTMLTextAreaElement>('textarea[placeholder="What stayed with you? What would you return to?"]')?.value).toBe('An unsaved observation worth keeping')
  await act(async () => button('Keep editing').click())
  await act(async () => button('Save changes').click())
  expect(useBookshelf.getState().books.find((entry) => entry.id === book.id)?.notes).toBe('An unsaved observation worth keeping')
  expect(useBookshelf.getState().history.some((entry) => entry.bookId === book.id && entry.book.notes === '')).toBe(true)
})

it('searches for an edition before saving and opens the author across saved books and articles', async () => {
  await createBook({ title: 'Related essay', kind: 'article', authors: ['A. Writer'] })
  await createBook({ title: 'Another writer', authors: ['B. Writer'] })
  const upstream = vi.fn(async (url: string) => {
    expect(url).toContain('/api/book-catalog/visual?')
    if (url.includes('provider=google')) return new Response(null,{status:429})
    return Response.json({results:[{work:{id:'OL1W',title:'A story',authors:[{id:'OL2A',name:'A. Writer'}],editionCount:3},edition:{id:'OL3M',title:'A story',subtitle:'',editionLabel:'Revised edition',publisher:'A Press',date:'1997',year:1997,language:'eng',isbn:'9780140327243',pages:200,coverId:null}}],nextOffset:null})
  })
  vi.stubGlobal('fetch', upstream)
  await render()
  await act(async () => button('Add a book').click()); await until(() => !!host.querySelector('dialog'))
  await input(host.querySelector('#book-catalog-query')!, 'A story')
  await act(async () => button('Search').click())
  expect(host.textContent).toContain('Revised edition')
  await act(async () => host.querySelector<HTMLInputElement>('.book-stage-choice [value="read"]')!.click())
  expect(host.querySelector('.edition-save-label')?.textContent).toBe('Save as read')
  await act(async () => host.querySelector<HTMLButtonElement>('.edition-choice')!.click())
  expect([...host.querySelectorAll('dialog button')].some(element=>element.textContent==='Add to bookshelf')).toBe(false)
  await until(() => useBookshelf.getState().books.length === 3 && location.hash.includes('book='))
  expect(useBookshelf.getState().books.at(-1)).toMatchObject({ title: 'A story', status: 'read', catalog: { editionId: 'OL3M', workId: 'OL1W' }, pages: 200, year: 1997 })
  await act(async () => host.querySelector<HTMLAnchorElement>('dialog a[href*="author="]')!.click())
  await until(() => !!host.querySelector('.bookshelf-author-heading'))
  expect(host.textContent).toContain('Saved works by A. Writer')
  const titles = [...host.querySelectorAll('.bookshelf-volume-details > button')].map((element) => element.textContent)
  expect(titles.sort()).toEqual(['A story','Related essay'])
})

it('opens directly to a scratch note, saves once on real input, links a concept, and reopens either note in place', async () => {
  const { useWriting, plainTextFromWriting } = await import('../../src/writing/store.ts')
  const { useReading } = await import('../../src/reading/store.ts')
  const book = await createBook({ title: 'Discourses on Livy' })
  history.replaceState(null, '', '/#/bookshelf?book=' + book.id)
  await render()
  const editor = () => host.querySelector<HTMLElement & { editor: Editor }>('[contenteditable=true]')?.editor
  await until(() => !!editor())
  expect(useWriting.getState().docs).toHaveLength(0)
  expect(button('Reading notes').getAttribute('aria-pressed')).toBe('true')
  await act(async () => { editor()!.commands.insertContent('Virtù changes with the times.'); editor()!.commands.setTextSelection({ from: 1, to: 6 }) })
  const conceptButton = host.querySelector<HTMLButtonElement>('.writing-selection-concepts button')
  expect(conceptButton).toBeTruthy()
  await act(async () => conceptButton!.click())
  await until(() => !!useReading.getState().topics.find(topic => topic.name === 'Virtù'))
  await act(async () => button('New note').click())
  await until(() => !!editor() && !editor()!.getText())
  const first = useWriting.getState().docs[0]
  expect(first.bookEditionId).toBe(book.id)
  expect(plainTextFromWriting(first.content)).toBe('Virtù changes with the times.')
  expect(first.content.content?.[0].content?.[0].marks?.[0].attrs?.topicId).toBe(useReading.getState().topics[0].id)
  expect(useWriting.getState().docs).toHaveLength(1)
  await act(async () => { editor()!.commands.insertContent('A second observation') })
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close book details"]')!.click())
  await until(() => useWriting.getState().docs.length === 2)
  await act(async () => { location.hash = '#/bookshelf?book=' + book.id + '&note=' + first.id })
  await until(() => editor()?.getText() === 'Virtù changes with the times.')
  const topic = useReading.getState().topics[0]
  expect(host.querySelector('.book-notebook-concepts a')?.getAttribute('href')).toBe('#/topics?topic=' + topic.id)
  await act(async () => host.querySelector<HTMLButtonElement>('.book-notebook-index-toggle')!.click())
  expect(host.querySelectorAll('.book-notebook-index li')).toHaveLength(2)
})

it('autosaves into the same local note while the book stays open and preserves a custom title', async () => {
  const { useWriting, plainTextFromWriting } = await import('../../src/writing/store.ts')
  const book = await createBook({ title: 'A retained edition', notes: 'Earlier shelf observation' })
  history.replaceState(null, '', '/#/bookshelf?book=' + book.id + '&legacyNote=1')
  await render()
  const editable = () => host.querySelector<HTMLElement & { editor: Editor }>('[contenteditable=true]')?.editor
  await until(() => !!editable())
  expect(host.querySelector<HTMLDetailsElement>('.book-edition-note')?.open).toBe(true)
  await act(async () => { editable()!.commands.insertContent('First observation') })
  await until(() => useWriting.getState().docs[0]?.title === 'First observation')
  const id = useWriting.getState().docs[0].id, live = editable()
  const title = host.querySelector<HTMLInputElement>('[aria-label="Note title"]')!
  expect(title.value).toBe('')
  expect(title.placeholder).toBe('Add a title…')
  await input(host.querySelector<HTMLInputElement>('[aria-label="Note title"]')!, 'Book I, chapter 3')
  await act(async () => { editable()!.commands.insertContent(' and context') })
  await until(() => plainTextFromWriting(useWriting.getState().docs[0].content) === 'First observation and context')
  expect(useWriting.getState().docs).toHaveLength(1)
  expect(useWriting.getState().docs[0]).toMatchObject({ id, title: 'Book I, chapter 3', bookEditionId: book.id })
  expect(title.value).toBe('Book I, chapter 3')
  expect(editable()).toBe(live)
  expect(useBookshelf.getState().books[0].notes).toBe('Earlier shelf observation')
})

it('shows source-edition quotes from writing and links the concept to its exact marked passage', async () => {
  const { createTopic } = await import('../../src/reading/store.ts')
  const { createWritingDocument } = await import('../../src/writing/store.ts')
  const { saveQuote, quoteScope } = await import('../../src/quotes/store.ts')
  const book = await createBook({ title: 'Reading field notes' }), topic = await createTopic('Observation')
  const passage = { id: 'marked-passage', topicId: topic.id, relation: 'concept', createdAt: 1, updatedAt: 1 }
  const doc = await createWritingDocument({ title: 'An observation', bookEditionId: book.id, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Look at the leaves.', marks: [{ type: 'writingConcept', attrs: passage }] }] }] } })
  await saveQuote(quoteScope(), 'cited-quote', 'captured', { text: 'Trees grow.', origin: { kind: 'writing', id: doc.id, title: doc.title }, source: { title: book.title, author: '', edition: '', locator: 'p. 2', bookId: book.id } })
  history.replaceState(null, '', '/#/bookshelf?book=' + book.id)
  await render()
  await until(() => !!host.querySelector('a[href="#/quotes?quote=cited-quote"]'))
  expect(host.querySelector('a[href="#/quotes?quote=cited-quote"]')?.textContent).toBe('Trees grow.')
  expect(host.querySelector('.book-notebook-concepts a[href="#/topics?topic=' + topic.id + '"]')?.textContent).toBe(topic.name)
  expect(host.querySelector('[data-writing-concept]')?.textContent).toBe('Look at the leaves.')
  await act(async () => { location.hash = '#/bookshelf?book=' + book.id + '&note=' + doc.id + '&passage=marked-passage' })
  const editor = host.querySelector<HTMLElement & { editor: Editor }>('[contenteditable=true]')!.editor
  await until(() => editor.state.selection.from === 1 && editor.state.selection.to === 20)
})

it('attaches an older retained version to a catalog book and verifies a quote against just that edition', async () => {
  const { captureArticle } = await import('../../src/reading/captureArticle.ts')
  const { getStore } = await import('../../src/data/repo.ts')
  const { decodeQuotes } = await import('../../src/quotes/model.ts')
  const { useKnowledge } = await import('../../src/knowledge/index.ts')
  const { useReading } = await import('../../src/reading/store.ts')
  const catalog = { workId: 'OL7W', editionId: 'OL37M', authors: [], editionLabel: 'First edition', publisher: '', language: '', coverId: null }
  const book = await createBook({ title: 'My catalog book', catalog, notes: 'Already cataloged' })
  const source = { title: 'My retained transcription', url: 'https://example.org/my-local-copy' }
  const original = await captureArticle({ ...source, text: 'A phrase unique to the first edition.' })
  const firstVersion = useKnowledge.getState().sources.find((s) => s.id === original.sourceId)!.currentVersionId
  await captureArticle({ ...source, text: 'Revised text with different words.' })
  history.replaceState(null, '', '/#/bookshelf?book=' + book.id)
  await render()
  await act(async () => button('Attach Library text').click())
  await until(() => !!host.querySelector('.book-text-picker option[value="' + original.sourceId + '"]'))
  async function choose(select: HTMLSelectElement, value: string) {
    await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
  }
  await choose(host.querySelector<HTMLSelectElement>('.book-text-picker select')!, original.sourceId)
  await choose(host.querySelectorAll<HTMLSelectElement>('.book-text-picker select')[1], firstVersion)
  expect(host.querySelector('.book-text-picker blockquote')?.textContent).toBe('A phrase unique to the first edition.')
  await act(async () => button('Attach this version').click())
  await until(() => useBookshelf.getState().books[0]?.sourceVersionId === firstVersion)
  expect(useBookshelf.getState().books).toHaveLength(1)
  await act(async () => button('Read alongside').click())
  await until(() => !!host.querySelector('[aria-label="Scrollable edition text"]'))
  const pane = host.querySelector<HTMLElement>('[aria-label="Scrollable edition text"]')!
  expect(pane.textContent).toBe('A phrase unique to the first edition.')
  expect(host.querySelector('[contenteditable=true]')).not.toBeNull()
  const words = pane.querySelector('span')!.firstChild!, range = document.createRange()
  range.setStart(words, 2); range.setEnd(words, 8)
  await act(async () => {
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
    pane.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Selected edition text"] button')!.click())
  expect(useReading.getState().topics[0].name).toBe('phrase')
  expect(useReading.getState().highlights[0]).toMatchObject({ quote: 'phrase', topicId: useReading.getState().topics[0].id, versionId: firstVersion, start: 2, end: 8 })
  expect(pane.querySelector('mark')?.textContent).toBe('phrase')
  await act(async () => button('Capture a quote').click())
  await until(() => !!host.querySelector('.quote-form textarea'))
  await input(host.querySelector<HTMLTextAreaElement>('.quote-form textarea')!, 'unique to the first')
  await act(async () => host.querySelector<HTMLButtonElement>('.quote-form button[type="submit"]')!.click())
  await until(() => !!host.querySelector('.book-linked-quotes a'))
  const quote = decodeQuotes(await getStore().getKv('quotes.v1')).quotes[0]
  expect(quote.history[0]).toMatchObject({ source: { bookId: book.id, versionId: firstVersion }, verification: { status: 'exact' } })
  expect(useBookshelf.getState().books[0].notes).toBe('Already cataloged')
})
