export const CRM_KV = 'crm.v1'
export const CRM_COLLECTIONS = ['people', 'companies', 'objects', 'groups', 'memberships', 'fields', 'fieldValues', 'notes', 'interactions', 'tasks', 'views', 'relationships', 'candidates', 'proposals', 'imports', 'history', 'campaigns', 'templates', 'sequences', 'members'] as const
export type CrmCollection = typeof CRM_COLLECTIONS[number]
export type CrmJson = null | boolean | number | string | CrmJson[] | { [key: string]: CrmJson }
export type CrmEntityType = 'person' | 'company' | 'object'
export interface CrmEntityRef { type: CrmEntityType; id: string }
export interface CrmSourceRef { provider: string; accountId: string; externalId: string; observedAt?: number; version?: string; originalAssetId?: string; url?: string }
export interface CrmEvidence { label: string; sourceRef?: CrmSourceRef; sourceId?: string; url?: string; excerpt?: string }
export interface CrmAffiliation {
  id: string; kind: 'education' | 'employment' | 'membership' | 'advisory'; organization: string;
  role?: string; degree?: string; field?: string; startDate?: string; endDate?: string; current?: boolean;
  organizationUrl?: string; organizationId?: string; excerpt?: string; evidence: CrmEvidence[];
}
/** Unknown imported fields remain in raw/extra; source payloads are never coerced away. */
export interface CrmBase { id: string; revision: number; createdAt: number; updatedAt: number; archivedAt: number | null; sourceRefs: CrmSourceRef[]; raw?: CrmJson; extra?: Record<string, CrmJson>; [key: string]: unknown }
export interface CrmPerson extends CrmBase { firstName: string; lastName: string; fullName: string; emails: string[]; phones: string[]; urls: string[]; jobTitle: string; description: string; location: string; companyIds: string[]; tags: string[]; avatarAssetId: string | null; mergedIntoId: string | null; affiliations?: CrmAffiliation[]; profileCaptureIds?: string[] }
export interface CrmCompany extends CrmBase { name: string; description: string; domain: string; emails: string[]; phones: string[]; urls: string[]; industry: string; tags: string[]; logoAssetId: string | null; organizationType?: 'company' | 'school' | 'university' | 'nonprofit' | 'community' | 'other'; tagline?: string; location?: string; profileCaptureIds?: string[] }
export interface CrmObject extends CrmBase { name: string; objectType: string; groupId: string | null; personIds: string[]; companyIds: string[]; description: string }
export interface CrmGroup extends CrmBase { name: string; parentId: string | null; entityType: CrmEntityType; objectType?: string; description: string; color: string; visibility: string; iconAssetId?: string | null; coverAssetId?: string | null; emoji?: string; icon?: 'folder' | 'people' | 'graduation' | 'planet' | 'sparkle' | 'books' | 'globe' | 'heart' | 'coffee' | 'briefcase' | 'camera' | 'music' | 'leaf' | 'lightning' | 'code' | 'mountains'; coverStyle?: 'contours' | 'orbit' | 'paper' | 'grid' | 'solid'; coverPosition?: number; appearanceDensity?: 'compact' | 'comfortable'; titleFont?: 'sans' | 'serif'; coverHeight?: 'small' | 'medium' | 'large'; titleColor?: string; coverDim?: number }
export interface CrmMembership extends CrmBase { groupId: string; entityType: CrmEntityType; entityId: string }
export interface CrmFieldOption { id: string; label: string; color?: string; order: number; [key: string]: unknown }
export interface CrmField extends CrmBase { groupId: string; entityType: CrmEntityType; name: string; type: string; options: CrmFieldOption[]; config: Record<string, CrmJson> }
export interface CrmFieldValue extends CrmBase { fieldId: string; groupId: string; entityType: CrmEntityType; entityId: string; value: CrmJson }
export interface CrmNote extends CrmBase { entityRefs: CrmEntityRef[]; body: string; authorName: string; parentId: string | null; mentionIds: string[]; attachmentAssetIds: string[]; pinned: boolean }
export interface CrmInteraction extends CrmBase { title: string; type: string; status: 'scheduled' | 'logged' | 'cancelled'; body: string; personIds: string[]; companyIds: string[]; startAt: number | null; endAt: number | null; occurredAt: number | null; timezone: string; allDay: boolean; attendanceConfirmed: boolean; attachmentAssetIds: string[] }
export interface CrmTask extends CrmBase { title: string; body: string; entityRefs: CrmEntityRef[]; dueAt: number | null; completedAt: number | null; assigneeId: string | null }
export type CrmFilter = { op: 'and' | 'or'; rules: CrmFilter[] } | { field: string; operator: 'eq' | 'neq' | 'contains' | 'notContains' | 'empty' | 'notEmpty' | 'in' | 'gt' | 'gte' | 'lt' | 'lte'; value?: CrmJson }
export interface CrmView extends CrmBase { name: string; groupId: string | null; collection: 'people' | 'companies' | 'objects'; layout: 'table' | 'gallery' | 'board' | 'network' | 'list'; filter: CrmFilter | null; columns: string[]; sort: { field: string; direction: 'asc' | 'desc' }[]; groupBy: string | null }
export interface CrmRelationship extends CrmBase { from: CrmEntityRef; to: CrmEntityRef; relation: string; confirmed: boolean; context: string; evidence: CrmEvidence[] }
export interface CrmCandidate extends CrmBase {
  /** Review suggestions only; multiple matches never choose a target automatically. */
  matchingPersonIds?: string[]; sourceIdentityEstablished?: boolean; kind: 'person' | 'company' | 'interaction' | 'relationship' | 'update' | 'merge'; status: 'pending' | 'accepted' | 'dismissed'; provider: string; accountId: string; externalId: string; payload: Record<string, unknown>; targetId: string | null; confidence: 'exact' | 'possible' | 'unknown'; evidence: CrmEvidence[] }
