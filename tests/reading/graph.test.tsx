// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { Blob as NodeBlob } from 'node:buffer'
import { TextEncoder as NodeTextEncoder } from 'node:util'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App.tsx'
import { useApp, useWorld } from '../../src/app/store.ts'
import { useAuth } from '../../src/data/auth.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, initRepo } from '../../src/data/repo.ts'
import { captureThought, initializeKnowledge, resetKnowledge, setSourcePolicy, useKnowledge } from '../../src/knowledge/index.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'
import KnowledgeGraph from '../../src/reading/KnowledgeGraph.tsx'
import { connectReading, initializeReading, READING_KV, resetReading, useReading, type ReadingSnapshot } from '../../src/reading/store.ts'
import { restoreWorkspaceContext } from '../../src/workspace/state.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
let store: ReturnType<typeof createMemoryStore>
const byLabel = <T extends HTMLElement = HTMLInputElement>(label: string) => {
  const element = host.querySelector<T>(`[aria-label="${label}"]`)
  if (!element) throw new Error(`Missing control: ${label}`)
  return element
}
const button = (text: string) => {
  const element = [...host.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === text)
  if (!element) throw new Error(`Missing button: ${text}`)
  return element
}
function type(label: string, value: string) {
  const input = byLabel<HTMLInputElement>(label)
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
function select(label: string, value: string) {
  const element = byLabel<HTMLSelectElement>(label)
  act(() => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })) })
}
function clickNode(key: string) {
  const node = host.querySelector<SVGGElement>(`[data-graph-node="${key}"]`)
  if (!node) throw new Error(`Missing graph node: ${key}`)
  act(() => { node.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check() && Date.now() < deadline) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  expect(check(), host.textContent ?? '').toBe(true)
}
async function source(text: string) {
  await captureThought(text)
  return useKnowledge.getState().sources.at(-1)!
}
async function render(initialSourceId?: string) { await act(async () => root.render(<KnowledgeGraph initialSourceId={initialSourceId} />)) }

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('TextEncoder', class extends NodeTextEncoder { override encode(text?: string) { return new Uint8Array(super.encode(text)) } })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('The graph must stay local') }))
  resetKnowledge(); resetReading()
  localStorage.clear(); restoreWorkspaceContext()
  useAuth.setState({ state: 'none', user: null })
  useApp.getState().togglePanel('chat', false)
  store = createMemoryStore()
  await initRepo({ store })
  await completeFirstRun({ T0: 0, start: 'empty' })
  await initializeKnowledge(); await initializeReading()
  history.replaceState(null, '', '/#/graph')
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); resetReading(); resetKnowledge(); await closeRepo()
  useWorld.getState().hydrate(null, [])
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('local knowledge graph', () => {
  it('filters sources, supplies keyboard node selection and opens the exact retained source', async () => {
    const first = await source('Aurora orbital budget.'), second = await source('Birch orchard cultivation.')
    await render()
    type('Filter graph', 'Aurora orbital')
    expect(host.querySelectorAll('[data-graph-node]')).toHaveLength(1)
    expect(host.querySelector(`[data-graph-node="source:${second.id}"]`)).toBeNull()
    type('Filter graph', 'No such retained source')
    expect(host.querySelectorAll('[data-graph-node]')).toHaveLength(0)
    expect(host.textContent).toContain('No nodes match these filters')
    act(() => byLabel<HTMLButtonElement>('Clear graph search').click())
    const options = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    act(() => { options[0].focus(); options[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(host.querySelector('[role="option"][aria-selected="true"]'))
    clickNode(`source:${first.id}`)
    expect(document.activeElement).toBe(host.querySelector('.reading-graph-detail h3'))
    expect(host.querySelector('.reading-graph-preview')?.textContent).toBe('Aurora orbital budget.')
    const link = host.querySelector<HTMLAnchorElement>('.reading-graph-open')!
    expect(link.getAttribute('href')).toBe(`#/library?source=${first.id}`)
    await act(async () => { link.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(location.hash).toBe(`#/library?source=${first.id}`)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('saves a semantic connection through the form, reloads it, and removes it without losing focus', async () => {
    const first = await source('Aurora orbital budget.'), second = await source('Birch orchard cultivation.')
    await render()
    select('Connection from', `source:${first.id}`)
    select('Connection relationship', 'supports')
    select('Connection to', `source:${second.id}`)
    await act(async () => button('Save connection').click())
    await until(() => useReading.getState().connections.length === 1 && !useReading.getState().busy)
    const saved = await store.getKv<ReadingSnapshot>(READING_KV)
    expect(saved?.connections[0]).toMatchObject({ from: { kind: 'source', id: first.id }, to: { kind: 'source', id: second.id }, relation: 'supports' })
    await act(async () => root.unmount()); resetReading(); await initializeReading(); root = createRoot(host)
    await render(second.id)
    expect(host.querySelector('.reading-graph-edge.is-manual text')?.textContent).toBe('supports')
    expect([...host.querySelectorAll('.reading-graph-counts div')].find((entry) => entry.querySelector('dt')?.textContent === 'Backlinks')?.querySelector('dd')?.textContent).toBe('1')
    await act(async () => byLabel<HTMLButtonElement>(`Remove supports connection to ${first.title}`).click())
    await until(() => useReading.getState().connections.length === 0 && !useReading.getState().busy)
    expect((await store.getKv<ReadingSnapshot>(READING_KV))?.connections).toHaveLength(0)
    expect(document.activeElement).toBe(host.querySelector('.reading-graph-connections h4'))
    expect(host.querySelector('.reading-graph-edge.is-manual')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('creates a topic, assigns it to a source and keeps its identity when renamed', async () => {
    const entry = await source('Aurora orbital budget.')
    await render(entry.id)
    act(() => { const summary = [...host.querySelectorAll('summary')].find((element) => element.textContent?.includes('New topic'))!; summary.click() })
    type('New topic name', 'Atomic archives')
    await act(async () => button('Create topic').click())
    await until(() => useReading.getState().topics.length === 1 && !useReading.getState().busy)
    const topic = useReading.getState().topics[0]
    clickNode(`source:${entry.id}`)
    const choice = [...host.querySelectorAll<HTMLLabelElement>('.reading-graph-topic-choices label')].find((label) => label.textContent === topic.name)!.querySelector<HTMLInputElement>('input')!
    await act(async () => choice.click())
    await until(() => useReading.getState().items.some((item) => item.sourceId === entry.id && item.topicIds.includes(topic.id)))
    expect(host.querySelector('.reading-graph-edge.is-assigned title')?.textContent).toContain('assigned topic')
    expect(host.querySelector('.reading-graph-edge.is-assigned text')).toBeNull()
    clickNode(`topic:${topic.id}`)
    type('Topic name', 'Durable archives')
    await act(async () => button('Rename').click())
    await until(() => useReading.getState().topics[0].name === 'Durable archives')
    const saved = await store.getKv<ReadingSnapshot>(READING_KV)
    expect(saved?.topics[0]).toMatchObject({ id: topic.id, name: 'Durable archives' })
    expect(saved?.items.find((item) => item.sourceId === entry.id)?.topicIds).toContain(topic.id)
    expect(saved?.connections).toHaveLength(0)
  })

  it('shows only a selected neighborhood and immediately removes excluded sources and their edges', async () => {
    const first = await source('Aurora orbital budget.'), second = await source('Birch orchard cultivation.'), unrelated = await source('Cobalt pottery glazing.')
    await connectReading({ from: { kind: 'source', id: first.id }, to: { kind: 'source', id: second.id }, relation: 'builds-on' })
    await render(first.id)
    expect(host.querySelector(`[data-graph-node="source:${second.id}"]`)).not.toBeNull()
    expect(host.querySelector(`[data-graph-node="source:${unrelated.id}"]`)).toBeNull()
    expect(host.querySelector('.reading-graph-edge.is-manual text')?.textContent).toBe('builds on')
    await act(async () => setSourcePolicy(second.id, { excluded: true }))
    expect(host.querySelector(`[data-graph-node="source:${second.id}"]`)).toBeNull()
    expect(host.querySelector('.reading-graph-edge.is-manual')).toBeNull()
    expect(host.querySelector('.reading-graph-inspector')?.textContent).not.toContain(second.title)
    // Hiding a source does not erase the user's saved relationship.
    expect((await store.getKv<ReadingSnapshot>(READING_KV))?.connections).toHaveLength(1)
  })

  it('bounds a large corpus to pages of 80 nodes, finds later nodes, and fits a stable layout', async () => {
    const entry = await source('Seed fixture')
    resetKnowledge()
    const snapshot: KnowledgeSnapshot = { schemaVersion: 1, revision: 20, sources: Array.from({ length: 181 }, (_, index) => ({ ...entry, id: crypto.randomUUID(), nodeId: undefined, title: `Record ${String(index).padStart(3, '0')}`, tags: [], pendingProjection: false, currentVersionId: '' })), versions: [], passages: [], imports: [], proposals: [], jobs: [] }
    await store.putKv('knowledge.v1', snapshot)
    await initializeKnowledge()
    await render()
    expect(host.querySelectorAll('[data-graph-node]')).toHaveLength(80)
    const positions = [...host.querySelectorAll('[data-graph-node]')].map((node) => node.getAttribute('transform'))
    act(() => byLabel<HTMLButtonElement>('Zoom in graph').click())
    expect(host.querySelector('.reading-graph-canvas-tools')?.textContent).toContain('120%')
    act(() => byLabel<HTMLButtonElement>('Fit graph to view').click())
    expect(host.querySelector('.reading-graph-canvas-tools')?.textContent).toContain('100%')
    expect([...host.querySelectorAll('[data-graph-node]')].map((node) => node.getAttribute('transform'))).toEqual(positions)
    act(() => button('Next nodes').click())
    expect(host.querySelector('.reading-graph-pagination')?.textContent).toContain('Page 2 of 3')
    expect(host.querySelectorAll('[data-graph-node]')).toHaveLength(80)
    type('Filter graph', 'Record 180')
    expect(host.querySelectorAll('[data-graph-node]')).toHaveLength(1)
    expect(host.querySelector('.reading-graph-node-list')?.textContent).toContain('Record 180')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('discloses connections outside a page and expands a selected neighborhood without dropping its links', async () => {
    const seed = await source('Seed fixture')
    resetKnowledge()
    const entries = Array.from({ length: 92 }, (_, index) => ({ ...seed, id: `graph-${index}`, nodeId: undefined, title: `Record ${String(index).padStart(3, '0')}`, tags: [], currentVersionId: '' }))
    await store.putKv('knowledge.v1', { schemaVersion: 1, revision: 20, sources: entries, versions: [], passages: [], imports: [], proposals: [], jobs: [] })
    await initializeKnowledge()
    const reading = useReading.getState()
    await store.putKv(READING_KV, { ...reading, revision: 21, connections: entries.slice(1).map((entry, index) => ({ id: `link-${index}`, from: { kind: 'source', id: entries[0].id }, to: { kind: 'source', id: entry.id }, relation: 'related', createdAt: index })) })
    resetReading(); await initializeReading(); await render()
    expect(host.querySelector('.reading-graph-outside')?.textContent).toContain('12 connections continue outside this view')
    clickNode(`source:${entries[0].id}`)
    act(() => button('Show selected neighborhood').click())
    expect(host.querySelectorAll('[data-graph-node]')).toHaveLength(80)
    act(() => [...host.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.startsWith('Expand neighborhood'))!.click())
    expect(host.querySelectorAll('[data-graph-node]')).toHaveLength(92)
    expect(host.querySelectorAll('.reading-graph-edge.is-manual')).toHaveLength(91)
    expect(host.querySelector('.reading-graph-outside')?.textContent).toContain('All visible connections are shown')
    expect(useReading.getState().connections).toHaveLength(91)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps labels at least 11px and node radii at least 5px in a narrow fitted viewport', async () => {
    let resize!: (width: number, height: number) => void
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: (entries: { contentRect: { width: number; height: number } }[]) => void) { resize = (width, height) => callback([{ contentRect: { width, height } }]) }
      observe() { resize(650, 400) }
      disconnect() {}
    })
    await source('Aurora orbital budget.'); await source('Birch orchard cultivation.'); await source('Cobalt pottery glazing.')
    await render()
    function checkReadability(width: number, height: number) {
      const svg = host.querySelector('.reading-graph-canvas')!
      expect(svg.getAttribute('viewBox')).toBe(`0 0 ${width} ${height}`)
      const transform = svg.querySelector(':scope > g')!.getAttribute('transform')!
      const scale = Number(/scale\(([^)]+)\)/.exec(transform)![1])
      for (const text of svg.querySelectorAll<SVGTextElement>('.reading-graph-node text')) expect(parseFloat(text.style.fontSize) * scale).toBeGreaterThanOrEqual(10.99)
      for (const circle of svg.querySelectorAll('.reading-graph-node-dot')) expect(Number(circle.getAttribute('r')) * scale).toBeGreaterThanOrEqual(4.99)
    }
    checkReadability(650, 400)
    act(() => byLabel<HTMLButtonElement>('Zoom out graph').click())
    checkReadability(650, 400)
    act(() => resize(350, 360))
    checkReadability(350, 360)
  })

  it('opens the graph through real App hash navigation without mounting the 3D renderer', async () => {
    const entry = await source('Graph route keeps original evidence reachable.')
    history.replaceState(null, '', '/#/today')
    await act(async () => root.render(<App />))
    await until(() => host.querySelector('#knowledge-thought') !== null)
    await act(async () => { history.replaceState(null, '', '/#/graph'); window.dispatchEvent(new HashChangeEvent('hashchange')) })
    await until(() => host.querySelector('svg[aria-label="Interactive knowledge graph"]') !== null)
    expect(host.querySelector('a[href="#/graph"][aria-current="page"]')).not.toBeNull()
    expect(host.querySelector(`[data-graph-node="source:${entry.id}"]`)).not.toBeNull()
    expect(host.querySelector('canvas')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('graph exploration and motion', () => {
  it('highlights a real neighborhood, distinguishes directed relationships, and pins without changing source or spatial data', async () => {
    const first = await source('Aurora orbital budget.'), second = await source('Birch orchard cultivation.'), other = await source('Cobalt pottery glazing.')
    await connectReading({ from: { kind: 'source', id: first.id }, to: { kind: 'source', id: second.id }, relation: 'supports' })
    const nodesBefore = await store.listNodes(), readingBefore = await store.getKv(READING_KV)
    await render(); clickNode(`source:${first.id}`)
    const a = host.querySelector<SVGGElement>(`[data-graph-node="source:${first.id}"]`)!, b = host.querySelector(`[data-graph-node="source:${second.id}"]`)!, unrelated = host.querySelector(`[data-graph-node="source:${other.id}"]`)!
    expect(b.classList.contains('is-connected')).toBe(true)
    expect(unrelated.classList.contains('is-dimmed')).toBe(true)
    expect(host.querySelectorAll('[data-origin="manual"][data-relation="supports"]')).toHaveLength(1)
    expect(host.querySelector('[data-relation="supports"] path')?.getAttribute('marker-end')).toContain('-arrow')
    act(() => { a.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true })) })
    expect(a.getAttribute('data-pinned')).toBe('true')
    const before = a.getAttribute('transform')
    act(() => { a.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true })) })
    expect(a.getAttribute('transform')).not.toBe(before)
    expect(a.getAttribute('data-pinned')).toBe('true')
    act(() => byLabel<HTMLButtonElement>('Release all graph pins').click())
    expect(a.getAttribute('data-pinned')).toBe('false')
    expect(await store.listNodes()).toEqual(nodesBefore)
    expect(await store.getKv(READING_KV)).toEqual(readingBefore)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('drags a node to a 2D pin and searches into a matching neighborhood with Enter', async () => {
    const first = await source('Aurora orbital budget.'), second = await source('Birch orchard cultivation.')
    await connectReading({ from: { kind: 'source', id: first.id }, to: { kind: 'source', id: second.id }, relation: 'builds-on' })
    await render()
    const node = host.querySelector<SVGGElement>(`[data-graph-node="source:${first.id}"]`)!, canvas = host.querySelector('svg.reading-graph-canvas')!
    const start = node.getAttribute('transform')
    const pointer = (type: string, x: number, y: number) => { const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }); Object.defineProperty(event, 'pointerId', { value: 7 }); return event }
    act(() => node.dispatchEvent(pointer('pointerdown', 100, 100)))
    act(() => canvas.dispatchEvent(pointer('pointermove', 150, 125)))
    expect(node.getAttribute('transform')).not.toBe(start)
    act(() => canvas.dispatchEvent(pointer('pointerup', 150, 125)))
    expect(node.getAttribute('data-pinned')).toBe('true')
    expect(host.textContent).toContain('Your 3D positions are unchanged')
    type('Filter graph', 'Birch orchard')
    act(() => byLabel('Filter graph').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(byLabel<HTMLInputElement>('Filter graph').value).toBe('')
    expect(host.querySelector(`[data-graph-node="source:${second.id}"]`)?.getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector(`[data-graph-node="source:${first.id}"]`)).not.toBeNull()
    expect(useReading.getState().connections).toHaveLength(1)
  })

  it('stops finite frames and directed traces when paused or when reduced-motion preference changes', async () => {
    let now = 0, next = 0, changed: (() => void) | undefined
    const queued = new Map<number, FrameRequestCallback>()
    const media = { matches: false, addEventListener: (_type: string, callback: () => void) => { changed = callback }, removeEventListener: () => {} }
    vi.stubGlobal('matchMedia', () => media)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++next; queued.set(id, callback); return id })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => queued.delete(id))
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const first = await source('Aurora orbital budget.'), second = await source('Birch orchard cultivation.')
    await connectReading({ from: { kind: 'source', id: first.id }, to: { kind: 'source', id: second.id }, relation: 'contradicts' })
    await render(); clickNode(`source:${first.id}`)
    expect(host.querySelector('.reading-graph')?.getAttribute('data-motion')).toBe('on')
    expect(host.querySelector('.reading-graph-edge-trace')).not.toBeNull()
    act(() => byLabel<HTMLButtonElement>('Toggle graph motion').click())
    expect(host.querySelector('.reading-graph')?.getAttribute('data-motion')).toBe('off')
    expect(queued.size).toBe(0)
    expect(host.querySelector('.reading-graph-edge-trace')).toBeNull()
    act(() => byLabel<HTMLButtonElement>('Toggle graph motion').click())
    act(() => byLabel<HTMLButtonElement>('Zoom in graph').click())
    expect(queued.size).toBeGreaterThan(0)
    act(() => { now = 100; const frames = [...queued.values()]; queued.clear(); for (const callback of frames) callback(now) })
    act(() => { media.matches = true; changed?.() })
    expect(host.querySelector('.reading-graph')?.getAttribute('data-motion')).toBe('off')
    expect(byLabel<HTMLButtonElement>('Graph uses reduced motion').disabled).toBe(true)
    expect(queued.size).toBe(0)
    expect(host.querySelector('.reading-graph-edge-trace')).toBeNull()
    await act(async () => root.unmount()); root = createRoot(host)
    expect(queued.size).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })
})
