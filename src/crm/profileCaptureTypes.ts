import type { CrmAffiliation, CrmCompany, CrmPerson } from './types.ts'

export const PROFILE_CAPTURE_FIELDS = ['name', 'headline', 'description', 'location', 'emails', 'phones', 'urls', 'industry', 'affiliations'] as const
export type ProfileCaptureField = typeof PROFILE_CAPTURE_FIELDS[number]
export interface CapturedProfileImage { url: string; label?: string; isProfile?: boolean; subjectName?: string }
export interface CapturedProfileData {
  entityType: 'person' | 'company'
  name: string
  headline?: string
  description?: string
  location?: string
  industry?: string
  emails?: string[]
  phones?: string[]
  urls?: string[]
  affiliations?: Omit<CrmAffiliation, 'id' | 'evidence'>[]
  images?: CapturedProfileImage[]
}
export interface CrmProfileCaptureInput {
  requestId: string
  url: string
  title: string
  text: string
  html?: string
  profile: CapturedProfileData
}
export interface CrmCapturedProfile extends Required<Omit<CapturedProfileData, 'affiliations'>> { affiliations: CrmAffiliation[] }
export interface CrmProfileCaptureMatch { collection: 'people' | 'companies'; id: string; name: string; revision: number; reason: 'profile-url' | 'source-continuity' }
export interface CrmProfileCaptureSource { url: string; title: string; text: string; originalAssetId: string; capturedAt: number; contentHash: string; captureMethod: 'browser-extension' | 'public-url' | 'saved-source'; sourceId?: string; sourceVersionId?: string }
export interface CrmProfileCaptureDraft {
  id: string
  draftId: string
  revision: number
  status: 'pending' | 'accepted' | 'dismissed'
  profile: CrmCapturedProfile
  source: CrmProfileCaptureSource
  matches: CrmProfileCaptureMatch[]
  targetId: string | null
  reviewUrl: string
  cloudAiUsed: false
}
export interface CrmProfileCaptureList { drafts: CrmProfileCaptureDraft[]; total: number; nextOffset: number | null }
export interface CrmProfileCaptureApply {
  requestId: string
  targetId?: string | null
  createNew?: boolean
  expectedRecordRevision?: number
  fields: ProfileCaptureField[]
  affiliationIds?: string[]
  groupId?: string
}
export interface CrmProfileCaptureApplyResult { ok: true; record: CrmPerson | CrmCompany; draft: CrmProfileCaptureDraft; replayed?: boolean }
export interface CrmProfileCaptureScanResult { drafts: CrmProfileCaptureDraft[]; processed: number; total: number; nextOffset: number | null; skipped: { sourceId: string; reason: string }[]; cloudAiUsed: false }