export interface CrmProposal extends CrmBase { status: 'pending' | 'approved' | 'rejected'; collection: CrmCollection; targetId: string | null; expectedRecordRevision: number | null; patch: Record<string, unknown>; evidence: CrmEvidence[]; clientId: string; explanation: string; decidedAt: number | null }
export interface CrmImport extends CrmBase { provider: string; accountId: string; name: string; status: 'complete' | 'partial' | 'failed'; originalAssetIds: string[]; counts: Record<string, number>; errors: string[] }
export interface CrmHistory extends CrmBase { operation: string; collection: CrmCollection; recordId: string; before: CrmBase | null; after: CrmBase | null; actor: string; undoOf: string | null }
export interface CrmCampaign extends CrmBase { name: string; subject: string; body: string; personIds: string[]; status: 'draft' | 'archived'; templateId: string | null; metrics: Record<string, number> }
export interface CrmTemplate extends CrmBase { name: string; subject: string; body: string; variables: string[] }
export interface CrmSequence extends CrmBase { name: string; status: 'draft' | 'paused'; personIds: string[]; steps: { id: string; delayDays: number; subject: string; body: string }[] }
export interface CrmMember extends CrmBase { name: string; email: string; role: string }
export interface CrmCollectionMap { people: CrmPerson; companies: CrmCompany; objects: CrmObject; groups: CrmGroup; memberships: CrmMembership; fields: CrmField; fieldValues: CrmFieldValue; notes: CrmNote; interactions: CrmInteraction; tasks: CrmTask; views: CrmView; relationships: CrmRelationship; candidates: CrmCandidate; proposals: CrmProposal; imports: CrmImport; history: CrmHistory; campaigns: CrmCampaign; templates: CrmTemplate; sequences: CrmSequence; members: CrmMember }
export type CrmRow = CrmCollectionMap[CrmCollection]
export type CrmSnapshot = { schemaVersion: 1; revision: number } & { [K in CrmCollection]: CrmCollectionMap[K][] }
export interface CrmListQuery { q?: string; groupId?: string; entityId?: string; entityType?: CrmEntityType; status?: string; archived?: boolean; offset?: number; limit?: number; filter?: CrmFilter; sort?: { field: string; direction: 'asc' | 'desc' }[] }
export interface CrmPage<K extends CrmCollection = CrmCollection> { revision: number; collection: K; rows: CrmCollectionMap[K][]; total: number; nextOffset: number | null }
export interface CrmCommand { requestId: string; operation: string; collection?: CrmCollection; id?: string; expectedRecordRevision?: number; record?: Record<string, unknown>; patch?: Record<string, unknown>; [key: string]: unknown }
export interface CrmCommandResult { ok: true; revision: number; operation: string; record?: CrmRow; records?: CrmRow[]; counts?: Record<string, number>; mergedId?: string; historyId?: string; replayed?: boolean; [key: string]: unknown }
