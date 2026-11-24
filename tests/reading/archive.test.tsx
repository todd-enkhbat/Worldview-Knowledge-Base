// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { TextEncoder as NodeTextEncoder } from 'node:util'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeRepo, completeFirstRun, initRepo } from '../../src/data/repo.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { captureThought, getSourceOriginal, importKnowledgeFiles, initializeKnowledge, resetKnowledge, setSourcePolicy, useKnowledge } from '../../src/knowledge/index.ts'
import ReadingArchive, { articleUrl } from '../../src/reading/ReadingArchive.tsx'
import { captureArticle } from '../../src/reading/captureArticle.ts'
import { addHighlight, assignTopics, createTopic, initializeReading, resetReading, updateReadingItem, useReading } from '../../src/reading/store.ts'
import { createWritingDocument, initializeWriting, resetWriting } from '../../src/writing/store.ts'
import { useAuth } from '../../src/data/auth.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement
const openSource = vi.fn(), openRecord = vi.fn()
beforeEach(async () => {
  history.replaceState(null, '', '/#/library')
  useAuth.setState({ state: 'none', user: null })
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('TextEncoder', class extends NodeTextEncoder { override encode(input?: string) { return new Uint8Array(super.encode(input)) } })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Archive must not fetch article URLs or use cloud services') }))
  resetReading(); resetKnowledge(); resetWriting(); openSource.mockClear(); openRecord.mockClear()
  await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  await initializeKnowledge(); await initializeReading()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetReading(); resetKnowledge(); resetWriting(); await closeRepo(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function render() { await act(async () => root.render(<ReadingArchive onOpenSource={openSource} onOpenRecord={openRecord} />)) }
const titles = () => [...host.querySelectorAll('.reading-file-title')].map((entry) => entry.textContent)
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim() === label)!
async function filter(label: string) { await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.reading-filters button')].find((entry) => entry.querySelector('span')?.textContent === label)!.click()) }
async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function seed() {
  const article = await captureArticle({ title: 'Copper orchard article', url: 'https://example.org/orchard', text: 'The retained article body discusses copper orchard.' })
  await captureThought('A personal note\nMy own thinking stays here.')
  const note = useKnowledge.getState().sources.find((entry) => entry.kind === 'thought')!
  await importKnowledgeFiles([new NodeFile(['A retained document about evidence.'], 'Evidence.md', { type: 'text/markdown' }) as unknown as File])
  const document = useKnowledge.getState().sources.find((entry) => entry.id !== article.sourceId && entry.id !== note.id)!
  return { article, note, document }
}

it('filters articles, personal notes and documents, and searches retained source text without network requests', async () => {
  await seed(); await render()
  expect(titles()).toHaveLength(3)
  await filter('Articles'); expect(titles()).toEqual(['Copper orchard article'])
  await filter('Notes'); expect(titles()).toEqual(['A personal note'])
  await filter('Documents'); expect(titles()).toEqual(['Evidence'])
  await filter('All files')
  await input(host.querySelector('#library-filter')!, 'retained evidence')
  expect(titles()).toEqual(['Evidence'])
  expect(fetch).not.toHaveBeenCalled()
})

it('persists favorites and topic membership while filtering the same retained sources', async () => {
  const { article, note } = await seed(), topic = await createTopic('Local evidence')
  await assignTopics(article.sourceId, [topic.id]); await render()
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Favorite Copper orchard article"]')!.click())
  await filter('Favorites'); expect(titles()).toEqual(['Copper orchard article'])
  expect(useReading.getState().items.find((entry) => entry.sourceId === article.sourceId)?.favorite).toBe(true)
  await filter('All files')
  await act(async () => { const select = host.querySelector<HTMLSelectElement>('#reading-topic')!; select.value = topic.name; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(titles()).toEqual(['Copper orchard article'])
  await act(async () => host.querySelector<HTMLButtonElement>('.reading-file-title')!.click())
  expect(openSource).toHaveBeenCalledExactlyOnceWith(article.sourceId)
  expect(openRecord).not.toHaveBeenCalled()
  expect(useKnowledge.getState().sources.some((entry) => entry.id === note.id)).toBe(true)
})

it('creates and renames a folder through the dialog, then removes only its organization while retaining original bytes', async () => {
  const { article } = await seed(), original = await getSourceOriginal(article.sourceId)
  const originalBytes = Array.from(new Uint8Array(await original!.blob.arrayBuffer()))
  await render(); await act(async () => button('Folder').click())
  await input(host.querySelector('dialog input')!, 'Research shelf')
  await act(async () => button('Create folder').click())
  const folder = useReading.getState().folders.find((entry) => entry.name === 'Research shelf')!
  await act(async () => updateReadingItem(article.sourceId, { folderId: folder.id }))
  await act(async () => host.querySelector<HTMLButtonElement>('.reading-folders button')!.click())
  expect(titles()).toEqual(['Copper orchard article'])
  await act(async () => button('Rename').click())
  await input(host.querySelector('dialog input')!, 'Long-term archive')
  await act(async () => button('Save name').click())
  expect(useReading.getState().folders.find((entry) => entry.id === folder.id)?.name).toBe('Long-term archive')
  await act(async () => button('Remove folder').click())
  expect(titles()).toHaveLength(3)
  expect(useReading.getState().items.find((entry) => entry.sourceId === article.sourceId)?.folderId).toBeNull()
  expect(useReading.getState().folders.find((entry) => entry.id === folder.id)?.deletedAt).toBeTypeOf('number')
  expect(Array.from(new Uint8Array(await (await getSourceOriginal(article.sourceId))!.blob.arrayBuffer()))).toEqual(originalBytes)
})

it('shows annotated sources in Highlighted and keeps excluded source originals without rendering a duplicate world projection', async () => {
  const { article, note } = await seed(), source = useKnowledge.getState().sources.find((entry) => entry.id === article.sourceId)!
  const version = useKnowledge.getState().versions.find((entry) => entry.id === source.currentVersionId)!, start = version.text.indexOf('retained')
  await addHighlight({ sourceId: source.id, versionId: version.id, start, end: start + 8, quote: 'retained', note: 'Serendipitous apricot margin remark' })
  await render()
  await input(host.querySelector('#library-filter')!, 'serendipitous apricot')
  expect(titles()).toEqual(['Copper orchard article'])
  expect(version.text).not.toContain('Serendipitous apricot')
  await input(host.querySelector('#library-filter')!, '')
  await filter('Highlighted')
  expect(titles()).toEqual(['Copper orchard article'])
  await act(async () => setSourcePolicy(source.id, { excluded: true }))
  expect(titles()).toEqual([])
  await filter('All files')
  expect(titles()).not.toContain('Copper orchard article')
  expect(titles()).toContain('A personal note')
  expect((await getSourceOriginal(source.id))?.blob.size).toBeGreaterThan(0)
  expect(useKnowledge.getState().versions.some((entry) => entry.id === version.id && entry.text === version.text)).toBe(true)
  expect(useKnowledge.getState().sources.some((entry) => entry.id === note.id)).toBe(true)
})

it('captures a pasted article and first impression into the local archive while retaining its original envelope', async () => {
  await render(); await act(async () => button('Save article').click())
  const fields = host.querySelectorAll<HTMLInputElement>('dialog input'), areas = host.querySelectorAll<HTMLTextAreaElement>('dialog textarea')
  await input(fields[0], 'A pasted article'); await input(fields[1], 'https://example.org/new-article?utm_source=test')
  await input(areas[0], 'Exact original words.\nA second paragraph 🌍.'); await input(areas[1], 'Why this matters to me.')
  expect(fields[0].value).toBe('A pasted article'); expect(fields[1].value).toContain('https://example.org/new-article')
  expect(areas[0].value).toContain('Exact original words.')
  expect(host.querySelector<HTMLFormElement>('dialog form')!.checkValidity()).toBe(true)
  await act(async () => { button('Save to my files').click(); await vi.waitFor(() => expect(openSource).toHaveBeenCalledOnce()) })
  expect(host.querySelector('[role=alert]')?.textContent ?? '').toBe('')
  const source = useKnowledge.getState().sources.find((entry) => entry.title === 'A pasted article')!
  expect(source).toBeTruthy(); expect(openSource).toHaveBeenCalledExactlyOnceWith(source.id)
  expect(useReading.getState().notes.find((entry) => entry.sourceId === source.id)?.text).toBe('Why this matters to me.')
  const retained = JSON.parse(await (await getSourceOriginal(source.id))!.blob.text())
  expect(retained).toMatchObject({ title: 'A pasted article', text: 'Exact original words.\nA second paragraph 🌍.' })
  expect(fetch).not.toHaveBeenCalled()
})

it('accepts only HTTP provenance links', () => {
  expect(articleUrl({ metadata: { url: 'javascript:alert(1)' } } as never)).toBeNull()
  expect(articleUrl({ metadata: { url: 'https://example.org/article' } } as never)).toBe('https://example.org/article')
})

it('finds unpublished draft body text, saves a reusable view and files the selected draft locally', async () => {
  await initializeWriting()
  const draft = await createWritingDocument({ title: 'Unpublished essay', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A remarkable heliotrope observation in the draft body.' }] }] } })
  const { createFolder } = await import('../../src/reading/store.ts')
  const folder = await createFolder('My essays')
  await render()
  await input(host.querySelector('#library-filter')!, 'heliotrope observation')
  expect(titles()).toEqual(['Unpublished essay'])
  await act(async () => button('Save this view').click())
  await input(host.querySelector('dialog input')!, 'Essay evidence')
  await act(async () => button('Save view').click())
  expect(useReading.getState().savedViews?.[0]).toMatchObject({ name: 'Essay evidence', query: 'heliotrope observation' })
  expect(location.hash).toContain('q=heliotrope+observation')
  await act(async () => host.querySelector<HTMLInputElement>('[aria-label="Select Unpublished essay"]')!.click())
  await act(async () => { const select = host.querySelector<HTMLSelectElement>('[aria-label="Move selected files to folder"]')!; select.value = folder.id; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => button('Move files').click())
  expect(useReading.getState().items.find((entry) => entry.sourceId === `writing:${draft.id}`)?.folderId).toBe(folder.id)
  expect(useKnowledge.getState().sources).toHaveLength(0)
})

it('keeps URL filters on a cold reopen for the same account and clears them for another account', async () => {
  history.replaceState(null, '', '/#/library?q=retained+evidence&filter=documents&view=list')
  await seed(); await render()
  expect(host.querySelector<HTMLInputElement>('#library-filter')?.value).toBe('retained evidence')
  expect(titles()).toEqual(['Evidence'])
  expect(history.state?.worldviewLibraryAccount).toBe('local')
  await act(async () => root.unmount()); root = createRoot(host); await render()
  expect(host.querySelector<HTMLInputElement>('#library-filter')?.value).toBe('retained evidence')
  await act(async () => root.unmount())
  useAuth.setState({ state: 'signed-in', user: { id: 'different-account', email: 'different@example.invalid' } })
  root = createRoot(host); await render()
  expect(host.querySelector<HTMLInputElement>('#library-filter')?.value).toBe('')
  expect(titles()).toHaveLength(3)
  expect(location.hash).toBe('#/library')
  expect(history.state?.worldviewLibraryAccount).toBe('different-account')
})
