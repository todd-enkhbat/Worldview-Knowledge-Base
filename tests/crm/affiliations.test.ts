import { afterEach, beforeEach, expect, it } from 'vitest'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'
import { createCrmRecord, crmFieldValue, matchCrmFilter } from '../../src/crm/model.ts'
import type { CrmAffiliation } from '../../src/crm/types.ts'

let db: WorldDb
beforeEach(() => { db = openWorldDb(':memory:'); db.putSettings({ T0: 0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: 1, schemaVersion: 1 }) })
afterEach(() => db.close())
const education: CrmAffiliation = { id: 'school', kind: 'education', organization: 'Columbia University', degree: 'BSc', field: 'Computer Science', startDate: '2018', endDate: '2022', evidence: [{ label: 'Saved profile', url: 'https://example.org/ada', excerpt: 'Columbia University, BSc Computer Science, 2018–2022' }] }
const create = (id: string, affiliations?: CrmAffiliation[]) => db.crm.command({ requestId: `create-${id}`, operation: 'create', collection: 'people', record: { id, fullName: id, ...(affiliations ? { affiliations } : {}) } })

it('searches retained schools and degrees and filters alma mater without confusing degree text with school identity', () => {
  create('ada', [education, { id: 'work', kind: 'employment', organization: 'Example Labs', role: 'Researcher', evidence: [] }]); create('grace')
  expect(db.crm.list('people', { q: 'computer science' }).rows.map(row => row.id)).toEqual(['ada'])
  expect(db.crm.list('people', { filter: { field: 'almaMater', operator: 'eq', value: 'columbia university' } }).rows.map(row => row.id)).toEqual(['ada'])
  expect(db.crm.list('people', { filter: { field: 'employers', operator: 'contains', value: 'Example' } }).rows.map(row => row.id)).toEqual(['ada'])
  expect(db.crm.list('people', { filter: { field: 'almaMater', operator: 'empty' } }).rows.map(row => row.id)).toEqual(['grace'])
  const person = db.crm.get('people', 'ada')!
  expect(crmFieldValue(person, 'education')).toEqual(['Columbia University · BSc · Computer Science'])
  expect(matchCrmFilter(person, { field: 'almaMater', operator: 'neq', value: 'MIT' })).toBe(true)
})
it('searches linked company names without rewriting imported people when a company changes', () => {
  db.crm.command({ requestId: 'company', operation: 'create', collection: 'companies', record: { id: 'company', name: 'Literal 100%_Studio' } })
  db.crm.command({ requestId: 'person', operation: 'create', collection: 'people', record: { id: 'person', companyIds: ['company'] } })
  const before = db.crm.get('people', 'person')
  expect(db.crm.list('people', { q: '100%_Studio' }).rows.map(row => row.id)).toEqual(['person'])
  expect(db.crm.list('people', { filter: { field: 'companyNames', operator: 'eq', value: 'Literal 100%_Studio' } }).total).toBe(1)
  db.crm.command({ requestId: 'rename', operation: 'update', collection: 'companies', id: 'company', expectedRecordRevision: 1, patch: { name: 'New Studio' } })
  expect(db.crm.list('people', { q: 'new studio' }).total).toBe(1); expect(db.crm.get('people', 'person')).toEqual(before)
})
it('retains evidence and both conflicting affiliation versions during a reversible contact merge', () => {
  create('one', [education]); create('two', [{ ...education, degree: 'MSc' }])
  const merged = db.crm.command({ requestId: 'merge', operation: 'merge', survivorId: 'one', duplicateIds: ['two'], expectedRevisions: { one: 1, two: 1 } })
  const affiliations = db.crm.get('people', 'one')!.affiliations!
  expect(affiliations.map(row => row.degree)).toEqual(['BSc', 'MSc']); expect(new Set(affiliations.map(row => row.id)).size).toBe(2)
  expect(affiliations.every(row => row.evidence[0].excerpt === education.evidence[0].excerpt)).toBe(true)
  db.crm.command({ requestId: 'undo', operation: 'undo_merge', historyId: merged.historyId })
  expect(db.crm.get('people', 'one')!.affiliations).toEqual([education]); expect(db.crm.get('people', 'two')!.affiliations).toEqual([{ ...education, degree: 'MSc' }])
})
it('accepts legacy records without new fields but refuses malformed structured education', () => {
  expect(createCrmRecord('people', { fullName: 'Legacy', raw: { education: 'kept verbatim' } }).affiliations).toBeUndefined()
  expect(() => createCrmRecord('people', { affiliations: [{ ...education, organization: '' }] })).toThrow('organization')
  expect(() => createCrmRecord('people', { affiliations: [education, education] })).toThrow('identity')
  expect(() => createCrmRecord('people', { affiliations: [{ ...education, organizationUrl: 'javascript:alert(1)' }] })).toThrow('URL')
})
it('resolves older and imported relationships at read time and keeps ambiguous names unlinked', () => {
  create('former', [{ id: 'a', organization: '8VC', kind: 'employment', role: 'Associate', endDate: '2020', evidence: [] }])
  create('current', [{ id: 'b', organization: 'Eight VC', organizationUrl: 'https://www.linkedin.com/company/8vc/about', kind: 'employment', current: true, evidence: [] }])
  const addCompany = (id: string, name: string, urls: string[]) => db.crm.command({ requestId: id, operation: 'create', collection: 'companies', record: { id, name, urls } })
  addCompany('company1', '8VC', ['https://linkedin.com/company/8vc'])
  expect(db.crm.detail('companies', 'company1').companyRoster?.former.map(person => person.id)).toEqual(['former'])
  expect(db.crm.detail('people', 'current').companies.map(row => row.id)).toEqual(['company1'])
  addCompany('company2', '8VC', ['https://elsewhere.org'])
  expect(db.crm.detail('companies', 'company1').companyRoster?.former).toEqual([])
  expect(db.crm.detail('companies', 'company1').companyRoster?.current.map(person => person.id)).toEqual(['current'])
  expect(db.crm.get('people', 'current')?.revision).toBe(1)
})
it('finds distinct outside contacts connected to the current team and preserves the direction of a confirmed introduction', () => {
  db.crm.command({ requestId: 'company', operation: 'create', collection: 'companies', record: { id: 'company', name: '8VC' } })
  create('employee', [{ id: 'role', kind: 'employment', organization: '8VC', current: true, evidence: [] }])
  create('colleague', [{ id: 'role', kind: 'employment', organization: '8VC', current: true, evidence: [] }])
  create('outsider'); create('unconfirmed')
  const edge = (id: string, from: string, to: string, confirmed = true) => db.crm.command({ requestId: id, operation: 'create', collection: 'relationships', record: { id, from: { id: from, type: 'person' }, to: { id: to, type: 'person' }, relation: 'Introduced by', context: 'Conference in Boston', confirmed } })
  edge('one', 'employee', 'outsider'); edge('duplicate', 'outsider', 'employee'); edge('unverified', 'unconfirmed', 'employee', false); edge('both-internal', 'employee', 'colleague')
  expect(db.crm.detail('companies', 'company').introductionPaths).toEqual([{ id: 'one', via: { id: 'outsider', name: 'outsider' }, employee: { id: 'employee', name: 'employee' }, fromId: 'employee', relation: 'Introduced by', context: 'Conference in Boston' }])
})

