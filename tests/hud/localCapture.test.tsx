// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useApp, useWorld } from '../../src/app/store.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, getStore, initRepo } from '../../src/data/repo.ts'
import { loadChat, resetChat, stage, useChat } from '../../src/ai/chat/session.ts'
import { Chat } from '../../src/hud/Chat.tsx'
import { AiConnection } from '../../src/capture/AiConnection.tsx'
import { restoreWorkspaceContext, useWorkspace, validateWorkspaceContext } from '../../src/workspace/state.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | null = null, host: HTMLDivElement | null = null
beforeEach(async () => {
  localStorage.clear(); restoreWorkspaceContext('capture-test')
  await initRepo({ store: createMemoryStore() })
  await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  resetChat(); await loadChat()
  useApp.setState((s) => ({ panels: { ...s.panels, chat: true } }))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove(); root = null; host = null
  await closeRepo(); vi.unstubAllGlobals()
  vi.useRealTimers(); vi.restoreAllMocks()
})
const button = (text: string) => [...host!.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)!
async function type(text: string) {
  const textarea = host!.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return textarea
}

it('shows local capture, preserves old conversations and saves words with their exact original without a cloud request', async () => {
  const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify({ provider: null, model: null, configured: false })))
  vi.stubGlobal('fetch', fetcher)
  useChat.setState({ history: [{ role: 'assistant', content: 'A previous saved answer.' }] })
  const original = new TextEncoder().encode('Exact original bytes: copper orchard')
  const file = new File([original], 'field-notes.txt', { type: 'text/plain' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => original.buffer.slice(0) })
  stage([{ name: file.name, kind: 'text', bytes: file.size, blocks: [], file }])
  await act(async () => root!.render(<Chat embedded />))
  expect(host!.querySelector('h2')?.textContent).toBe('Quick capture')
  expect(host!.textContent).toContain('A previous saved answer.')
  expect(host!.querySelector('[aria-label="Send to AI"]')).toBeNull()
  expect(host!.textContent).not.toContain('Find connections')
  expect(host!.textContent).not.toContain('Meet your agents')
  expect(host!.querySelector('a[href="#/sources?connection=cloud"]')?.textContent).toBe('Cloud AI off')
  const textarea = await type('Keep the copper orchard decision.\nLaunch on December 12.')
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  await act(async () => textarea.dispatchEvent(enter))
  expect(enter.defaultPrevented).toBe(false)
  expect(useWorld.getState().nodes.size).toBe(0)
  await act(async () => button('Save to world').click())
  const record = [...useWorld.getState().nodes.values()][0]
  expect(record.contentMd).toContain('Launch on December 12.')
  expect(record.attachments[0].name).toBe(file.name)
  expect(Array.from(new Uint8Array(await (await getStore().getBlob(record.attachments[0].blobId))!.arrayBuffer()))).toEqual(Array.from(original))
  expect(host!.querySelector('textarea')!.value).toBe('')
  expect(host!.textContent).toContain('Added to your world')
  expect(fetcher.mock.calls.every((call) => String(call[0]) === '/api/ai/status')).toBe(true)
})

it('saves by Cmd/Ctrl+Enter when local status cannot be reached, without exposing a paid send action', async () => {
  const fetcher = vi.fn(async (_url: string) => { throw new Error('Local status unavailable') }); vi.stubGlobal('fetch', fetcher)
  await act(async () => root!.render(<Chat embedded />))
  const textarea = await type('A thought captured while offline.')
  await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })))
  expect([...useWorld.getState().nodes.values()][0].contentMd).toContain('A thought captured while offline.')
  expect(host!.querySelector('[aria-label="Send to AI"]')).toBeNull()
  expect(fetcher.mock.calls.every((call) => String(call[0]) === '/api/ai/status')).toBe(true)
})

