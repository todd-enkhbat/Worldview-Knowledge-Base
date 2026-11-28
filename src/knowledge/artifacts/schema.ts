import { emptyArtifacts, type ArtifactSnapshot } from './types.ts'

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
const dateOrNull = (value: unknown) => value === null || finite(value)

export function decodeArtifacts(value: unknown): ArtifactSnapshot {
  if (value === undefined) return emptyArtifacts()
  if (!value || typeof value !== 'object') throw new Error('The knowledge pages could not be read. Existing data was not changed.')
  const data = value as ArtifactSnapshot
  if (data.schemaVersion !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0 || !['pages', 'pageRevisions', 'claims', 'claimRevisions', 'jobs', 'tombstones', 'activity'].every((key) => Array.isArray(data[key as keyof ArtifactSnapshot]))) throw new Error('Knowledge pages use an unsupported format. Existing data was not changed.')
  for (const rows of [data.pages, data.pageRevisions, data.claims, data.claimRevisions, data.jobs, data.tombstones, data.activity]) {
    const ids = new Set<string>()
    for (const row of rows) { if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id)) throw new Error('Knowledge pages contain an invalid identity. Existing data was not changed.'); ids.add(row.id) }
  }
  const refs = (entries: unknown) => Array.isArray(entries) && entries.every((entry) => entry && typeof entry.passageId === 'string' && typeof entry.sourceVersionId === 'string' && ['supports', 'opposes', 'context'].includes(entry.relation))
  for (const page of data.pages) if (typeof page.title !== 'string' || !['topic', 'entity', 'project', 'answer', 'profile'].includes(page.kind) || !Array.isArray(page.sourceIds) || page.sourceIds.some((id) => typeof id !== 'string') || !finite(page.createdAt) || !finite(page.updatedAt) || !dateOrNull(page.archivedAt)) throw new Error('A knowledge page is incomplete.')
  for (const claim of data.claims) if (claim.decision !== undefined && (claim.decision !== true || !data.pages.some(page => page.id === claim.pageId && page.kind === 'project'))) throw new Error('A decision must belong to a project page.')
  for (const revision of data.pageRevisions) if (typeof revision.pageId !== 'string' || typeof revision.contentMd !== 'string' || !refs(revision.evidence) || !finite(revision.recordedAt) || !['proposed', 'accepted', 'rejected', 'withdrawn'].includes(revision.status)) throw new Error('A page revision is incomplete.')
  for (const revision of data.claimRevisions) if (typeof revision.claimId !== 'string' || typeof revision.text !== 'string' || !refs(revision.evidence) || !finite(revision.recordedAt) || ![revision.eventAt, revision.sourceAuthoredAt, revision.validFrom, revision.validUntil].every(dateOrNull) || !['proposed', 'accepted', 'rejected', 'withdrawn'].includes(revision.status)) throw new Error('A claim revision is incomplete.')
  for (const job of data.jobs) if (typeof job.pageId !== 'string' || !Array.isArray(job.sourceIds) || !Array.isArray(job.draftEvidence) || !Number.isSafeInteger(job.checkpoint) || job.checkpoint < 0 || !Number.isSafeInteger(job.total) || job.total < 0 || !['queued', 'running', 'complete', 'failed', 'paused', 'cancelled'].includes(job.status)) throw new Error('A knowledge job is incomplete.')
  return structuredClone(data)
}

/** Only explicit ISO calendar dates enter validity; ambiguous prose remains original text. */
export function parseClaimDate(value: string): number | null {
  if (!value.trim()) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Use an unambiguous YYYY-MM-DD date, or leave it unknown.')
  const ms = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new Error('This calendar date does not exist.')
  return ms
}