it('classifies school rosters by evidence without inferring graduation from dates, a degree title or another school', () => {
  db.crm.command({ requestId: 'school', operation: 'create', collection: 'companies', record: { id: 'cu', name: 'Columbia University' } })
  const add = (id: string, patch: Partial<CrmAffiliation>) => create(id, [{ ...education, ...patch }])
  add('explicit', { excerpt: 'Columbia University · Graduated with honors' })
  add('alum', { excerpt: 'Person · alumniOf · Columbia University' })
  add('candidate', { current: true, endDate: 'Present', excerpt: 'Expected graduation Spring 2028' })
  add('dates-only', {})
  add('other-school', { excerpt: 'Graduated from Elsewhere University' })
  add('negative', { excerpt: 'Did not graduate' })
  db.crm.command({ requestId: 'legacy-school', operation: 'create', collection: 'people', record: { id: 'legacy-school', fullName: 'School contact', companyIds: ['cu'], affiliations: [education] } })
  const roster = db.crm.detail('companies', 'cu').companyRoster!
  expect(roster.educationStatuses).toMatchObject({ explicit: ['graduate'], alum: ['alum'], candidate: ['student'], 'dates-only': ['attended'], 'other-school': ['attended'], negative: ['attended'] })
  expect(roster.current).toEqual([])
  expect(db.crm.list('memberships').total).toBe(0)
})

it('browses current employer evidence without former roles or memberships at the same organization', () => {
  for (const [id, kind, dates] of [['current','employment',{current:true}], ['former','employment',{endDate:'2020'}], ['member','membership',{}]] as const) {
    create(id, [{ id, kind, ...dates, organization: 'Studio', evidence: [] }])
  }
  expect(db.crm.list('people', { filter: { field: 'currentEmployers', operator: 'eq', value: 'studio' } }).rows.map(row => row.id)).toEqual(['current'])
})

