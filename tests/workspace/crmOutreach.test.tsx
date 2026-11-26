// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CrmOutreach } from '../../src/crm/CrmOutreach.tsx'
const mocks = vi.hoisted(() => ({ command: vi.fn(), pages: {} as Record<string, unknown[]> }))
vi.mock('../../src/crm/client.ts', () => ({ crmCommand: mocks.command, crmMessage: (value: unknown) => value instanceof Error ? value.message : String(value), personName: (person: { fullName: string }) => person.fullName, useCrmList: (collection: string) => ({ data: { rows: mocks.pages[collection] ?? [], total: (mocks.pages[collection] ?? []).length, nextOffset: null }, loading: false, error: '', refresh: () => {} }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement
const fetcher = vi.fn<typeof fetch>(), campaign = { id: 'campaign1', revision: 2, name: 'A thoughtful update', subject: 'Hello {{firstName}}', body: 'Hi {{firstName}},\nA short update.', personIds: ['person1'], templateId: null, status: 'draft' }
const button = (text: string) => { const found = [...host.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === text); if (!found) throw new Error('Missing button: ' + text); return found }
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); fetcher.mockReset(); mocks.command.mockReset(); mocks.pages = { campaigns: [campaign], templates: [], sequences: [], people: [{ id: 'person1', fullName: 'Ada Example', emails: ['ada@example.test'] }] }; vi.stubGlobal('fetch', fetcher) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('prepares personalized drafts and copies the selected recipient without invoking a mail service', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  mocks.command.mockResolvedValue({ drafts: [
    { personId: 'person1', to: 'ada@example.test', subject: 'Hello Ada', body: 'A short update.' },
    { personId: 'person2', to: 'lin@example.test', subject: 'Hello Lin', body: 'Your update.' },
  ] })
  await act(async () => root.render(<CrmOutreach />))
  await act(async () => (host.querySelector('aside button') as HTMLButtonElement).click())
  await act(async () => button('Preview personalized drafts').click())
  expect(mocks.command).toHaveBeenCalledWith({ operation: 'prepare_campaign', id: 'campaign1', expectedRecordRevision: 2 })
  await act(async () => button('ada@example.test').click())
  const select = host.querySelector<HTMLSelectElement>('[aria-label="Preview recipient"]')!
  await act(async () => { select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => button('lin@example.test').click())
  expect(writeText.mock.calls).toEqual([['ada@example.test'], ['lin@example.test']])
  expect(fetcher).not.toHaveBeenCalled()
})
