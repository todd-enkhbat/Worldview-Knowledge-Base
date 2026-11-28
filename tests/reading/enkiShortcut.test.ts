import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { expect, it, vi } from 'vitest'

it('summons once for three trusted bracket taps and ignores repeats, composition, modified keys, hidden pages and secure fields', async () => {
  const events: Record<string, (event: Record<string, unknown>) => void> = {}, send = vi.fn(async () => ({ ok: true }))
  let now = 0
  class Element { secure: boolean; constructor(secure = false) { this.secure = secure } closest() { return this.secure ? this : null } }
  const document = { visibilityState: 'visible' }, window = {}
  const context = createContext({ window, document, Element, performance: { now: () => now }, addEventListener: (name: string, fn: typeof events[string]) => { events[name] = fn }, chrome: { runtime: { sendMessage: send } } })
  const source = new Script(readFileSync('extensions/worldview-reader/enki-shortcut.js', 'utf8'))
  source.runInContext(context)
  const original = events.keydown
  source.runInContext(context); expect(events.keydown).toBe(original)
  const key = (extra = {}) => { now += 100; events.keydown({ key: ']', isTrusted: true, composedPath: () => [new Element()], ...extra }) }
  key(); key(); key(); await Promise.resolve()
  expect(send).toHaveBeenCalledOnce()
  expect(send).toHaveBeenCalledWith({ type: 'reader-enki-summon' })
  for (const bad of [{ isTrusted: false }, { repeat: true }, { isComposing: true }, { ctrlKey: true }, { key: 'a' }, { composedPath: () => [new Element(true)] }]) { key(); key(bad); key() }
  document.visibilityState = 'hidden'; key(); key(); key()
  document.visibilityState = 'visible'; events.blur({}); key(); now += 1500; key(); key()
  expect(send).toHaveBeenCalledOnce()
})
