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
import { createWritingDocument, initializeWriting, resetWriting, useWriting } from '../../src/writing/store.ts'
import { initializeCollections, saveInvestigation } from '../../src/workspace/collections.ts'
import { useWorkspace } from '../../src/workspace/state.ts'
import TopicHome from '../../src/reading/TopicHome.tsx'
import { createBook, initializeBookshelf, resetBookshelf } from '../../src/bookshelf/store.ts'
import { saveQuote, quoteScope } from '../../src/quotes/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('TextEncoder', class extends NodeTextEncoder { override encode(value?: string) { return new Uint8Array(super.encode(value)) } })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Topic pages stay local') }))
  resetReading(); resetKnowledge(); resetWriting(); resetBookshelf()
  await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: 0, start: 'empty' })
  await initializeKnowledge(); await initializeReading(); await initializeWriting(); await initializeBookshelf(); await initializeCollections(); await initializeArtifacts()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetReading(); resetKnowledge(); resetWriting(); resetBookshelf(); await closeRepo(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

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

it('opens grouped book notes and source quotations from a concept and keeps the filters local', async () => {
  const topic = await createTopic('Virtù')
  const edition = await createBook({ title:'Discourses on Livy', authors:['Niccolò Machiavelli'] })
  const note = await createWritingDocument({ title:'Fortune and action', bookEditionId:edition.id, content:{ type:'doc', content:[{ type:'paragraph', content:[
    { type:'text', text:'I think ' }, { type:'text', text:'Virtù', marks:[{ type:'writingConcept', attrs:{ id:'selected', topicId:topic.id, relation:'concept', createdAt:1, updatedAt:1 } }] },
    { type:'text', text:' connects them. Later, virtù returns.' },
  ] }] } })
  await saveQuote(quoteScope(), 'saved', 'captured', { text:'A passage using Virtù.', origin:{ kind:'book', id:edition.id, title:edition.title }, source:{ bookId:edition.id, title:edition.title, author:edition.authors[0], edition:'', locator:'I.3' } })
  await act(async () => root.render(<TopicHome hash={`#/topics?topic=${topic.id}`} />))
  const backlinks = host.querySelector('[aria-label="Concept backlinks"]')!
  expect(backlinks.querySelectorAll('article')).toHaveLength(2)
  expect(backlinks.querySelector(`a[href="#/bookshelf?book=${edition.id}&note=${note.id}&passage=selected"]`)?.textContent).toContain('I think Virtù connects them.')
  expect(backlinks.textContent).toContain('1 more passage')
  const quotes = [...backlinks.querySelectorAll('button')].find(b => b.textContent?.startsWith('Quotes'))!
  await act(async () => quotes.click())
  expect(backlinks.querySelectorAll('article')).toHaveLength(1)
  expect(backlinks.querySelector('a[href="#/quotes?quote=saved"] blockquote')?.textContent).toBe('A passage using Virtù.')
  expect(backlinks.textContent).toContain('Niccolò Machiavelli · I.3')
  expect(fetch).not.toHaveBeenCalled()
})

it('opens one personal synthesis note from the concept page and resumes it after a return', async () => {
  const concept = await createTopic('Virtù')
  const hash = '#/topics?topic=' + encodeURIComponent(concept.id)
  location.hash = hash
  await act(async () => root.render(<TopicHome hash={hash} />))
  expect(useWriting.getState().docs).toHaveLength(0)
  const write = [...host.querySelectorAll('button')].find(button => button.textContent === 'Write about Virtù')
  expect(write).toBeDefined()
  await act(async () => write!.click())
  const [doc] = useWriting.getState().docs
  const note = '#/write?doc=' + encodeURIComponent(doc.id)
  expect(location.hash).toBe(note)
  const resume = [...host.querySelectorAll('a')].find(anchor => anchor.textContent === 'Open concept note')
  expect(resume?.getAttribute('href')).toBe(note)
  expect(doc.topicIds).toEqual([concept.id])
})

it('keeps a single-line note readable once and makes empty sections and source assignment reachable', async () => {
  const topic = await createTopic('Virtù'), title = 'Virtù requires practice.'
  await createWritingDocument({ title, content:{ type:'doc', content:[{ type:'paragraph', content:[{ type:'text', text:title }] }] } })
  await act(async () => root.render(<TopicHome hash={`#/topics?topic=${topic.id}`} />))
  const row = host.querySelector('.concept-reference-main')!
  expect(row.textContent!.split(title).length - 1).toBe(1)
  expect(host.textContent).not.toContain('On your writing desk')
  const main = host.querySelector('[aria-label="Topic sections"]')!
  expect(main.textContent).toContain('Sources')
  expect(main.textContent).not.toContain('Knowledge pages')
  expect(host.querySelector('.topic-other-sections a[href$="tab=pages"]')).not.toBeNull()
  await act(async () => root.render(<TopicHome hash={`#/topics?topic=${topic.id}&tab=sources`} />))
  expect(host.querySelector('.topic-assign[open] input')).not.toBeNull()
})
