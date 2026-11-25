// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCrmRecord } from '../../src/crm/model.ts'
import type { CrmDetail } from '../../src/crm/client.ts'
import type { CrmCalendarEvent } from '../../src/crm/connectionTypes.ts'
import PersonInspector from '../../src/crm/PersonInspector.tsx'

const mocks = vi.hoisted(() => ({ command: vi.fn(), get: vi.fn(), all: vi.fn(), download: vi.fn(), refresh: vi.fn(), upload: vi.fn(), portrait: vi.fn(), writer: true, details: new Map<string, unknown>() }))
vi.mock('../../src/crm/commentMedia.ts', () => ({ retainCrmCommentFiles: mocks.upload, retainCrmPortrait: mocks.portrait }))
vi.mock('../../src/data/repo.ts', async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), useRepoStatus: (select: (state: { writer: boolean }) => unknown) => select({ writer: mocks.writer }) }))
vi.mock('../../src/crm/client.ts', () => ({
  crmCommand: mocks.command, crmGet: mocks.get, crmAll: mocks.all, downloadCrm: mocks.download,
  crmMessage: (cause: unknown) => cause instanceof Error ? cause.message : String(cause),
  personName: (person: { fullName: string; emails: string[] }) => person.fullName || person.emails[0] || 'Unnamed contact',
  useCrmQuery: (path: string) => ({ data: mocks.details.get(path) ?? null, loading: false, error: '', refresh: mocks.refresh }),
}))
vi.mock('../../src/crm/CrmControls.tsx', () => ({ CrmAvatar: () => <span>Local portrait</span> }))
const calendarEvent: CrmCalendarEvent = { id: 'event_1', accountId: 'google_personal', calendarId: 'primary', iCalUID: 'original-uid', title: 'Research lunch', body: 'Original context', status: 'confirmed', startAt: 1806400000000, endAt: 1806403600000, timezone: 'America/New_York', allDay: false, htmlLink: 'https://calendar.google.com/calendar/event?eid=test', attendees: [], organizer: { email: 'host@example.test', name: 'Host' }, updated: '', originalStartTime: '', raw: { id: 'event_1', summary: 'Research lunch' } }
vi.mock('../../src/crm/CrmConnections.tsx', () => ({ CalendarPicker: ({ onSelect, onClose }: { onSelect: (value: CrmCalendarEvent) => Promise<void>; onClose: () => void }) => <div><button onClick={() => void onSelect(calendarEvent)}>Use selected source event</button><button onClick={onClose}>Close picker</button></div> }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement
const changed = vi.fn(), closed = vi.fn()
const makeDetail = (id = 'per_1'): CrmDetail => ({ revision: 4, collection: 'people', record: createCrmRecord('people', { id, revision: 3, fullName: id === 'per_1' ? 'Test Person' : 'Another Person', emails: ['reader@example.test'] }, 1000), related: { companies: [], memberships: [], groups: [], fields: [], fieldValues: [], notes: [createCrmRecord('notes', { id: 'note_1', body: '<p>Kept observation</p><img src=x onerror=alert(1)>', visibility: 'private', authorName: '', entityRefs: [{ type: 'person', id }] }, 1000)], tasks: [], interactions: [], relationships: [], history: [] } })
beforeEach(() => {
  mocks.writer = true; mocks.command.mockReset().mockResolvedValue({ ok: true, revision: 5, operation: 'comment' }); mocks.get.mockReset().mockResolvedValue({ rows: [] }); mocks.all.mockReset().mockResolvedValue([]); mocks.upload.mockReset().mockResolvedValue([{ assetId: `crm-file-${'a'.repeat(64)}`, name: 'research.pdf', mime: 'application/pdf', bytes: 800 }]); mocks.download.mockClear(); mocks.refresh.mockClear(); mocks.details.clear(); changed.mockClear(); closed.mockClear()
  mocks.details.set('people/per_1', makeDetail()); mocks.details.set('people/per_2', makeDetail('per_2'))
  mocks.portrait.mockReset().mockResolvedValue({ assetId: `crm-avatar-${'b'.repeat(64)}`, name: 'portrait.png', mime: 'image/png', bytes: 1000 })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })
async function render(id = 'per_1') { await act(async () => root.render(<PersonInspector person={makeDetail(id).record} onClose={closed} onChanged={changed} />)) }
function button(label: string) { const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label); expect(found, label).toBeDefined(); return found! }
async function click(label: string) { await act(async () => button(label).click()) }
async function input(label: string, value: string) {
  const element = host.querySelector<HTMLTextAreaElement | HTMLInputElement>(`[aria-label="${label}"]`)!
  expect(element).not.toBeNull()
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}

it('renders original note text safely, preserving missing author and private visibility without a cloud request', async () => {
  await render()
  expect(host.textContent).toContain('Kept observation')
  expect(host.textContent).toContain('Original author unavailable')
  expect(host.textContent).toContain('private')
  expect(host.querySelector('img')).toBeNull()
  expect(mocks.command).not.toHaveBeenCalled()
  expect(mocks.all.mock.calls.map(call => call[0])).toEqual(['groups', 'members'])
})

it('keeps a failed comment draft and retries with the same request identity before clearing on durable success', async () => {
  mocks.command.mockRejectedValueOnce(new Error('Connection interrupted'))
  await render(); await input('Comment', 'A note worth keeping.'); await click('Add comment')
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.value).toBe('A note worth keeping.')
  expect(host.textContent).toContain('Connection interrupted')
  const first = mocks.command.mock.calls[0][0]
  await click('Add comment')
  expect(mocks.command.mock.calls[1][0]).toEqual(first)
  expect(first).toMatchObject({ operation: 'comment', record: { body: 'A note worth keeping.', visibility: 'private', entityRefs: [{ type: 'person', id: 'per_1' }] } })
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.value).toBe('')
  expect(changed).toHaveBeenCalledTimes(1)
})

