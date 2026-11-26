import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { expect, it, vi } from 'vitest'

const article = { url: 'https://example.com/article', title: 'Synthetic article', text: 'An exact synthetic article.' }
const token = `wvread_${'a'.repeat(43)}`
function area() {
  const values: Record<string, unknown> = {}
  return { values, setAccessLevel: vi.fn(async () => {}), get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in values).map((key) => [key, structuredClone(values[key])])), set: async (next: Record<string, unknown>) => { Object.assign(values, structuredClone(next)) }, remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key] } }
}

it('limits permissions to explicit tabs plus local service access and queues offline captures without leaking tokens to content scripts', async () => {
  const manifest = JSON.parse(readFileSync('extensions/worldview-reader/manifest.json', 'utf8'))
  expect(manifest.permissions).toEqual(['activeTab', 'scripting', 'storage', 'alarms'])
  expect(manifest.content_scripts).toBeUndefined(); expect(manifest.externally_connectable).toBeUndefined()
  expect(manifest.host_permissions).toEqual(['http://localhost/*', 'http://127.0.0.1/*'])
  const local = area(), session = area(), listeners: Record<string, (...args: unknown[]) => unknown> = {}
  const extensionId = 'a'.repeat(32), popup = `chrome-extension://${extensionId}/popup.html`
  const alarms = { get: vi.fn(async () => null), clear: vi.fn(async () => true), create: vi.fn(async () => {}), onAlarm: { addListener: (callback: (...args: unknown[]) => unknown) => { listeners.alarm = callback } } }
  const chrome = { alarms, storage: { local, session }, runtime: { id: extensionId, getURL: (path: string) => `chrome-extension://${extensionId}/${path}`, onMessage: { addListener: (callback: (...args: unknown[]) => unknown) => { listeners.message = callback } } }, action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) }, tabs: { get: async () => ({ active: true, url: article.url }), sendMessage: vi.fn(async () => ({ ok: true })), onRemoved: { addListener: (callback: (...args: unknown[]) => unknown) => { listeners.removed = callback } }, onUpdated: { addListener: (callback: (...args: unknown[]) => unknown) => { listeners.updated = callback } } }, scripting: { executeScript: vi.fn(async () => [{ result: article }]) } }
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('Local service is offline') })
  const script = readFileSync('extensions/worldview-reader/background.js', 'utf8').replace(/^import .*$/m, 'const extractArticle = () => {}; const extractFolkPhotos = () => {}; const extractProfile = () => {}')
  expect(script).not.toMatch(/^await /m)
  new Script(script).runInContext(createContext({ chrome, fetch: fetcher, AbortSignal, crypto, URL, TextEncoder, structuredClone, console }))
  const send = (message: Record<string, unknown>, sender: Record<string, unknown> = { id: extensionId, url: popup }) => new Promise<Record<string, unknown>>((resolve) => listeners.message(message, sender, resolve))
  expect(local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' })
  expect(await send({ type: 'reader-pair', token, port: 80 })).toMatchObject({ ok: false })
  expect(await send({ type: 'reader-pair', token, port: 5174 })).toMatchObject({ ok: true })
  expect(await send({ type: 'reader-follow', tabId: 7 })).toMatchObject({ ok: true, result: { queued: true } })
  const tracked = (session.values.tracked as Record<number, { nonce: string }>)[7]
  const progress = { type: 'reading-progress', nonce: tracked.nonce, url: article.url, progress: { fraction: .3, position: 120, activeMs: 15000, following: true } }
  expect(await send(progress, { id: extensionId, url: article.url, tab: { id: 7 } })).toMatchObject({ ok: true, result: { queued: true } })
  expect(local.values.outbox).toMatchObject([{ text: article.text }, { progress: { activeMs: 15000 } }])
  const sequences = (local.values.outbox as { sequence: number }[]).map((entry) => entry.sequence)
  expect(sequences[1]).toBeGreaterThan(sequences[0])
  expect(await send({ ...progress, nonce: 'forged' }, { id: extensionId, url: article.url, tab: { id: 7 } })).toMatchObject({ ok: false })
  expect(local.values.outbox).toHaveLength(2)
  fetcher.mockImplementation(async (_url, options) => { const payload = JSON.parse(String(options?.body)); return new Response(JSON.stringify({ sourceId: 'source', versionId: 'version', sequence: payload.sequence })) })
  expect(alarms.create).toHaveBeenCalledWith('worldview-pending-captures', { delayInMinutes: 1, periodInMinutes: 1 })
  listeners.alarm({ name: 'worldview-pending-captures' })
  await send({ type: 'reader-status' })
  expect(fetcher.mock.calls.every(([address]) => String(address).startsWith('http://127.0.0.1:5174/'))).toBe(true)
  expect(local.values.outbox).toEqual([])
  const responsesToContent = await send(progress, { id: extensionId, url: article.url, tab: { id: 7 } })
  expect(JSON.stringify(responsesToContent)).not.toContain(token)
  const beforeDrift = fetcher.mock.calls.length
  expect(await send(progress, { id: extensionId, url: 'https://example.com/another-article', tab: { id: 7 } })).toMatchObject({ ok: false })
  expect(fetcher.mock.calls).toHaveLength(beforeDrift); expect(session.values.tracked).toEqual({})
  await send({ type: 'reader-follow', tabId: 7 })
  listeners.updated(7, { url: 'https://example.com/another-article' })
  await send({ type: 'reader-status' })
  expect(session.values.tracked).toEqual({})
})

