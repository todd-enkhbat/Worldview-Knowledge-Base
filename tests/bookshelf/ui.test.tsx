// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { TextEncoder as NodeTextEncoder } from 'node:util'
import { act, useEffect, useState } from 'react'
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
async function until(check: () => boolean) { await act(async () => { await vi.waitFor(() => expect(check()).toBe(true)) }) }

it('starts honestly empty and adds a customized book with its recommender and own details through the real editor', async () => {
  await render(); expect(useBookshelf.getState().books).toEqual([])
  expect(host.textContent).toContain('Make room for the next good idea.')
  await act(async () => button('Add a book').click()); await until(() => !!host.querySelector('dialog'))
  await input(host.querySelector<HTMLInputElement>('input[placeholder="The title you want to keep"]')!, 'A deliberate reading choice')
  await input(host.querySelector<HTMLInputElement>('input[placeholder="Separate multiple authors with a semicolon"]')!, 'An author; A collaborator')
  await input(host.querySelector<HTMLInputElement>('input[placeholder="A person, a conversation, a place you found it"]')!, 'My reading group')
  await input(host.querySelector<HTMLTextAreaElement>('textarea[placeholder="What stayed with you? What would you return to?"]')!, 'A reason to return to this book.')
  await act(async () => button('Add to bookshelf').click()); await until(() => useBookshelf.getState().books.length === 1 && location.hash.includes('book='))
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
  await input(host.querySelector<HTMLTextAreaElement>('textarea[placeholder="What stayed with you? What would you return to?"]')!, 'An unsaved observation worth keeping')
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close book details"]')!.click())
  expect(host.querySelector('.bookshelf-conflict')?.textContent).toContain('Keep your changes before leaving?')
  expect(host.querySelector<HTMLTextAreaElement>('textarea[placeholder="What stayed with you? What would you return to?"]')?.value).toBe('An unsaved observation worth keeping')
  await act(async () => button('Keep editing').click())
  await act(async () => button('Save changes').click())
  expect(useBookshelf.getState().books.find((entry) => entry.id === book.id)?.notes).toBe('An unsaved observation worth keeping')
  expect(useBookshelf.getState().history.some((entry) => entry.bookId === book.id && entry.book.notes === '')).toBe(true)
})
