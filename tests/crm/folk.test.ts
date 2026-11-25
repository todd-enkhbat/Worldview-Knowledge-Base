import { describe, expect, it } from 'vitest'
import { normalizeFolkExport } from '../../server/crmFolk.ts'

const fixture = () => ({
  format: 'worldview-folk-export.v1', accountId: 'workspace-test', capturedAt: '2026-11-23T12:00:00Z',
  workspace: { name: 'Test workspace', members: [{ id: 'usr_1', fullName: 'Owner', email: 'owner@example.test' }], groups: [
    { id: 'grp_a', name: 'Research', entityTypes: ['person', 'company'], customFieldsByEntityType: { person: [{ name: 'Status', type: 'singleSelect', options: ['New', 'Met'] }, { name: 'Introduced by', type: 'contactField', options: [] }, { name: 'Owner', type: 'userField' }], company: [{ name: 'Status', type: 'singleSelect', options: ['Prospect'] }] }, pipelines: [{ id: 'pipe_a', name: 'People pipeline', entityType: 'person', customFieldName: 'Status' }] },
    { id: 'grp_b', name: 'Friends', entityTypes: ['person'], customFieldsByEntityType: { person: [{ name: 'Status', type: 'singleSelect', options: ['Close', 'New'] }] }, pipelines: [] },
    { id: 'grp_empty', name: 'Empty', entityTypes: [], customFieldsByEntityType: {}, pipelines: [] },
  ] },
  groups: [{ id: 'grp_a', name: 'Research', visibility: 'private', emoji: '📚' }, { id: 'grp_b', name: 'Friends', visibility: 'public' }, { id: 'grp_empty', name: 'Empty', visibility: 'private' }],
  people: [
    { id: 'per_1', fullName: '', firstName: '', lastName: '', emails: ['person@example.test'], phones: ['123'], urls: [], addresses: ['New York'], birthday: '2000-01-01', gender: 'unknown', groups: [{ id: 'grp_a', name: 'Research' }, { id: 'grp_b', name: 'Friends' }], companies: [{ id: 'com_1', name: 'Example' }], customFieldValues: { grp_a: { Status: 'New', Owner: [{ id: 'usr_1', fullName: 'Owner' }], 'Introduced by': [{ id: 'per_2', fullName: 'Friend' }], FutureField: { nested: ['keep', 42] } }, grp_b: { Status: 'Close' } }, interactionMetadata: { workspace: { approximateCount: 50 } }, strongestConnection: { email: { id: 'usr_1' } }, futureNative: { preserved: true } },
    { id: 'per_2', fullName: 'Friend', groups: [], emails: ['person@example.test'], companies: [], customFieldValues: {} },
  ],
  companies: [{ id: 'com_1', name: 'Example', groups: [{ id: 'grp_a', name: 'Research' }], customFieldValues: { grp_a: { Status: 'Prospect' } }, fundingRaised: '12', employeeRange: '1-10' }],
  notes: [
    { id: 'note_parent', entity: { entityType: 'person', id: 'per_1' }, content: '<p>Private note</p>', author: { type: 'user', id: 'usr_deleted', deleted: true }, visibility: 'private', createdAt: '2026-01-01T00:00:00Z', parentNote: null },
    { id: 'note_reply', entity: { entityType: 'person', id: 'per_1' }, content: 'Reply', author: { type: 'assistant', fullName: 'Assistant' }, visibility: 'private', parentNote: { id: 'note_parent', deleted: false, content: 'Private note' } },
  ],
  tasks: [{ id: 'task_1', title: 'Follow up', description: 'Keep context', entity: { entityType: 'company', id: 'com_1' }, dueAt: '2026-12-01', dueTime: '09:00', recurrenceFrequency: 'monthly', assignedUsers: [{ id: 'usr_1' }, { id: 'usr_2' }], isPublic: false, completedAt: '2026-11-01T10:00:00Z', createdBy: { id: 'usr_1' } }],
  interactions: [
    { id: 'int_1', entity: { entityType: 'person', id: 'per_1' }, interactionType: 'calendar', dateTime: '2026-12-01T10:00:00Z', privacyLevel: 'sharedFull', content: { subject: 'Meeting', body: 'Full content' }, from: { type: 'email', value: 'owner@example.test' }, to: [], historyKind: 'upcoming' },
    { id: 'int_1', entity: { entityType: 'company', id: 'com_1' }, interactionType: 'calendar', dateTime: '2026-12-01T10:00:00Z', privacyLevel: 'subjectOnly', content: { subject: 'Meeting' }, historyKind: 'upcoming' },
    { id: 'int_logged', entity: { entityType: 'person', id: 'per_1' }, interactionType: 'logged', dateTime: '2026-11-01T10:00:00Z', privacyLevel: 'sharedFull', title: 'Coffee', content: 'Manual memory', activityType: 'meeting' },
  ],
  completeness: { groups: true, people: true, companies: true, notes: true, tasks: true, interactions: false, interactionBodies: false, savedTableViewLayout: false },
  limitations: ['Interaction export incomplete.'],
})

