// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCrmRecord, emptyCrm } from '../../src/crm/model.ts'
import type { CrmCollection, CrmSnapshot } from '../../src/crm/types.ts'
import PeopleWorkspace from '../../src/crm/PeopleWorkspace.tsx'
import PeopleNetwork from '../../src/crm/PeopleNetwork.tsx'
import CrmReview from '../../src/crm/CrmReview.tsx'
import { readCrmPresentation, writeCrmPresentation } from '../../src/crm/presentation.ts'

const scope = vi.hoisted(() => ({ writer: true, store: { info: { kind: 'sqlite' } } }))
vi.mock('../../src/data/repo.ts', async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), isRepoReady: () => true, getWorldGeneration: () => 1, getStore: () => scope.store, useRepoStatus: Object.assign((selector: (state: { writer: boolean }) => unknown) => selector({ writer: scope.writer }), { getState: () => ({ writer: scope.writer }) }) }))
vi.mock('../../src/data/auth.ts', () => ({ useAuth: (selector: (state: { user: null }) => unknown) => selector({ user: null }) }))
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: ({ count }: { count: number }) => ({ measure: vi.fn(), getTotalSize: () => count * 52, getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 52, size: 52 })) }) }))
vi.mock('../../src/crm/PersonInspector.tsx', () => ({ default: ({ person }: { person: { fullName: string } }) => <aside>Opened contact: {person.fullName}</aside> }))
vi.mock('../../src/crm/CrmConnections.tsx', () => ({ CrmConnections: () => <div>Connection setup</div> }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement, state: CrmSnapshot, fingerprint: string
const requests: Record<string, unknown>[] = [], receipts = new Map<string, unknown>()
const selectPerson = vi.fn()
const record = <K extends CrmCollection>(collection: K, input: Record<string, unknown>) => createCrmRecord(collection, input, 1000)
function fixture(): CrmSnapshot {
  return { ...emptyCrm(), revision: 5,
    people: [record('people', { id: 'per_1', fullName: 'Ada Example', emails: ['ada@example.test'] }), record('people', { id: 'per_2', fullName: 'Basil Example', emails: ['basil@example.test'] }), record('people', { id: 'per_3', fullName: 'Cleo Example', emails: ['cleo@example.test'] })],
    groups: [record('groups', { id: 'grp_1', name: 'Research', entityTypes: ['person', 'company'] }), record('groups', { id: 'grp_2', name: 'Friends' })],
    memberships: [record('memberships', { id: 'mem_1', groupId: 'grp_1', entityType: 'person', entityId: 'per_1' }), record('memberships', { id: 'mem_2', groupId: 'grp_1', entityType: 'person', entityId: 'per_2' }), record('memberships', { id: 'mem_3', groupId: 'grp_2', entityType: 'person', entityId: 'per_1' })],
    fields: [record('fields', { id: 'field_a', groupId: 'grp_1', entityType: 'person', name: 'Status', type: 'singleSelect', options: [{ id: 'a_new', label: 'New', order: 0 }, { id: 'a_met', label: 'Met', order: 1 }] }), record('fields', { id: 'field_b', groupId: 'grp_2', entityType: 'person', name: 'Status', type: 'singleSelect', options: [{ id: 'b_close', label: 'Close', order: 0 }] })],
    fieldValues: [record('fieldValues', { id: 'value_a', fieldId: 'field_a', groupId: 'grp_1', entityType: 'person', entityId: 'per_1', value: 'a_new' }), record('fieldValues', { id: 'value_original', fieldId: 'field_a', groupId: 'grp_1', entityType: 'person', entityId: 'per_2', value: 'Archived original stage' }), record('fieldValues', { id: 'value_b', fieldId: 'field_b', groupId: 'grp_2', entityType: 'person', entityId: 'per_1', value: 'b_close' })],
    relationships: [record('relationships', { id: 'edge_confirmed', from: { type: 'person', id: 'per_2' }, to: { type: 'person', id: 'per_3' }, relation: 'introduced', confirmed: true }), record('relationships', { id: 'edge_candidate', from: { type: 'person', id: 'per_1' }, to: { type: 'person', id: 'per_2' }, relation: 'possible', confirmed: false }), record('relationships', { id: 'edge_company', from: { type: 'person', id: 'per_1' }, to: { type: 'company', id: 'com_1' }, relation: 'works at', confirmed: true })],
    interactions: [record('interactions', { id: 'event_1', title: 'Shared event', personIds: ['per_1', 'per_2'], status: 'scheduled', attendanceConfirmed: false })],
    proposals: [record('proposals', { id: 'proposal_1', collection: 'people', targetId: 'per_1', expectedRecordRevision: 1, patch: { jobTitle: 'Researcher' }, evidence: [{ label: 'Official profile', url: 'https://example.test/profile' }], explanation: 'A supported role', clientId: 'local' })],
    candidates: [record('candidates', { id: 'candidate_1', kind: 'update', targetId: 'per_1', provider: 'import-update', accountId: 'test', externalId: 'test-update', payload: { collection: 'people', patch: { location: 'New York' } } })],
  }
}
function detail(collection: CrmCollection, id: string) { const found = state[collection].find(row => row.id === id); return { revision: state.revision, collection, record: found, related: { companies: [], groups: [], memberships: [], fields: [], fieldValues: [], notes: [], tasks: [], interactions: [], relationships: [], history: [] } } }
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input), 'http://localhost'), path = url.pathname.replace('/api/crm/', ''), params = url.searchParams
  if (init?.method === 'POST') {
    const command = JSON.parse(String(init.body)) as Record<string, unknown>
    requests.push(command)
    if (receipts.has(String(command.requestId))) return response(receipts.get(String(command.requestId)))
    if (command.operation === 'pipeline_move') { const saved = state.fieldValues.find(row => row.fieldId === command.fieldId && row.entityId === (command.entity as { id: string }).id)!; saved.value = command.value as string; saved.revision++ }
    if (command.operation === 'create' && command.collection === 'proposals') state.proposals.push(record('proposals', command.record as Record<string, unknown>))
    if (command.operation === 'review_proposal') state.proposals.find(row => row.id === command.id)!.status = command.approve === false ? 'rejected' : 'approved'
    if (command.operation === 'review_candidate') state.candidates.find(row => row.id === command.id)!.status = command.accept === false ? 'dismissed' : 'accepted'
    state.revision++
    const result = { ok: true, operation: command.operation, revision: state.revision }
    receipts.set(String(command.requestId), result); return response(result)
  }
  if (path === 'status') return response({ available: true, workspaceFingerprint: fingerprint, revision: state.revision, schemaVersion: 1, counts: Object.fromEntries(Object.entries(state).filter(([, rows]) => Array.isArray(rows)).map(([key, rows]) => [key, { active: (rows as unknown[]).length, total: (rows as unknown[]).length }])), pendingCandidates: state.candidates.length, pendingProposals: state.proposals.filter(row => row.status === 'pending').length, dueTasks: 0, cloudEnrichment: false, sendingEnabled: false })
  if (path === 'duplicates') return response({ revision: state.revision, duplicates: [{ firstId: 'per_1', secondId: 'per_2', reasons: ['matching-profile-url'] }] })
  const [collection, id] = path.split('/') as [CrmCollection, string | undefined]
  if (id) return response(detail(collection, decodeURIComponent(id)))
  let rows = [...state[collection]]
  if (params.get('status')) rows = rows.filter(row => row.status === params.get('status'))
  if (params.get('groupId')) { const allowed = new Set(state.memberships.filter(member => member.groupId === params.get('groupId')).map(member => member.entityId)); rows = rows.filter(row => allowed.has(row.id)) }
  if (params.get('q')) rows = rows.filter(row => JSON.stringify(row).toLowerCase().includes(params.get('q')!.toLowerCase()))
  return response({ revision: state.revision, collection, rows, total: rows.length, nextOffset: null })
})
beforeEach(() => {
  state = fixture(); fingerprint = 'workspace-test-one'; sessionStorage.clear(); scope.writer = true; requests.length = 0; receipts.clear(); fetcher.mockClear(); selectPerson.mockClear()
  vi.stubGlobal('fetch', fetcher); vi.stubGlobal('crypto', webcrypto)
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open') } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function until(predicate: () => boolean) { for (let index = 0; index < 100 && !predicate(); index++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }); expect(predicate()).toBe(true) }
function button(label: string) { const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label); expect(result, label).toBeDefined(); return result! }
async function click(label: string) { await act(async () => button(label).click()) }
async function select(element: HTMLSelectElement, value: string) { await act(async () => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })) }) }
async function upload(value: unknown) { const text = JSON.stringify(value), file = { size: text.length, text: async () => text } as File, field = host.querySelector<HTMLInputElement>('input[type=file]')!; Object.defineProperty(field, 'files', { configurable: true, value: [file] }); await act(async () => { field.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 10)) }) }

