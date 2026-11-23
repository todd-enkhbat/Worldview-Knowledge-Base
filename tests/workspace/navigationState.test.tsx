// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { TextEncoder as NodeTextEncoder } from 'node:util'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App.tsx'
import { useApp, useWorld } from '../../src/app/store.ts'
import { resetChat, setCloudAiStatus, useChat } from '../../src/ai/chat/session.ts'
import { WORLD_KV_KEYS } from '../../src/data/archive.ts'
import { useAuth } from '../../src/data/auth.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, getWorldGeneration, handleRemoteChange, initRepo } from '../../src/data/repo.ts'
import { captureThought, importKnowledgeFiles, initializeKnowledge, resetKnowledge, useKnowledge } from '../../src/knowledge/index.ts'
import Workbench from '../../src/workspace/Workbench.tsx'
import { flushWorkspacePersistence } from '../../src/workspace/persistence.ts'
import { restoreWorkspaceContext, useWorkspace, type WorkspaceSection } from '../../src/workspace/state.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
let store: ReturnType<typeof createMemoryStore>
let fetcher: ReturnType<typeof vi.fn>

function type(element: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, text)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function key(element: EventTarget, value: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options })
  act(() => { element.dispatchEvent(event) })
  return event
}
function byLabel<T extends HTMLElement = HTMLButtonElement>(label: string): T {
  const element = host.querySelector<T>(`[aria-label="${label}"]`)
  if (!element) throw new Error(`Missing control: ${label}`)
  return element
}
async function render(section: WorkspaceSection, hash = `#/${section}`) {
  history.replaceState(null, '', `/${hash}`)
  await act(async () => root.render(<Workbench section={section} hash={location.hash} />))
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
const saveButton = () => host.querySelector<HTMLButtonElement>('.knowledge-save-thought')!
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check() && Date.now() < deadline) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  expect(check(), host.textContent ?? 'Workspace did not render').toBe(true)
}

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('TextEncoder', class extends NodeTextEncoder { override encode(value?: string) { return new Uint8Array(super.encode(value)) } })
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(prefers-color-scheme: dark)', media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  fetcher = vi.fn(async (url: string) => {
    if (url === '/api/ai/status') return new Response(JSON.stringify({ provider: null, configured: false }), { status: 200 })
    throw new Error(`Unexpected network request: ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  localStorage.clear()
  restoreWorkspaceContext()
  resetKnowledge()
  useAuth.setState({ state: 'none', user: null })
  for (const panel of Object.keys(useApp.getState().panels) as (keyof ReturnType<typeof useApp.getState>['panels'])[]) useApp.getState().togglePanel(panel, false)
  useApp.getState().closeEditor()
  store = createMemoryStore()
  await initRepo({ store })
  await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  await initializeKnowledge()
  resetChat()
  setCloudAiStatus({ provider: null, configured: false })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  await flushWorkspacePersistence()
  host.remove()
  await closeRepo()
  resetKnowledge()
  useWorld.getState().hydrate(null, [])
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('workspace navigation and local capture', () => {
  it('keeps the filtered Library and its scroll position when returning from Today', async () => {
    await captureThought('Aurora architecture decision')
    await captureThought('Garden planting notes')
    await render('library')
    const filter = host.querySelector<HTMLInputElement>('#library-filter')!
    const panel = host.querySelector<HTMLDivElement>('[data-section="library"]')!
    type(filter, 'aurora')
    expect(panel.querySelectorAll('.knowledge-library-item')).toHaveLength(1)
    act(() => { panel.scrollTop = 180; panel.dispatchEvent(new Event('scroll', { bubbles: true })) })
    await render('today')
    expect(panel.style.display).toBe('none')
    // A browser can reset scroll when display:none removes content from layout.
    // Returning should restore the last visible position even in that case.
    panel.scrollTop = 0
    await render('library')
    expect(host.querySelector('#library-filter')).toBe(filter)
    expect(host.querySelector('[data-section="library"]')).toBe(panel)
    expect(filter.value).toBe('aurora')
    expect(panel.querySelectorAll('.knowledge-library-item')).toHaveLength(1)
    expect(panel.scrollTop).toBe(180)
    expect(panel.style.display).not.toBe('none')
  })

  it.each([{ metaKey: true }, { ctrlKey: true }])('saves a thought once with the platform shortcut %j, without an API', async (modifier) => {
    await render('today')
    const textarea = host.querySelector<HTMLTextAreaElement>('#knowledge-thought')!
    type(textarea, 'This decision should stay readable on my own device.')
    key(textarea, 'Enter', { ...modifier, isComposing: true })
    expect(useWorld.getState().nodes.size).toBe(0)
    expect(key(textarea, 'Enter', modifier).defaultPrevented).toBe(true)
    await until(() => useWorld.getState().nodes.size === 1 && useWorkspace.getState().draft === '')
    key(textarea, 'Enter', { ...modifier, repeat: true })
    expect(await store.listNodes()).toHaveLength(1)
    expect([...useWorld.getState().nodes.values()][0].contentMd).toBe('This decision should stay readable on my own device.')
    expect(document.activeElement).toBe(textarea)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('retains a newer draft typed while an earlier thought is saving', async () => {
    await render('today')
    const textarea = host.querySelector<HTMLTextAreaElement>('#knowledge-thought')!
    const release = deferred()
    let entered = false
    const putBlob = store.putBlob.bind(store)
    vi.spyOn(store, 'putBlob').mockImplementationOnce(async (blob) => { entered = true; await release.promise; return putBlob(blob) })
    try {
      type(textarea, 'The first thought is being saved.')
      act(() => saveButton().click())
      await until(() => entered)
      expect(saveButton().disabled).toBe(true)
      type(textarea, 'A newer thought I started while waiting.')
      await act(async () => release.resolve())
      await until(() => saveButton().textContent?.includes('Save thought') === true)
      expect(await store.listNodes()).toHaveLength(1)
      expect([...useWorld.getState().nodes.values()][0].contentMd).toBe('The first thought is being saved.')
      expect(textarea.value).toBe('A newer thought I started while waiting.')
      expect(useWorkspace.getState().draft).toBe(textarea.value)
      expect(fetcher).not.toHaveBeenCalled()
    } finally { release.resolve() }
  })

  it.each(['different wording', 'same wording'])('does not apply an older save completion to a replaced world generation with %s', async (wording) => {
    await render('today')
    const textarea = host.querySelector<HTMLTextAreaElement>('#knowledge-thought')!
    const release = deferred()
    let entered = false
    const commit = store.commitKnowledge!.bind(store)
    vi.spyOn(store, 'commitKnowledge').mockImplementation(async (delta, options) => {
      const result = await commit(delta, options)
      // Pause after the final projected source is committed, while its successful
      // UI completion is still pending. This is not a rejected-storage test.
      if (!entered && delta.upserts.sources?.some((source) => source.kind === 'thought' && source.pendingProjection === false)) {
        entered = true
        await release.promise
      }
      return result
    })
    try {
      const submitted = 'A thought from the previous world generation.'
      type(textarea, submitted)
      act(() => saveButton().click())
      await until(() => entered)
      const generation = getWorldGeneration()
      await act(async () => handleRemoteChange({ type: 'import' }))
      expect(getWorldGeneration()).toBeGreaterThan(generation)
      const replacementComposer = host.querySelector<HTMLTextAreaElement>('#knowledge-thought')!
      const replacementDraft = wording === 'same wording' ? submitted : 'The replacement world has a different draft.'
      // Equal text can still belong to a newly entered draft in a different world.
      type(replacementComposer, '')
      type(replacementComposer, replacementDraft)
      act(() => useWorkspace.setState({ selectedRecordId: 'replacement-selection' }))
      await act(async () => release.resolve())
      await until(() => !saveButton().disabled)
      expect(useWorkspace.getState().draft).toBe(replacementDraft)
      expect(replacementComposer.value).toBe(replacementDraft)
      expect(useWorkspace.getState().selectedRecordId).toBe('replacement-selection')
      expect(host.querySelector('.knowledge-saved')).toBeNull()
    } finally { release.resolve() }
  })

  it('keeps an older retained source version selected after leaving and returning to Library', async () => {
    const original = 'The original plan kept the evidence ledger on this device.'
    const revision = 'The revised plan adds a verified archive before every restore.'
    await importKnowledgeFiles([new NodeFile([original], 'decision.md', { type: 'text/markdown' }) as unknown as File])
    const older = useKnowledge.getState().versions[0]
    await importKnowledgeFiles([new NodeFile([revision], 'decision.md', { type: 'text/markdown' }) as unknown as File])
    const source = useKnowledge.getState().sources[0]
    expect(useKnowledge.getState().versions).toHaveLength(2)
    const hash = `#/library?source=${source.id}`
    await render('library', hash)
    const select = byLabel<HTMLSelectElement>('Source version')
    expect(host.querySelector('.knowledge-prose')?.textContent).toContain(revision)
    act(() => { select.value = older.id; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(host.querySelector('.knowledge-prose')?.textContent).toContain(original)
    await render('today')
    await render('library', hash)
    expect(byLabel<HTMLSelectElement>('Source version').value).toBe(older.id)
    expect(host.querySelector('.knowledge-prose')?.textContent).toContain(original)
    expect(host.querySelector('.knowledge-prose')?.textContent).not.toContain(revision)
    expect(host.querySelector('.knowledge-reader')?.textContent).toContain('earlier retained source version')
  })

  it('routes a capture intent from Library and focuses the visible Today composer', async () => {
    await render('library')
    const filter = host.querySelector<HTMLInputElement>('#library-filter')!
    act(() => { filter.focus(); window.dispatchEvent(new CustomEvent('worldview:capture')) })
    expect(location.hash).toBe('#/today')
    await render('today')
    const textarea = host.querySelector<HTMLTextAreaElement>('#knowledge-thought')!
    await until(() => document.activeElement === textarea)
    expect(textarea.closest<HTMLElement>('[data-section="today"]')?.style.display).not.toBe('none')
    expect(host.querySelector('[data-section="library"]')?.getAttribute('style')).toContain('display: none')
  })

  it('remembers sidebar and appearance on this device without changing the portable world', async () => {
    await render('today')
    await flushWorkspacePersistence()
    const before = await store.readWorldSnapshot!(WORLD_KV_KEYS)
    act(() => byLabel('Collapse sidebar').click())
    const select = byLabel<HTMLSelectElement>('Appearance')
    act(() => { select.value = 'light'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(host.querySelector('.knowledge-workbench')?.classList.contains('is-nav-collapsed')).toBe(true)
    expect(host.querySelector('.knowledge-workbench')?.getAttribute('data-theme')).toBe('light')
    expect(document.body.dataset.workspaceTheme).toBe('light')
    await act(async () => root.unmount())
    root = createRoot(host)
    await render('today')
    expect(byLabel('Expand sidebar').getAttribute('aria-expanded')).toBe('false')
    expect(byLabel<HTMLSelectElement>('Appearance').value).toBe('light')
    expect(host.querySelector('.knowledge-workbench')?.getAttribute('data-theme')).toBe('light')
    await flushWorkspacePersistence()
    expect(await store.readWorldSnapshot!(WORLD_KV_KEYS)).toEqual(before)
    expect(await store.getKv('worldview.appearance.v1')).toBeUndefined()
    expect(await store.getKv('worldview.sidebar.v1')).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('shows full mobile navigation despite a collapsed desktop preference and focuses New thought after closing it', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(max-width: 760px)' || query === '(prefers-color-scheme: dark)', media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    localStorage.setItem('worldview.sidebar.v1', 'collapsed')
    await render('today')
    const textarea = host.querySelector<HTMLTextAreaElement>('#knowledge-thought')!
    act(() => byLabel('Open navigation').click())
    expect(byLabel('Workspace navigation').getAttribute('role')).toBe('dialog')
    expect(host.querySelector('.knowledge-workbench')?.classList.contains('is-nav-collapsed')).toBe(false)
    expect(byLabel('Capture a thought').textContent).toContain('New thought')
    expect(host.querySelector('.knowledge-center')?.hasAttribute('inert')).toBe(true)
    act(() => byLabel('Capture a thought').click())
    await until(() => document.activeElement === textarea)
    expect(host.querySelector('.knowledge-center')?.hasAttribute('inert')).toBe(false)
    expect(byLabel('Workspace navigation').getAttribute('aria-modal')).toBeNull()
    expect(localStorage.getItem('worldview.sidebar.v1')).toBe('collapsed')
  })

  it('offers local capture instead of paid-AI actions when cloud AI is disabled', async () => {
    await render('search')
    expect(host.querySelector('.knowledge-search-investigation-actions')?.textContent).not.toContain('Ask about these sources')
    expect(host.querySelector('[aria-label="Open AI companion"]')).toBeNull()
    act(() => byLabel('Open quick capture').click())
    await until(() => host.querySelector('section[aria-label="Quick capture"]') !== null && useChat.getState().cloudAi === 'disabled')
    const capture = host.querySelector('section[aria-label="Quick capture"]')!
    expect(capture.textContent).toContain('Save to world')
    expect(capture.textContent).toContain('Cloud AI off')
    expect(capture.querySelector('[aria-label="Send to AI"]')).toBeNull()
    expect(capture.textContent).not.toContain('Find connections')
    expect(capture.textContent).not.toContain('Meet your agents')
    expect(fetcher.mock.calls.every(([url]) => url === '/api/ai/status')).toBe(true)
  })

  it('keeps the real App shell across hash navigation and replaces it for another account', async () => {
    history.replaceState(null, '', '/#/library')
    await act(async () => root.render(<App />))
    await until(() => host.querySelector('#library-filter') !== null)
    const shell = host.querySelector('.knowledge-workbench')
    const navigation = byLabel('Workspace navigation')
    const filter = host.querySelector<HTMLInputElement>('#library-filter')!
    type(filter, 'kept investigation')
    async function navigate(section: WorkspaceSection) {
      await act(async () => {
        history.replaceState(null, '', `/#/${section}`)
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      })
    }
    await navigate('today')
    expect(host.querySelector('.knowledge-top h1')?.textContent).toBe('Today')
    await navigate('library')
    expect(host.querySelector('.knowledge-top h1')?.textContent).toBe('Library')
    expect(host.querySelector('.knowledge-workbench')).toBe(shell)
    expect(byLabel('Workspace navigation')).toBe(navigation)
    expect(host.querySelector('#library-filter')).toBe(filter)
    expect(filter.value).toBe('kept investigation')
    expect(host.querySelector('canvas')).toBeNull()
    await act(async () => useAuth.setState({ state: 'signed-in', user: { id: 'another-account', email: 'other@example.invalid' } }))
    expect(host.querySelector('.knowledge-workbench')).not.toBe(shell)
    expect(filter.isConnected).toBe(false)
    expect(host.querySelector<HTMLInputElement>('#library-filter')?.value).toBe('')
  })
})
