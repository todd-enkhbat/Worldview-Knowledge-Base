import { createHash } from 'node:crypto'
import type { WorldDb } from './worldDb.ts'
import { listMemoryClients, type MemoryClient, type PublicMemoryClient } from './memoryAccess.ts'
import { createCrmRecord, isCrmCollection } from '../src/crm/model.ts'
import type { CrmCollection, CrmEntityRef, CrmPerson, CrmProposal, CrmRow } from '../src/crm/types.ts'

type ScopedClient = MemoryClient | PublicMemoryClient
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
export const canUseCrm = (client: ScopedClient) => !!client.crmPersonIds?.length || !!client.crmGroupIds?.length || !!client.allowCreateCrmPeople
const permittedKeys: Partial<Record<CrmCollection, string[]>> = {
  people: ['firstName', 'lastName', 'fullName', 'emails', 'phones', 'urls', 'jobTitle', 'description', 'location', 'companyIds', 'tags', 'affiliations'],
  companies: ['name', 'description', 'domain', 'emails', 'phones', 'urls', 'industry', 'tags', 'organizationType', 'tagline', 'location'],
  objects: ['name', 'description', 'objectType', 'groupId', 'personIds', 'companyIds'],
  groups: ['name', 'description', 'color', 'parentId'], fields: ['name', 'type', 'options', 'config'],
  fieldValues: ['fieldId', 'groupId', 'entityType', 'entityId', 'value'], memberships: ['groupId', 'entityType', 'entityId'],
  notes: ['entityRefs', 'body', 'parentId', 'pinned', 'mentionIds'], tasks: ['title', 'body', 'entityRefs', 'dueAt', 'recurrenceFrequency'],
  relationships: ['from', 'to', 'relation', 'context', 'confirmed', 'evidence'],
  interactions: ['title', 'type', 'body', 'personIds', 'companyIds'],
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, part) => object(part) ? Object.fromEntries(Object.keys(part).sort().map(key => [key, part[key]])) : part)).digest('hex')
export function createCrmAssistant(db: WorldDb, now: () => number = Date.now) {
  const activeGroups = (client: ScopedClient) => new Set((client.crmGroupIds ?? []).filter(id => db.crm.get('groups', id)?.archivedAt === null))
  function allowedEntity(ref: CrmEntityRef, client: ScopedClient): boolean {
    const collection = ref.type === 'person' ? 'people' : ref.type === 'company' ? 'companies' : 'objects', row = db.crm.get(collection, ref.id)
    if (!row || row.archivedAt !== null || collection === 'people' && (row as CrmPerson).mergedIntoId) return false
    if (ref.type === 'person' && client.crmPersonIds?.includes(ref.id)) return true
    const groups = activeGroups(client)
    if (db.crm.rows('memberships', false).some(member => member.entityId === ref.id && member.entityType === ref.type && groups.has(member.groupId))) return true
    return !!client.allowCreateCrmPeople && ref.type === 'person' && db.crm.rows('proposals', false).some(proposal => proposal.clientId === client.id && proposal.status === 'approved' && proposal.collection === 'people' && proposal.targetId === ref.id && proposal.extra?.createdByAssistant === true)
  }
  function allowedRecord(collection: CrmCollection, row: CrmRow, client: ScopedClient): boolean {
    if (row.archivedAt !== null || !canUseCrm(client)) return false
    if (['people', 'companies', 'objects'].includes(collection)) return allowedEntity({ type: collection === 'people' ? 'person' : collection === 'companies' ? 'company' : 'object', id: row.id }, client)
    if (collection === 'groups') return activeGroups(client).has(row.id)
    if (collection === 'fields') return activeGroups(client).has(String(row.groupId))
    if (collection === 'memberships' || collection === 'fieldValues') return activeGroups(client).has(String(row.groupId)) && allowedEntity({ type: row.entityType as CrmEntityRef['type'], id: String(row.entityId) }, client)
    if (collection === 'notes' || collection === 'tasks') return Array.isArray(row.entityRefs) && row.entityRefs.length > 0 && row.entityRefs.every(ref => object(ref) && allowedEntity(ref as unknown as CrmEntityRef, client))
    if (collection === 'relationships') return allowedEntity(row.from as CrmEntityRef, client) && allowedEntity(row.to as CrmEntityRef, client)
    if (collection === 'interactions') return Array.isArray(row.personIds) && Array.isArray(row.companyIds) && row.personIds.length + row.companyIds.length > 0 && row.personIds.every(id => allowedEntity({ type: 'person', id: String(id) }, client)) && row.companyIds.every(id => allowedEntity({ type: 'company', id: String(id) }, client))
    return false
  }
  const publicRecord = (collection: CrmCollection, row: CrmRow) => Object.fromEntries([...new Set(['id', 'revision', 'createdAt', 'updatedAt', ...(permittedKeys[collection] ?? []), ...(collection === 'groups' ? ['entityType', 'entityTypes'] : [])])].filter(key => row[key] !== undefined).map(key => [key, row[key]]))
  function authorize(proposal: CrmProposal): void {
    const client = listMemoryClients(db).find(entry => entry.id === proposal.clientId && entry.worldId === 'local' && entry.revokedAt === null && entry.expiresAt > now())
    check(client && canUseCrm(client), 'This assistant People grant expired or was revoked. Reject this proposal or reconnect explicitly.')
    const allowed = permittedKeys[proposal.collection]
    check(allowed && Object.keys(proposal.patch).every(key => allowed.includes(key)), 'This assistant proposal changes unsupported People fields.')
    const current = proposal.targetId ? db.crm.get(proposal.collection, proposal.targetId) : undefined
    if (proposal.targetId) check(current && allowedRecord(proposal.collection, current, client), 'The target is outside this assistant’s current People scope.')
    else check(proposal.collection === 'people' ? client.allowCreateCrmPeople : ['notes', 'tasks', 'relationships', 'memberships', 'fieldValues'].includes(proposal.collection), 'This assistant cannot create that type of People record.')
    const proposed = createCrmRecord(proposal.collection, { ...(current ?? {}), ...proposal.patch })
    if (proposal.collection !== 'people' || proposal.targetId) check(allowedRecord(proposal.collection, proposed, client), 'The proposed references are outside this assistant’s current People scope.')
    if (proposal.collection === 'people' || proposal.collection === 'companies') for (const companyId of (proposal.patch.companyIds ?? []) as string[]) check(allowedEntity({ type: 'company', id: companyId }, client), 'A company reference is outside the selected People scope.')
    if (proposal.collection === 'people' && proposal.patch.affiliations !== undefined) for (const affiliation of (proposed as CrmPerson).affiliations ?? []) if (affiliation.organizationId) check(allowedEntity({ type: 'company', id: affiliation.organizationId }, client), 'An affiliation organization is outside the selected People scope.')
    if (proposal.collection === 'groups' && proposed.parentId) check(activeGroups(client).has(String(proposed.parentId)), 'Choose a permitted parent group.')
    if (proposal.collection === 'notes' && proposed.parentId) { const parent = db.crm.get('notes', String(proposed.parentId)); check(parent && allowedRecord('notes', parent, client), 'The parent comment is outside this assistant scope.') }
    if (proposal.collection === 'notes') for (const id of proposed.mentionIds as string[]) check(allowedEntity({ type: 'person', id }, client), 'A mentioned person is outside this assistant scope.')
  }
  db.crm.setProposalAuthorizer(authorize)
  function operation(name: string, raw: unknown, client: MemoryClient): unknown {
    check(canUseCrm(client) && client.worldId === 'local' && !db.getKv('importInProgress'), 'Choose explicit People or group access before using CRM tools.')
    const input = object(raw) ? raw : {}, collection = input.collection ?? 'people'
    if (name === 'get_crm_edit_status') { const proposal = typeof input.proposalId === 'string' ? db.crm.get('proposals', input.proposalId) : undefined; check(proposal && proposal.clientId === client.id, 'This proposal is unavailable to this assistant.'); return { ok: true, proposalId: proposal.id, status: proposal.status, targetId: proposal.targetId, revision: proposal.revision } }
    check(isCrmCollection(collection) && permittedKeys[collection], 'Choose a supported People collection.')
    if (name === 'list_crm_records') {
      const offset = Number.isSafeInteger(input.offset) && Number(input.offset) >= 0 ? Number(input.offset) : 0, limit = Number.isSafeInteger(input.limit) ? Math.max(1, Math.min(100, Number(input.limit))) : 30, query = typeof input.query === 'string' ? input.query.toLocaleLowerCase().slice(0, 2000) : ''
      const records = db.crm.rows(collection, false).filter(row => allowedRecord(collection, row, client)).map(row => publicRecord(collection, row)).filter(row => !query || JSON.stringify(row).toLocaleLowerCase().includes(query)), rows: Record<string, unknown>[] = []
      let bytes = 0
      for (const row of records.slice(offset, offset + limit)) { let summary = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 800) : Array.isArray(value) ? value.slice(0, 25) : value])); if (Buffer.byteLength(JSON.stringify(summary)) > 16000) summary = { id: row.id, revision: row.revision, name: row.fullName ?? row.name ?? row.title ?? '', previewTruncated: true }; const size = Buffer.byteLength(JSON.stringify(summary)); if (bytes + size > 48 * 1024) break; bytes += size; rows.push(summary) }
      return { revision: db.crm.revision(), collection, rows, total: records.length, nextOffset: offset + rows.length < records.length ? offset + rows.length : null }
    }
    if (name === 'read_crm_record') { const row = typeof input.id === 'string' ? db.crm.get(collection, input.id) : undefined; check(row && allowedRecord(collection, row, client), 'This record is outside the selected People scope.'); const record = publicRecord(collection, row); check(Buffer.byteLength(JSON.stringify(record)) <= 64 * 1024, 'This People record is too large for an assistant read. Narrow its fields in Worldview first.'); return { revision: db.crm.revision(), collection, record } }
    check(name === 'propose_crm_change' && typeof input.requestId === 'string' && input.requestId.length > 0 && input.requestId.length <= 160 && object(input.patch), 'Provide a unique requestId, collection and structured patch.')
    check(typeof input.explanation === 'string' && input.explanation.length <= 4000 && Array.isArray(input.evidence) && input.evidence.length <= 32 && input.evidence.every(item => object(item) && typeof item.label === 'string' && item.label.length <= 1000 && (item.url === undefined || typeof item.url === 'string' && /^https?:\/\//.test(item.url))), 'Provide an explanation and explicit evidence labels or public source URLs.')
    check(Buffer.byteLength(JSON.stringify(input.patch)) <= 64 * 1024, 'Keep a proposed People change within 64 KiB.')
    const fingerprint = digest(input), existing = db.crm.rows('proposals').find(proposal => proposal.clientId === client.id && proposal.extra?.requestId === input.requestId)
    if (existing) { check(existing.extra?.requestFingerprint === fingerprint, 'This assistant requestId was already used for a different CRM proposal.'); authorize(existing); return { ok: true, proposalId: existing.id, status: existing.status, reviewRequired: true, reviewUrl: '#/people?tab=review', replayed: true } }
    check(db.crm.rows('proposals', false).filter(proposal => proposal.clientId === client.id && proposal.status === 'pending').length < 100, 'Review existing People proposals before adding more.')
    const targetId = typeof input.id === 'string' ? input.id : null
    if (targetId) check(Number.isSafeInteger(input.expectedRecordRevision) && db.crm.get(collection, targetId)?.revision === input.expectedRecordRevision, 'Refresh the current target revision before proposing this change.')
    const proposal = createCrmRecord('proposals', { collection, targetId, expectedRecordRevision: targetId ? input.expectedRecordRevision : null, patch: input.patch, evidence: input.evidence, explanation: input.explanation, clientId: client.id, extra: { clientName: client.name, createdByAssistant: !targetId, requestId: input.requestId, requestFingerprint: fingerprint } }, now())
    authorize(proposal)
    const result = db.crm.command({ requestId: 'crm-assistant:' + digest([client.id, input.requestId]), operation: 'create', collection: 'proposals', record: { collection, targetId, expectedRecordRevision: proposal.expectedRecordRevision, patch: proposal.patch, evidence: proposal.evidence, explanation: proposal.explanation, clientId: client.id, extra: proposal.extra } }, `assistant:${client.id}`)
    return { ok: true, proposalId: result.record!.id, status: 'pending', reviewRequired: true, reviewUrl: '#/people?tab=review', replayed: !!result.replayed }
  }
  return { operation, authorize }
}
export const crmAssistantTools = [
  ['list_crm_records', 'List only explicitly authorized People, company/group/field/comment/task/relationship records. source allSources access never grants CRM access. Returns current record revisions.'],
  ['read_crm_record', 'Read one authorized CRM record. Original imports, credentials and unrelated people are excluded.'],
  ['propose_crm_change', 'Propose an enrichment, comment, task, group-field, membership or relationship change within the explicit People scope. Existing records require exact expectedRecordRevision; evidence and explanation are required. Nothing applies until local user review; no cloud AI is enabled.'],
  ['get_crm_edit_status', 'Read the decision on a CRM proposal submitted by this client.'],
].map(([name, description]) => ({ name, description, inputSchema: { type: 'object' as const, properties: { collection: { type: 'string', enum: Object.keys(permittedKeys) }, id: { type: 'string', maxLength: 1000 }, query: { type: 'string', maxLength: 2000 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, requestId: { type: 'string', maxLength: 160 }, expectedRecordRevision: { type: 'integer', minimum: 1 }, patch: { type: 'object' }, evidence: { type: 'array', maxItems: 32, items: { type: 'object' } }, explanation: { type: 'string', maxLength: 4000 }, proposalId: { type: 'string', maxLength: 1000 } }, additionalProperties: false }, annotations: { readOnlyHint: name !== 'propose_crm_change', destructiveHint: false, idempotentHint: true, openWorldHint: false } }))