it('renders the real virtual table, keeps unknown pipeline cards visible and moves only the correct group field', async () => {
  await act(async () => root.render(<PeopleWorkspace hash="#/people" />)); await until(() => host.textContent!.includes('Ada Example'))
  expect(host.querySelectorAll('table tbody tr')).toHaveLength(3)
  await act(async () => host.querySelector<HTMLButtonElement>('[title="Research"]')!.click()); await click('Pipeline')
  await until(() => !!host.querySelector('[aria-label="Move Ada Example to stage"]'))
  expect(host.textContent).toContain('Original / unavailable stage')
  expect(host.querySelector('[aria-label="Move Basil Example to stage"]')).not.toBeNull()
  await select(host.querySelector<HTMLSelectElement>('[aria-label="Move Ada Example to stage"]')!, 'a_met')
  await until(() => requests.some(request => request.operation === 'pipeline_move'))
  expect(requests.find(request => request.operation === 'pipeline_move')).toMatchObject({ fieldId: 'field_a', entity: { type: 'person', id: 'per_1' }, value: 'a_met', expectedRecordRevision: 1 })
  expect(state.fieldValues.find(row => row.id === 'value_b')!.value).toBe('b_close')
})

it('prevents write controls in the read-only table while keeping the saved records visible', async () => {
  scope.writer = false
  await act(async () => root.render(<PeopleWorkspace hash="#/people" />)); await until(() => host.textContent!.includes('Ada Example'))
  expect(button('Add person').disabled).toBe(true)
  expect(button('Save view').disabled).toBe(true)
  expect(button('Create group').disabled).toBe(true)
  expect(requests).toHaveLength(0)
})

