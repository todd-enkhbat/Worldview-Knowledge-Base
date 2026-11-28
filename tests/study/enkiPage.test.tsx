// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { EnkiPage, type PageBridge } from '../../src/study/EnkiPage.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const host = document.createElement('div')
document.body.append(host)
const root = createRoot(host)
afterEach(async () => { await act(async () => root.render(null)) })
const button = (text: string) => [...host.querySelectorAll('button')].find(row => row.textContent === text)!
function bridge() {
  return {
    page: vi.fn().mockResolvedValue({ title: 'Field notes', url: 'https://example.org/essay', description: 'An orchard journal.', selection: '', kind: 'article' }),
    savePage: vi.fn().mockResolvedValue({ sourceId: 'article' }),
    read: vi.fn().mockResolvedValue({ id: 'contact', profile: { name: 'Ada Example', entityType: 'person', url: 'https://example.org/ada', companies: [], schools: [], headline: '', photo: '', website: '', industry: '' }, groups: [], workspace: 'Test' }),
    save: vi.fn().mockResolvedValue({ status: 'saved' }),
    openBrowser: vi.fn(), openRecord: vi.fn(), form: vi.fn(),
    screenState: vi.fn(), onScreenContacts: vi.fn(),
  } satisfies PageBridge
}
it('reads immediately, saves only on click, and replaces the page on refresh', async () => {
  const api = bridge()
  await act(async () => root.render(<EnkiPage bridge={api} />))
  expect(host.textContent).toContain('Field notes')
  expect(api.page).toHaveBeenCalledOnce()
  expect(api.savePage).not.toHaveBeenCalled()
  await act(async () => button('Save page').click())
  expect(api.savePage).toHaveBeenCalledOnce()
  expect(host.textContent).toContain('Saved to your library.')
  api.page.mockResolvedValue({ title: 'Another page', url: 'https://example.org/next', description: '', selection: '', kind: 'article' })
  await act(async () => button('Refresh page').click())
  expect(host.textContent).toContain('Another page')
  expect(host.textContent).not.toContain('Field notes')
})
it('loads CRM automatically even when the desktop also exposes screen scanning', async () => {
  const api = bridge()
  api.page.mockResolvedValue({ title: 'Ada Example', url: 'https://example.org/ada', description: '', selection: '', kind: 'person' })
  await act(async () => root.render(<EnkiPage bridge={api} />))
  expect(api.read).toHaveBeenCalledWith('dia')
  expect(api.screenState).not.toHaveBeenCalled()
  expect(host.querySelector('h1')?.textContent).toBe('Ada Example')
  expect(button('Save contact')).toBeDefined()
})
it('provides an actionable setup error and retries without reloading the app', async () => {
  const api = bridge()
  api.page.mockRejectedValueOnce(Error('Connect Enki to Dia in Reader.'))
  await act(async () => root.render(<EnkiPage bridge={api} />))
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Connect Enki')
  await act(async () => button('Try again').click())
  expect(host.textContent).toContain('Field notes')
  expect(host.querySelector('[role=alert]')).toBeNull()
})
