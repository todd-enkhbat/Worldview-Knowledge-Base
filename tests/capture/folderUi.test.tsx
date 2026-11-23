// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FolderCapture } from '../../src/capture/FolderCapture.tsx'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, initRepo } from '../../src/data/repo.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = null
  host = null
  await closeRepo()
  vi.unstubAllGlobals()
})

async function render(sqlite = true) {
  const memory = createMemoryStore()
  await initRepo({ store: sqlite ? { ...memory, info: { kind: 'sqlite', blobBackend: 'server' } } : memory })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<FolderCapture />))
}

const folder = { id: 'fixture-folder', path: '/fixture/notes', paused: false, status: 'watching', lastScanAt: Date.now(), files: 1, indexed: 1, excluded: 0, missing: 0, errors: [], exclusions: [] }
const button = (text: string) => [...host!.querySelectorAll('button')].find((element) => element.textContent?.trim() === text)!
function inputPath(path: string) {
  const input = host!.querySelector<HTMLInputElement>('#capture-folder-path')!
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, path); input.dispatchEvent(new Event('input', { bubbles: true })) })
}

describe('explicit local folder controls', () => {
  it('registers only on submission and sends actual pause/resume/rescan/remove requests', async () => {
    const requests: { url: string; method: string; body?: string }[] = []
    let registered = false
    let paused = false
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      requests.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined })
      if (method === 'POST' && url.endsWith('/folders')) registered = true
      if (method === 'PATCH') paused = JSON.parse(String(init?.body)).paused
      if (method === 'DELETE') registered = false
      return new Response(JSON.stringify({ available: true, folders: registered ? [{ ...folder, paused, status: paused ? 'paused' : 'watching' }] : [] }), { status: 200 })
    }))
    await render()
    expect(requests.every((request) => request.method === 'GET')).toBe(true)
    expect(host!.textContent).toContain('No folders are watched')
    inputPath('/fixture/notes')
    await act(async () => host!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(requests.find((request) => request.method === 'POST')?.body).toBe(JSON.stringify({ path: '/fixture/notes' }))
    expect(host!.textContent).toContain('Watching')
    await act(async () => button('Pause').click())
    expect(requests.at(-1)).toMatchObject({ method: 'PATCH', body: JSON.stringify({ paused: true }) })
    await act(async () => button('Resume').click())
    expect(requests.at(-1)).toMatchObject({ method: 'PATCH', body: JSON.stringify({ paused: false }) })
    await act(async () => button('Rescan').click())
    expect(requests.at(-1)).toMatchObject({ url: '/api/capture/folders/fixture-folder/scan', method: 'POST' })
    await act(async () => button('Stop watching').click())
    expect(requests.at(-1)?.method).toBe('DELETE')
    expect(host!.textContent).toContain('No folders are watched')
  })

  it('retains the path and reports a failed registration without showing a fictitious watched folder', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'POST' ? { error: 'That folder could not be opened.' } : { available: true, folders: [] }), { status: init?.method === 'POST' ? 400 : 200 })))
    await render()
    inputPath('/fixture/missing')
    await act(async () => host!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(host!.querySelector('[role=alert]')?.textContent).toContain('could not be opened')
    expect(host!.querySelector<HTMLInputElement>('input')!.value).toBe('/fixture/missing')
    expect(host!.textContent).toContain('No folders are watched')
  })

  it('does not capture into a different server world when the active workspace uses browser storage', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await render(false)
    expect(host!.textContent).toContain('Manual file imports remain available here')
    expect(host!.querySelector('form')).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