it('keeps optional cloud setup behind disclosure and never probes a provider while disabled', async () => {
  const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify({ provider: null, model: null, configured: false })))
  vi.stubGlobal('fetch', fetcher)
  await act(async () => root!.render(<AiConnection />))
  expect(host!.textContent).toContain('Cloud AI is off.')
  expect(host!.querySelector('details')?.open).toBe(false)
  expect(host!.querySelector('input')).toBeNull()
  expect(button('Check key and model access')).toBeUndefined()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('retains an unsaved multiline draft across closing, reopening and investigation navigation', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ provider: null, model: null, configured: false }))))
  await act(async () => root!.render(<Chat embedded />))
  const draft = 'An unfinished copper orchard thought.\nKeep the second line too.'
  await type(draft)
  await act(async () => {
    useWorkspace.setState({ lastSection: 'library', selectedSourceId: 'retained-source', sourceIds: ['retained-source'] })
    host!.querySelector<HTMLButtonElement>('[aria-label="Close capture panel"]')!.click()
    root!.render(null)
  })
  expect(useWorkspace.getState().quickCaptureDraft).toBe(draft)
  await act(async () => {
    useWorkspace.setState({ lastSection: 'search', query: 'copper orchard' })
    useApp.getState().togglePanel('chat', true)
    root!.render(<Chat embedded />)
  })
  expect(host!.querySelector('textarea')!.value).toBe(draft)
  expect(useWorkspace.getState()).toMatchObject({ selectedSourceId: 'retained-source', sourceIds: ['retained-source'], lastSection: 'search' })
  expect(useWorld.getState().nodes.size).toBe(0)
  expect(useChat.getState().history).toEqual([])
  await act(async () => restoreWorkspaceContext('capture-test'))
  expect(host!.querySelector('textarea')!.value).toBe(draft)
})

it('clears the displayed draft for another account or an explicit workspace reset', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ provider: null, model: null, configured: false }))))
  await act(async () => root!.render(<Chat embedded />))
  await type('The first account’s private unfinished note.')
  await act(async () => restoreWorkspaceContext('another-account'))
  expect(host!.querySelector('textarea')!.value).toBe('')
  await type('Another account’s note.')
  await act(async () => restoreWorkspaceContext('capture-test'))
  expect(host!.querySelector('textarea')!.value).toBe('The first account’s private unfinished note.')
  await act(async () => useWorkspace.setState(validateWorkspaceContext(null), true))
  expect(host!.querySelector('textarea')!.value).toBe('')
  await act(async () => restoreWorkspaceContext('capture-test'))
  expect(host!.querySelector('textarea')!.value).toBe('')
})

it.each(['title', 'Read note'] as const)('opens a saved capture in Library from its %s action and closes capture without requiring the world canvas', async (action) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ provider: null, model: null, configured: false }))))
  useApp.setState({ selectedId: null })
  location.hash = '#/today'
  await act(async () => root!.render(<Chat embedded />))
  await type('A receipt that opens a readable note.\nRetain this body.')
  await act(async () => button('Save to world').click())
  const record = [...useWorld.getState().nodes.values()][0]
  expect(record.contentMd).toContain('Retain this body.')
  expect(host!.querySelector('canvas')).toBeNull()
  const receiptAction = host!.querySelector<HTMLButtonElement>(action === 'title' ? '.chat-captured-title' : '.chat-captured-open')!
  expect(receiptAction.textContent).toContain(action === 'title' ? record.title : 'Read note')
  await act(async () => receiptAction.click())
  expect(location.hash).toBe(`#/library?record=${encodeURIComponent(record.id)}`)
  expect(useWorkspace.getState()).toMatchObject({ selectedRecordId: record.id, selectedPassageId: null })
  expect(useApp.getState().panels.chat).toBe(false)
  expect(useApp.getState().selectedId).toBeNull()
})

it('shows the saved calendar day correctly when the local time zone is west of UTC', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-23T12:00:00Z'))
  const format = Date.prototype.toLocaleDateString
  vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(function (this: Date, _locales, options) {
    return format.call(this, 'en-US', { timeZone: 'America/New_York', ...options })
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ provider: null, model: null, configured: false }))))
  await act(async () => root!.render(<Chat embedded />))
  await type('A November 23 calendar memory.')
  await act(async () => button('Save to world').click())
  expect(new Date([...useWorld.getState().nodes.values()][0].temporalOrigin).toISOString()).toBe('2026-11-23T00:00:00.000Z')
  expect(host!.querySelector('.chat-captured-meta')?.textContent).toContain('Nov 23')
  expect(host!.querySelector('.chat-captured-meta')?.textContent).not.toContain('Nov 22')
})
