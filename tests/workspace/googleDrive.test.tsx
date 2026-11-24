// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { Blob as NodeBlob } from 'node:buffer'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, initRepo } from '../../src/data/repo.ts'
import { createWritingDocument, initializeWriting, resetWriting, useWriting } from '../../src/writing/store.ts'
import { writingFromPlainText } from '../../src/writing/model.ts'
import { GoogleDriveConnection } from '../../src/connections/GoogleDriveConnection.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement, store: ReturnType<typeof createMemoryStore>
const connected = { available: true, configured: true, connected: true, pickerConfigured: false, connectedAt: 1 }
const fetcher = vi.fn<typeof fetch>()
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const button = (text: string) => { const found = [...host.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === text); if (!found) throw new Error('Missing button: ' + text); return found }
async function click(text: string) { await act(async () => button(text).click()) }
async function until(check: () => boolean) { for (let n = 0; n < 100 && !check(); n++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) }); expect(check(), host.textContent ?? '').toBe(true) }
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob); fetcher.mockReset(); vi.stubGlobal('fetch', fetcher)
  resetWriting(); store = createMemoryStore(); await initRepo({ store }); await completeFirstRun({ T0: 0, start: 'empty' }); await initializeWriting()
  Object.defineProperty(store.info, 'kind', { value: 'sqlite', configurable: true })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetWriting(); await closeRepo(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('shows honest OAuth setup without loading Google scripts, claiming a connection or requesting a provider', async () => {
  fetcher.mockResolvedValue(response({ available: true, configured: false, connected: false, pickerConfigured: false }))
  await act(async () => root.render(<GoogleDriveConnection />))
  await until(() => host.textContent?.includes('Setup needed') === true)
  expect(host.textContent).toContain('Existing ChatGPT or Codex connections are separate')
  expect(host.textContent).toContain('does not enable cloud AI')
  expect(host.querySelector('input[type=file]')).not.toBeNull()
  expect(host.querySelector('a[href*="accounts.google.com"]')).toBeNull()
  expect(document.querySelector('script[src="https://apis.google.com/js/api.js"]')).toBeNull()
  expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('/api/connections/drive'))).toBe(true)
})
it('keeps the newer disconnected status when an earlier connected status resolves late', async () => {
  let release!: (value: Response) => void
  fetcher.mockImplementationOnce(() => new Promise((resolve) => { release = resolve })).mockResolvedValue(response({ ...connected, configured: false, connected: false }))
  await act(async () => root.render(<GoogleDriveConnection />))
  await act(async () => window.dispatchEvent(new Event('focus')))
  await until(() => fetcher.mock.calls.length === 2)
  await act(async () => release(response(connected)))
  expect(host.textContent).toContain('Give this app its own Google connection')
  expect(host.textContent).not.toContain('Files you choose')
})
it('prepares an explicit Google consent link only after the user asks to connect', async () => {
  fetcher.mockImplementation(async (url) => String(url).endsWith('/connect') ? response({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?scope=drive.file&state=synthetic-state' }) : response({ ...connected, connected: false }))
  await act(async () => root.render(<GoogleDriveConnection />))
  await until(() => host.textContent?.includes('Ready to connect') === true)
  expect(host.querySelector('a[href*="accounts.google.com"]')).toBeNull()
  await click('Connect Google Drive')
  const link = host.querySelector<HTMLAnchorElement>('a[href*="accounts.google.com"]')!
  expect(link.textContent).toContain('Continue to Google')
  expect(link.target).toBe('_blank')
  expect(host.textContent).not.toContain('synthetic-access')
})
it('explains isolated-window Picker incompatibility without exposing a token or loading a blocked frame', async () => {
  vi.stubGlobal('crossOriginIsolated', true)
  fetcher.mockResolvedValue(response({ ...connected, pickerConfigured: true }))
  await act(async () => root.render(<GoogleDriveConnection />))
  await until(() => host.textContent?.includes('Choose in Google') === true)
  await click('Choose in Google')
  expect(host.querySelector('[role=alert]')?.textContent).toContain('isolated app window')
  expect(document.querySelector('script[src="https://apis.google.com/js/api.js"]')).toBeNull()
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/picker'))).toBe(false)
})
it('opens Desktop selection in Google and reviews the returned file without importing it automatically', async () => {
  vi.stubGlobal('crossOriginIsolated', true)
  const state: { revision: number; selection?: { id: string; fileIds: string[] } } = { revision: 1 }
  const file = { id: 'selected-file', name: 'The file I chose in Google', mimeType: 'text/plain', version: '7', capabilities: { canDownload: true } }
  fetcher.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/connect')) {
      expect(JSON.parse(String(init?.body))).toEqual({ pickFiles: true })
      return response({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?trigger_onepick=true&state=synthetic', connectionRevision: 1 })
    }
    if (String(url).endsWith('/inspect')) { expect(JSON.parse(String(init?.body))).toEqual({ fileId: file.id }); return response({ file, ticket: 'selected-ticket', updateAvailable: false }) }
    return response({ ...connected, pickerConfigured: true, pickerMode: 'desktop', connectionRevision: state.revision, ...(state.selection ? { selection: state.selection } : {}) })
  })
  await act(async () => root.render(<GoogleDriveConnection />))
  await until(() => host.textContent?.includes('Choose in Google') === true)
  await click('Choose in Google')
  expect(host.querySelector('a[href*="trigger_onepick=true"]')).not.toBeNull()
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(host.querySelector('a[href*="trigger_onepick=true"]')).not.toBeNull()
  state.revision = 2; state.selection = { id: 'verified-selection', fileIds: [file.id] }
  await act(async () => window.dispatchEvent(new Event('focus')))
  await until(() => host.textContent?.includes(file.name) === true)
  expect(host.querySelector('a[href*="trigger_onepick=true"]')).toBeNull()
  expect(button('Keep a local copy').disabled).toBe(false)
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/inspect'))).toHaveLength(1)
  expect(fetcher.mock.calls.some(([url]) => /\/(?:picker|import)$/.test(String(url)))).toBe(false)
  expect(document.querySelector('script[src="https://apis.google.com/js/api.js"]')).toBeNull()
})
it('clears a completed cancellation link and lets the user start another Desktop connection', async () => {
  const state = { cancelled: false }
  fetcher.mockImplementation(async (url) => String(url).endsWith('/connect')
    ? response({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?trigger_onepick=true&state=synthetic', authorizationRevision: 0 })
    : response({ ...connected, connected: false, pickerMode: 'desktop', pickerConfigured: true, authorizationRevision: state.cancelled ? 1 : 0, authorizationResult: state.cancelled ? 'cancelled' : null }))
  await act(async () => root.render(<GoogleDriveConnection />))
  await until(() => host.textContent?.includes('Ready to connect') === true)
  await click('Connect Google Drive')
  expect(host.querySelector('a[href*="trigger_onepick=true"]')).not.toBeNull()
  state.cancelled = true
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(host.querySelector('a[href*="trigger_onepick=true"]')).toBeNull()
  expect(host.querySelector('[role=status]')?.textContent).toContain('cancelled')
  expect(button('Connect Google Drive').disabled).toBe(false)
})
it('requires a named target, saved writing and an explicit replace choice before a guarded update', async () => {
  const doc = await createWritingDocument({ title: 'My saved essay', content: writingFromPlainText('Exact saved writing.') })
  const file = { id: 'target-file', name: 'Selected Google document', mimeType: 'application/vnd.google-apps.document', version: '7', webViewLink: 'https://docs.google.com/document/d/target-file/edit', capabilities: { canDownload: true, canEdit: true } }
  const uploads: Record<string, unknown>[] = []
  fetcher.mockImplementation(async (url, init) => {
    const path = String(url)
    if (path.includes('/files?')) return response({ files: [file], nextPageToken: null })
    if (path.endsWith('/inspect')) return response({ file, ticket: 'current-target-ticket', updateAvailable: true })
    if (path.endsWith('/export')) { uploads.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return response({ file: { ...file, version: '8' } }) }
    return response(connected)
  })
  await act(async () => root.render(<GoogleDriveConnection />)); await until(() => host.textContent?.includes('Files you choose') === true)
  await click('Find files')
  const target = [...host.querySelectorAll<HTMLButtonElement>('.google-drive-file-list button')].find((entry) => entry.textContent?.includes(file.name))!
  await act(async () => target.click())
  expect(button('Update selected Google file').disabled).toBe(true)
  const select = host.querySelector<HTMLSelectElement>('[aria-label="Writing to send to Google"]')!
  await act(async () => { select.value = doc.id; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(button('Update selected Google file').disabled).toBe(true)
  const confirmation = host.querySelector<HTMLInputElement>('.google-drive-update input[type=checkbox]')!
  await act(async () => confirmation.click())
  expect(button('Update selected Google file').disabled).toBe(false)
  await click('Update selected Google file')
  await until(() => uploads.length === 1 && host.textContent?.includes('Selected Google file updated and verified.') === true)
  expect(uploads[0]).toMatchObject({ documentId: doc.id, expectedUpdatedAt: doc.updatedAt, ticket: 'current-target-ticket' })
  expect(atob(String(uploads[0].htmlBase64))).toContain('Exact saved writing.')
  expect(host.querySelector('a[href="https://docs.google.com/document/d/target-file/edit"]')).not.toBeNull()
  expect(useWriting.getState().docs.find((entry) => entry.id === doc.id)).toEqual(doc)
})
