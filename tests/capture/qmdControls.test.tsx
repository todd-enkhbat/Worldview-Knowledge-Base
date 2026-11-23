// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, initRepo, wipeWorld } from '../../src/data/repo.ts'
import { useKnowledge } from '../../src/knowledge/index.ts'
import { QmdControls } from '../../src/capture/QmdControls.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | null = null, host: HTMLDivElement | null = null
const status = { installed: true, version: '2.9.0', enabled: false, sourceIds: [], followNewSources: false, mode: 'lexical', phase: 'disabled', busy: false, error: null, indexedPassages: 0, indexedSources: 0, models: [], progress: null }
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = null; host = null; await closeRepo(); vi.unstubAllGlobals() })
async function render(sqlite = true) {
  const store = createMemoryStore(); if (sqlite) store.info.kind = 'sqlite'
  await initRepo({ store }); await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  useKnowledge.setState({ sources: [{ id: 'source-a', externalId: 'a', title: 'Chosen source', kind: 'thought', currentVersionId: 'v1', createdAt: 1, updatedAt: 1, aiAllowed: true, excluded: false, tags: [] }] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<QmdControls />))
}
const button = (text: string) => [...host!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text)!

it('requires the same SQLite world and never offers an unrelated server index to a browser-only world', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); await render(false)
  expect(host!.textContent).toContain('Move to SQLite'); expect(fetcher).not.toHaveBeenCalled(); expect(button('Build QMD index')).toBeUndefined()
})

it('makes future-source following an explicit request and keeps lexical as the initial mode', async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'POST' ? { ...status, enabled: true, followNewSources: true, phase: 'ready' } : status), { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetcher); await render()
  expect(host!.querySelector<HTMLSelectElement>('select')!.value).toBe('lexical')
  expect(button('Build QMD index').disabled).toBe(true)
  await act(async () => host!.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
  await act(async () => button('Build QMD index').click())
  expect(fetcher.mock.calls.find((call) => call[1]?.method === 'POST')?.[1]?.body).toBe(JSON.stringify({ sourceIds: [], mode: 'lexical', followNewSources: true }))
  expect(host!.textContent).toContain('Local QMD is ready for the selected source scope.')
})

it('ignores an old index response after the same store is replaced', async () => {
  let release: (value: Response) => void = () => {}
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? new Promise<Response>((resolve) => { release = resolve }) : new Response(JSON.stringify(status)))
  vi.stubGlobal('fetch', fetcher); await render()
  await act(async () => host!.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
  await act(async () => button('Build QMD index').click())
  await act(async () => { await wipeWorld({ confirm: true }) })
  await act(async () => release(new Response(JSON.stringify({ ...status, enabled: true, phase: 'ready', indexedPassages: 999 }))))
  expect(host!.textContent).not.toContain('999 passages'); expect(host!.textContent).not.toContain('Local QMD is ready for the selected source scope.')
})
