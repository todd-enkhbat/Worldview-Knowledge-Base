// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { Blob as NodeBlob } from 'node:buffer'
import { TextEncoder as NodeTextEncoder } from 'node:util'
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeRepo, completeFirstRun, getStore, initRepo } from '../../src/data/repo.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { initializeKnowledge, resetKnowledge, useKnowledge } from '../../src/knowledge/index.ts'
import type { KnowledgeSource, SourceVersion } from '../../src/knowledge/types.ts'
import AnnotatedReader, { HighlightedText, selectionInSource } from '../../src/reading/AnnotatedReader.tsx'
import { captureArticle } from '../../src/reading/captureArticle.ts'
import { addHighlight, createFolder, initializeReading, READING_KV, resetReading, useReading } from '../../src/reading/store.ts'
import * as readingStore from '../../src/reading/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement
const scrollRef = createRef<HTMLDivElement>(), readVersion = vi.fn()
const body = 'First 🌍 repeated quote.\nSecond repeated quote and tail.'
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('TextEncoder', class extends NodeTextEncoder { override encode(input?: string) { return new Uint8Array(super.encode(input)) } })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Reader must not call external services') }))
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  resetReading(); resetKnowledge(); readVersion.mockClear()
  await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  await initializeKnowledge(); await initializeReading()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges()
  resetReading(); resetKnowledge(); await closeRepo(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function article(text = body, url = 'https://example.org/reading') {
  const { sourceId } = await captureArticle({ title: 'Selection study', text, url })
  const source = useKnowledge.getState().sources.find((entry) => entry.id === sourceId)!
  return { source, version: useKnowledge.getState().versions.find((entry) => entry.id === source.currentVersionId)! }
}
async function render(source: KnowledgeSource, version: SourceVersion) {
  await act(async () => root.render(<div ref={scrollRef}><AnnotatedReader source={source} version={version} scrollRef={scrollRef} onReadVersion={readVersion} /></div>))
}
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim() === label)!
async function type(selector: string, value: string) {
  const element = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
  await act(async () => { Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
function select(element: HTMLElement, start: number, end: number) {
  const nodes: Text[] = [], walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  while (walk.nextNode()) nodes.push(walk.currentNode as Text)
  const endpoint = (offset: number): [Text, number] => { for (const node of nodes) { if (offset <= node.length) return [node, offset]; offset -= node.length } throw new Error('Selection outside fixture') }
  const range = document.createRange(); range.setStart(...endpoint(start)); range.setEnd(...endpoint(end))
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  return selection
}

it('maps exact UTF-16 offsets across highlighted spans and repeated quotes after Unicode characters', async () => {
  const { source, version } = await article(), start = body.lastIndexOf('repeated quote')
  await addHighlight({ sourceId: source.id, versionId: version.id, start: start + 2, end: start + 6, quote: body.slice(start + 2, start + 6) })
  await render(source, version)
  const text = host.querySelector<HTMLElement>('.reading-article-text')!
  const selection = select(text, start, start + 'repeated quote'.length)
  expect(selectionInSource(text, body, selection)).toEqual({ start, end: start + 14, quote: 'repeated quote', prefix: body.slice(0, start), suffix: body.slice(start + 14) })
  expect(start).not.toBe(body.indexOf('repeated quote'))
  expect(text.textContent).toBe(body)
  selection.collapseToStart(); expect(selectionInSource(text, body, selection)).toBeNull()
})

it('keeps selection controls hidden during a drag, then saves the exact mouse-up range and comment against the same retained version', async () => {
  const { source, version } = await article(), start = body.lastIndexOf('repeated quote')
  await render(source, version)
  await act(async () => { select(host.querySelector('.reading-article-text')!, start, start + 14); document.dispatchEvent(new Event('selectionchange')) })
  expect(host.querySelector('[aria-label="Save selected passage"]')).toBeNull()
  expect(host.querySelector('.reading-article-text')?.textContent).toBe(body)
  expect(window.getSelection()?.toString()).toBe('repeated quote')
  await act(async () => host.querySelector('.reading-article-text')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
  expect(host.querySelector('[aria-label="Save selected passage"]')).toBeTruthy()
  await type('#reading-selection-comment', 'This is the second occurrence 🌱.')
  await act(async () => button('Save highlight').click())
  expect(useReading.getState().highlights[0]).toMatchObject({ sourceId: source.id, versionId: version.id, start, end: start + 14, quote: 'repeated quote', note: 'This is the second occurrence 🌱.' })
  expect(host.querySelector('.reading-remark')?.textContent).toBe('This is the second occurrence 🌱.')
  const snapshot = await getStore().getKv<{ highlights: unknown[] }>(READING_KV)
  expect(snapshot?.highlights).toHaveLength(1)
  expect(useKnowledge.getState().versions.find((entry) => entry.id === version.id)?.text).toBe(body)
})

it('preserves overlapping highlights and locates a fully contained annotation', async () => {
  const { source, version } = await article(), start = body.lastIndexOf('repeated quote')
  await addHighlight({ sourceId: source.id, versionId: version.id, start, end: start + 14, quote: 'repeated quote' })
  const nested = await addHighlight({ sourceId: source.id, versionId: version.id, start: start + 2, end: start + 6, quote: body.slice(start + 2, start + 6) })
  await render(source, version)
  expect(host.querySelector('.reading-article-text')?.textContent).toBe(body)
  const mark = host.querySelector<HTMLElement>(`[data-highlight-ids~="${nested.id}"]`)!
  expect(mark).toBeTruthy()
  const scroll = vi.fn(); Object.defineProperty(mark, 'scrollIntoView', { value: scroll, configurable: true })
  await act(async () => host.querySelector<HTMLButtonElement>(`#annotation-${nested.id} .reading-quote`)!.click())
  expect(scroll).toHaveBeenCalledOnce()
})

it('does not finish a source on opening and requires fifteen visible seconds before recording scroll completion', async () => {
  const { source, version } = await article()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  await render(source, version)
  Object.defineProperties(scrollRef.current!, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 500, configurable: true }, scrollTop: { value: 500, writable: true, configurable: true } })
  expect(useReading.getState().items[0]).toMatchObject({ status: 'reading', progress: 0, readAt: null })
  await act(async () => vi.advanceTimersByTimeAsync(14999))
  expect(useReading.getState().items[0].readAt).toBeNull()
  await act(async () => vi.advanceTimersByTimeAsync(1))
  expect(useReading.getState().items[0]).toMatchObject({ status: 'read', progress: 1, position: 500, readAt: expect.any(Number) })
})

it('does not count hidden-tab time as reading', async () => {
  const { source, version } = await article()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await render(source, version)
  Object.defineProperties(scrollRef.current!, { scrollHeight: { value: 100, configurable: true }, clientHeight: { value: 500, configurable: true } })
  await act(async () => vi.advanceTimersByTimeAsync(30000))
  expect(useReading.getState().items[0]).toMatchObject({ status: 'reading', progress: 0, readAt: null })
})

it('saves a personal note, files the source and creates a connected topic through reader controls', async () => {
  const { source, version } = await article(), folder = await createFolder('Research folder')
  await render(source, version)
  await act(async () => button('Notes 0').click())
  await type('#reading-note', 'My interpretation stays separate from the source.')
  await act(async () => button('Save note').click())
  expect(useReading.getState().notes[0]).toMatchObject({ sourceId: source.id, text: 'My interpretation stays separate from the source.' })
  await act(async () => button('Organize').click())
  await act(async () => { const select = host.querySelector<HTMLSelectElement>('[aria-label="File in folder"]')!; select.value = folder.id; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await type('#reading-new-topic', 'Connected idea')
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Create and connect topic"]')!.click())
  const topic = useReading.getState().topics.find((entry) => entry.name === 'Connected idea')!
  expect(useReading.getState().items[0]).toMatchObject({ sourceId: source.id, folderId: folder.id, topicIds: [topic.id] })
  expect(useKnowledge.getState().versions.find((entry) => entry.id === version.id)?.text).toBe(body)
})

it('does not carry an unsaved note into another source or continue the previous source timer', async () => {
  const first = await article(), second = await article('Another source and its own text.', 'https://example.org/second')
  await render(first.source, first.version)
  await act(async () => button('Notes 0').click())
  await type('#reading-note', 'A private unfinished note about the first source.')
  await render(second.source, second.version)
  expect(host.textContent).not.toContain('A private unfinished note about the first source.')
  await act(async () => button('Notes 0').click())
  expect(host.querySelector<HTMLTextAreaElement>('#reading-note')?.value).toBe('')
  expect(useReading.getState().notes).toEqual([])
})

it('does not render stale or invalid highlight anchors as marks', async () => {
  const { source, version } = await article()
  await addHighlight({ sourceId: source.id, versionId: version.id, start: 0, end: 5, quote: body.slice(0, 5) })
  const valid = useReading.getState().highlights[0]
  await act(async () => root.render(<div className="fixture"><HighlightedText text={body} highlights={[{ ...valid, quote: 'WRONG' }, { ...valid, id: 'beyond', start: body.length, end: body.length + 5 }]} onHighlight={() => {}} /></div>))
  expect(host.textContent).toBe(body); expect(host.querySelector('mark')).toBeNull()
})

it('does not assign an old account’s deferred topic into a replacement workspace that reuses the same source and topic IDs', async () => {
  const { source, version } = await article()
  await render(source, version)
  await act(async () => button('Organize').click())
  await type('#reading-new-topic', 'Old workspace topic')
  const create = readingStore.createTopic
  let notify!: () => void, release!: () => void
  const created = new Promise<void>((resolve) => { notify = resolve }), gate = new Promise<void>((resolve) => { release = resolve })
  vi.spyOn(readingStore, 'createTopic').mockImplementation(async (name) => {
    const saved = await create(name)
    notify(); await gate
    return saved
  })
  const assign = vi.spyOn(readingStore, 'assignTopics')
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Create and connect topic"]')!.click(); await created })
  const corpus = await getStore().getKv('knowledge.v1'), snapshot = await getStore().getKv(READING_KV), settings = await getStore().getSettings()
  const replacement = createMemoryStore()
  await replacement.putSettings(settings!)
  await replacement.putKv('knowledge.v1', corpus)
  await replacement.putKv(READING_KV, snapshot)
  await act(async () => { await closeRepo(); await initRepo({ store: replacement }); await initializeKnowledge(); await initializeReading() })
  await render(source, version)
  // The imported source has the same ID, so ID-only component scoping is insufficient.
  await act(async () => button('Organize').click())
  expect(host.querySelector<HTMLInputElement>('#reading-new-topic')!.value).toBe('')
  await act(async () => { release(); await gate })
  expect(assign).not.toHaveBeenCalled()
  expect(useReading.getState().items.find((entry) => entry.sourceId === source.id)?.topicIds).toEqual([])
  expect((await replacement.getKv<{ items: { sourceId: string; topicIds: string[] }[] }>(READING_KV))!.items.find((entry) => entry.sourceId === source.id)?.topicIds).toEqual([])
})

it('supports roving tab focus with Arrow keys, Home and End', async () => {
  const { source, version } = await article()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0 })
  await render(source, version)
  const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  expect(tabs.map((entry) => entry.tabIndex)).toEqual([0, -1, -1])
  await act(async () => tabs[0].focus())
  for (const [key, expected] of [['ArrowRight', 1], ['End', 2], ['Home', 0], ['ArrowLeft', 2]] as const) {
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
    expect(document.activeElement).toBe(tabs[expected])
    expect(tabs[expected].getAttribute('aria-selected')).toBe('true')
    expect(tabs.map((entry) => entry.tabIndex)).toEqual(tabs.map((_, index) => index === expected ? 0 : -1))
    expect(host.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(tabs[expected].id)
  }
})

it('files the selected occurrence as a quotation linked to the original retained version', async () => {
  const { source, version } = await article(), start = body.lastIndexOf('repeated quote')
  await render(source, version)
  await act(async () => {
    select(host.querySelector('.reading-article-text')!, start, start + 14)
    host.querySelector('.reading-article-text')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await act(async () => button('Save quote').click())
  const dialog = host.querySelector('dialog')!
  expect(dialog.querySelector('textarea')?.value).toBe('repeated quote')
  expect(dialog.textContent).toContain('Exact text match')
  await act(async () => dialog.querySelector<HTMLButtonElement>('button[type=submit]')!.click())
  const saved = await getStore().getKv<import('../../src/quotes/model.ts').QuoteLibrary>('quotes.v1')
  expect(saved?.quotes[0]).toMatchObject({
    text: 'repeated quote', origin: { id: source.id, kind: 'article' },
    history: [{ source: { versionId: version.id, sourceId: source.id }, verification: { status: 'exact', start, end: start + 14 } }],
  })
  expect(host.querySelector('dialog')).toBeNull()
  expect(useReading.getState().highlights).toHaveLength(0)
})

it('returns from a concept backlink to the exact imported words or margin note', async () => {
  const { source, version } = await article('Virtù is one thing. Virtù appears again.')
  const note = await readingStore.addReadingNote(source.id, 'A margin note on Virtù')
  const original = location.hash, start = version.text.lastIndexOf('Virtù')
  try {
    history.replaceState(null, '', '#/library?source=' + source.id + '&version=' + version.id + '&from=' + start + '&term=Virt%C3%B9')
    await render(source, version)
    expect(host.querySelector('[data-concept-target]')?.textContent).toBe('Virtù')
    expect(host.querySelector('[data-concept-target]')?.previousElementSibling?.textContent).toBe(version.text.slice(0, start))
    history.replaceState(null, '', '#/library?source=' + source.id + '&note=' + note.id)
    await render(source, version)
    expect(host.querySelector('[role=tab][aria-selected=true]')?.textContent).toContain('Notes')
    expect(host.querySelector('[id="annotation-' + note.id + '"]')?.textContent).toContain('A margin note on Virtù')
  } finally { history.replaceState(null, '', original || '#') }
})
