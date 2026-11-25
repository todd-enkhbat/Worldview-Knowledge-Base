import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'
import { SqliteCrmStore } from '../../server/crmStore.ts'
import { createCrmRecord, crmAssetReferences, displayPerson, emptyCrm } from '../../src/crm/model.ts'
import type { CrmCollection, CrmCollectionMap } from '../../src/crm/types.ts'

let db: WorldDb, store: SqliteCrmStore, serial = 0
beforeEach(() => {
  db = openWorldDb(':memory:')
  db.putSettings({ T0: 0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: 1, schemaVersion: 1 })
  store = new SqliteCrmStore(db, { now: () => 2000 }); serial = 0
})
afterEach(() => db.close())
const cmd = (operation: string, rest: Record<string, unknown> = {}) => store.command({ requestId: `test-${++serial}`, operation, ...rest })
const create = <K extends CrmCollection>(collection: K, record: Record<string, unknown>): CrmCollectionMap[K] => cmd('create', { collection, record }).record as CrmCollectionMap[K]
const person = (id: string, rest: Record<string, unknown> = {}) => create('people', { id, fullName: id, ...rest })

describe('normalized CRM record store', () => {
  it('paginates 250 people and searches literal wildcard text without replacing all records', () => {
    const people = Array.from({ length: 260 }, (_, n) => ({ id: `p-${n}`, fullName: n === 50 ? 'Name 100%_real' : `Person ${n}` }))
    cmd('import', { collections: { people } })
    const first = store.list('people', { limit: 250 })
    expect(first).toMatchObject({ total: 260, nextOffset: 250 }); expect(first.rows).toHaveLength(250)
    expect(store.list('people', { offset: 250, limit: 250 }).rows).toHaveLength(10)
    expect(store.list('people', { q: '100%_real' }).rows.map(row => row.id)).toEqual(['p-50'])
    expect(() => store.list('people', { limit: 501 })).toThrow('at most 500')
  })
  it('preserves source data, unnamed people, unknown metadata and local edits across repeat imports', () => {
    const raw = { id: 'folk-person', futureData: { owner: ['private'] } }, imported = { id: 'folk-person', fullName: '', emails: ['private@example.test'], raw, sourceRefs: [{ provider: 'folk', accountId: 'workspace', externalId: 'folk-person' }] }
    expect(cmd('import', { collections: { people: [imported] } }).counts).toEqual({ created: 1, unchanged: 0, staged: 0 })
    const saved = store.get('people', imported.id)!; expect(displayPerson(saved)).toBe('private@example.test')
    cmd('update', { collection: 'people', id: saved.id, expectedRecordRevision: saved.revision, patch: { description: 'My own comment' } })
    expect(cmd('import', { records: { people: [imported] } }).counts).toEqual({ created: 0, unchanged: 1, staged: 0 })
    expect(store.get('people', saved.id)).toMatchObject({ description: 'My own comment', raw })
    cmd('import', { collections: { people: [{ ...imported, raw: { ...raw, futureData: { owner: ['changed'] } }, jobTitle: 'Researcher' }] } })
    expect(store.get('people', saved.id)?.jobTitle).toBe('')
    const staged = store.list('candidates').rows[0]
    expect(staged.kind).toBe('update')
    cmd('review_candidate', { id: staged.id, expectedRecordRevision: staged.revision, accept: true, expectedTargetRevision: store.get('people', saved.id)!.revision })
    expect(store.get('people', saved.id)?.jobTitle).toBe('Researcher')
  })
  it('keeps group-specific fields and supports nested filters, pipelines and multi-entity groups', () => {
    const p = person('p'), company = create('companies', { id: 'co', name: 'Company' }), group = create('groups', { id: 'g', name: 'Research', entityTypes: ['person', 'company'] })
    cmd('membership', { groupId: group.id, entity: { type: 'person', id: p.id } })
    cmd('membership', { groupId: group.id, entity: { type: 'company', id: company.id } })
    const field = create('fields', { id: 'status', groupId: group.id, entityType: 'person', name: 'Status', type: 'singleSelect', options: [{ id: 'met', label: 'Met', order: 0 }], config: {} })
    cmd('pipeline_move', { fieldId: field.id, entity: { type: 'person', id: p.id }, value: 'met', expectedRecordRevision: 0 })
    expect(store.list('people', { groupId: 'g', filter: { op: 'and', rules: [{ field: 'field:status', operator: 'eq', value: 'met' }] } }).rows.map(row => row.id)).toEqual(['p'])
    expect(store.list('fields', { entityId: p.id }).rows).toHaveLength(1)
    expect(store.detail('people', p.id).related.fields).toHaveLength(1)
    expect(() => cmd('set_field', { fieldId: field.id, entity: { type: 'person', id: p.id }, value: 'invalid', expectedRecordRevision: 1 })).toThrow('available option')
    create('groups', { id: 'child', name: 'Child', parentId: group.id })
    expect(() => cmd('update', { collection: 'groups', id: group.id, expectedRecordRevision: 1, patch: { parentId: 'child' } })).toThrow('cycle')
  })
  it('makes comments idempotent and rejects stale edits atomically', () => {
    const p = person('p'), request = { requestId: 'one-comment', operation: 'comment', record: { body: 'Remember this', entityRefs: [{ type: 'person', id: p.id }] } }
    expect(store.command(request).replayed).toBeUndefined(); expect(store.command(request).replayed).toBe(true)
    expect(store.list('notes').rows).toHaveLength(1)
    cmd('update', { collection: 'people', id: p.id, expectedRecordRevision: 1, patch: { description: 'new' } })
    expect(() => cmd('update', { collection: 'people', id: p.id, expectedRecordRevision: 1, patch: { description: 'old' } })).toThrow('changed')
    expect(store.get('people', p.id)?.description).toBe('new')
    expect(() => store.command({ ...request, record: { body: 'different' } })).toThrow('different data')
  })
  it('offers exact duplicate candidates and reversible merges with conservative conflict checks', () => {
    const first = person('first', { emails: ['Shared@example.test'] }), second = person('second', { emails: ['shared@example.test'], tags: ['friend'] })
    const note = create('notes', { body: 'Second person note', entityRefs: [{ type: 'person', id: second.id }] })
    expect(store.duplicates()[0]).toMatchObject({ firstId: 'first', secondId: 'second', automatic: false })
    const merged = cmd('merge', { survivorId: first.id, duplicateIds: [second.id], expectedRevisions: { first: 1, second: 1 } })
    expect(store.get('notes', note.id)?.entityRefs).toEqual([{ type: 'person', id: first.id }])
    expect(store.get('people', second.id)?.mergedIntoId).toBe(first.id)
    cmd('undo_merge', { historyId: merged.historyId })
    expect(store.get('notes', note.id)?.entityRefs).toEqual([{ type: 'person', id: second.id }])
    expect(store.get('people', second.id)?.archivedAt).toBeNull()
    const mergeAgain = cmd('merge', { survivorId: first.id, duplicateIds: [second.id], expectedRevisions: { first: 3, second: 3 } })
    cmd('update', { collection: 'notes', id: note.id, expectedRecordRevision: 4, patch: { body: 'Later user edit' } })
    expect(() => cmd('undo_merge', { historyId: mergeAgain.historyId })).toThrow('changed later')
    expect(store.get('notes', note.id)?.body).toBe('Later user edit')
  })
  it('stages connector results idempotently and does not treat an invitation as attended', () => {
    person('p')
    const batch = { provider: 'google-calendar', accountId: 'account', name: 'Calendar', originalAssetIds: [], candidates: [{ kind: 'interaction', externalId: 'event-1', payload: { title: 'Future invitation', startAt: 5000, status: 'scheduled', personIds: ['p'], sourceRefs: [{ provider: 'google-calendar', accountId: 'account', externalId: 'event-1' }] } }], counts: { events: 1 }, errors: [] }
    expect(store.stageBatch(batch).created).toBe(1); expect(store.stageBatch(batch).replayed).toBe(true)
    expect(store.list('interactions').rows).toHaveLength(0)
    const candidate = store.list('candidates').rows[0]
    cmd('review_candidate', { id: candidate.id, expectedRecordRevision: 1, accept: true })
    const interaction = store.list('interactions').rows[0]
    expect(interaction).toMatchObject({ status: 'scheduled', attendanceConfirmed: false })
    expect(store.list('relationships').rows).toHaveLength(0)
  })
  it('requires current target revision and current assistant permission for enrichment approval', () => {
    const p = person('p'), proposal = create('proposals', { collection: 'people', targetId: p.id, expectedRecordRevision: p.revision, patch: { jobTitle: 'Enriched' }, clientId: 'assistant', explanation: 'Public profile', evidence: [{ label: 'Profile' }] })
    expect(() => cmd('review_proposal', { id: proposal.id, expectedRecordRevision: 1 })).toThrow('reauthorized')
    expect(store.get('proposals', proposal.id)?.status).toBe('pending')
    store.setProposalAuthorizer(() => {})
    cmd('review_proposal', { id: proposal.id, expectedRecordRevision: 1 })
    expect(store.get('people', p.id)?.jobTitle).toBe('Enriched')
  })
  it('restores portable originals, archived metadata and history with no account secrets', () => {
    const original = emptyCrm(), assetId = 'crm-file-' + 'a'.repeat(64)
    original.people.push(createCrmRecord('people', { id: 'p', archivedAt: 1000, raw: { notAnAsset: 'private-source' }, extra: { future: 42 }, sourceRefs: [{ provider: 'folk', accountId: 'workspace', externalId: 'p', originalAssetId: assetId }] }))
    store.restoreSnapshot(original)
    expect(store.getSnapshot()).toEqual(original)
    expect(crmAssetReferences(store.getSnapshot())).toEqual(new Set([assetId]))
    store.clear(); expect(store.getSnapshot()).toBeUndefined()
    store.restoreSnapshot(original); expect(store.get('people', 'p')?.extra).toEqual({ future: 42 })
  })
  it('only fills empty candidate fields unless a conflicting value is explicitly reviewed', () => {
    const p = person('p', { fullName: 'Original name', emails: ['old@example.test'], description: 'My own notes' })
    const candidate = create('candidates', { kind: 'person', provider: 'google-contacts', accountId: 'a', externalId: 'contact', payload: { fullName: 'Different name', description: '', emails: ['new@example.test'], jobTitle: 'Engineer' }, targetId: p.id })
    cmd('review_candidate', { id: candidate.id, expectedRecordRevision: 1, expectedTargetRevision: p.revision })
    expect(store.get('people', p.id)).toMatchObject({ fullName: 'Original name', description: 'My own notes', emails: ['old@example.test', 'new@example.test'], jobTitle: 'Engineer' })
    const another = create('candidates', { kind: 'person', provider: 'google-contacts', accountId: 'a', externalId: 'contact-v2', payload: { fullName: 'Different name' }, targetId: p.id })
    cmd('review_candidate', { id: another.id, expectedRecordRevision: 1, expectedTargetRevision: 2, patch: { fullName: 'Chosen name' } })
    expect(store.get('people', p.id)?.fullName).toBe('Chosen name')
  })
  it('requires explicit confirmation for past calendar invitations and supports reviewed confirmation later', () => {
    const record = { title: 'Past invitation', startAt: 1000, endAt: 1500, sourceRefs: [{ provider: 'google-calendar', accountId: 'a', externalId: 'event' }] }
    const invitation = cmd('log_calendar', { record }).record!
    expect(invitation).toMatchObject({ status: 'scheduled', attendanceConfirmed: false, occurredAt: null })
    cmd('log_calendar', { record, confirmAttendance: true, expectedRecordRevision: invitation.revision })
    expect(store.get('interactions', invitation.id)).toMatchObject({ status: 'logged', attendanceConfirmed: true, occurredAt: 1000 })
  })
  it('reviews changed connector source content without discarding subsequent updates', () => {
    const batch = { provider: 'google-contacts', accountId: 'account', name: 'Contacts', originalAssetIds: [], candidates: [{ kind: 'person', externalId: 'source-person', payload: { fullName: 'Ada' }, raw: { name: 'Ada', version: 1 } }], counts: { contacts: 1 }, errors: [] }
    store.stageBatch(batch); const initial = store.list('candidates').rows[0]
    cmd('review_candidate', { id: initial.id, expectedRecordRevision: 1 })
    const targetId = store.get('candidates', initial.id)!.targetId
    const changed = { ...batch, candidates: [{ ...batch.candidates[0], payload: { fullName: 'Ada', jobTitle: 'Researcher' }, raw: { name: 'Ada', version: 2 } }] }
    expect(store.stageBatch(changed).created).toBe(1)
    const pending = store.list('candidates', { status: 'pending' }).rows[0]
    expect(pending.targetId).toBe(targetId)
    cmd('review_candidate', { id: pending.id, expectedRecordRevision: 1, expectedTargetRevision: 1 })
    expect(store.get('people', targetId!)?.jobTitle).toBe('Researcher')
    expect(store.list('people').total).toBe(1)
  })
  it('canonicalizes known select labels, filters IDs and labels, and preserves imported unknown values', () => {
    person('p'); create('groups', { id: 'g', name: 'Group' }); cmd('membership', { groupId: 'g', entity: { type: 'person', id: 'p' } })
    const field = create('fields', { id: 'select', groupId: 'g', entityType: 'person', name: 'Status', type: 'singleSelect', options: [{ id: 'met-id', label: 'Met person', order: 0 }] })
    cmd('set_field', { fieldId: field.id, entity: { type: 'person', id: 'p' }, value: 'Met person' })
    expect(store.list('fieldValues').rows[0].value).toBe('met-id')
    for (const value of ['met-id', 'Met person']) expect(store.list('people', { filter: { field: 'field:select', operator: 'eq', value } }).total).toBe(1)
    expect(store.list('people', { filter: { field: 'field:select', operator: 'contains', value: 'person' } }).total).toBe(1)
    cmd('import', { collections: { fieldValues: [{ id: 'unknown', fieldId: field.id, groupId: 'g', entityType: 'person', entityId: 'p', value: 'Retired old option' }] } })
    cmd('update', { collection: 'fields', id: field.id, expectedRecordRevision: 1, patch: { name: 'Renamed field' } })
    expect(store.get('fieldValues', 'unknown')?.value).toBe('Retired old option')
    expect(() => cmd('update', { collection: 'fields', id: field.id, expectedRecordRevision: 2, patch: { options: [] } })).toThrow('available option')
  })
  it('records missing import capabilities as partial and retains all limitations', () => {
    const result = cmd('import', { collections: { people: [{ id: 'p' }] }, completeness: { people: true, interactions: false }, sourceErrors: ['Interaction bodies unavailable.'] })
    expect(store.get('imports', String(result.importId))).toMatchObject({ status: 'partial', errors: ['Interaction bodies unavailable.'], extra: { completeness: { interactions: false } } })
  })
  it('creates one next recurring task with month-end clamping and honors retries', () => {
    const task = create('tasks', { title: 'Recurring', dueAt: Date.UTC(2026, 0, 31, 10), recurrence: { frequency: 'monthly', interval: 1 } })
    const completed = cmd('complete_task', { id: task.id, expectedRecordRevision: 1 }), next = completed.nextTask as typeof task
    expect(next.dueAt).toBe(Date.UTC(2026, 1, 28, 10))
    const march = cmd('complete_task', { id: next.id, expectedRecordRevision: 1 }).nextTask as typeof task
    expect(march.dueAt).toBe(Date.UTC(2026, 2, 31, 10))
    expect(cmd('complete_task', { id: task.id, expectedRecordRevision: 2 }).nextTask).toBeUndefined()
  })
  it.each([['weekday', Date.UTC(2026, 10, 20, 12), Date.UTC(2026, 10, 23, 12)], ['biweekly', Date.UTC(2026, 10, 20, 12), Date.UTC(2026, 11, 4, 12)], ['quarterly', Date.UTC(2026, 0, 31, 12), Date.UTC(2026, 3, 30, 12)]] as const)('supports the Inspector %s recurrence choice', (frequency, start, expected) => {
    const task = create('tasks', { title: 'Repeat', dueAt: start, recurrenceFrequency: frequency })
    expect((cmd('complete_task', { id: task.id, expectedRecordRevision: 1 }).nextTask as typeof task).dueAt).toBe(expected)
  })
  it('reimports explicit merged source identities without duplicates or alias ambiguity', () => {
    const source = (id: string, title: string) => ({ id, fullName: title, raw: { id, title }, sourceRefs: [{ provider: 'folk', accountId: 'workspace', externalId: id }] })
    const initial = [source('a', 'First'), source('b', 'Second')]
    cmd('import', { collections: { people: initial } })
    cmd('merge', { survivorId: 'a', duplicateIds: ['b'], expectedRevisions: { a: 1, b: 1 } })
    expect(cmd('import', { collections: { people: initial } }).counts).toEqual({ created: 0, unchanged: 2, staged: 0 })
    const changed = source('b', 'Second updated')
    cmd('import', { collections: { people: [changed] } })
    const candidate = store.list('candidates').rows[0]
    expect(candidate.targetId).toBe('a')
    cmd('review_candidate', { id: candidate.id, expectedRecordRevision: 1, expectedTargetRevision: 2, patch: { fullName: 'Chosen merge title' } })
    expect(cmd('import', { collections: { people: [initial[0], changed] } }).counts).toEqual({ created: 0, unchanged: 2, staged: 0 })
    expect(store.list('people').total).toBe(1)
  })
  it('suggests an existing Folk person for a first Google or Gmail source without accepting or overwriting', () => {
    const existing = person('folk-person', { emails: ['Ada@Example.test'], fullName: 'My saved name', jobTitle: 'My saved role' })
    const before = store.get('people', existing.id)
    const batch = { provider: 'gmail-headers', accountId: 'columbia', name: 'Reviewed email participants', originalAssetIds: [], candidates: [{ kind: 'person', externalId: 'ada@example.test', payload: { fullName: 'Header display name', emails: [' ada@example.test '], jobTitle: '' }, evidence: [{ label: 'From header' }] }], counts: { candidates: 1 }, errors: [] }
    store.stageBatch(batch)
    const candidate = store.list('candidates').rows[0], retained = store.get('candidates', candidate.id)!
    expect(candidate).toMatchObject({ status: 'pending', confidence: 'possible', targetId: existing.id, matchingPersonIds: [existing.id] })
    expect(retained.extra?.matchingPersonIds).toEqual([existing.id])
    expect(candidate.evidence.map(item => item.label).join(' ')).toContain('1 existing person matches exact normalized email')
    expect(store.get('people', existing.id)).toEqual(before); expect(store.list('people').total).toBe(1)
    cmd('review_candidate', { id: candidate.id, expectedRecordRevision: candidate.revision, expectedTargetRevision: existing.revision, accept: true })
    expect(store.list('people').total).toBe(1); expect(store.get('people', existing.id)).toMatchObject({ fullName: 'My saved name', jobTitle: 'My saved role', emails: ['Ada@Example.test'] })
  })
  it('leaves shared email and conflicting email/profile identities ambiguous until explicit review', () => {
    person('one', { emails: ['shared@example.test'] }); person('two', { emails: ['SHARED@example.test'], urls: ['https://linkedin.com/in/second'] })
    const batch = { provider: 'google-contacts', accountId: 'account', name: 'Contacts', originalAssetIds: [], candidates: [{ kind: 'person', externalId: 'shared', payload: { emails: ['shared@example.test'], urls: ['https://linkedin.com/in/second/?utm_source=share'] } }], counts: {}, errors: [] }
    store.stageBatch(batch)
    const candidate = store.list('candidates').rows[0]
    expect(candidate).toMatchObject({ targetId: null, confidence: 'possible', status: 'pending', matchingPersonIds: ['one', 'two'] })
    expect(store.get('candidates', candidate.id)!.extra?.matchingPersonIds).toEqual(['one', 'two'])
    expect(candidate.evidence.map(item => item.label).join(' ')).toContain('2 existing people match')
    expect(store.list('people').total).toBe(2)
    expect(store.get('people', 'one')!.revision).toBe(1); expect(store.get('people', 'two')!.revision).toBe(1)
  })
  it('matches profile URL evidence but never uses a matching name, archived person or Gmail alias guess', () => {
    person('profile', { urls: ['https://www.linkedin.com/in/ada/'] }); person('name-only', { fullName: 'Same Name', emails: ['ada.alias@example.test'] })
    const archived = person('archived', { emails: ['removed@example.test'] }); cmd('archive', { collection: 'people', id: archived.id, expectedRecordRevision: 1 })
    const candidates = [{ kind: 'person', externalId: 'profile', payload: { fullName: 'Different name', urls: ['https://www.linkedin.com/in/ada?utm_campaign=share#bio'] } }, { kind: 'person', externalId: 'name', payload: { fullName: 'Same Name', emails: ['adaalias@example.test'] } }, { kind: 'person', externalId: 'archived', payload: { emails: ['removed@example.test'] } }]
    store.stageBatch({ provider: 'website-reader', accountId: 'local', name: 'Profiles', originalAssetIds: [], candidates, counts: {}, errors: [] })
    const rows = store.list('candidates').rows
    expect(rows.find(row => row.externalId === 'profile')).toMatchObject({ targetId: 'profile', confidence: 'possible', status: 'pending' })
    expect(rows.find(row => row.externalId === 'name')!.targetId).toBeNull(); expect(rows.find(row => row.externalId === 'archived')!.targetId).toBeNull()
    expect(rows.find(row => row.externalId === 'profile')!.evidence[0].label).toContain('profile URL')
  })
  it('allows an explicitly separate initial person while preserving later source continuity', () => {
    person('existing', { emails: ['shared@example.test'], fullName: 'Original person' })
    const batch = { provider: 'gmail-headers', accountId: 'account', name: 'Email', originalAssetIds: [], candidates: [{ kind: 'person', externalId: 'shared@example.test', payload: { emails: ['shared@example.test'], fullName: 'Different person' }, raw: { version: 1 } }], counts: {}, errors: [] }
    store.stageBatch(batch); const initial = store.list('candidates').rows[0]
    expect(initial.targetId).toBe('existing')
    const accepted = cmd('review_candidate', { id: initial.id, expectedRecordRevision: initial.revision, accept: true, createSeparate: true })
    expect(accepted.record!.id).not.toBe('existing'); expect(store.list('people').total).toBe(2)
    expect(store.get('people', 'existing')!.fullName).toBe('Original person')
    store.stageBatch({ ...batch, candidates: [{ ...batch.candidates[0], payload: { ...batch.candidates[0].payload, jobTitle: 'Updated source' }, raw: { version: 2 } }] })
    const next = store.list('candidates', { status: 'pending' }).rows[0]
    expect(next).toMatchObject({ targetId: accepted.record!.id, sourceIdentityEstablished: true })
    expect(() => cmd('review_candidate', { id: next.id, expectedRecordRevision: 1, createSeparate: true })).toThrow('initial person suggestion')
    expect(() => cmd('review_candidate', { id: next.id, expectedRecordRevision: 1, targetId: 'existing', expectedTargetRevision: 1 })).toThrow('source identity already belongs')
    cmd('review_candidate', { id: next.id, expectedRecordRevision: 1, expectedTargetRevision: 1 })
    expect(store.list('people').total).toBe(2); expect(store.get('people', accepted.record!.id)!.jobTitle).toBe('Updated source')
  })
  it('does not allow createSeparate to bypass an update candidate target', () => {
    person('existing')
    const candidate = create('candidates', { kind: 'update', provider: 'import-update', accountId: 'account', externalId: 'source', targetId: 'existing', payload: { collection: 'people', patch: { jobTitle: 'Updated' } } })
    expect(() => cmd('review_candidate', { id: candidate.id, expectedRecordRevision: 1, createSeparate: true })).toThrow('initial person suggestion')
    expect(store.get('candidates', candidate.id)!.status).toBe('pending'); expect(store.list('people').total).toBe(1)
  })
  it('infers historical group capability from retained memberships and fields without changing source declarations', () => {
    const sourceRaw = { id: 'g', entityTypes: ['person'], future: 'retained' }
    cmd('import', { collections: { groups: [{ id: 'g', name: 'Original group', entityType: 'person', entityTypes: ['person'], raw: sourceRaw }, { id: 'field-group', name: 'Field-backed group', entityType: 'person', entityTypes: ['person'] }, { id: 'empty-group', name: 'People only', entityType: 'person' }], companies: [{ id: 'old-company', name: 'Original company' }], memberships: [{ id: 'old-membership', groupId: 'g', entityType: 'company', entityId: 'old-company', archivedAt: 1000 }], fields: [{ id: 'old-company-field', groupId: 'field-group', entityType: 'company', name: 'Company field', archivedAt: 1000 }] } })
    const before = store.get('groups', 'g')!, beforeFieldGroup = store.get('groups', 'field-group')!
    const company = create('companies', { id: 'new-company', name: 'New company' })
    cmd('membership', { groupId: 'g', entity: { type: 'company', id: company.id } })
    const field = create('fields', { groupId: 'g', entityType: 'company', name: 'Company status' })
    cmd('set_field', { fieldId: field.id, entity: { type: 'company', id: company.id }, value: 'Following' })
    cmd('membership', { groupId: 'field-group', entity: { type: 'company', id: company.id } })
    expect(store.get('groups', 'g')).toEqual(before); expect(store.get('groups', 'g')!.raw).toEqual(sourceRaw)
    expect(store.get('groups', 'field-group')).toEqual(beforeFieldGroup)
    expect(store.list('companies').total).toBe(2)
    expect(() => cmd('membership', { groupId: 'empty-group', entity: { type: 'company', id: company.id } })).toThrow('compatible')
    expect(() => create('fields', { groupId: 'empty-group', entityType: 'company', name: 'Not supported' })).toThrow('compatible')
  })
  it.each(['archived', 'merged'] as const)('rejects initial candidate approval targeting a now-%s person', state => {
    person('survivor'); person('target')
    const candidate = create('candidates', { kind: 'person', provider: 'google-contacts', accountId: 'account', externalId: 'new-source', targetId: 'target', payload: { jobTitle: 'Source role' } })
    if (state === 'archived') cmd('archive', { collection: 'people', id: 'target', expectedRecordRevision: 1 })
    else cmd('merge', { survivorId: 'survivor', duplicateIds: ['target'], expectedRevisions: { survivor: 1, target: 1 } })
    expect(() => cmd('review_candidate', { id: candidate.id, expectedRecordRevision: 1, expectedTargetRevision: 2 })).toThrow('active canonical')
    expect(store.get('candidates', candidate.id)!.status).toBe('pending'); expect(store.get('people', 'target')!.jobTitle).toBe('')
  })
  it('renders draft campaign personalization locally without an email send capability', () => {
    person('p', { firstName: 'Ada', emails: ['ada@example.test'] })
    const campaign = create('campaigns', { name: 'Draft', personIds: ['p'], subject: 'Hello {{firstName}}', body: '{{email}} {{arbitrary()}}' })
    expect(cmd('prepare_campaign', { id: campaign.id, expectedRecordRevision: 1 })).toMatchObject({ sendingEnabled: false, drafts: [{ subject: 'Hello Ada', body: 'ada@example.test {{arbitrary()}}' }] })
    expect(() => cmd('send_campaign', { id: campaign.id })).toThrow('Unknown CRM command')
  })
})
