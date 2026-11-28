import type { KnowledgePassage, KnowledgeSnapshot } from '../types.ts'
import type { ArtifactPageView, ArtifactSnapshot, Claim, ClaimRevision, EvidenceRef, KnowledgePage, PageRevision } from './types.ts'
import { supersededValidUntil } from '../../vendor/gbrain/supersede-interval.ts'

export interface ArtifactReadOptions { aiOnly?: boolean; atTime?: number; sourceIds?: readonly string[]; includeStale?: boolean }

/** Historical wording never bypasses present source policy, deletion or exact offsets. */
export function resolveArtifactEvidence(ref: EvidenceRef, knowledge: KnowledgeSnapshot, opts: ArtifactReadOptions = {}): KnowledgePassage | null {
  const passage = knowledge.passages.find((item) => item.id === ref.passageId && item.versionId === ref.sourceVersionId)
  if (!passage) return null
  const source = knowledge.sources.find((item) => item.id === passage.sourceId)
  const version = knowledge.versions.find((item) => item.id === passage.versionId && item.sourceId === passage.sourceId)
  if (!source || source.deleted || source.excluded || opts.aiOnly && !source.aiAllowed || opts.sourceIds && !opts.sourceIds.includes(source.id)) return null
  if (!version || !Number.isSafeInteger(passage.start) || !Number.isSafeInteger(passage.end) || passage.start < 0 || passage.end < passage.start || passage.end > version.text.length || version.text.slice(passage.start, passage.end) !== passage.text) return null
  return passage
}

export function evidenceState(refs: readonly EvidenceRef[], knowledge: KnowledgeSnapshot, opts: ArtifactReadOptions = {}): { restricted: boolean; stale: boolean; missing: number } {
  let missing = 0, stale = false
  for (const ref of refs) {
    const passage = resolveArtifactEvidence(ref, knowledge, opts)
    if (!passage) { missing++; continue }
    if (knowledge.sources.find((source) => source.id === passage.sourceId)?.currentVersionId !== passage.versionId) stale = true
  }
  return { restricted: missing > 0, stale, missing }
}

function withinScope(page: KnowledgePage, opts: ArtifactReadOptions): boolean {
  return !opts.sourceIds || page.sourceIds.every((id) => opts.sourceIds!.includes(id))
}

/** A single inaccessible dependency suppresses the whole derived sentence/page, not just its citation. */
export function artifactPageView(snapshot: ArtifactSnapshot, knowledge: KnowledgeSnapshot, pageId: string, opts: ArtifactReadOptions = {}): ArtifactPageView | null {
  const page = snapshot.pages.find((item) => item.id === pageId && item.archivedAt === null)
  if (!page || !withinScope(page, opts)) return null
  const time = opts.atTime ?? Infinity
  const history = snapshot.pageRevisions.filter((revision) => revision.pageId === page.id && revision.recordedAt <= time)
  const accepted = history.filter((revision) => revision.status === 'accepted' && (revision.acceptedAt ?? revision.recordedAt) <= time).sort((a, b) => (b.acceptedAt ?? b.recordedAt) - (a.acceptedAt ?? a.recordedAt) || snapshot.pageRevisions.indexOf(b) - snapshot.pageRevisions.indexOf(a))
  const revision = opts.atTime === undefined ? history.find((item) => item.id === page.currentRevisionId) ?? null : accepted[0] ?? null
  const state = evidenceState(revision?.evidence ?? [], knowledge, opts)
  const blockedPageSource = page.sourceIds.some((id) => {
    const source = knowledge.sources.find((source) => source.id === id)
    return !source || source.deleted || source.excluded || opts.aiOnly && !source.aiAllowed
  })
  const restricted = state.restricted || blockedPageSource
  const claims: ArtifactPageView['claims'] = []
  for (const claim of snapshot.claims.filter((item) => item.pageId === page.id)) {
    const revisions = snapshot.claimRevisions.filter((item) => item.claimId === claim.id && (item.acceptedAt ?? item.recordedAt) <= time && item.status === 'accepted').sort((a, b) => (a.acceptedAt ?? a.recordedAt) - (b.acceptedAt ?? b.recordedAt))
    const selected = opts.atTime === undefined ? revisions.find((item) => item.id === claim.currentRevisionId) : revisions.at(-1)
    if (!selected || snapshot.tombstones.some((item) => item.pageId === page.id && item.fingerprint === claim.fingerprint && item.reason === 'withdrawn')) continue
    const eligibility = evidenceState(selected.evidence, knowledge, opts)
    if (restricted || eligibility.restricted || opts.aiOnly && eligibility.stale && !opts.includeStale) continue
    const next = revisions.find((item) => item.recordedAt > selected.recordedAt)
    const until = next && selected.validFrom !== null ? supersededValidUntil({ valid_from: new Date(selected.validFrom), valid_until: selected.validUntil === null ? null : new Date(selected.validUntil) }, next.validFrom === null ? null : new Date(next.validFrom), new Date(next.recordedAt)).getTime() : selected.validUntil
    claims.push({ claim, revision: structuredClone(selected), effectiveValidUntil: until, stale: eligibility.stale })
  }
  const visible = <T extends PageRevision | ClaimRevision>(item: T) => {
    const eligibility = evidenceState(item.evidence, knowledge, opts)
    return !restricted && !eligibility.restricted && !(opts.aiOnly && eligibility.stale && !opts.includeStale)
  }
  return {
    page: structuredClone(page), revision: revision && visible(revision) ? structuredClone(revision) : null,
    proposed: opts.aiOnly ? [] : history.filter((item) => item.status === 'proposed' && visible(item)).map((item) => structuredClone(item)),
    claims, stale: state.stale, restricted, missingEvidence: state.missing,
    history: history.filter(visible).map((item) => structuredClone(item)),
  }
}