it('scopes reply parents and pin edits to the actual saved record revision', async () => {
  await render(); await click('Reply'); await input('Comment', 'Thread reply'); await click('Save reply')
  expect(mocks.command.mock.calls[0][0]).toMatchObject({ operation: 'comment', record: { parentId: 'note_1', body: 'Thread reply' } })
  await click('Pin comment')
  expect(mocks.command.mock.calls[1][0]).toMatchObject({ operation: 'update', collection: 'notes', id: 'note_1', expectedRecordRevision: 1, patch: { pinned: true } })
})

it('never carries a draft or reply into a different selected person', async () => {
  await render(); await input('Comment', 'Only for the first person'); await render('per_2')
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.value).toBe('')
  expect(host.textContent).toContain('Another Person')
  expect(mocks.command).not.toHaveBeenCalled()
})

it('logs the selected calendar source idempotently and leaves attendance unconfirmed', async () => {
  await render(); await click('From calendar'); await click('Use selected source event')
  expect(mocks.command.mock.calls[0][0]).toMatchObject({ operation: 'log_calendar', record: { title: 'Research lunch', personIds: ['per_1'], attendanceConfirmed: false, sourceRefs: [{ provider: 'google-calendar', accountId: 'google_personal', externalId: 'primary:event_1' }], raw: { id: 'event_1' } } })
  expect(host.textContent).toContain('Attendance remains unconfirmed')
})

it('downloads an enrichment brief with a revision-bound proposal schema and keeps application AI off', async () => {
  await render(); await click('Details'); await click('Download enrichment brief ')
  const [filename, value] = mocks.download.mock.calls[0]
  expect(filename).toBe('Worldview-enrichment-per_1.json')
  expect(value).toMatchObject({ contact: { id: 'per_1', emails: ['reader@example.test'] }, proposals: [{ collection: 'people', targetId: 'per_1', expectedRecordRevision: 1, patch: {}, evidence: [{ label: expect.any(String), url: expect.any(String) }], explanation: expect.any(String) }] })
  expect(value.contact).not.toHaveProperty('raw')
  expect(mocks.command).not.toHaveBeenCalled()
})

it('keeps retained profile captures findable and shows education changes in history comparisons', async () => {
  const detail = makeDetail(), before = { ...detail.record, affiliations: [{ id: 'school', kind: 'education' as const, organization: 'Earlier University', degree: 'BA', evidence: [] }] }, after = { ...detail.record, affiliations: [{ id: 'school', kind: 'education' as const, organization: 'Corrected University', degree: 'MA', evidence: [] }] }
  detail.record.profileCaptureIds = ['capture_one', 'capture_one', 'capture_two']
  detail.related.history = [createCrmRecord('history', { id: 'history_school', operation: 'update', collection: 'people', recordId: detail.record.id, before, after, actor: 'profile-capture' }, 1000)]
  mocks.details.set('people/per_1', detail)
  await render(); await click('Details')
  const links = [...host.querySelectorAll<HTMLAnchorElement>('.crm-person-capture-sources a')]
  expect(links.map(link => link.getAttribute('href'))).toEqual(['#/people?capture=capture_one', '#/people?capture=capture_two'])
  await click('History'); const previews = [...host.querySelectorAll('.crm-person-history pre')].map(value => value.textContent)
  expect(previews[0]).toContain('Earlier University'); expect(previews[0]).toContain('BA'); expect(previews[1]).toContain('Corrected University'); expect(previews[1]).toContain('MA')
  expect(mocks.command).not.toHaveBeenCalled()
})