it('requires a fresh company comparison after another edit and leaves untouched source URLs unchanged', async () => {
  state.companies.push(record('companies', { id: 'company_one', name: 'Example Company', domain: 'example.org', urls: ['https://example.org/?a,b', 'https://example.org/?a,b'] }))
  await act(async () => root.render(<PeopleWorkspace hash="#/people?tab=companies" />)); await until(() => host.textContent!.includes('Example Company'))
  await act(async () => host.querySelector<HTMLButtonElement>('.crm-person-cell')!.click()); await until(() => !!host.querySelector('.crm-entity-inspector form'))
  state.companies[0].revision = 2; state.companies[0].description = 'A newer saved description'
  await act(async () => window.dispatchEvent(new Event('worldview:crm-changed'))); await until(() => host.textContent!.includes('This record changed while you were editing'))
  expect(button('Save changes').disabled).toBe(true); expect(requests).toHaveLength(0)
  await click('Review latest details'); await click('Save changes')
  await until(() => requests.some(value => value.operation === 'update'))
  const command = requests.find(value => value.operation === 'update')!
  expect(command).toMatchObject({ collection: 'companies', id: 'company_one', expectedRecordRevision: 2, patch: { description: 'A newer saved description' } })
  expect(command.patch).not.toHaveProperty('urls'); expect(state.companies[0].urls).toEqual(['https://example.org/?a,b', 'https://example.org/?a,b'])
})

it('switches to the portrait gallery with safe social links, selection and the existing contact inspector', async () => {
  state.people[0].urls = ['https://www.linkedin.com/in/ada-example', 'javascript:alert(1)']
  await act(async () => root.render(<PeopleWorkspace hash="#/people" />)); await until(() => host.textContent!.includes('Ada Example'))
  await click('Gallery')
  expect(host.querySelectorAll('.crm-contact-card')).toHaveLength(3)
  const link = host.querySelector<HTMLAnchorElement>('.crm-contact-gallery a')!
  expect(link.href).toBe('https://www.linkedin.com/in/ada-example')
  expect(link.rel).toContain('noopener')
  expect(host.querySelector('a[href^="javascript:"]')).toBeNull()
  await act(async () => host.querySelector<HTMLInputElement>('[aria-label="Select Ada Example"]')!.click())
  expect(host.querySelector('.crm-contact-card')?.getAttribute('data-selected')).toBe('true')
  expect(host.textContent).toContain('1 selected on this page')
  await click('Open Ada Example'); await until(() => host.textContent!.includes('Opened contact: Ada Example'))
  expect(requests).toHaveLength(0)
})

