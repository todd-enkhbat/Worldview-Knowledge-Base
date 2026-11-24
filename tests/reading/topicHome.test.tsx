// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { Blob as NodeBlob } from 'node:buffer'
import { TextEncoder as NodeTextEncoder } from 'node:util'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, initRepo } from '../../src/data/repo.ts'
import { captureThought, initializeKnowledge, resetKnowledge, useKnowledge } from '../../src/knowledge/index.ts'
import { createKnowledgePage, initializeArtifacts } from '../../src/knowledge/artifacts/index.ts'
import { addHighlight, addPdfHighlight, addReadingNote, assignTopics, createTopic, initializeReading, resetReading, updateReadingItem } from '../../src/reading/store.ts'
import { createWritingDocument, initializeWriting, resetWriting } from '../../src/writing/store.ts'
import { initializeCollections, saveInvestigation } from '../../src/workspace/collections.ts'
import { useWorkspace } from '../../src/workspace/state.ts'
import TopicHome from '../../src/reading/TopicHome.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('TextEncoder', class extends NodeTextEncoder { override encode(value?: string) { return new Uint8Array(super.encode(value)) } })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Topic pages stay local') }))
  resetReading(); resetKnowledge(); resetWriting()
  await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: 0, start: 'empty' })
  await initializeKnowledge(); await initializeReading(); await initializeWriting(); await initializeCollections(); await initializeArtifacts()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetReading(); resetKnowledge(); resetWriting(); await closeRepo(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('puts explicitly related sources, highlights, remarks, writing, pages and investigations in one topic home', async () => {
  await captureThought('A thermal observation\nCopper changes the measurement.')
  const source = useKnowledge.getState().sources[0], version = useKnowledge.getState().versions.find((entry) => entry.id === source.currentVersionId)!
  const topic = await createTopic('Measurement')
  await assignTopics(source.id, [topic.id])
  const start = version.text.indexOf('Copper')
  await addHighlight({ sourceId: source.id, versionId: version.id, start, end: start + 6, quote: 'Copper', note: 'A useful experimental anchor' })
  await addReadingNote(source.id, 'My thoughts about uncertainty')
  const draft = await createWritingDocument({ title: 'An essay about measuring', topicIds: [topic.id] })
  await createKnowledgePage({ title: 'Experimental understanding', kind: 'topic', sourceIds: [source.id], contentMd: 'My accepted wording about the experiment.' })
  useWorkspace.setState({ sourceIds: [source.id] }); await saveInvestigation('Measurement investigation')
  await act(async () => root.render(<TopicHome hash={`#/topics?topic=${topic.id}`} />))
  expect(host.textContent).toContain('A thermal observation')
  expect(host.textContent).toContain('A useful experimental anchor')
  expect(host.textContent).toContain('My thoughts about uncertainty')
  expect(host.textContent).toContain('An essay about measuring')
  expect(host.textContent).toContain('Experimental understanding')
  expect(host.textContent).toContain('Measurement investigation')
  expect(host.querySelector(`a[href="#/write?doc=${draft.id}"]`)).not.toBeNull()
  expect(host.querySelector(`a[href="#/graph?topic=${topic.id}"]`)).not.toBeNull()
  expect(fetch).not.toHaveBeenCalled()
})

it('links PDF quotations to their exact source version and page while displaying the quotation separately from a comment', async () => {
  await captureThought('Retained PDF extraction\nBoth pages have different wording.')
  const source = useKnowledge.getState().sources[0], version = useKnowledge.getState().versions.find((entry) => entry.id === source.currentVersionId)!
  const topic = await createTopic('PDF reading')
  await assignTopics(source.id, [topic.id]); await updateReadingItem(source.id, { position: 1, status: 'reading' })
  await addPdfHighlight({ sourceId: source.id, versionId: version.id, page: 2, quote: 'Exact quotation on the second page', note: 'My interpretation of that quotation', rects: [{ x: .1, y: .2, width: .5, height: .03 }] })
  await act(async () => root.render(<TopicHome hash={`#/topics?topic=${topic.id}`} />))
  const card = host.querySelector<HTMLAnchorElement>('.topic-highlight')!
  expect(card.getAttribute('href')).toBe(`#/library?source=${source.id}&version=${version.id}&page=2`)
  expect(card.getAttribute('aria-label')).toContain('page 2')
  expect(card.querySelector('blockquote')?.textContent).toBe('Exact quotation on the second page')
  expect(card.querySelector('.topic-highlight-comment')?.textContent).toBe('Your commentMy interpretation of that quotation')
  expect(card.querySelector('small')?.textContent).toContain('page 2')
})
