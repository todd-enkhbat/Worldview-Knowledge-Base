import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'
import { SqliteCrmStore } from '../../server/crmStore.ts'
import { readerOrganization } from '../../server/readerOrganization.ts'
import type { CrmCollection } from '../../src/crm/types.ts'

let db: WorldDb, store: SqliteCrmStore
beforeEach(() => { db = openWorldDb(':memory:'); db.putSettings({ T0: 0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: 1, schemaVersion: 1 }); store = new SqliteCrmStore(db, { now: () => 2000 }) })
afterEach(() => db.close())
const create = (collection: CrmCollection, record: Record<string, unknown>) => store.command({ requestId: randomUUID(), operation: 'create', collection, record })
it('changes one school without renaming its shared organization and preserves the rest of the record', () => {
  create('companies', { id: 'berkeley', name: 'Berkeley' }); create('companies', { id: 'columbia', name: 'Columbia' })
  create('people', { id: 'ada', fullName: 'Ada', emails: ['ada@example.org'], affiliations: [{ id: 'school', kind: 'education', organization: 'Berkeley', organizationId: 'berkeley', degree: 'BA', evidence: [], organizationLogoUrl: 'https://berkeley.edu/logo.png' }] })
  const revision = store.get('people', 'ada')!.revision
  readerOrganization(store, 'ada', { action: 'affiliation', requestId: randomUUID(), revision, affiliationId: 'school', kind: 'education', organization: 'Columbia' }, 2000, () => {}, 'person')
  const person = store.get('people', 'ada')!
  expect(person.emails).toEqual(['ada@example.org'])
  expect(person.affiliations).toEqual([expect.objectContaining({ id: 'school', organization: 'Columbia', organizationId: 'columbia', degree: 'BA' })])
  expect(person.affiliations![0].organizationLogoUrl).toBeUndefined()
  expect(store.get('companies', 'berkeley')!.name).toBe('Berkeley')
  expect(() => readerOrganization(store, 'ada', { action: 'affiliation', requestId: randomUUID(), revision, affiliationId: 'school', kind: 'education', organization: 'Other' }, 2000, () => {}, 'person')).toThrow()
})
it('adds and links a current company with a repeatable request identity', () => {
  create('companies', { id: 'lab', name: 'Research Lab' }); create('people', { id: 'ada', fullName: 'Ada' })
  const input = { action: 'affiliation', requestId: randomUUID(), revision: store.get('people', 'ada')!.revision, kind: 'employment', organization: 'Research Lab' }
  readerOrganization(store, 'ada', input, 2000, () => {}, 'person')
  readerOrganization(store, 'ada', input, 2000, () => {}, 'person')
  expect(store.get('people', 'ada')!.companyIds).toEqual(['lab'])
  expect(store.get('people', 'ada')!.affiliations).toHaveLength(1)
})
