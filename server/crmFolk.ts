import { createHash } from 'node:crypto'
import { crmRecordLocation } from '../src/crm/recordLocation.ts'
import { CRM_COLLECTIONS } from '../src/crm/types.ts'
import type { CrmBase, CrmEntityRef, CrmEntityType, CrmField, CrmJson, CrmSnapshot, CrmSourceRef } from '../src/crm/types.ts'

type Row = Record<string, unknown>
export interface FolkNormalizationReport {
  counts: Record<string, number>
  issues: string[]
  completeness: Record<string, boolean>
}
export interface FolkNormalizationResult { snapshot: CrmSnapshot; report: FolkNormalizationReport }

const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const string = (value: unknown): string => typeof value === 'string' ? value : ''
const strings = (value: unknown): string[] => array(value).filter((item): item is string => typeof item === 'string')
const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))]
const time = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
const stableId = (kind: string, ...parts: string[]): string => `folk_${kind}_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)}`
const entityType = (value: unknown): CrmEntityType | null => value === 'person' || value === 'company' || value === 'object' ? value : null
const json = (value: unknown): CrmJson => JSON.parse(JSON.stringify(value ?? null)) as CrmJson
const reference = (value: unknown): CrmEntityRef | null => {
  const row = object(value)
  const id = string(row.id)
  const type = entityType(row.entityType ?? row.type) ?? (id.startsWith('per_') ? 'person' : id.startsWith('com_') ? 'company' : id.startsWith('obj_') ? 'object' : null)
  return type && id ? { type, id } : null
}
const rows = (value: unknown): Row[] => array(value).map(object)
const ids = (value: unknown): string[] => unique(array(value).map(item => string(object(item).id) || string(item)))

/**
 * Pure, deterministic adapter. Source IDs are retained; imported records are never
 * matched by names or emails. The caller owns backup, conflict review and persistence.
 * Unknown source fields remain in raw, including values unavailable in the UI.
 */
