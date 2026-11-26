// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { Blob as NodeBlob } from 'node:buffer'
import { TextEncoder as NodeTextEncoder } from 'node:util'
import { Activity, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, getStore, initRepo, wipeWorld } from '../../src/data/repo.ts'
import { initializeKnowledge, resetKnowledge, useKnowledge } from '../../src/knowledge/index.ts'
import { captureArticle } from '../../src/reading/captureArticle.ts'
import * as readingStore from '../../src/reading/store.ts'
import * as writingStore from '../../src/writing/store.ts'
import { normalizedWritingJSON, writingExtensions } from '../../src/writing/extensions.ts'
import { emptyWritingContent, plainTextFromWriting, validateWritingContent, writingFromPlainText } from '../../src/writing/model.ts'
import { readWritingHistory } from '../../src/writing/history.ts'
import WritingStudio from '../../src/writing/WritingStudio.tsx'
import { WritingResearch } from '../../src/writing/WritingResearch.tsx'
import { WritingHistoryPanel } from '../../src/writing/WritingHistory.tsx'
import type { WritingDocument, WritingDocumentPatch } from '../../src/writing/types.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement, editor: Editor, editorElement: HTMLDivElement, doc: WritingDocument
const update = vi.fn(), restored = vi.fn(), flush = vi.fn(async () => {})
const byText = (text: string) => {
  const control = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === text)
  if (!control) throw new Error(`Missing button: ${text}`)
  return control
}
const byLabel = <T extends HTMLElement = HTMLButtonElement>(text: string) => {
  const control = host.querySelector<T>(`[aria-label="${text}"]`)
  if (!control) throw new Error(`Missing control: ${text}`)
  return control
}
async function click(text: string) { await act(async () => byText(text).click()) }
async function input(control: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(control, value); control.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function until(check: () => boolean) { for (let count = 0; count < 150 && !check(); count++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) }); expect(check(), host.textContent ?? '').toBe(true) }
function deferred<T>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function ResearchHarness({ id }: { id: string }) {
  const current = writingStore.useWriting((state) => state.docs.find((entry) => entry.id === id))!
  const change = (patch: WritingDocumentPatch) => { update(patch); void writingStore.updateWritingDocument(id, patch) }
  return <WritingResearch document={current} editor={editor} update={change} onClose={() => {}} disabled={false} />
}
function HistoryHarness({ id }: { id: string }) {
  const current = writingStore.useWriting((state) => state.docs.find((entry) => entry.id === id))!
  return <WritingHistoryPanel document={current} flush={flush} onRestored={restored} onClose={() => {}} />
}
async function research() { await act(async () => root.render(<ResearchHarness id={doc.id} />)) }
async function seed() {
  const captured = await captureArticle({ title: 'The orchard experiment', url: 'https://example.org/orchard', text: 'Copper leaves retain the exact observation. A second sentence supplies context.' })
  const source = useKnowledge.getState().sources.find((entry) => entry.id === captured.sourceId)!
  const version = useKnowledge.getState().versions.find((entry) => entry.id === source.currentVersionId)!
  const quote = 'exact observation', start = version.text.indexOf(quote)
  const highlight = await readingStore.addHighlight({ sourceId: source.id, versionId: version.id, quote, start, end: start + quote.length, note: 'A useful retained passage.' })
  return { source, version, highlight }
}
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('TextEncoder', class extends NodeTextEncoder { override encode(value?: string) { return new Uint8Array(super.encode(value)) } })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Writing workflows must remain local') }))
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(0, 0, 0, 0) })
  readingStore.resetReading(); writingStore.resetWriting(); resetKnowledge(); update.mockClear(); restored.mockClear(); flush.mockReset(); flush.mockResolvedValue(undefined)
  await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: 0, start: 'empty' }); await initializeKnowledge(); await readingStore.initializeReading(); await writingStore.initializeWriting()
  doc = await writingStore.createWritingDocument({ title: 'An essay from my research', content: writingFromPlainText('A working draft.') })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  editorElement = document.createElement('div'); document.body.append(editorElement)
  editor = new Editor({ element: editorElement, extensions: writingExtensions(), content: emptyWritingContent() })
})
afterEach(async () => { await act(async () => root.unmount()); editor.destroy(); host.remove(); editorElement.remove(); readingStore.resetReading(); writingStore.resetWriting(); resetKnowledge(); await closeRepo(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('inserts a retained highlight into a real editor with its exact source, version, quote and offsets', async () => {
  const { source, version, highlight } = await seed()
  await research(); await click('Insert quotation')
  const citation = normalizedWritingJSON(editor.getJSON()).content?.find((entry) => entry.type === 'writingCitation')
  expect(citation?.attrs).toMatchObject({ sourceId: source.id, versionId: version.id, sourceTitle: source.title, quote: highlight.quote, start: highlight.start, end: highlight.end, url: 'https://example.org/orchard' })
  expect(() => validateWritingContent(normalizedWritingJSON(editor.getJSON()))).not.toThrow()
  expect(host.textContent).toContain('Inserted into your draft.')
  expect(await getStore().listNodes()).toEqual([])
  expect(fetch).not.toHaveBeenCalled()
})

it('keeps stale or mismatched quotations out of the draft and explains how to recover', async () => {
  const { highlight } = await seed()
  readingStore.useReading.setState({ highlights: [{ ...highlight, versionId: 'unavailable-version' }] })
  await research(); await click('Insert quotation')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('retained version is unavailable')
  expect(normalizedWritingJSON(editor.getJSON())).toEqual(emptyWritingContent())
  await act(async () => readingStore.useReading.setState({ highlights: [{ ...highlight, quote: 'Changed words' }] }))
  await click('Insert quotation')
  expect(normalizedWritingJSON(editor.getJSON())).toEqual(emptyWritingContent())
})

it('inserts a page-bound PDF quotation and a deep link to that exact retained page', async () => {
  const { source, version } = await seed()
  await readingStore.addPdfHighlight({ sourceId: source.id, versionId: version.id, page: 7, quote: 'Words on the seventh page.', rects: [{ x: .1, y: .2, width: .4, height: .03 }] })
  await research(); await click('Insert quotation · page 7')
  const citation = normalizedWritingJSON(editor.getJSON()).content?.find((entry) => entry.type === 'writingCitation')
  expect(citation?.attrs).toMatchObject({ sourceId: source.id, versionId: version.id, page: 7, quote: 'Words on the seventh page.', start: 0, end: 26 })
  expect(host.querySelector(`a[href="#/library?source=${source.id}&version=${version.id}&page=7"]`)).not.toBeNull()
  expect(editor.getHTML()).toContain('&amp;page=7')
  expect(() => validateWritingContent(normalizedWritingJSON(editor.getJSON()))).not.toThrow()
})

it('files a draft and inserts a canonical topic link while source metadata stays exact', async () => {
  const { source } = await seed(), topic = await readingStore.createTopic('Measurement')
  const before = structuredClone(source)
  await research(); await click('Topics')
  const checkbox = [...host.querySelectorAll('label')].find((label) => label.textContent === 'Measurement')!.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  await act(async () => checkbox.click())
  await until(() => writingStore.useWriting.getState().docs.find((entry) => entry.id === doc.id)?.topicIds?.includes(topic.id) === true)
  expect(update).toHaveBeenCalledWith({ topicIds: [topic.id] })
  await act(async () => byLabel('Insert topic link Measurement').click())
  expect(normalizedWritingJSON(editor.getJSON()).content?.[0].content?.find((entry) => entry.type === 'writingTopicLink')?.attrs).toEqual({ topicId: topic.id, label: 'Measurement' })
  expect(useKnowledge.getState().sources.find((entry) => entry.id === source.id)).toEqual(before)
})

it('merges a newly created topic with assignments changed while its creation was pending', async () => {
  const existing = await readingStore.createTopic('Existing topic'), created = await readingStore.createTopic('New topic'), pending = deferred<typeof created>()
  vi.spyOn(readingStore, 'createTopic').mockImplementationOnce(() => pending.promise)
  await research(); await click('Topics')
  await input(host.querySelector('#writing-new-topic')!, 'New topic')
  await act(async () => byLabel('Create writing topic').click())
  await act(async () => { await writingStore.updateWritingDocument(doc.id, { topicIds: [existing.id] }) })
  await act(async () => pending.resolve(created))
  await until(() => writingStore.useWriting.getState().docs.find((entry) => entry.id === doc.id)?.topicIds?.includes(created.id) === true)
  expect(writingStore.useWriting.getState().docs.find((entry) => entry.id === doc.id)?.topicIds).toEqual(expect.arrayContaining([existing.id, created.id]))
})

it('shows backlinks from other writing that cites this document', async () => {
  const publication = await writingStore.publishWritingDocument(doc.id)
  await writingStore.createWritingDocument({ title: 'A connected follow-up', content: { type: 'doc', content: [{ type: 'writingCitation', attrs: { sourceId: publication.sourceId, versionId: publication.versionId, sourceTitle: doc.title, quote: 'A working draft.', start: 0, end: 16 } }] } })
  await research()
  expect(host.textContent).toContain('Writing that cites this document')
  expect(host.textContent).toContain('A connected follow-up')
})

it('names a real snapshot, compares a later edit, and restores it while retaining the previous draft', async () => {
  await act(async () => root.render(<HistoryHarness id={doc.id} />))
  await input(host.querySelector('#writing-snapshot-name')!, 'Before the final edit')
  await act(async () => byLabel('Save named snapshot').click())
  await until(() => host.textContent?.includes('Named snapshot saved.') === true)
  await act(async () => { await writingStore.updateWritingDocument(doc.id, { content: writingFromPlainText('The later ending.') }) })
  const milestone = [...host.querySelectorAll<HTMLButtonElement>('.writing-timeline button')].find((button) => button.querySelector('strong')?.textContent === 'Before the final edit')!
  await act(async () => milestone.click())
  expect(host.querySelector('[aria-label="Compare writing versions"]')?.textContent).toContain('Different from your current draft')
  expect(host.textContent).toContain('The later ending.')
  await click('Restore this version')
  await until(() => restored.mock.calls.length === 1)
  expect(plainTextFromWriting(writingStore.useWriting.getState().docs.find((entry) => entry.id === doc.id)!.content)).toBe('A working draft.')
  expect((await readWritingHistory()).entries.some((entry) => entry.kind === 'restore' && plainTextFromWriting(entry.document.content) === 'The later ending.')).toBe(true)
  expect(flush).toHaveBeenCalledTimes(2)
  expect(fetch).not.toHaveBeenCalled()
})

it('does not continue a named-snapshot write after a workspace replacement during flush', async () => {
  const pending = deferred<void>(), saving = vi.spyOn(writingStore, 'saveWritingSnapshot')
  flush.mockImplementationOnce(() => pending.promise)
  await act(async () => root.render(<WritingHistoryPanel document={doc} flush={flush} onRestored={restored} onClose={() => {}} />))
  await input(host.querySelector('#writing-snapshot-name')!, 'Should remain in the old workspace')
  await act(async () => byLabel('Save named snapshot').click())
  await act(async () => { await wipeWorld({ confirm: true }); pending.resolve() })
  expect(saving).not.toHaveBeenCalled()
  expect((await readWritingHistory()).entries).toEqual([])
  expect(restored).not.toHaveBeenCalled()
})

it('does not assign a topic after its pending creation finishes in a hidden writing panel', async () => {
  const created = await readingStore.createTopic('A retained topic'), pending = deferred<typeof created>()
  vi.spyOn(readingStore, 'createTopic').mockImplementationOnce(() => pending.promise)
  await act(async () => root.render(<Activity mode="visible"><ResearchHarness id={doc.id} /></Activity>))
  await click('Topics'); await input(host.querySelector('#writing-new-topic')!, 'A retained topic')
  await act(async () => byLabel('Create writing topic').click())
  await act(async () => root.render(<Activity mode="hidden"><ResearchHarness id={doc.id} /></Activity>))
  await act(async () => pending.resolve(created))
  expect(update).not.toHaveBeenCalled()
  expect(writingStore.useWriting.getState().docs.find((entry) => entry.id === doc.id)?.topicIds ?? []).toEqual([])
})

it('ignores an older history refresh after a newer retained snapshot has become visible', async () => {
  const store = getStore(), originalRead = store.getKv.bind(store), pending = deferred<unknown>()
  let held = false
  vi.spyOn(store, 'getKv').mockImplementation((async (key: string) => {
    if (key === 'writingHistory.v1' && !held) { held = true; return pending.promise }
    return originalRead(key)
  }) as typeof store.getKv)
  await act(async () => root.render(<HistoryHarness id={doc.id} />))
  await act(async () => { await writingStore.saveWritingSnapshot(doc.id, 'The newer visible snapshot') })
  await until(() => host.textContent?.includes('The newer visible snapshot') === true)
  await act(async () => pending.resolve(undefined))
  expect(host.textContent).toContain('The newer visible snapshot')
})

it('resumes the latest writing and creates a blank draft directly while keeping templates available', async () => {
  const first = await writingStore.createWritingDocument({ title: 'First article' })
  const next = await writingStore.createWritingDocument({ title: 'Second article' })
  await writingStore.updateWritingDocument(next.id, { subtitle: 'Revised edition' })
  await act(async () => root.render(<WritingStudio hash="#/write" />))
  expect(host.querySelector('.writing-resume')?.getAttribute('href')).toBe('#/write?doc=' + next.id)
  expect(host.querySelector('.writing-files a[href="#/write?doc=' + first.id + '"]')).not.toBeNull()
  const templates = host.querySelector<HTMLDetailsElement>('.writing-templates')!
  expect(templates.open).toBe(false)
  expect(templates.textContent).toContain('Research note')
  const initialCount = writingStore.useWriting.getState().docs.length
  await click('New draft')
  const created = writingStore.useWriting.getState().docs.at(-1)!
  expect(location.hash).toBe('#/write?doc=' + created.id)
  expect(created.format).toBe('note')
  expect(writingStore.useWriting.getState().docs.length).toBe(initialCount + 1)
})
