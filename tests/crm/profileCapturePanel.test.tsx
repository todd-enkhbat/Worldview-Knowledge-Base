// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProfileCapturePanel } from '../../src/crm/ProfileCapturePanel.tsx'
import { createCrmRecord } from '../../src/crm/model.ts'
import type { CrmProfileCaptureDraft } from '../../src/crm/profileCaptureTypes.ts'
const mocks = vi.hoisted(() => ({ post: vi.fn(), query: vi.fn() }))
vi.mock('../../src/crm/ProfileCaptureClient.ts', () => ({ profileCapturePost: mocks.post }))
vi.mock('../../src/crm/client.ts', () => ({ useCrmQuery: mocks.query, crmMessage: (value: unknown) => value instanceof Error ? value.message : String(value), personName: (value: { fullName: string }) => value.fullName }))
vi.mock('../../src/crm/socialProfiles.tsx', () => ({ safeProfileUrl: (value: string) => /^https?:\/\//.test(value) ? value : '' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root, draft: CrmProfileCaptureDraft
const person = { ...createCrmRecord('people', { id: 'ada', fullName: 'Ada Example', jobTitle: 'Existing role', revision: 7, urls: ['https://example.org/ada'] }, 1), revision: 7 }
let currentPerson = person
const button = (text: string) => { const found = [...document.querySelectorAll('button')].find(value => value.textContent?.trim() === text); if (!found) throw new Error('Missing button ' + text); return found }
const checkbox = (text: string) => { const found = [...document.querySelectorAll('label')].find(value => value.querySelector('strong')?.textContent === text)?.querySelector<HTMLInputElement>('input'); if (!found) throw new Error('Missing choice ' + text); return found }
const render = async (id = draft.id) => { await act(async () => root.render(<ProfileCapturePanel draftId={id} disabled={false} onClose={() => {}} />)) }
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.clearAllMocks(); currentPerson = person
  HTMLDialogElement.prototype.showModal = function () { this.open = true }; HTMLDialogElement.prototype.close = function () { this.open = false }
  draft = { id: 'capture-1', draftId: 'capture-1', revision: 1, status: 'pending', targetId: person.id, reviewUrl: '#/people?capture=capture-1', cloudAiUsed: false, matches: [{ id: person.id, name: person.fullName, revision: person.revision, collection: 'people', reason: 'profile-url' }], profile: { entityType: 'person', name: 'Ada Captured', headline: 'Captured role', description: 'Captured biography.', location: '', industry: '', emails: [], phones: [], urls: ['https://example.org/ada'], images: [], affiliations: [{ id: 'school', kind: 'education', organization: 'Example University', degree: 'BA', evidence: [] }, { id: 'work', kind: 'employment', organization: 'Example Company', role: 'Engineer', evidence: [] }] }, source: { url: 'https://example.org/ada', title: 'Ada profile', text: '<script>not executable</script>\nVisible profile biography.', originalAssetId: 'original', capturedAt: 1, contentHash: 'hash', captureMethod: 'browser-extension' } }
  mocks.query.mockImplementation((path: string | null, initial: unknown) => ({ data: path === 'profile-capture/capture-1' ? draft : path === 'people/ada' ? { record: currentPerson } : path?.startsWith('profile-capture?') ? { drafts: [draft], total: 1, nextOffset: null } : initial, loading: false, error: '', refresh: vi.fn() }))
  mocks.post.mockResolvedValue({ ok: true, record: { ...person, revision: 8 }, draft: { ...draft, status: 'accepted' } })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
it('keeps nonempty existing text unchecked, adds selected affiliations and sends the reviewed target revision', async () => {
  await render()
  expect(checkbox('Name').checked).toBe(false); expect(checkbox('Role / headline').checked).toBe(false); expect(checkbox('About').checked).toBe(true)
  expect(mocks.post).not.toHaveBeenCalled(); expect(document.querySelector('script')).toBeNull(); expect(document.body.textContent).toContain('Visible profile biography.')
  await act(async () => checkbox('Example Company').click()); await act(async () => button('Save selected details').click())
  expect(mocks.post).toHaveBeenCalledWith('capture-1/apply', expect.objectContaining({ targetId: 'ada', expectedRecordRevision: 7, affiliationIds: ['school'], fields: ['description', 'urls', 'affiliations'] }))
  expect(document.body.textContent).toContain('Profile saved.'); expect(document.querySelector('iframe')).toBeNull()
})
it('requires an explicit new-record choice and keeps the same request identity after an uncertain response', async () => {
  draft = { ...draft, targetId: null, matches: [] }; mocks.post.mockRejectedValueOnce(new Error('The connection ended before the receipt arrived.'))
  await render(); expect(button('Save selected details').disabled).toBe(true)
  await act(async () => checkbox('Create a new person').click()); expect(button('Create from capture').disabled).toBe(false)
  await act(async () => button('Create from capture').click()); expect(document.querySelector('[role=alert]')?.textContent).toContain('connection ended')
  const first = mocks.post.mock.calls[0][1]
  await act(async () => button('Create from capture').click()); expect(mocks.post.mock.calls[1][1]).toEqual(first); expect(first).toMatchObject({ createNew: true, fields: expect.arrayContaining(['name', 'affiliations']) })
})
it('shows pending source captures and opens their review without changing a contact', async () => {
  await act(async () => root.render(<ProfileCapturePanel disabled={false} onClose={() => {}} />))
  expect(document.body.textContent).toContain('Save profile or company'); expect(document.body.textContent).toContain('Ready to review 1')
  await act(async () => host.querySelector<HTMLButtonElement>('.crm-capture-inbox button')!.click()); expect(document.body.textContent).toContain('Choose what to keep'); expect(mocks.post).not.toHaveBeenCalled()
})

it('blocks an outdated selection after the target changes and requires a fresh comparison', async () => {
  await render(); await act(async () => checkbox('Role / headline').click())
  currentPerson = { ...person, revision: 8, jobTitle: 'A newer saved role' }; await render()
  expect(button('Save selected details').disabled).toBe(true); expect(mocks.post).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('This record changed while you were reviewing')
  await act(async () => button('Review latest details').click()); expect(checkbox('Role / headline').checked).toBe(false)
  expect(document.body.textContent).toContain('Currently: A newer saved role')
  await act(async () => checkbox('Role / headline').click()); await act(async () => button('Save selected details').click())
  expect(mocks.post).toHaveBeenCalledWith('capture-1/apply', expect.objectContaining({ expectedRecordRevision: 8 }))
})

it('prefills a saved public URL and retries an uncertain capture before opening its saved review', async () => {
  mocks.post.mockReset().mockRejectedValueOnce(new Error('The capture receipt was interrupted.')).mockResolvedValueOnce(draft)
  await act(async () => root.render(<ProfileCapturePanel initialUrl="https://example.org/ada" disabled={false} onClose={() => {}} />)); await act(async () => button('Public URL').click())
  expect(host.querySelector<HTMLInputElement>('[aria-label="Public profile URL"]')!.value).toBe('https://example.org/ada')
  await act(async () => button('Capture public profile').click()); expect(host.querySelector('[role=alert]')?.textContent).toContain('receipt was interrupted')
  const input = mocks.post.mock.calls[0][1]; expect(mocks.post.mock.calls[0][0]).toBe('from-url'); expect(input).toMatchObject({ url: 'https://example.org/ada' })
  await act(async () => button('Capture public profile').click()); expect(mocks.post.mock.calls[1]).toEqual(['from-url', input]); expect(host.textContent).toContain('Choose what to keep')
})

it('shows real paged saved-source progress and retries the same next batch without double-counting', async () => {
  const first = { drafts: [draft], processed: 10, total: 12, nextOffset: 10, skipped: Array.from({ length: 9 }, (_, index) => ({ sourceId: `source-${index}`, reason: 'No supported profile evidence.' })), cloudAiUsed: false }
  const last = { drafts: [], processed: 2, total: 12, nextOffset: null, skipped: [{ sourceId: 'last-1', reason: 'Source excluded.' }, { sourceId: 'last-2', reason: 'No supported profile evidence.' }], cloudAiUsed: false }
  mocks.post.mockReset().mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('The next scan batch was interrupted.')).mockResolvedValueOnce(last)
  await act(async () => root.render(<ProfileCapturePanel disabled={false} onClose={() => {}} />)); await act(async () => button('Saved sources').click()); await act(async () => button('Scan saved Reader sources').click())
  expect(host.textContent).toContain('10 of 12 sources checked'); expect(host.textContent).toContain('1 capture staged · 9 sources skipped')
  await act(async () => button('Scan next sources').click()); const secondInput = mocks.post.mock.calls[1][1]; expect(secondInput).toMatchObject({ offset: 10, limit: 10 }); expect(host.textContent).toContain('10 of 12 sources checked')
  await act(async () => button('Scan next sources').click()); expect(mocks.post.mock.calls[2]).toEqual(['scan-saved', secondInput]); expect(host.textContent).toContain('12 of 12 sources checked'); expect(host.textContent).toContain('1 capture staged · 11 sources skipped')
})

it('finds accepted originals in the paged archive and resets pagination when its status changes', async () => {
  mocks.query.mockImplementation((path: string | null, initial: unknown) => ({ data: path === 'profile-capture/capture-1' ? draft : path?.startsWith('profile-capture?') ? { drafts: [draft], total: 31, nextOffset: path.includes('offset=0') ? 30 : null } : initial, loading: false, error: '', refresh: vi.fn() }))
  await act(async () => root.render(<ProfileCapturePanel disabled={false} onClose={() => {}} />)); await act(async () => button('Next').click())
  expect(mocks.query.mock.calls.some(([path]) => path === 'profile-capture?limit=30&offset=30&status=pending')).toBe(true)
  draft = { ...draft, status: 'accepted' }
  await act(async () => { const select = host.querySelector<HTMLSelectElement>('[aria-label="Capture archive status"]')!; select.value = 'accepted'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(mocks.query.mock.calls.some(([path]) => path === 'profile-capture?limit=30&offset=0&status=accepted')).toBe(true)
  expect(host.textContent).toContain('Capture archive 31'); expect(host.textContent).toContain('Accepted · Original retained')
  await act(async () => host.querySelector<HTMLButtonElement>('.crm-capture-inbox button')!.click())
  expect(host.textContent).toContain('Profile saved.'); expect(host.textContent).toContain('Visible profile biography.'); expect(host.textContent).toContain('Download original capture')
  expect(host.querySelector('.crm-capture-field-list')).toBeNull(); expect(mocks.post).not.toHaveBeenCalled()
})
