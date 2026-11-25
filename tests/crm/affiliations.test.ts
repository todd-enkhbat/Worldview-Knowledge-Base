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
