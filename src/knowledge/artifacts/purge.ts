import type { KnowledgeSnapshot } from '../types.ts'
import type { ArtifactSnapshot } from './types.ts'
import { normalizeArtifactFingerprints } from './fingerprint.ts'

/** A pure sidecar for the corpus deletion transaction; no app or repository imports. */
export async function purgeArtifactSources(value: ArtifactSnapshot | undefined, removedSourceIds: ReadonlySet<string>, corpus: KnowledgeSnapshot): Promise<{ snapshot: ArtifactSnapshot; projectedNodeIds: string[] } | null> {
  if (!value || !removedSourceIds.size) return null
  const removedVersions = new Set(corpus.versions.filter((version) => removedSourceIds.has(version.sourceId)).map((version) => version.id))
  const snapshot = structuredClone(value)
  const affected = new Set(snapshot.pages.filter((page) => page.sourceIds.some((id) => removedSourceIds.has(id))).map((page) => page.id))
  for (const revision of snapshot.pageRevisions) if (revision.evidence.some((ref) => removedVersions.has(ref.sourceVersionId))) affected.add(revision.pageId)
  for (const revision of snapshot.claimRevisions) if (revision.evidence.some((ref) => removedVersions.has(ref.sourceVersionId))) { const claim = snapshot.claims.find((claim) => claim.id === revision.claimId); if (claim) affected.add(claim.pageId) }
  if (!affected.size) return null
  await normalizeArtifactFingerprints(snapshot)
  const now = Date.now(), removed = '[Removed after permanent source deletion.]'
  for (const page of snapshot.pages) if (affected.has(page.id)) { page.title = 'Deleted source reference'; page.question = null; page.currentRevisionId = null; page.archivedAt = now; page.updatedAt = now }
  for (const revision of snapshot.pageRevisions) if (affected.has(revision.pageId)) { revision.contentMd = removed; revision.correction = null; revision.evidence = []; revision.status = 'withdrawn' }
  const claims = new Set(snapshot.claims.filter((claim) => affected.has(claim.pageId)).map((claim) => claim.id))
  for (const claim of snapshot.claims) if (claims.has(claim.id)) {
    claim.currentRevisionId = null
    if (!snapshot.tombstones.some((item) => item.pageId === claim.pageId && item.fingerprint === claim.fingerprint && item.reason === 'withdrawn')) snapshot.tombstones.push({ id: crypto.randomUUID(), pageId: claim.pageId, fingerprint: claim.fingerprint, reason: 'withdrawn', recordedAt: now })
  }
  for (const revision of snapshot.claimRevisions) if (claims.has(revision.claimId)) { revision.text = removed; revision.evidence = []; revision.status = 'withdrawn' }
  for (const job of snapshot.jobs) if (affected.has(job.pageId)) { job.status = 'cancelled'; job.draftEvidence = []; job.error = 'A source was permanently deleted.'; job.updatedAt = now }
  for (const entry of snapshot.activity) if (affected.has(entry.pageId)) entry.detail = ''
  for (const id of affected) snapshot.activity.push({ id: crypto.randomUUID(), pageId: id, targetId: id, action: 'source-permanently-deleted', recordedAt: now, detail: 'Derived wording was removed; hashed review decisions remain.' })
  snapshot.revision++
  return { snapshot, projectedNodeIds: snapshot.pages.filter((page) => affected.has(page.id) && page.projectedNodeId).map((page) => page.projectedNodeId!) }
}
