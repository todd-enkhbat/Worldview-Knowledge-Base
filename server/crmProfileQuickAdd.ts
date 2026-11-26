import { PROFILE_CAPTURE_FIELDS, type CrmProfileCaptureDraft } from '../src/crm/profileCaptureTypes.ts'
import type { CrmProfileCapture } from './crmProfileCapture.ts'
import type { CrmProfileMedia } from './crmProfileMedia.ts'
import { CrmError, type SqliteCrmStore } from './crmStore.ts'

interface Services { capture: CrmProfileCapture; store: SqliteCrmStore; media: CrmProfileMedia | null }
export interface QuickAddResult {
  status: 'review' | 'saved'
  recordId?: string
  image?: 'saved' | 'kept' | 'unavailable'
  message?: string
}

export async function quickAddProfile(services: Services, draft: CrmProfileCaptureDraft, requestId: string, groupId?: string, authorize?: () => void, selectedTarget?: { id: string; revision: number; name: string; verifiedCatalogName?: string }): Promise<QuickAddResult> {
  authorize?.()
  const { capture, store, media } = services
  const type = draft.profile.entityType, collection = type === 'person' ? 'people' : 'companies'
  if (groupId) {
    const group = store.get('groups', groupId)
    if (!group || group.archivedAt !== null || !store.groupSupports(group, type)) {
      return { status: 'review', message: 'That group is no longer available for this profile. Review the saved source in People.' }
    }
  }
  if (draft.status === 'dismissed' || draft.matches.length > 1) {
    return { status: 'review', message: draft.status === 'dismissed' ? 'This capture was previously dismissed.' : 'Multiple records match. Review which record to update.' }
  }

  const subjectKey = (name: string) => name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (selectedTarget && draft.matches.some(match => match.id !== selectedTarget.id)) {
    return { status: 'review', message: 'This website also matches a different record. Review the identity in People.' }
  }
  const match = selectedTarget ?? draft.matches[0]
  if (!match && draft.status === 'pending') {
    const name = subjectKey(draft.profile.name)
    const existing = store.rows(collection, false).some(row => !row.mergedIntoId && name === subjectKey(
      type === 'company' ? String(row.name) : String(row.fullName || [row.firstName, row.lastName].filter(Boolean).join(' '))))
    if (existing) return { status: 'review', message: 'A saved record has this name. Choose it in People or confirm that this is a separate record.' }
  }
  const catalogMatch = type === 'company' && selectedTarget?.verifiedCatalogName && subjectKey(selectedTarget.verifiedCatalogName) === subjectKey(draft.profile.name)
  if (match && subjectKey(match.name) !== subjectKey(draft.profile.name) && !catalogMatch) {
    return { status: 'review', message: 'A profile link is attached to a record with a different name. Review the identity in People.' }
  }

  let record
  if (draft.status === 'accepted') {
    // A second capture of identical content can add the same record to another group.
    record = draft.targetId ? store.get(collection, draft.targetId) : undefined
    if (!record || record.archivedAt !== null || record.mergedIntoId) return { status: 'review', message: 'The previously saved record is unavailable.' }
    if (groupId) store.command({ requestId: `capture-group:${requestId}`, operation: 'membership', groupId, entity: { type, id: record.id } }, 'profile-capture')
  } else {
    const target = match ? store.get(collection, match.id) : undefined
    const scalarKeys: Record<string, string> = { name: type === 'person' ? 'fullName' : 'name', headline: type === 'person' ? 'jobTitle' : 'tagline', description: 'description', location: 'location', industry: 'industry' }
    const fields = PROFILE_CAPTURE_FIELDS.filter(key => !target || !scalarKeys[key] || !target[scalarKeys[key]])
    try {
      record = (await capture.apply(draft.id, { requestId, ...(match ? { targetId: match.id, expectedRecordRevision: match.revision } : { createNew: true }), fields, ...(groupId ? { groupId } : {}) }, { authorize })).record
    } catch (error) {
      authorize?.()
      if (error instanceof CrmError && error.status === 409) return { status: 'review', message: 'The profile or its match changed. Review the saved source in People.' }
      throw error
    }
  }
  const result: QuickAddResult = { status: 'saved', recordId: record.id }
  const image = draft.profile.images.find(item => item.isProfile && item.subjectName === draft.profile.name)
  if (image && media) {
    try { result.image = await media.saveProfileImage(type, record.id, image.url, draft.source.url, requestId, authorize) }
    catch { authorize?.(); result.image = 'unavailable' }
  }
  return result
}
