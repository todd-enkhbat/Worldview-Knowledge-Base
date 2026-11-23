import type { KnowledgePassage, KnowledgeSnapshot, SearchFilters } from './types.ts'

/** Rechecked at delivery, independently of a search or cached derived result. */
export function eligibleEvidence(snapshot: KnowledgeSnapshot, passage: KnowledgePassage, filters: SearchFilters = {}): boolean {
  const source = snapshot.sources.find((item) => item.id === passage.sourceId)
  const version = snapshot.versions.find((item) => item.id === passage.versionId && item.sourceId === passage.sourceId)
  return !!source && !!version && !source.deleted && !source.excluded && (!filters.aiOnly || source.aiAllowed) && (filters.includeHistory || source.currentVersionId === version.id) && (!filters.sourceIds || filters.sourceIds.includes(source.id)) && (!filters.kinds || filters.kinds.includes(source.kind)) && (!filters.role || filters.role === passage.role) && (filters.authoredAfter === undefined || passage.authoredAt !== null && passage.authoredAt >= filters.authoredAfter) && (filters.authoredBefore === undefined || passage.authoredAt !== null && passage.authoredAt <= filters.authoredBefore) && Number.isSafeInteger(passage.start) && Number.isSafeInteger(passage.end) && passage.start >= 0 && passage.end >= passage.start && passage.end <= version.text.length && version.text.slice(passage.start, passage.end) === passage.text
}
