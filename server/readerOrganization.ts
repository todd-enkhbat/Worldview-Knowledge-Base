import { readerEnrichmentEvidence } from './readerEnrichment.ts'
import type { SqliteCrmStore } from './crmStore.ts'
import type { CrmCommand, CrmPerson, CrmAffiliation } from '../src/crm/types.ts'
import { normalizeProfileUrl } from '../src/crm/model.ts'

const textFields = new Set(['name', 'fullName', 'firstName', 'lastName', 'jobTitle', 'description', 'domain', 'industry', 'tagline', 'location', 'organizationType', 'status', 'employeeRange', 'lastFundingDate'])
const listFields = new Set(['emails', 'phones', 'urls', 'tags', 'addresses'])
const numericFields = new Set(['foundationYear', 'fundingRaised'])
const companyFields = new Set([...textFields, ...listFields, ...numericFields].filter(field => !['fullName','firstName','lastName','jobTitle'].includes(field)))
const personFields = new Set(['fullName','firstName','lastName','jobTitle','description','location','emails','phones','urls','tags','status','addresses'])

function valid(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

export function readerOrganization(store: SqliteCrmStore, id: string, input: Record<string, unknown>, now: number, changed: () => void, type: 'person' | 'company' = 'company') {
  const collection = type === 'company' ? 'companies' : 'people'
  const editable = type === 'company' ? companyFields : personFields
  const detail = store.detail(collection, id)
  const { related } = detail
  const record = store.get(collection, id)
  valid(record && record.archivedAt === null && !record.mergedIntoId, 'Choose an active record.')
  const entity = { type, id }
  const membershipFields = related.fields.filter(field => field.entityType === type && !field.archivedAt)
  const personSummary = (person: {id: string; fullName: string; firstName: string; lastName: string; jobTitle: string}) =>
    ({ id: person.id, name: person.fullName || [person.firstName, person.lastName].filter(Boolean).join(' '), jobTitle: person.jobTitle })

  if (input.action === 'find-people') {
    valid(type === 'company', 'Choose an organization to link people.')
    const q = typeof input.query === 'string' ? input.query.trim() : ''
    valid(q.length >= 2 && q.length <= 120, 'Enter at least two characters of a name.')
    return { people: store.list('people', { q, limit: 12 }).rows.filter(person => !person.mergedIntoId).map(personSummary) }
  }

  if (input.action !== undefined) {
    const requestId = input.requestId
    valid(typeof requestId === 'string' && /^[a-f0-9-]{36}$/i.test(requestId), 'The editor needs a new request.')
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    let command: CrmCommand
    switch (input.action) {
      case 'affiliation': {
        valid(type === 'person' && Number.isInteger(input.revision), 'Choose a contact and reload its latest details.')
        valid(input.kind === 'education' || input.kind === 'employment', 'Choose a company or school.')
        valid(typeof input.organization === 'string' && input.organization.trim() && input.organization.length <= 1000, 'Enter a company or school name.')
        const person = record as CrmPerson
        const roles = person.affiliations ?? []
        const existing = roles.find(role => role.id === (input.affiliationId ?? requestId))
        valid(input.affiliationId === undefined || existing && existing.kind === input.kind, 'This affiliation changed. Reopen the contact before editing it.')
        const name = input.organization.trim()
        const same = existing?.organization === name
        const matches = store.rows('companies', false).filter(company => !company.mergedIntoId && company.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())
        const organizationId = same ? existing.organizationId : matches.length === 1 ? matches[0].id : undefined
        const role: CrmAffiliation = { ...existing, id: existing?.id ?? requestId, kind: input.kind,
          organization: name, evidence: same ? existing.evidence : [],
          ...(input.kind === 'employment' && !existing ? { current: true } : {}),
        }
        if (organizationId) role.organizationId = organizationId
        else delete role.organizationId
        if (!same) {
          delete role.organizationUrl
          delete role.organizationLogoUrl
          delete role.excerpt
        }
        const affiliations = existing ? roles.map(value => value.id === existing.id ? role : value) : [...roles, role]
        const companyIds = person.companyIds.filter(id => id !== existing?.organizationId || affiliations.some(value => value.organizationId === id && value.kind === 'employment' && value.current))
        if (organizationId && role.kind === 'employment' && role.current && !companyIds.includes(organizationId)) companyIds.push(organizationId)
        command = { requestId, operation: 'update', collection: 'people', id, expectedRecordRevision: Number(input.revision), patch: { affiliations, companyIds } }
        break
      }
      case 'edit': {
        valid(Number.isInteger(input.revision), 'Reload the latest details before saving.')
        valid(input.patch && typeof input.patch === 'object' && !Array.isArray(input.patch), 'Choose details to save.')
        const patch = Object.fromEntries(Object.entries(input.patch).map(([key, value]) => {
          valid(editable.has(key), 'This field cannot be edited from Reader.')
          if (textFields.has(key)) {
            valid(typeof value === 'string' && value.length <= (key === 'description' ? 12000 : 500), 'Check the length of the field.')
            if (key === 'lastFundingDate' && value) valid(/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, 'Choose a valid funding date.')
            if (key === 'name') valid(value.trim(), 'Enter the organization name.')
          }
          if (listFields.has(key)) valid(Array.isArray(value) && value.length <= 64 && value.every(item => typeof item === 'string' && item.length <= 2048 && (key !== 'urls' || !!normalizeProfileUrl(item))), 'Enter one valid value per line. Websites need https:// or http://.')
          if (numericFields.has(key)) valid(value === null || typeof value === 'number' && Number.isFinite(value) && (key === 'foundationYear' ? Number.isInteger(value) && value >= 1 && value <= 9999 : value >= 0), 'Enter a valid number.')
          return [key, value]
        }))
        command = { requestId, operation: 'update', collection, id, expectedRecordRevision: Number(input.revision), patch }
        break
      }
      case 'group': {
        const group = typeof input.groupId === 'string' ? store.get('groups', input.groupId) : undefined
        valid(group && !group.archivedAt && store.groupSupports(group, type), 'Choose an available organization group.')
        command = { requestId, operation: 'membership', groupId: group.id, entity, remove: input.remove === true }
        break
      }
      case 'field': {
        const field = membershipFields.find(field => field.id === input.fieldId)
        valid(field, 'Join the field’s group before editing it.')
        valid(Number(input.revision) === (related.fieldValues.find(value => value.fieldId === field.id)?.revision ?? 0), 'This field changed. Reopen Reader before saving.')
        command = { requestId, operation: 'set_field', fieldId: field.id, entity, value: input.value }
        break
      }
      case 'note':
        valid(typeof input.body === 'string' && input.body.trim() && input.body.length <= 12000, 'Enter a note of up to 12,000 characters.')
        command = { requestId, operation: 'comment', record: { body: input.body.trim(), entityRefs: [entity] } }
        break
      case 'task':
      case 'interaction': {
        valid(title && title.length <= 300, 'Enter a title of up to 300 characters.')
        const date = input.date === null ? null : Number(input.date)
        valid(date === null || typeof input.date === 'number' && Number.isFinite(date) && Math.abs(date) <= 8.64e15, 'Choose a valid date.')
        const body = typeof input.body === 'string' ? input.body.trim().slice(0, 12000) : ''
        if (input.action === 'task') command = { requestId, operation: 'create', collection: 'tasks', record: { title, body, dueAt: date, entityRefs: [entity] } }
        else {
          const kind = typeof input.kind === 'string' && ['event', 'meeting', 'call', 'email', 'message', 'introduction'].includes(input.kind) ? input.kind : 'meeting'
          command = { requestId, operation: 'log_reader_interaction', record: { title, body, type: kind, companyIds: type === 'company' ? [id] : [], personIds: type === 'person' ? [id] : [], startAt: date } }
        }
        break
      }
      case 'complete-task': {
        const task = related.tasks.find(task => task.id === input.taskId)
        valid(task && task.revision === input.revision, 'The task changed. Reopen Reader to see the latest version.')
        command = { requestId, operation: 'complete_task', id: task.id, expectedRecordRevision: task.revision, completed: !task.completedAt }
        break
      }
      case 'link-person': {
        valid(type === 'company', 'Choose an organization to link people.')
        const person = typeof input.personId === 'string' ? store.get('people', input.personId) : undefined
        valid(person && !person.archivedAt && !person.mergedIntoId, 'Choose an existing active contact.')
        command = { requestId, operation: 'update', collection: 'people', id: person.id, expectedRecordRevision: person.revision, patch: { companyIds: [...new Set([...person.companyIds, id])] } }
        break
      }
      default:
        throw new Error('Choose a supported organization action.')
    }
    const result = store.command(command, 'reader-organization')
    if (!result.replayed) changed()
    return readerOrganization(store, id, {}, now, changed, type)
  }

  const roster = related.companyRoster
  const people = new Map((roster ? [...roster.current, ...roster.former, ...roster.education, ...roster.other] : []).map(person => [person.id, personSummary(person)]))
  return {
    record: Object.fromEntries(Object.entries(record).filter(([key]) => editable.has(key) || ['id','revision','createdAt','updatedAt','createdBy'].includes(key))),
    evidence: readerEnrichmentEvidence(record),
    memberships: related.memberships.map(member => ({ id: member.groupId, createdAt: member.createdAt, createdBy: member.createdBy })),
    groups: store.rows('groups', false).filter(group => store.groupSupports(group, type)).map(group => ({ id: group.id, name: group.name, emoji: group.emoji })),
    people: [...people.values()],
    connections: type === 'person' ? [...new Map([...related.companies, ...(related.affiliationOrganizations || [])].map(company => [company.id, { id: company.id, name: company.name, type: company.organizationType, logoUrl: company.logoUrl || '', logoAssetId: company.logoAssetId }])).values()] : [],
    affiliations: type === 'person' && 'affiliations' in record ? record.affiliations ?? [] : [],
    history: related.history.map(({ id, actor, operation, createdAt }) => ({ id, actor, operation, createdAt })),
    fields: membershipFields.map(field => {
      const saved = related.fieldValues.find(value => value.fieldId === field.id)
      return { id: field.id, name: field.name, type: field.type, options: field.options, value: saved?.value, revision: saved?.revision ?? 0 }
    }),
    notes: related.notes.map(({ id, body, authorName, createdAt }) => ({ id, body, authorName, createdAt })),
    tasks: related.tasks.map(({ id, title, body, dueAt, completedAt, revision }) => ({ id, title, body, dueAt, completedAt, revision })),
    interactions: related.interactions.map(({ id, title, body, type, startAt, status }) => ({ id, title, body, type, startAt, status })),
  }
}