it('keeps institution groups in sync for education and current work, and respects a manual removal or addition', () => {
  create('alum', [education])
  create('employee', [{ ...education, id: 'job', kind: 'employment', current: true, endDate: '' }])
  create('previous', [{ ...education, kind: 'employment', endDate: '2018' }])
  create('retailer', [{ ...education, kind: 'employment', organization: 'Columbia Sportswear', current: true, endDate: '' }])
  db.crm.command({ requestId: 'columbia-group', operation: 'create', collection: 'groups', record: { id: 'columbia', name: '🦁 Columbia', entityType: 'person' } })
  const members = () => db.crm.list('people', { groupId: 'columbia' }).rows.map(person => person.id).sort()
  expect(members()).toEqual(['alum', 'employee'])
  const membership = db.crm.detail('people', 'alum').related.memberships[0]
  db.crm.command({ requestId: 'exclude', operation: 'membership', remove: true, expectedRecordRevision: membership.revision, entity: { id: 'alum', type: 'person' }, groupId: 'columbia' })
  db.crm.command({ requestId: 'again', operation: 'sync_affiliation_groups' })
  expect(members()).toEqual(['employee'])
  db.crm.command({ requestId: 'end-job', operation: 'update', collection: 'people', id: 'employee', expectedRecordRevision: 1, patch: { affiliations: [{ ...education, kind: 'employment', current: false, endDate: '2022' }] } })
  expect(members()).toEqual([])
  db.crm.command({ requestId: 'return-job', operation: 'update', collection: 'people', id: 'employee', expectedRecordRevision: 2, patch: { affiliations: [{ ...education, kind: 'employment', current: true, endDate: '' }] } })
  expect(members()).toEqual(['employee'])
  db.crm.command({ requestId: 'pin', operation: 'membership', entity: { id: 'employee', type: 'person' }, groupId: 'columbia' })
  db.crm.command({ requestId: 'leave', operation: 'update', collection: 'people', id: 'employee', expectedRecordRevision: 3, patch: { affiliations: [] } })
  expect(members()).toEqual(['employee'])
})

it('keeps distinct institutions out of an ambiguous group and rejects a different college using Columbia as its short name', () => {
  for (const [id,name] of [['first','Trinity College'], ['second','Trinity College'], ['columbia','Columbia']]) {
    db.crm.command({ requestId: 'org-'+id, operation: 'create', collection: 'companies', record: {id,name} })
  }
  for (const [id,name] of [['trinity-group','Trinity College'], ['columbia-group','Columbia']]) {
    db.crm.command({ requestId: 'group-'+id, operation: 'create', collection:'groups', record: {id,name} })
  }
  create('student', [{ ...education, organization: 'Trinity College', organizationId:'first' }])
  create('other-columbia', [{...education, organization:'Columbia', organizationUrl:'https://www.colum.edu/'}])
  expect(db.crm.list('people', {groupId:'trinity-group'}).total).toBe(0)
  expect(db.crm.list('people', {groupId:'columbia-group'}).total).toBe(0)
})

it('keeps school aliases ambiguous across duplicate institutions and rejects another campus URL', () => {
  const add = (id: string, name: string, domain: string, fields: Record<string, unknown> = {}) => db.crm.command({ requestId: id, operation: 'create', collection: 'companies', record: { id, name, domain, organizationType: 'university', ...fields } })
  const person = (id: string, label: string, organizationUrl?: string) => create(id, [{ ...education, organization: label, ...(organizationUrl ? { organizationUrl } : {}) }])
  const org = (id: string) => db.crm.detail('people', id).affiliationOrganizations.map(row => row.id)
  add('campus', 'Michigan Technological University', 'other-school.edu')
  person('short', 'Michigan Tech')
  expect(org('short')).toEqual([])
  add('mtu', 'Michigan Technological University', 'mtu.edu')
  expect(org('short')).toEqual(['mtu'])
  person('other-campus', 'Michigan Tech', 'https://other-school.edu/')
  expect(org('other-campus')).toEqual([])
  add('duplicate', 'Michigan Technological University', 'mtu.edu')
  expect(org('short')).toEqual([])
  add('schema', 'Northern Institute', 'northern.example.org', {
    raw: { '@type': 'CollegeOrUniversity', name: 'Northern Institute', url: 'https://northern.example.org/', alternateName: 'Northbridge' },
    sourceRefs: [{ provider: 'profile-capture', accountId: 'local', externalId: 'official', url: 'https://northern.example.org/' }],
  })
  person('named-alias', 'Northbridge')
  expect(org('named-alias')).toEqual(['schema'])
})
