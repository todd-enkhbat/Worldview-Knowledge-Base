// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, initRepo, wipeWorld } from '../../src/data/repo.ts'
import { SourcesHub } from '../../src/workspace/SourcesHub.tsx'

const mounts = vi.hoisted(() => ({ voice: vi.fn(), cloud: vi.fn() }))
vi.mock('../../src/capture/SourcesVoiceInbox.tsx', () => ({ SourcesVoiceInbox: () => { mounts.voice(); return <label>Voice draft<input aria-label="Voice draft" /></label> } }))
vi.mock('../../src/capture/AiConnection.tsx', () => ({ AiConnection: () => { mounts.cloud(); return <p>Cloud connection settings</p> } }))
vi.mock('../../src/capture/FolderCapture.tsx', () => ({ FolderCapture: () => <p>Folder settings</p> }))
vi.mock('../../src/capture/QmdControls.tsx', () => ({ QmdControls: () => <p>Search settings</p> }))
vi.mock('../../src/capture/TelegramCaptureControls.tsx', () => ({ TelegramCaptureControls: () => <p>Telegram settings</p> }))
vi.mock('../../src/capture/PortabilityControls.tsx', () => ({ PortabilityControls: () => <p>Export settings</p> }))
vi.mock('../../src/workspace/MemoryClients.tsx', () => ({ MemoryClients: () => <p>Agent settings</p> }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const values: Record<string, unknown> = {
  '/api/models/whisper/status': { available: true, modelReady: true },
  '/api/capture/folders': { available: true, folders: [{ paused: true, status: 'watching' }] },
  '/api/qmd/status': { installed: true, enabled: false, phase: 'idle' },
  '/api/memory/clients': { clients: [{ expiresAt: Date.now() + 60_000, revokedAt: 123 }, { expiresAt: 1, revokedAt: null }] },
  '/api/capture/telegram': { configured: false, enabled: false },
  '/api/ai/status': { provider: null, configured: false },
  '/api/reading-capture': { available: true, clients: [] },
  '/api/connections/drive': { available: true, configured: false, connected: false },
  '/api/connections/notebooks': { granola: false, wispr: false },
  '/api/connections/desktop': { available: true, bytes: 1048576 },
}
let root: Root, host: HTMLDivElement
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
const connection = (id: string) => host.querySelector<HTMLDetailsElement>(`[data-connection="${id}"]`)!
async function toggle(id: string, open: boolean) {
  await act(async () => { const details = connection(id); details.open = open; details.dispatchEvent(new Event('toggle')) })
}
beforeEach(async () => {
  mounts.voice.mockClear(); mounts.cloud.mockClear()
  const store = createMemoryStore(); store.info.kind = 'sqlite'
  await initRepo({ store }); await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  fetchMock = vi.fn<typeof fetch>(async (url) => new Response(JSON.stringify(values[String(url)]), { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); await closeRepo(); vi.unstubAllGlobals() })

it('starts with compact native disclosures, truthful readiness, and no setup side effects', async () => {
  await act(async () => root.render(<SourcesHub hash="#/sources" importActions={<button>Import files</button>} />))
  expect(host.querySelectorAll('details.sources-hub-connection')).toHaveLength(11)
  expect(host.querySelector('details[open]')).toBeNull()
  expect(mounts.voice).not.toHaveBeenCalled(); expect(mounts.cloud).not.toHaveBeenCalled()
  expect(connection('voice').textContent).toContain('Transcription ready')
  expect(connection('folders').textContent).toContain('Paused')
  expect(connection('qmd').textContent).toContain('Ready to enable')
  expect(connection('memory').textContent).toContain('No agents connected')
  expect(connection('telegram').textContent).toContain('Setup needed')
  expect(connection('cloud').textContent).toContain('Off')
  expect(connection('browser').textContent).toContain('Ready to pair')
  expect(connection('drive').textContent).toContain('Setup needed')
  expect(connection('desktop').textContent).toContain('Ready to download')
  expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Refresh connection status')
  expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Import files')).toBe(true)
  expect(fetchMock).toHaveBeenCalledTimes(10)
  for (const [, options] of fetchMock.mock.calls) expect(options?.method ?? 'GET').toBe('GET')
})

it('opens controls on demand and retains a draft when its native disclosure is collapsed', async () => {
  await act(async () => root.render(<SourcesHub hash="#/sources" />))
  await toggle('voice', true)
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Voice draft"]')!
  input.value = 'Unfinished voice note'
  await toggle('voice', false)
  expect(connection('voice').open).toBe(false)
  expect(host.querySelector('input')).toBe(input)
  await toggle('voice', true)
  expect(host.querySelector('input')).toBe(input)
  expect(input.value).toBe('Unfinished voice note')
  expect(mounts.cloud).not.toHaveBeenCalled()
})

it.each([['MacIntel', 0, true], ['MacIntel', 5, false], ['Win32', 0, false]])('offers the installed Mac app on %s with %s touch points', async (platform, maxTouchPoints, canOpen) => {
  vi.stubGlobal('navigator', Object.create(navigator, { platform: { value: platform }, maxTouchPoints: { value: maxTouchPoints } }))
  await act(async () => root.render(<SourcesHub hash="#/sources?connection=desktop" />))
  const panel = connection('desktop')
  expect(Boolean(panel.querySelector('a[href="worldview-local://open"]'))).toBe(canOpen)
  expect(panel.querySelector('a[href="/api/connections/desktop/download"]')?.textContent).toContain('Download Worldview for Mac')
})

it('opens and focuses the cloud disclosure from the Quick capture link without probing a provider', async () => {
  await act(async () => root.render(<SourcesHub hash="#/sources" />))
  await act(async () => root.render(<SourcesHub hash="#/sources?connection=cloud" />))
  const details = connection('cloud'), summary = details.querySelector('summary')!
  expect(details.open).toBe(true)
  expect(document.activeElement).toBe(summary)
  expect(summary.getAttribute('aria-controls')).toBe('sources-cloud-panel')
  expect(host.querySelector('#sources-cloud-panel')?.getAttribute('aria-labelledby')).toBe('sources-cloud-title')
  expect(details.textContent).toContain('Cloud connection settings')
  expect(mounts.voice).not.toHaveBeenCalled()
  for (const [, options] of fetchMock.mock.calls) expect(options?.method ?? 'GET').toBe('GET')
})

it('ignores a late connection status from before a workspace replacement', async () => {
  let resolve: (response: Response) => void = () => {}
  let held = false
  fetchMock.mockImplementation(async (url) => {
    if (String(url) === '/api/ai/status' && !held) { held = true; return new Promise<Response>((done) => { resolve = done }) }
    return new Response(JSON.stringify(values[String(url)]))
  })
  await act(async () => root.render(<SourcesHub hash="#/sources" />))
  await act(async () => { await wipeWorld({ confirm: true }) })
  await act(async () => resolve(new Response(JSON.stringify({ configured: true, provider: 'openai' }))))
  expect(connection('cloud').textContent).toContain('Off')
  expect(connection('cloud').textContent).not.toContain('Configured')
})