export function projectDecisionHistory(snapshot: ArtifactSnapshot, knowledge: KnowledgeSnapshot, pageId: string): {
  claim: Claim
  revisions: { revision: ClaimRevision; status: 'current' | 'replaced' | 'withdrawn'; stale: boolean }[]
}[] {
  const view = artifactPageView(snapshot, knowledge, pageId)
  if (!view || view.page.kind !== 'project' || view.restricted) return []
  const byClaim = new Map<string, ClaimRevision[]>()
  for (const revision of snapshot.claimRevisions) {
    if (revision.acceptedAt === null || (revision.status !== 'accepted' && revision.status !== 'withdrawn')) continue
    const rows = byClaim.get(revision.claimId) ?? []
    rows.push(revision)
    byClaim.set(revision.claimId, rows)
  }
  return snapshot.claims.filter(claim => claim.pageId === pageId && claim.decision).flatMap(claim => {
    const revisions = (byClaim.get(claim.id) ?? []).slice().reverse().sort((a, b) => (b.acceptedAt ?? 0) - (a.acceptedAt ?? 0))
      .flatMap(revision => {
        const evidence = evidenceState(revision.evidence, knowledge)
        if (evidence.restricted) return []
        const status = revision.status === 'withdrawn' ? 'withdrawn' as const : revision.id === claim.currentRevisionId ? 'current' as const : 'replaced' as const
        return [{ revision, status, stale: evidence.stale }]
      })
    return revisions.length ? [{ claim, revisions }] : []
  })
}

export interface ArtifactContextEntry { id: string; kind: KnowledgePage['kind']; title: string; content: string; revisionId: string; evidence: EvidenceRef[]; updatedAt: number }
/** User-approved profile/project/wiki context only; proposals and stale derived text are never injected. */
export function artifactContext(snapshot: ArtifactSnapshot, knowledge: KnowledgeSnapshot, opts: ArtifactReadOptions = {}): ArtifactContextEntry[] {
  const result: ArtifactContextEntry[] = []
  for (const page of snapshot.pages) {
    const view = artifactPageView(snapshot, knowledge, page.id, { ...opts, aiOnly: true })
    if (!view?.revision || view.restricted || view.stale && !opts.includeStale || view.revision.status !== 'accepted') continue
    result.push({ id: page.id, kind: page.kind, title: page.title, content: view.revision.contentMd, revisionId: view.revision.id, evidence: structuredClone(view.revision.evidence), updatedAt: view.revision.recordedAt })
  }
  return result
}

export function artifactHealth(snapshot: ArtifactSnapshot, knowledge: KnowledgeSnapshot): { stalePages: string[]; restrictedPages: string[]; unsupportedClaims: string[]; unfinishedJobs: string[]; orphanPages: string[] } {
  const views = snapshot.pages.filter((page) => page.archivedAt === null).map((page) => artifactPageView(snapshot, knowledge, page.id)!)
  return { stalePages: views.filter((view) => view.stale).map((view) => view.page.id), restrictedPages: views.filter((view) => view.restricted).map((view) => view.page.id),
    unsupportedClaims: snapshot.claimRevisions.filter((revision) => revision.status === 'accepted' && revision.evidence.length === 0 && !revision.manual).map((revision) => revision.id),
    unfinishedJobs: snapshot.jobs.filter((job) => job.status === 'queued' || job.status === 'running' || job.status === 'failed').map((job) => job.id),
    orphanPages: views.filter((view) => !view.page.sourceIds.length && !view.revision?.manual).map((view) => view.page.id) }
}