export function normalizeFolkExport(value: unknown): FolkNormalizationResult {
  const input = object(value)
  if (!Array.isArray(input.people) || !Array.isArray(input.companies) || !Array.isArray(input.groups)) {
    throw new Error('A Folk export must include people, companies and groups arrays.')
  }
  const workspace = object(input.workspace)
  const workspaceMembers = rows(workspace.members)
  const derivedAccountId = stableId('workspace', string(workspace.name), ...workspaceMembers.map(member => string(member.id)).sort())
  const accountId = string(input.accountId) || string(workspace.id) || derivedAccountId
  const observedAt = time(input.capturedAt) ?? 0
  const issues: string[] = []
  if (!string(input.accountId) && !string(workspace.id)) issues.push('The connector did not expose a workspace ID. Retain this export accountId for future migrations.')
  const completeness: Record<string, boolean> = Object.fromEntries(Object.entries(object(input.completeness)).map(([key, complete]) => [key, complete === true]))
  for (const key of ['groups', 'people', 'companies', 'notes', 'tasks', 'interactions', 'interactionBodies', 'savedTableViewLayout']) {
    if (!(key in completeness)) completeness[key] = false
  }
  issues.push(...strings(input.limitations))
  for (const key of ['groups', 'people', 'companies', 'notes', 'tasks', 'interactions']) {
    if (!completeness[key]) issues.push(`Source completeness has not been established for ${key}.`)
  }
  const snapshot = { schemaVersion: 1, revision: 0, ...Object.fromEntries(CRM_COLLECTIONS.map(key => [key, []])) } as unknown as CrmSnapshot
  const source = (externalId: string, url?: string): CrmSourceRef => ({ provider: 'folk', accountId, externalId, observedAt, ...(url ? { url } : {}) })
  const base = (row: Row, id: string, kind: string): CrmBase => ({
    id, revision: 1, createdAt: time(row.createdAt) ?? 0,
    updatedAt: time(row.updatedAt) ?? time(row.createdAt) ?? 0,
    archivedAt: time(row.archivedAt), sourceRefs: [source(['membership', 'relationship', 'fieldValue'].includes(kind) ? id : string(row.id) || id, string(row.url))],
    raw: json(row), extra: { providerKind: kind },
  })
  const deduplicate = (collection: string, values: unknown): Row[] => {
    const found = new Map<string, Row>()
    let duplicates = 0
    for (const row of rows(values)) {
      const id = string(row.id)
      if (!id) { issues.push(`Skipped a ${collection} row without a source ID.`); continue }
      if (found.has(id)) duplicates++
      found.set(id, row)
    }
    if (duplicates) issues.push(`Collapsed ${duplicates} repeated ${collection} source IDs; original export pages remain authoritative.`)
    return [...found.values()]
  }
  const groupSchemas = new Map(rows(workspace.groups).map(group => [string(group.id), group]))
  const groupRows = new Map([...deduplicate('groups', input.groups), ...rows(workspace.groups)].map(group => [string(group.id), group]))
  // The list endpoint supplies visibility/emoji while the structure endpoint supplies fields/pipelines.
  for (const group of rows(input.groups)) groupRows.set(string(group.id), { ...object(groupRows.get(string(group.id))), ...group })
  for (const [id, group] of groupRows) {
    if (!id) continue
    const schema = object(groupSchemas.get(id))
    const types = array(schema.entityTypes).map(entityType).filter((type): type is CrmEntityType => type !== null)
    snapshot.groups.push({
      ...base({ ...schema, ...group }, id, 'group'), name: string(group.name),
      parentId: string(group.parentId) || null, entityType: types[0] ?? 'person',
      description: string(group.description), color: string(group.color), visibility: string(group.visibility) || 'unknown',
      entityTypes: types, emoji: string(group.emoji), createdBy: json(group.createdBy),
    })
  }
  const fieldIndex = new Map<string, CrmField>()
  const fieldKey = (groupId: string, type: CrmEntityType, name: string): string => JSON.stringify([groupId, type, name])
  const addField = (groupId: string, type: CrmEntityType, field: Row): CrmField => {
    const name = string(field.name)
    const key = fieldKey(groupId, type, name)
    const existing = fieldIndex.get(key)
    if (existing) return existing
    const id = string(field.id) || stableId('field', accountId, groupId, type, name)
    const normalized: CrmField = {
      ...base(field, id, 'field'), groupId, entityType: type, name, type: string(field.type) || 'unknown',
      options: array(field.options).map((option, order) => {
        const raw = object(option)
        const label = string(option) || string(raw.label) || string(raw.name)
        const duplicateLabelIndex = array(field.options).slice(0, order).filter(previous => (string(previous) || string(object(previous).label) || string(object(previous).name)) === label).length
        return { ...raw, id: string(raw.id) || stableId('option', id, label, String(duplicateLabelIndex)), label, order, raw: json(option) }
      }), config: object(json(object(field.config))) as Record<string, CrmJson>,
    }
    fieldIndex.set(key, normalized)
    snapshot.fields.push(normalized)
    return normalized
  }
  for (const [groupId, schema] of groupSchemas) {
    for (const [typeName, fields] of Object.entries(object(schema.customFieldsByEntityType))) {
      const type = entityType(typeName)
      if (!type) { issues.push('Preserved an unrecognized entity field schema in the raw group.'); continue }
      for (const field of rows(fields)) addField(groupId, type, field)
    }
  }
  const memberships = new Map<string, CrmSnapshot['memberships'][number]>()
  const addEntityDetails = (row: Row, type: CrmEntityType, entityId: string) => {
    for (const group of rows(row.groups)) {
      const groupId = string(group.id)
      if (!groupId) continue
      const id = stableId('membership', accountId, groupId, type, entityId)
      memberships.set(id, { ...base(group, id, 'membership'), groupId, entityType: type, entityId })
      if (!groupRows.has(groupId)) {
        issues.push(`An entity references group ${groupId} without an accessible group schema.`)
        groupRows.set(groupId, group)
        snapshot.groups.push({ ...base(group, groupId, 'group'), name: string(group.name), parentId: null, entityType: type, description: '', color: '', visibility: 'unknown', entityTypes: [type] })
      }
    }
    for (const [groupId, values] of Object.entries(object(row.customFieldValues))) {
      for (const [name, value] of Object.entries(object(values))) {
        const known = fieldIndex.get(fieldKey(groupId, type, name))
        const field = known ?? addField(groupId, type, { name, type: 'unknown', sourceSchemaMissing: true })
        if (!known) issues.push(`Preserved a custom field value without its schema in group ${groupId}.`)
        const id = stableId('value', accountId, field.id, type, entityId)
        const valueRefs = array(value).map(item => reference(item)).filter((ref): ref is CrmEntityRef => ref !== null)
        const fieldKind = field.type.toLowerCase().replace(/[-_ ]/g, '')
        const optionId = (part: unknown) => field.options.find(option => option.id === part || option.label === part)?.id ?? part
        const canonicalValue = ['select', 'singleselect'].includes(fieldKind) ? optionId(value) : ['multiselect', 'multipleselect', 'selectmultiple'].includes(fieldKind) && Array.isArray(value) ? value.map(optionId) : value
        snapshot.fieldValues.push({ ...base({ value }, id, 'fieldValue'), fieldId: field.id, groupId, entityType: type, entityId, value: json(canonicalValue), valueRefs, selectedOptionIds: field.options.filter(option => canonicalValue === option.id || strings(canonicalValue).includes(option.id)).map(option => option.id) })
        // Only explicit contact/object fields create semantic edges. Coattendance and
        // strongestConnection metadata do not prove two contacts know each other.
        if (field.type === 'contactField' || field.type === 'objectField') for (const target of valueRefs) {
          const relationId = stableId('relationship', accountId, entityId, field.id, target.type, target.id)
          snapshot.relationships.push({ ...base({ fieldId: field.id, value }, relationId, 'relationship'), from: { type, id: entityId }, to: target, relation: name, confirmed: true, context: 'Explicit imported relationship field', evidence: [{ label: 'Folk relationship field', sourceRef: source(entityId) }] })
        }
      }
    }
  }
  for (const row of deduplicate('people', input.people)) {
    const id = string(row.id)
    snapshot.people.push({
      ...base(row, id, 'person'), firstName: string(row.firstName), lastName: string(row.lastName), fullName: string(row.fullName),
      emails: strings(row.emails), phones: strings(row.phones), urls: strings(row.urls), jobTitle: string(row.jobTitle), description: string(row.description),
      location: crmRecordLocation(row), companyIds: ids(row.companies), tags: strings(row.tags), avatarAssetId: null, mergedIntoId: null,
      birthday: json(row.birthday), gender: json(row.gender), addresses: json(row.addresses), createdBy: json(row.createdBy), interactionMetadata: json(row.interactionMetadata), strongestConnection: json(row.strongestConnection),
    })
    addEntityDetails(row, 'person', id)
    for (const company of rows(row.companies)) {
      const companyId = string(company.id)
      if (!companyId) continue
      const relationId = stableId('relationship', accountId, 'person', id, 'company', companyId)
      snapshot.relationships.push({ ...base(company, relationId, 'relationship'), from: { type: 'person', id }, to: { type: 'company', id: companyId }, relation: 'works at', confirmed: true, context: 'Imported company association; current role is not independently verified.', evidence: [{ label: 'Folk company association', sourceRef: source(id) }] })
    }
  }
  for (const row of deduplicate('companies', input.companies)) {
    const id = string(row.id)
    snapshot.companies.push({ ...base(row, id, 'company'), name: string(row.name), description: string(row.description), domain: string(row.domain), emails: strings(row.emails), phones: strings(row.phones), urls: strings(row.urls), industry: string(row.industry), tags: strings(row.tags), logoAssetId: null, location: crmRecordLocation(row), addresses: json(row.addresses), foundationYear: json(row.foundationYear), fundingRaised: json(row.fundingRaised), lastFundingDate: json(row.lastFundingDate), employeeRange: json(row.employeeRange), createdBy: json(row.createdBy) })
    addEntityDetails(row, 'company', id)
  }
  for (const row of deduplicate('objects', input.objects)) {
    const id = string(row.id)
    snapshot.objects.push({ ...base(row, id, 'object'), name: string(row.name), objectType: string(row.objectType) || string(row.type), groupId: string(row.groupId) || null, personIds: ids(row.people), companyIds: ids(row.companies), description: string(row.description) })
    addEntityDetails(row, 'object', id)
  }
  snapshot.memberships = [...memberships.values()]
  for (const row of deduplicate('notes', input.notes)) {
    const author = object(row.author)
    const entity = reference(row.entity)
    snapshot.notes.push({ ...base(row, string(row.id), 'note'), entityRefs: entity ? [entity] : [], body: string(row.content), authorName: string(author.fullName), parentId: string(object(row.parentNote).id) || null, mentionIds: ids(row.mentions), attachmentAssetIds: [], pinned: row.pinned === true, visibility: string(row.visibility) || 'unknown', author: json(row.author), parentNote: json(row.parentNote), attachments: json(row.attachments) })
  }
  for (const row of deduplicate('tasks', input.tasks)) {
    const entity = reference(row.entity)
    const assigneeIds = ids(row.assignedUsers)
    snapshot.tasks.push({ ...base(row, string(row.id), 'task'), title: string(row.title), body: string(row.description), entityRefs: entity ? [entity] : [], dueAt: time(row.dueAt), completedAt: time(row.completedAt), assigneeId: assigneeIds[0] ?? null, assigneeIds, assignedUsers: json(row.assignedUsers), createdBy: json(row.createdBy), recurrenceFrequency: json(row.recurrenceFrequency), dueTime: json(row.dueTime), isPublic: row.isPublic === true })
  }
  const interactionRows = new Map<string, Row[]>()
  for (const entry of rows(input.interactions)) {
    const row = object(entry.interaction ?? entry)
    const id = string(row.id)
    if (!id) { issues.push('Skipped an interaction without a source ID.'); continue }
    const instances = interactionRows.get(id) ?? []
    instances.push({ ...row, ...(entry.historyKind ? { historyKind: entry.historyKind } : {}) })
    interactionRows.set(id, instances)
  }
  for (const [id, instances] of interactionRows) {
    const row = instances[0]
    const content = object(row.content)
    const associations = instances.map(instance => reference(instance.entity)).filter((ref): ref is CrmEntityRef => ref !== null)
    const at = time(row.dateTime)
    const isUpcoming = instances.some(instance => instance.historyKind === 'upcoming') || (string(row.interactionType) === 'calendar' && at !== null && at > observedAt)
    const levels = unique(instances.map(instance => string(instance.privacyLevel) || 'unknown'))
    const privacyLevel = levels.find(level => level !== 'sharedFull') ?? 'sharedFull'
    const body = privacyLevel === 'sharedFull' ? (string(row.content) || string(content.body) || string(content.text) || string(content.snippet)) : ''
    snapshot.interactions.push({ ...base(row, id, 'interaction'), raw: json(instances), title: string(row.title) || string(content.subject) || string(content.context), type: string(row.interactionType), status: isUpcoming ? 'scheduled' : 'logged', body, personIds: unique(associations.filter(ref => ref.type === 'person').map(ref => ref.id)), companyIds: unique(associations.filter(ref => ref.type === 'company').map(ref => ref.id)), startAt: string(row.interactionType) === 'calendar' ? at : null, endAt: time(row.endAt), occurredAt: isUpcoming ? null : at, timezone: string(row.timezone), allDay: row.allDay === true, attendanceConfirmed: false, attachmentAssetIds: [], privacyLevel, sourcePrivacyLevels: levels, from: json(row.from), to: json(row.to), entityRefs: associations, activityType: json(row.activityType), sourceUrl: string(row.url), readOnlySource: row.interactionType !== 'logged' })
  }
  for (const [groupId, schema] of groupSchemas) {
    for (const row of rows(schema.pipelines)) {
      const type = entityType(row.entityType) ?? 'person'
      const field = fieldIndex.get(fieldKey(groupId, type, string(row.customFieldName)))
      const id = string(row.id) || stableId('view', accountId, groupId, type, string(row.name))
      snapshot.views.push({ ...base(row, id, 'pipeline'), name: string(row.name), groupId, collection: type === 'person' ? 'people' : type === 'company' ? 'companies' : 'objects', layout: 'board', filter: null, columns: [], sort: [], groupBy: field?.id ?? null, sourceLayoutPartial: true })
    }
  }
  for (const row of workspaceMembers) {
    const id = string(row.id)
    if (id) snapshot.members.push({ ...base(row, id, 'member'), name: string(row.fullName), email: string(row.email), role: string(row.role) || 'source-member' })
  }
  const counts = Object.fromEntries(CRM_COLLECTIONS.filter(key => key !== 'imports').map(key => [key, snapshot[key].length]))
  const importId = stableId('import', accountId)
  snapshot.imports.push({ ...base({ id: importId }, importId, 'import'), provider: 'folk', accountId, name: 'Folk workspace migration', status: Object.values(completeness).every(Boolean) ? 'complete' : 'partial', originalAssetIds: strings(input.originalAssetIds), counts, errors: unique(issues), raw: json({ format: input.format, capturedAt: input.capturedAt, workspace: input.workspace, completeness, limitations: input.limitations, interactionExportStatus: input.interactionExportStatus }), sourceWorkspaceId: string(workspace.id) || null })
  counts.imports = snapshot.imports.length
  return { snapshot, report: { counts, issues: unique(issues), completeness } }
}