it('measures dwell only after explicit following while the chosen document is visible and focused', async () => {
  let now = 0, listener: (message: Record<string, unknown>, sender: unknown, response: (value: unknown) => void) => void = () => {}
  const intervals = new Map<number, () => void>(), events = new Map<string, () => void>()
  const document = { visibilityState: 'visible', hasFocus: () => focused, documentElement: { scrollHeight: 1000 }, addEventListener: (name: string, callback: () => void) => events.set(name, callback) }
  let focused = true
  const sendMessage = vi.fn(async () => ({ ok: true }))
  const chrome = { runtime: { sendMessage, onMessage: { addListener: (callback: typeof listener) => { listener = callback } } } }
  const context = createContext({ chrome, document, performance: { now: () => now }, location: { href: article.url }, innerHeight: 500, scrollY: 100, setInterval: (callback: () => void, delay: number) => { intervals.set(delay, callback); return delay }, clearInterval: (delay: number) => intervals.delete(delay), addEventListener: (name: string, callback: () => void) => events.set(name, callback), console })
  const content = readFileSync('extensions/worldview-reader/content.js', 'utf8')
  new Script(content).runInContext(context)
  expect(intervals.size).toBe(0)
  expect(sendMessage).not.toHaveBeenCalled()
  listener({ type: 'reading-start', nonce: 'chosen-tab' }, null, () => {})
  for (let count = 0; count < 5; count++) { now += 1000; intervals.get(1000)!() }
  focused = false
  for (let count = 0; count < 5; count++) { now += 1000; intervals.get(1000)!() }
  focused = true; document.visibilityState = 'hidden'
  for (let count = 0; count < 5; count++) { now += 1000; intervals.get(1000)!() }
  document.visibilityState = 'visible'; intervals.get(15000)!(); await Promise.resolve(); await Promise.resolve()
  expect(sendMessage).toHaveBeenCalledOnce()
  expect(sendMessage.mock.calls[0]).toMatchObject([{ type: 'reading-progress', nonce: 'chosen-tab', progress: { activeMs: 5000, fraction: .2 } }])
  let stopped: unknown
  listener({ type: 'reading-stop' }, null, (value) => { stopped = value })
  expect(stopped).toMatchObject({ progress: { following: false, activeMs: 0 } })
  expect(intervals.size).toBe(0)
  listener({ type: 'reading-start', nonce: 'before-bfcache' }, null, () => {})
  events.get('pagehide')!()
  expect(intervals.size).toBe(0)
  // BFCache retains this script's globals and listeners. Explicit Follow must restart its timers.
  new Script(content).runInContext(context)
  listener({ type: 'reading-start', nonce: 'after-bfcache' }, null, () => {})
  expect(intervals.size).toBe(2)
  now += 1000; intervals.get(1000)!(); intervals.get(15000)!(); await Promise.resolve()
  expect(sendMessage.mock.calls.at(-1)).toMatchObject([{ nonce: 'after-bfcache', progress: { activeMs: 1000 } }])
})