it('draws only confirmed personal edges and renders shared events as separate, opt-in context', async () => {
  await act(async () => root.render(<PeopleNetwork onSelectPerson={selectPerson} />)); await until(() => !!host.querySelector('.crm-graph-person'))
  expect(host.querySelectorAll('.crm-graph-edges line')).toHaveLength(1)
  expect(host.querySelector('.crm-graph-edges')!.textContent).toContain('introduced')
  expect(host.querySelectorAll('.crm-event-context')).toHaveLength(0)
  await act(async () => host.querySelector<HTMLInputElement>('.crm-context-toggle input')!.click())
  expect(host.querySelectorAll('.crm-event-context')).toHaveLength(1)
  expect(host.querySelector('.crm-event-context')!.textContent).toContain('attendance unconfirmed')
  expect(host.querySelectorAll('.crm-graph-edges line')).toHaveLength(1)
  expect(requests).toHaveLength(0)
})

it('allows graph selection in read-only mode but disables adding a personal connection', async () => {
  scope.writer = false
  await act(async () => root.render(<PeopleNetwork onSelectPerson={selectPerson} />)); await until(() => !!host.querySelector('.crm-graph-person'))
  await act(async () => host.querySelector<SVGGElement>('[aria-label="Ada Example"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(button('Connect').disabled).toBe(true)
  await click('Open selected contact')
  expect(selectPerson).toHaveBeenCalledWith(expect.objectContaining({ id: 'per_1' }))
  expect(requests).toHaveLength(0)
})

it('shows actual proposed fields and evidence before approving one revision-bound enrichment', async () => {
  await act(async () => root.render(<CrmReview onSelectPerson={selectPerson} />)); await until(() => host.textContent!.includes('Updated source record'))
  const enrichment = [...host.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(item => item.textContent!.startsWith('Enrichment'))!
  await act(async () => enrichment.click()); await until(() => host.textContent!.includes('A supported role'))
  await click('Compare'); await until(() => host.textContent!.includes('Official profile'))
  expect(host.textContent).toContain('Researcher')
  expect(requests).toHaveLength(0)
  await click('Approve change')
  expect(requests[0]).toMatchObject({ operation: 'review_proposal', id: 'proposal_1', expectedRecordRevision: 1, approve: true })
})

it('keeps review comparisons readable and all approval, dismissal and upload actions disabled in a read-only window', async () => {
  scope.writer = false
  await act(async () => root.render(<CrmReview onSelectPerson={selectPerson} />)); await until(() => host.textContent!.includes('Updated source record'))
  expect(button('Import enrichment proposals').disabled).toBe(true)
  await click('Compare'); await until(() => host.textContent!.includes('New York'))
  expect(button('Add source details').disabled).toBe(true)
  expect(button('Dismiss').disabled).toBe(true)
  expect(requests).toHaveLength(0)
})

it('validates the entire proposal upload before any writes, then retries the same valid file without duplicate identities', async () => {
  await act(async () => root.render(<CrmReview onSelectPerson={selectPerson} />)); await until(() => host.textContent!.includes('Updated source record'))
  const proposal = { collection: 'people', targetId: 'per_1', expectedRecordRevision: 1, patch: { location: 'New York' }, evidence: [{ label: 'Profile', url: 'https://example.test' }], explanation: 'Supported location' }
  await upload({ proposals: [proposal, { ...proposal, patch: null }] })
  expect(requests).toHaveLength(0)
  expect(host.textContent).toContain('nonempty patch')
  await upload({ proposals: [proposal] }); await until(() => requests.length === 1)
  await upload({ proposals: [proposal] }); await until(() => requests.length === 2)
  expect(requests[1]).toEqual(requests[0])
  expect(state.proposals).toHaveLength(2)
  expect(state.proposals[1]).toMatchObject({ status: 'pending', expectedRecordRevision: 1 })
})

function identityCandidate(input: Record<string, unknown>) {
  state.candidates = [record('candidates', { id: 'identity_1', kind: 'person', provider: 'google-contacts', accountId: 'account_1', externalId: 'source_1', payload: { fullName: 'Incoming Source Person', emails: ['ada@example.test'], jobTitle: 'Source role' }, confidence: 'possible', matchingPersonIds: [], evidence: [{ label: 'Exact normalized email only; compare before accepting.' }], ...input })]
}
async function openIdentityReview() {
  await act(async () => root.render(<CrmReview onSelectPerson={selectPerson} />))
  await until(() => host.textContent!.includes('Incoming Source Person'))
  await click('Compare')
  await until(() => !!host.querySelector('.crm-dialog-actions'))
}

it('preselects a unique exact-signal person only for comparison and approves with that target’s fetched revision', async () => {
  state.people[0].revision = 7
  identityCandidate({ targetId: 'per_1', matchingPersonIds: ['per_1'] })
  await openIdentityReview()
  const choice = host.querySelector<HTMLInputElement>('[aria-label="Use existing person: Ada Example"]')!
  expect(choice.checked).toBe(true)
  expect(host.querySelector('.crm-source-identity')!.textContent).toContain('ada@example.test')
  expect(host.querySelector('.crm-diff')!.textContent).toContain('Ada Example')
  expect(requests).toHaveLength(0)
  await click('Add source details')
  expect(requests[0]).toMatchObject({ operation: 'review_candidate', id: 'identity_1', expectedRecordRevision: 1, targetId: 'per_1', expectedTargetRevision: 7, accept: true })
  expect(requests[0]).not.toHaveProperty('createSeparate')
})

it('requires an explicit ambiguous identity decision and compares the selected contact’s latest saved revision', async () => {
  identityCandidate({ targetId: null, matchingPersonIds: ['per_1', 'per_2'] })
  await openIdentityReview()
  expect(button('Choose a person first').disabled).toBe(true)
  expect(host.querySelectorAll<HTMLInputElement>('.crm-source-identity input:checked')).toHaveLength(0)
  expect(host.querySelector('.crm-source-identity')!.textContent).toContain('Basil Example')
  expect(host.querySelector('.crm-source-identity')!.textContent).toContain('basil@example.test')
  expect(requests).toHaveLength(0)
  state.people[1].revision = 9
  state.people[1].jobTitle = 'Edited while reviewing'
  await act(async () => host.querySelector<HTMLInputElement>('[aria-label="Use existing person: Basil Example"]')!.click())
  await until(() => !!host.querySelector('.crm-diff')!.textContent?.includes('Edited while reviewing'))
  await click('Add source details')
  expect(requests[0]).toMatchObject({ operation: 'review_candidate', targetId: 'per_2', expectedTargetRevision: 9, accept: true })
})

it('lets a suggested match be explicitly kept separate without sending the suggested target identity', async () => {
  identityCandidate({ targetId: 'per_1', matchingPersonIds: ['per_1'] })
  await openIdentityReview()
  await act(async () => host.querySelector<HTMLInputElement>('.crm-identity-separate input')!.click())
  expect(host.querySelector('.crm-diff')!.textContent).not.toContain('Ada Example')
  await click('Create separate person')
  expect(requests[0]).toMatchObject({ operation: 'review_candidate', id: 'identity_1', createSeparate: true, accept: true })
  expect(requests[0]).not.toHaveProperty('targetId')
  expect(requests[0]).not.toHaveProperty('expectedTargetRevision')
})

it('keeps an established provider identity attached to its existing person and hides separate creation', async () => {
  identityCandidate({ targetId: 'per_1', sourceIdentityEstablished: true })
  await openIdentityReview()
  expect(host.textContent).toContain('This source already belongs to a person')
  expect(host.querySelector('.crm-identity-separate')).toBeNull()
  await click('Add source details')
  expect(requests[0]).toMatchObject({ targetId: 'per_1', expectedTargetRevision: 1, accept: true })
  expect(requests[0]).not.toHaveProperty('createSeparate')
})

it('never invents an identity match from a shared display name', async () => {
  identityCandidate({ targetId: null, payload: { fullName: 'Ada Example', emails: ['different@example.test'] } })
  await act(async () => root.render(<CrmReview onSelectPerson={selectPerson} />))
  await until(() => host.textContent!.includes('Ada Example'))
  await click('Compare')
  expect(host.querySelector('.crm-source-identity')).toBeNull()
  await click('Add to People')
  expect(requests[0]).toMatchObject({ createSeparate: true, accept: true })
  expect(requests[0]).not.toHaveProperty('targetId')
  expect(fetcher.mock.calls.some(call => String(call[0]).includes('/people/per_1'))).toBe(false)
})

it('keeps identity comparisons available in a read-only window without accepting either identity choice', async () => {
  scope.writer = false
  identityCandidate({ targetId: null, matchingPersonIds: ['per_1', 'per_2'] })
  await openIdentityReview()
  await act(async () => host.querySelector<HTMLInputElement>('[aria-label="Use existing person: Basil Example"]')!.click())
  expect(button('Add source details').disabled).toBe(true)
  await act(async () => host.querySelector<HTMLInputElement>('.crm-identity-separate input')!.click())
  expect(button('Create separate person').disabled).toBe(true)
  expect(requests).toHaveLength(0)
})

it('does not accept a suggested contact that was archived after staging', async () => {
  state.people[0].archivedAt = 2000
  identityCandidate({ targetId: 'per_1', matchingPersonIds: ['per_1'] })
  await openIdentityReview()
  expect(host.textContent).toContain('Matching contact unavailable')
  expect(button('Add source details').disabled).toBe(true)
  expect(requests).toHaveLength(0)
})

async function typeInput(element: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function remountPeople(hash = '#/people') { await act(async () => root.unmount()); root = createRoot(host); await act(async () => root.render(<PeopleWorkspace hash={hash} />)) }

it('restores group, Gallery, search, applied filters and columns after remount only for the same server workspace', async () => {
  await act(async () => root.render(<PeopleWorkspace hash="#/people" />)); await until(() => host.textContent!.includes('Ada Example'))
  await act(async () => host.querySelector<HTMLButtonElement>('[title="Research"]')!.click()); await click('Gallery')
  await typeInput(host.querySelector<HTMLInputElement>('[aria-label="Search contacts"]')!, 'Ada')
  await click('Filter'); await click('Condition'); await typeInput(host.querySelector<HTMLInputElement>('[aria-label="Filter value"]')!, 'Example'); await click('Apply filters')
  await click('Columns'); const email = [...host.querySelectorAll<HTMLLabelElement>('.crm-columns-panel label')].find(label => label.textContent?.trim() === 'Email')!.querySelector<HTMLInputElement>('input')!; await act(async () => email.click())
  await until(() => readCrmPresentation('local', fingerprint)?.query === 'Ada')
  const saved = readCrmPresentation('local', fingerprint)!; expect(saved).toMatchObject({ groupId: 'grp_1', layout: 'gallery', query: 'Ada', filter: { op: 'and', rules: [{ field: 'fullName', operator: 'contains', value: 'Example' }] } }); expect(saved.columns).not.toContain('emails')
  await remountPeople(); await until(() => !!host.querySelector('.crm-contact-gallery'))
  expect(host.querySelector<HTMLButtonElement>('[title="Research"]')!.getAttribute('aria-current')).toBe('page'); expect(host.querySelector<HTMLInputElement>('[aria-label="Search contacts"]')!.value).toBe('Ada'); expect(button('Filter').classList.contains('is-active')).toBe(true)
  await click('Columns'); expect([...host.querySelectorAll<HTMLLabelElement>('.crm-columns-panel label')].find(label => label.textContent?.trim() === 'Email')!.querySelector<HTMLInputElement>('input')!.checked).toBe(false)
  fingerprint = 'workspace-test-replacement'; await remountPeople(); await until(() => !!host.querySelector('.crm-table'))
  expect(host.querySelector<HTMLInputElement>('[aria-label="Search contacts"]')!.value).toBe(''); expect(host.querySelector<HTMLButtonElement>('[title="Research"]')!.hasAttribute('aria-current')).toBe(false); expect(button('Filter').classList.contains('is-active')).toBe(false); expect(readCrmPresentation('local', fingerprint)).toMatchObject({ groupId: '', query: '', layout: 'table', filter: null })
  expect(requests).toHaveLength(0)
})

it('honors an explicit Connections deep link over cached group navigation and never restores a contact selection', async () => {
  writeCrmPresentation('local', fingerprint, { area: 'people', groupId: 'grp_1', layout: 'gallery', query: 'Ada', filter: null, columns: ['name'], sort: [], viewId: '' })
  await act(async () => root.render(<PeopleWorkspace hash="#/people?tab=connections" />)); await until(() => host.textContent!.includes('Connection setup'))
  expect(readCrmPresentation('local', fingerprint)).toMatchObject({ area: 'connections', groupId: '' }); expect(host.textContent).not.toContain('Opened contact:'); expect(requests).toHaveLength(0)
})

it('opens a contact deep link after presentation restoration instead of clearing the fetched selection', async () => {
  await act(async () => root.render(<PeopleWorkspace hash="#/people?person=per_1" />)); await until(() => host.textContent!.includes('Opened contact: Ada Example'))
  await remountPeople('#/people?person=per_1'); await until(() => host.textContent!.includes('Opened contact: Ada Example')); expect(requests).toHaveLength(0)
})
