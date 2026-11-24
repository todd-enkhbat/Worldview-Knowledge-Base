// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AssistantConnections } from '../../src/connections/AssistantConnections.tsx'
import { defaultWritingAppearance, writingFromPlainText } from '../../src/writing/model.ts'
import { createShelfBook } from '../../src/bookshelf/model.ts'
import { useBookshelf } from '../../src/bookshelf/store.ts'
import { useWriting } from '../../src/writing/store.ts'
import { useKnowledge } from '../../src/knowledge/index.ts'
import type { StoreChange } from '../../src/data/WorldStore.ts'

const state = vi.hoisted(() => ({ generation: 1, listeners: new Set<(change: StoreChange) => void>(), store: { info: { kind: 'sqlite' } } }))
vi.mock('../../src/data/repo.ts', () => ({ getStore: () => state.store, getWorldGeneration: () => state.generation, isRepoReady: () => true, useRepoStatus: (selector: (state: { ready: boolean; writer: boolean }) => unknown) => selector({ ready: true, writer: true }), subscribeRepo: (callback: (change: StoreChange) => void) => { state.listeners.add(callback); return () => state.listeners.delete(callback) } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
const reply = (value: unknown) => Promise.resolve({ ok: true, json: async () => value } as Response)
beforeEach(() => { state.generation = 1; state.listeners.clear(); useBookshelf.setState({ books: [] }); useWriting.setState({ docs: [] }); useKnowledge.setState({ sources: [] }); vi.stubGlobal('Blob', NodeBlob); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const render = () => act(async () => root.render(<AssistantConnections />))
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === label)!

it('makes the complete rich proposal inspectable and downloadable beyond the truncated text comparison', async () => {
  const current = { id: 'doc', title: 'The same words', subtitle: '', byline: '', format: 'essay', content: writingFromPlainText('The text did not change.'), appearance: defaultWritingAppearance(), createdAt: 1, updatedAt: 1, archivedAt: null }
  const proposed = { ...current, format: 'newsletter', topicIds: ['topic-one'], appearance: { ...current.appearance, background: 'waves', textColor: '#123456' } }
  const review = { available: true, bridge: { command: 'node', args: [] }, entries: [{ id: 'proposal-one', clientName: 'My editor', operation: 'update_writing', status: 'pending', createdAt: 1, documentId: 'doc', currentDocument: current, document: proposed }] }
  vi.stubGlobal('fetch', vi.fn((path: string) => reply(path === '/api/memory/clients' ? { clients: [] } : review)))
  let downloaded: Blob | undefined
  vi.stubGlobal('URL', class extends URL { static override createObjectURL(blob: Blob) { downloaded = blob; return 'blob:local-proposal' } static override revokeObjectURL() {} })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  await render(); expect(button('Approve change').disabled).toBe(true)
  await act(async () => button('Review changes').click())
  const full = host.querySelector<HTMLDetailsElement>('.assistant-full-proposal')!
  await act(async () => full.querySelector('summary')!.click())
  expect(full.open).toBe(true)
  const payload = JSON.parse(full.querySelector('pre')!.textContent!)
  expect(payload.proposed).toMatchObject({ format: 'newsletter', topicIds: ['topic-one'], appearance: { background: 'waves', textColor: '#123456' } })
  expect(host.textContent).toContain('may be truncated')
  await act(async () => button('Download complete proposal').click())
  expect(JSON.parse(await downloaded!.text()).proposed).toEqual(proposed)
  expect(button('Approve change').disabled).toBe(false)
})

it('clears pending credential UI after world replacement instead of showing a late token in the new workspace', async () => {
  let resolveCreate!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn((path: string, input?: RequestInit) => input?.method === 'POST' ? new Promise<Response>((resolve) => { resolveCreate = resolve }) : reply(path === '/api/memory/clients' ? { clients: [] } : { available: true, bridge: { command: 'node', args: [] }, entries: [] })))
  await render()
  const permission = [...host.querySelectorAll('label')].find((label) => label.textContent?.includes('Propose new writing'))!.querySelector<HTMLInputElement>('input')!
  await act(async () => permission.click())
  await act(async () => button('Create scoped connection').click())
  await act(async () => { state.generation++; for (const listener of [...state.listeners]) listener({ type: 'import' }) })
  await act(async () => resolveCreate({ ok: true, json: async () => ({ token: 'late-private-fixture-token' }) } as Response))
  expect(host.querySelector('.assistant-configuration')).toBeNull()
  expect(host.textContent).not.toContain('late-private-fixture-token')
})

it('submits only explicitly selected bookshelf metadata and no implicit linked-source grant', async () => {
  const book = createShelfBook({ title: 'A selected book', sourceId: 'unselected-original' }); useBookshelf.setState({ books: [book] })
  let submitted: Record<string, unknown> | undefined
  vi.stubGlobal('fetch', vi.fn((path: string, input?: RequestInit) => { if (input?.method === 'POST') { submitted = JSON.parse(String(input.body)); return reply({ token: 'fixture-token' }) } return reply(path === '/api/memory/clients' ? { clients: [] } : { available: true, bridge: { command: 'node', args: [] }, entries: [] }) }))
  await render()
  const checkbox = [...host.querySelectorAll('label')].find((label) => label.textContent?.trim() === 'A selected book')!.querySelector<HTMLInputElement>('input')!
  await act(async () => checkbox.click()); await act(async () => button('Create scoped connection').click())
  expect(submitted).toMatchObject({ bookshelfBookIds: [book.id], sourceIds: [], allowCreateBooks: false })
})

it('shows changed book details in plain language while retaining the complete proposal', async () => {
  const before = createShelfBook({ title: 'The title stays', rating: 0, recommendedBy: 'A reader', notes: 'My unchanged notes.' }, 1)
  const after = { ...before, rating: 4, recommendedBy: 'A reading group' }
  const review = { available: true, bridge: { command: 'node', args: [] }, entries: [{ id: 'book-proposal', clientName: 'Book assistant', operation: 'update_book', status: 'pending', createdAt: 1, bookId: before.id, currentBook: before, book: after }] }
  vi.stubGlobal('fetch', vi.fn((path: string) => reply(path === '/api/memory/clients' ? { clients: [] } : review)))
  await render(); await act(async () => button('Review changes').click())
  const comparison = host.querySelector('.assistant-book-comparison')!
  expect(comparison.textContent).toContain('2 details changed')
  expect(comparison.textContent).toContain('Not rated')
  expect(comparison.textContent).toContain('4 / 5')
  expect(comparison.textContent).toContain('A reading group')
  expect(comparison.textContent).not.toContain(before.id)
  expect(comparison.textContent).not.toContain('My unchanged notes.')
  expect(JSON.parse(host.querySelector('.assistant-full-proposal pre')!.textContent!).proposed).toEqual(after)
})