it('stops a followed SPA document without attributing the newly navigated page geometry to the old article', async () => {
  let now = 0, listener: (message: Record<string, unknown>, sender: unknown, respond: (value: unknown) => void) => void = () => {}
  const intervals = new Map<number, () => void>(), location = { href: article.url }
  const document = { visibilityState: 'visible', hasFocus: () => true, documentElement: { scrollHeight: 1000 }, addEventListener: vi.fn() }
  const sendMessage = vi.fn(async () => ({ ok: true }))
  const context = createContext({ document, location, performance: { now: () => now }, innerHeight: 500, scrollY: 100, chrome: { runtime: { sendMessage, onMessage: { addListener: (callback: typeof listener) => { listener = callback } } } }, setInterval: (callback: () => void, delay: number) => { intervals.set(delay, callback); return delay }, clearInterval: (delay: number) => intervals.delete(delay), addEventListener: vi.fn() })
  new Script(readFileSync('extensions/worldview-reader/content.js', 'utf8')).runInContext(context)
  listener({ type: 'reading-start', nonce: 'original-document' }, null, () => {})
  now = 1000; intervals.get(1000)!()
  location.href = 'https://example.com/new-article'; context.scrollY = 900; document.documentElement.scrollHeight = 2000
  now = 2000; intervals.get(1000)!(); await Promise.resolve()
  expect(intervals.size).toBe(0)
  expect(sendMessage).toHaveBeenCalledOnce()
  expect(sendMessage.mock.calls[0]).toMatchObject([{ type: 'reading-navigation', url: article.url, progress: { fraction: .2, position: 100, activeMs: 0, following: false } }])
})

it('claims an approved connection without exposing its handoff secret or bearer to the popup status or content scripts', async () => {
  const local = area(), session = area(), extensionId = 'a'.repeat(32), popup = `chrome-extension://${extensionId}/popup.html`
  let listener: (message: Record<string, unknown>, sender: Record<string, unknown>, respond: (value: Record<string, unknown>) => void) => void = () => {}, approved = false
  const chrome = { storage: { local, session }, runtime: { id: extensionId, getURL: (path: string) => `chrome-extension://${extensionId}/${path}`, onMessage: { addListener: (callback: typeof listener) => { listener = callback } } }, action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) }, tabs: { onRemoved: { addListener: vi.fn() }, onUpdated: { addListener: vi.fn() } } }
  const secret = `wvconnect_${'b'.repeat(43)}`
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    if (String(url).endsWith('/connect')) return Response.json({ requestId: 'test-request', secret, expiresAt: Date.now() + 60_000 }, { status: 201 })
    expect(options?.headers).toMatchObject({ authorization: `Bearer ${secret}` })
    expect(options?.method).toBe('POST'); expect(options?.headers).toMatchObject({ 'content-type': 'application/json' }); const body = JSON.parse(String(options?.body)); return body.action === 'acknowledge' ? Response.json({ connected: true }) : Response.json(approved ? { connected: true, token } : { connected: false })
  })
  const script = readFileSync('extensions/worldview-reader/background.js', 'utf8').replace(/^import .*$/m, 'const extractArticle = () => {}; const extractFolkPhotos = () => {}; const extractProfile = () => {}')
  new Script(script).runInContext(createContext({ chrome, fetch: fetcher, AbortSignal, crypto, URL, TextEncoder, structuredClone, console }))
  const send = (message: Record<string, unknown>, sender = { id: extensionId, url: popup }) => new Promise<Record<string, unknown>>((resolve) => listener(message, sender, resolve))
  expect(await send({ type: 'reader-connect' })).toMatchObject({ ok: true, openUrl: 'http://127.0.0.1:5173/#/sources?connection=browser' })
  expect(local.values.pairing).toBeUndefined()
  expect(await send({ type: 'reader-status' })).toMatchObject({ paired: false, pendingConnection: true })
  approved = true
  const status = await send({ type: 'reader-status' })
  expect(status).toMatchObject({ paired: true, pendingConnection: false })
  expect(local.values.pairing).toEqual({ token, port: 5173 }); expect(local.values.pendingConnection).toBeUndefined()
  expect(JSON.stringify(status)).not.toContain(token); expect(JSON.stringify(status)).not.toContain(secret)
  await local.set({ outbox: [{ sequence: 10, title: 'Broken quote', url: article.url }, { sequence: 11, title: 'Retained next capture', url: article.url }] })
  expect(await send({ type: 'reader-discard-one', sequence: 10 })).toMatchObject({ ok: true })
  expect(local.values.outbox).toEqual([{ sequence: 11, title: 'Retained next capture', url: article.url }])
  const forged = await send({ type: 'reader-discard-one', sequence: 11 }, { id: extensionId, url: article.url, tab: { id: 7 } } as { id: string; url: string })
  expect(forged).toMatchObject({ ok: false }); expect(local.values.outbox).toHaveLength(1)
})
