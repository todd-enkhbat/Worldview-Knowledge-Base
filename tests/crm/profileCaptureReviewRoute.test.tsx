// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CrmReview from '../../src/crm/CrmReview.tsx'
import { createCrmRecord } from '../../src/crm/model.ts'
const mocks = vi.hoisted(() => ({ command: vi.fn(), get: vi.fn() }))
vi.mock('../../src/data/repo.ts', () => ({ useRepoStatus: (select: (value: { writer: boolean }) => unknown) => select({ writer: true }) }))
vi.mock('../../src/crm/client.ts', () => ({ crmCommand: mocks.command, crmGet: mocks.get, crmAll: vi.fn(), crmMessage: String, personName: (person: { fullName: string }) => person.fullName, useCrmList: (collection: string) => ({ data: { rows: collection === 'candidates' ? [capture] : [], total: collection === 'candidates' ? 1 : 0, nextOffset: null }, loading: false, error: '', refresh: vi.fn() }), useCrmQuery: () => ({ data: { duplicates: [] }, loading: false, error: '', refresh: vi.fn() }) }))
const capture = { ...createCrmRecord('candidates', { id: 'capture_1', kind: 'person', provider: 'profile-capture', accountId: 'local', externalId: 'source', payload: {}, evidence: [], status: 'pending' }), profileCapture: { profile: { name: 'A captured person' } } }
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.clearAllMocks() })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
it('routes captured profiles to their dedicated field review without invoking generic candidate approval', async () => {
  const open = vi.fn(); await act(async () => root.render(<CrmReview onSelectPerson={() => {}} onOpenCapture={open} />))
  expect(host.textContent).toContain('A captured person'); expect(host.textContent).toContain('Original saved')
  const button = [...host.querySelectorAll('button')].find(value => value.textContent?.trim() === 'Review capture')!; expect(button).toBeDefined()
  await act(async () => button.click()); expect(open).toHaveBeenCalledWith('capture_1'); expect(mocks.command).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled(); expect(host.querySelector('dialog')).toBeNull()
})
