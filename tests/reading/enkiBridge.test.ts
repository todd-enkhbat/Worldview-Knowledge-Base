import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { createEnkiBridge } from '../../extensions/worldview-reader/enki-bridge.js'
import { extractArticle, extractProfile, extractVisiblePeople } from '../../extensions/worldview-reader/extract.js'
import { ReaderBridge } from '../../server/readerBridge.ts'
const { JSDOM } = createRequire(import.meta.url)('jsdom')

afterEach(() => vi.unstubAllGlobals())

it('reads the selected browser document through the broker, rejects drift, and saves only on an explicit action', async () => {
  const broker = new ReaderBridge(), local: Record<string, unknown> = { enkiPendingAt: Date.now() }, writes: unknown[] = []
  let form = { answers: [] as { question: string; answer: string }[], embeddedForms: [] }
  const readFormFixture = () => ({ answers: [], embeddedForms: [] })
  const tab = { id: 17, url: 'https://example.org/essay', active: true }, doc = { id: 'document-one' }
  const dom = new JSDOM('<title>Field notes</title><main><h1>Field notes</h1><p>An article about the copper orchard and its collection of field observations.</p></main>', { url: tab.url, runScripts: 'outside-only' })
  const get = vi.fn(async (key: string) => ({ [key]: local[key] }))
  const chrome = {
    storage: { local: { get, set: async (value: Record<string, unknown>) => Object.assign(local, value), remove: async (key: string) => { delete local[key] } } },
    tabs: { query: vi.fn(async () => [tab]) },
    permissions: { contains: vi.fn(async () => true), onRemoved: { addListener() {} }, onAdded: { addListener() {} } },
    runtime: { onStartup: { addListener() {} } },
    alarms: { create: vi.fn(async () => {}), clear: vi.fn(async () => {}), onAlarm: { addListener() {} } },
    scripting: { executeScript: vi.fn(async ({ target, func, args = [] }: { target: { documentIds?: string[] }; func: (...args: unknown[]) => unknown; args?: unknown[] }) => {
      if (target.documentIds && !target.documentIds.includes(doc.id)) throw Error('Document changed')
      dom.window.TextEncoder = TextEncoder
      const fn = dom.window.eval('(' + func.toString() + ')')
      return [{ documentId: doc.id, frameId: 0, result: func.name === 'readFormFixture' ? form : await fn(...args) }]
    }), getRegisteredContentScripts: vi.fn(async () => []), registerContentScripts: vi.fn(async () => {}), unregisterContentScripts: vi.fn(async () => {}) },
  }
  vi.stubGlobal('chrome', chrome)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const input = JSON.parse(String(init.body))
    if (url.endsWith('/poll')) return Response.json({ command: await broker.poll('dia', init.signal!) })
    if (url.endsWith('/reply')) return Response.json(broker.reply('dia', input))
    if (url.endsWith('/summon')) return Response.json(broker.summon('dia', input.ref))
    broker.disconnect('dia'); return Response.json({ ok: true })
  }))
  const bridge = createEnkiBridge({
    pairing: async () => ({ port: 5173, token: 'test-pairing' }), endpoint: (_port: number, path: string) => 'http://127.0.0.1/' + path,
    extractArticle, extractProfile, extractVisiblePeople,
    readApplicationForm: readFormFixture,
    readExperience: async () => '', readEmbeddedApplicationForms: async () => [],
    enqueue: async (value: unknown) => { writes.push(value); return { sourceId: 'saved-article' } },
    serial: <T>(fn: () => Promise<T>) => fn(),
  })
  try {
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(local.enkiEnabled).toBe(true)
    expect(local.enkiPendingAt).toBeUndefined()
    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledWith([expect.objectContaining({ js: ['enki-shortcut.js'], allFrames: true })])
    const summoned = broker.waitForSummon(new AbortController().signal)
    await bridge.summon({ frameId: 0, documentId: doc.id, tab: { id: tab.id } })
    expect(await summoned).toMatchObject({ client: 'dia', ref: { id: String(tab.id), documentId: doc.id, url: tab.url } })
    const page = await broker.request('page', {}) as { client: string; value: { title: string; ref: Record<string, unknown>; kind: string } }
    expect(page.value).toMatchObject({ title: 'Field notes', url: tab.url, kind: 'article', ref: { id: '17', documentId: doc.id } })
    expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true })
    expect(writes).toEqual([])
    const saved = await broker.request('save-page', { ref: page.value.ref }, page.client)
    expect(saved.value).toEqual({ sourceId: 'saved-article' })
    expect(writes).toMatchObject([{ url: tab.url, title: 'Field notes', text: expect.stringContaining('copper orchard') }])
    form = { answers: [{ question: 'Volume', answer: '2' }], embeddedForms: [] }
    expect((await broker.request('page', {}, page.client)).value).toMatchObject({ kind: 'article' })
    dom.window.document.title = 'Research fellowship application'
    expect((await broker.request('page', {}, page.client)).value).toMatchObject({ kind: 'application' })
    doc.id = 'reloaded-document'
    await expect(broker.request('profile', { ref: page.value.ref }, page.client)).rejects.toThrow('reloaded')
    tab.url = 'https://example.org/another-page'
    await expect(broker.request('save-page', { ref: page.value.ref }, page.client)).rejects.toThrow('page changed')
    expect(writes).toHaveLength(1)
  } finally { await bridge.configure(false); dom.window.close() }
})
