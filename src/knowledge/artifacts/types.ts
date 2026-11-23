import type { Authorship } from '../types.ts'

export const ARTIFACTS_KV = 'artifacts.v1'
export type PageKind = 'topic' | 'entity' | 'project' | 'answer' | 'profile'
export type ReviewState = 'proposed' | 'accepted' | 'rejected' | 'withdrawn'
export interface EvidenceRef { passageId: string; sourceVersionId: string; relation: 'supports' | 'opposes' | 'context' }
export interface KnowledgePage {
  id: string; title: string; kind: PageKind; sourceIds: string[]; question: string | null
  currentRevisionId: string | null; projectedNodeId: string | null
  createdAt: number; updatedAt: number; archivedAt: number | null
}
export interface PageRevision {
  id: string; pageId: string; previousRevisionId: string | null; contentMd: string; evidence: EvidenceRef[]
  recordedAt: number; acceptedAt: number | null; status: ReviewState; manual: boolean; inputHash: string; generator: string
  /** Manual wording is a constraint on generation; the original revision remains immutable. */
  correction: string | null
}
export interface Claim {
  id: string; pageId: string; currentRevisionId: string | null; fingerprint: string; createdAt: number
}
export interface ClaimRevision {
  id: string; claimId: string; previousRevisionId: string | null; text: string
  attributedTo: Authorship | null; evidence: EvidenceRef[]; recordedAt: number
  sourceAuthoredAt: number | null; eventAt: number | null; validFrom: number | null; validUntil: number | null
  status: ReviewState; acceptedAt: number | null; manual: boolean; inputHash: string
}
export interface ArtifactJob {
  id: string; pageId: string; status: 'queued' | 'running' | 'complete' | 'failed' | 'paused' | 'cancelled'
  sourceIds: string[]; inputHash: string; generator: string; checkpoint: number; total: number
  createdAt: number; updatedAt: number; attempts: number; error: string | null; outputRevisionId: string | null
  draftEvidence: EvidenceRef[]
}
export interface ArtifactTombstone {
  id: string; pageId: string; fingerprint: string; reason: 'rejected' | 'withdrawn'; recordedAt: number
}
export interface ArtifactActivity {
  id: string; pageId: string; targetId: string; action: string; recordedAt: number; detail: string
}
export interface ArtifactSnapshot {
  schemaVersion: 1; revision: number; pages: KnowledgePage[]; pageRevisions: PageRevision[]
  claims: Claim[]; claimRevisions: ClaimRevision[]; jobs: ArtifactJob[]; tombstones: ArtifactTombstone[]; activity: ArtifactActivity[]
}
export interface ArtifactPageView {
  page: KnowledgePage; revision: PageRevision | null; proposed: PageRevision[]
  claims: { claim: Claim; revision: ClaimRevision; effectiveValidUntil: number | null; stale: boolean }[]
  stale: boolean; restricted: boolean; missingEvidence: number; history: PageRevision[]
}
export const emptyArtifacts = (): ArtifactSnapshot => ({ schemaVersion: 1, revision: 0, pages: [], pageRevisions: [], claims: [], claimRevisions: [], jobs: [], tombstones: [], activity: [] })
