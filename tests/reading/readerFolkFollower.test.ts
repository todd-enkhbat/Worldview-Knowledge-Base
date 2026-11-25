import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { expect, it, vi } from 'vitest'

function fixture() {
  const events = new Map<string, () => void>(), intervals = new Map<number, () => void>(), timeouts = new Map<number, () => void>()
  let listener: (message: Record<string, unknown>, sender: unknown, respond: (reply: unknown) => void) => void = () => {}, observerCallback = () => {}, focused = true
  const sendMessage = vi.fn(async (_message: Record<string, unknown>) => ({ ok: true })), disconnect = vi.fn(), observe = vi.fn()
  const location = { href: 'https://app.folk.app/apps/contacts/network/11111111-1111-1111-1111-111111111111/groups/22222222-2222-2222-2222-222222222222' }
  const document = { visibilityState: 'visible', hasFocus: () => focused, documentElement: {}, addEventListener: (name: string, callback: () => void) => events.set(name, callback), removeEventListener: (name: string) => events.delete(name) }
  const context = createContext({ document, location, chrome: { runtime: { sendMessage, onMessage: { addListener: (callback: typeof listener) => { listener = callback } } } }, MutationObserver: class { constructor(callback: () => void) { observerCallback = callback } observe = observe; disconnect = disconnect }, setInterval: (callback: () => void, delay: number) => { intervals.set(delay, callback); return delay }, clearInterval: (delay: number) => intervals.delete(delay), setTimeout: (callback: () => void, delay: number) => { timeouts.set(delay, callback); return delay }, clearTimeout: (delay: number) => timeouts.delete(delay), addEventListener: (name: string, callback: () => void) => events.set(name, callback) })
  new Script(readFileSync('extensions/worldview-reader/folk-content.js', 'utf8')).runInContext(context)
  const message = (value: Record<string, unknown>) => { let reply: unknown; listener(value, null, value => { reply = value }); return reply }
  const flush = async () => { const callback = timeouts.get(1200); timeouts.delete(1200); callback?.(); for (let i = 0; i < 5; i++) await Promise.resolve() }
  return { events, intervals, timeouts, sendMessage, observe, disconnect, document, location, message, flush, mutation: () => observerCallback(), focus: (value: boolean) => { focused = value } }
}

it('observes no page until an explicit start, coalesces visible scroll/DOM/image-load changes, and cleans up on Stop', async () => {
  const f = fixture(); expect(f.intervals.size).toBe(0); expect(f.sendMessage).not.toHaveBeenCalled(); expect(f.observe).not.toHaveBeenCalled()
  f.message({ type: 'folk-photos-start', nonce: 'explicit-group' }); expect(f.observe).toHaveBeenCalledOnce()
  f.events.get('scroll')!(); f.mutation(); f.events.get('load')!(); expect(f.timeouts.size).toBe(1)
  await f.flush(); expect(f.sendMessage).toHaveBeenCalledOnce(); expect(f.sendMessage).toHaveBeenLastCalledWith({ type: 'folk-photos-changed', nonce: 'explicit-group', url: f.location.href })
  f.document.visibilityState = 'hidden'; f.events.get('scroll')!(); await f.flush(); expect(f.sendMessage).toHaveBeenCalledOnce()
  f.document.visibilityState = 'visible'; f.focus(false); f.intervals.get(2000)!(); await f.flush(); expect(f.sendMessage).toHaveBeenCalledOnce()
  f.focus(true); f.intervals.get(2000)!(); await f.flush(); expect(f.sendMessage).toHaveBeenCalledTimes(2)
  f.message({ type: 'folk-photos-stop' }); expect(f.intervals.size).toBe(0); expect(f.timeouts.size).toBe(0); expect(f.events.has('scroll')).toBe(false); expect(f.events.has('load')).toBe(false)
})

it('stops on SPA navigation or a rejected receiver without extracting or transmitting page data itself', async () => {
  const f = fixture(); f.message({ type: 'folk-photos-start', nonce: 'original-group' }); const originalUrl = f.location.href
  f.location.href += '/people/other-person'; f.intervals.get(2000)!(); await f.flush()
  expect(f.sendMessage).toHaveBeenLastCalledWith({ type: 'folk-photos-navigation', nonce: 'original-group', url: originalUrl }); expect(f.intervals.size).toBe(0)
  f.message({ type: 'folk-photos-start', nonce: 'restart-explicit' }); f.sendMessage.mockResolvedValueOnce({ ok: false }); f.mutation(); await f.flush()
  expect(f.intervals.size).toBe(0); expect(f.events.has('scroll')).toBe(false)
  expect(f.sendMessage).toHaveBeenLastCalledWith({ type: 'folk-photos-stopped', nonce: 'restart-explicit', url: f.location.href, reason: 'The worker did not confirm this observer.' })
  expect(f.sendMessage.mock.calls.every(call => !JSON.stringify(call).includes('photoUrl'))).toBe(true)
})

it('answers nonce-bound observer heartbeats so worker state can distinguish active and locally stopped observers', () => {
  const f = fixture(); expect(f.message({ type: 'folk-photos-status', nonce: 'chosen' })).toMatchObject({ ok: true, following: false })
  f.message({ type: 'folk-photos-start', nonce: 'chosen' }); expect(f.message({ type: 'folk-photos-status', nonce: 'chosen' })).toEqual({ ok: true, following: true, nonce: 'chosen', url: f.location.href })
  expect(f.message({ type: 'folk-photos-status', nonce: 'other' })).toMatchObject({ following: false })
  f.message({ type: 'folk-photos-stop' }); expect(f.message({ type: 'folk-photos-status', nonce: 'chosen' })).toMatchObject({ following: false, nonce: '' })
})

it('notifies the worker when its connection fails instead of leaving a falsely live PH state', async () => {
  const f = fixture(); f.message({ type: 'folk-photos-start', nonce: 'chosen' }); f.sendMessage.mockRejectedValueOnce(new Error('Port closed'))
  f.mutation(); await f.flush(); expect(f.intervals.size).toBe(0)
  expect(f.sendMessage).toHaveBeenLastCalledWith({ type: 'folk-photos-stopped', nonce: 'chosen', url: f.location.href, reason: 'The observer lost its extension connection.' })
  expect(f.message({ type: 'folk-photos-status', nonce: 'chosen' })).toMatchObject({ following: false })
})

it('retains a paused change for retry when the chosen tab regains focus', async () => {
  const f = fixture(); f.message({ type: 'folk-photos-start', nonce: 'chosen' }); f.sendMessage.mockResolvedValueOnce({ ok: true, result: { paused: true } } as never)
  f.mutation(); await f.flush(); expect(f.intervals.size).toBe(1); expect(f.timeouts.size).toBe(1)
  f.focus(false); await f.flush(); expect(f.sendMessage).toHaveBeenCalledOnce()
  f.focus(true); f.intervals.get(2000)!(); await f.flush(); expect(f.sendMessage).toHaveBeenCalledTimes(2); expect(f.message({ type: 'folk-photos-status', nonce: 'chosen' })).toMatchObject({ following: true })
})