it('keeps the contact view available while preventing edits from a read-only window', async () => {
  mocks.writer = false
  await render()
  expect(host.textContent).toContain('Read only in this window')
  expect(host.querySelector<HTMLFieldSetElement>('.crm-person-edit-scope')!.disabled).toBe(true)
  await click('Add comment')
  expect(mocks.command).not.toHaveBeenCalled()
  await click('Close contact')
  expect(closed).toHaveBeenCalledOnce()
})

it('adds bold formatting and local member references to the exact comment payload', async () => {
  mocks.all.mockImplementation(async (collection: string) => collection === 'members' ? [createCrmRecord('members', { id: 'usr_1', name: 'Workspace Owner', email: 'owner@example.test', role: 'owner' })] : [])
  await render(); await input('Comment', 'Remember this')
  const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!
  textarea.setSelectionRange(0, 8)
  await click('Bold selected comment text')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)) })
  textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  const dropdown = host.querySelector<HTMLSelectElement>('[aria-label="Mention a workspace member"]')!
  await act(async () => { dropdown.value = 'usr_1'; dropdown.dispatchEvent(new Event('change', { bubbles: true })) })
  await click('Add comment')
  expect(mocks.command.mock.calls[0][0]).toMatchObject({ operation: 'comment', record: { bodyFormat: 'markdown', body: expect.stringContaining('**Remember**'), mentionIds: ['usr_1'] } })
})

it('retains attached originals through a failed save and links their metadata after a successful retry', async () => {
  mocks.command.mockRejectedValueOnce(new Error('Save interrupted'))
  await render(); await input('Comment', 'The source document')
  const picker = host.querySelector<HTMLInputElement>('[aria-label="Comment attachment files"]')!
  Object.defineProperty(picker, 'files', { configurable: true, value: [{ name: 'research.pdf' }] })
  await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(host.textContent).toContain('research.pdf')
  await click('Add comment')
  expect(host.textContent).toContain('Save interrupted')
  expect(host.textContent).toContain('research.pdf')
  const first = mocks.command.mock.calls[0][0]
  expect(first.record).toMatchObject({ attachmentAssetIds: [`crm-file-${'a'.repeat(64)}`], attachments: [{ name: 'research.pdf', bytes: 800 }] })
  await click('Add comment')
  expect(mocks.command.mock.calls[1][0]).toEqual(first)
  expect(host.textContent).not.toContain('research.pdf')
})

it('renders new Markdown safely while leaving original imported HTML inert', async () => {
  const detail = makeDetail()
  detail.related.notes.push(createCrmRecord('notes', { id: 'note_markdown', bodyFormat: 'markdown', body: '**Strong** and *emphasis* [source](https://example.test) [bad](javascript:alert(1)) <script>unsafe()</script>', entityRefs: [{ type: 'person', id: 'per_1' }] }))
  mocks.details.set('people/per_1', detail)
  await render()
  expect(host.querySelector('.crm-person-note-markdown strong')!.textContent).toBe('Strong')
  expect(host.querySelector('.crm-person-note-markdown em')!.textContent).toBe('emphasis')
  expect(host.querySelectorAll('.crm-person-note-markdown a')).toHaveLength(1)
  expect(host.querySelector('script')).toBeNull()
  expect(host.querySelector('img')).toBeNull()
})

it('retains a chosen portrait before a revision-bound update and keeps profile inputs available after a failed save', async () => {
  mocks.command.mockRejectedValueOnce(new Error('Profile changed elsewhere'))
  await render(); await click('Edit contact')
  const picker = host.querySelector<HTMLInputElement>('[aria-label="Contact portrait file"]')!
  Object.defineProperty(picker, 'files', { configurable: true, value: [{ name: 'portrait.png' }] })
  await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(mocks.portrait).toHaveBeenCalledOnce()
  expect(mocks.command.mock.calls[0][0]).toMatchObject({ operation: 'update', collection: 'people', id: 'per_1', expectedRecordRevision: 1, patch: { avatarAssetId: `crm-avatar-${'b'.repeat(64)}`, portraitOriginal: { name: 'portrait.png' } } })
  expect(host.textContent).toContain('Profile changed elsewhere')
  expect(button('Save details')).toBeDefined()
  expect(host.querySelector<HTMLInputElement>('.crm-person-profile-form input:not([type=file])')!.value).toBe('Test Person')
})