describe('Folk migration adapter', () => {
  it('retains exact source identity, empty names, separate contacts sharing email, and all raw metadata', () => {
    const { snapshot } = normalizeFolkExport(fixture())
    expect(snapshot.people).toHaveLength(2)
    expect(snapshot.people[0]).toMatchObject({ id: 'per_1', fullName: '', emails: ['person@example.test'], companyIds: ['com_1'], location: 'New York' })
    expect(snapshot.people[0].raw).toMatchObject({ futureNative: { preserved: true }, strongestConnection: { email: { id: 'usr_1' } } })
    expect(snapshot.people[0].sourceRefs[0]).toMatchObject({ provider: 'folk', accountId: 'workspace-test', externalId: 'per_1' })
    expect(snapshot.companies[0].raw).toMatchObject({ employeeRange: '1-10', fundingRaised: '12' })
  })

  it('preserves group-specific option order, multi-entity groups, unknown fields, and explicit memberships', () => {
    const { snapshot } = normalizeFolkExport(fixture())
    expect(snapshot.groups).toHaveLength(3)
    expect(snapshot.groups[0]).toMatchObject({ visibility: 'private', entityTypes: ['person', 'company'], emoji: '📚' })
    const status = snapshot.fields.filter(field => field.name === 'Status')
    expect(status).toHaveLength(3)
    expect(new Set(status.map(field => field.id)).size).toBe(3)
    expect(status[0].options.map(option => [option.label, option.order])).toEqual([['New', 0], ['Met', 1]])
    const researchValue = snapshot.fieldValues.find(value => value.fieldId === status[0].id && value.entityId === 'per_1')!
    expect(researchValue.value).toBe(status[0].options[0].id)
    expect(researchValue.raw).toEqual({ value: 'New' })
    const friendsField = status.find(field => field.groupId === 'grp_b')!
    expect(snapshot.fieldValues.find(value => value.fieldId === friendsField.id)?.value).toBe(friendsField.options[0].id)
    const newOptions = snapshot.fields.flatMap(field => field.options).filter(option => option.label === 'New')
    expect(new Set(newOptions.map(option => option.id)).size).toBe(2)
    const unknown = snapshot.fields.find(field => field.name === 'FutureField')!
    expect(unknown.type).toBe('unknown')
    expect(snapshot.fieldValues.find(value => value.fieldId === unknown.id)?.value).toEqual({ nested: ['keep', 42] })
    expect(snapshot.memberships).toHaveLength(3)
    expect(new Set(snapshot.memberships.map(membership => membership.sourceRefs[0].externalId)).size).toBe(3)
    expect(snapshot.views[0]).toMatchObject({ id: 'pipe_a', layout: 'board', groupBy: status[0].id, sourceLayoutPartial: true })
  })

  it('preserves note authors, privacy and reply parents without inventing a deleted author name', () => {
    const { snapshot } = normalizeFolkExport(fixture())
    expect(snapshot.notes[0]).toMatchObject({ authorName: '', visibility: 'private', author: { id: 'usr_deleted', deleted: true }, entityRefs: [{ type: 'person', id: 'per_1' }] })
    expect(snapshot.notes[1]).toMatchObject({ parentId: 'note_parent', authorName: 'Assistant' })
    expect(snapshot.notes[1].raw).toMatchObject({ parentNote: { content: 'Private note' } })
  })

  it('preserves recurring multi-assignee task scheduling and completion', () => {
    const { snapshot } = normalizeFolkExport(fixture())
    expect(snapshot.tasks[0]).toMatchObject({ assigneeId: 'usr_1', assigneeIds: ['usr_1', 'usr_2'], recurrenceFrequency: 'monthly', dueTime: '09:00', isPublic: false, dueAt: Date.parse('2026-12-01'), completedAt: Date.parse('2026-11-01T10:00:00Z'), entityRefs: [{ type: 'company', id: 'com_1' }] })
  })

  it('deduplicates interaction IDs while retaining associations and the most restrictive display privacy', () => {
    const { snapshot, report } = normalizeFolkExport(fixture())
    expect(snapshot.interactions).toHaveLength(2)
    expect(snapshot.interactions[0]).toMatchObject({ id: 'int_1', personIds: ['per_1'], companyIds: ['com_1'], status: 'scheduled', occurredAt: null, privacyLevel: 'subjectOnly', body: '', attendanceConfirmed: false, readOnlySource: true })
    expect(snapshot.interactions[0].raw).toHaveLength(2)
    expect(snapshot.interactions[1]).toMatchObject({ body: 'Manual memory', status: 'logged', readOnlySource: false })
    expect(report.completeness.interactions).toBe(false)
    expect(snapshot.imports[0].status).toBe('partial')
    expect(report.issues).toContain('Source completeness has not been established for interactions.')
  })

  it('only creates relationship edges from explicit company/contact relations', () => {
    const { snapshot } = normalizeFolkExport(fixture())
    expect(snapshot.relationships).toHaveLength(2)
    expect(snapshot.relationships).toEqual(expect.arrayContaining([expect.objectContaining({ relation: 'Introduced by', to: { type: 'person', id: 'per_2' } }), expect.objectContaining({ relation: 'works at', to: { type: 'company', id: 'com_1' } })]))
    expect(snapshot.relationships.every(relation => relation.to.id !== 'usr_1')).toBe(true)
  })

  it('is deterministic and keeps incremental reimports on the same record IDs', () => {
    const input = fixture()
    const first = normalizeFolkExport(input)
    expect(normalizeFolkExport(input)).toEqual(first)
    input.capturedAt = '2026-11-24T12:00:00Z'
    input.interactions.push({ ...input.interactions[1], id: 'int_2' })
    const next = normalizeFolkExport(input)
    for (const collection of ['people', 'companies', 'groups', 'fields', 'fieldValues', 'memberships', 'notes', 'tasks', 'imports'] as const) {
      expect(next.snapshot[collection].map(row => row.id)).toEqual(first.snapshot[collection].map(row => row.id))
    }
    expect(next.snapshot.interactions.map(row => row.id)).toContain('int_2')
  })

  it('retains canonical select identity when source options are reordered', () => {
    const input = fixture()
    const first = normalizeFolkExport(input)
    input.workspace.groups[0].customFieldsByEntityType.person![0].options!.reverse()
    const next = normalizeFolkExport(input)
    const field = first.snapshot.fields.find(field => field.groupId === 'grp_a' && field.name === 'Status')!
    const reordered = next.snapshot.fields.find(entry => entry.id === field.id)!
    expect(reordered.options.find(option => option.label === 'New')!.id).toBe(field.options.find(option => option.label === 'New')!.id)
    expect(next.snapshot.fieldValues.find(value => value.fieldId === field.id)!.value).toBe(first.snapshot.fieldValues.find(value => value.fieldId === field.id)!.value)
    expect(reordered.options.map(option => option.label)).toEqual(['Met', 'New'])
  })

  it('never mutates an export and rejects exports missing required collections', () => {
    const input = fixture()
    const original = structuredClone(input)
    normalizeFolkExport(input)
    expect(input).toEqual(original)
    expect(() => normalizeFolkExport({ people: [] })).toThrow('people, companies and groups')
  })
})
