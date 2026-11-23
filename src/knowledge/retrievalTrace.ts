import { create } from 'zustand'
import type { KnowledgeSnapshot, SearchFilters, SearchHit } from './types.ts'
import { accumulateRrf } from '../vendor/gbrain/rrf-page-fusion.ts'

export interface RetrievalRun {
  query: string; normalizedQuery: string; filters: SearchFilters; revision: number
  model: string | null; mode: 'lexical' | 'hybrid' | 'qmd-lexical' | 'qmd-hybrid'; timingsMs: { lexical: number; semantic: number; native?: number; total: number }
  coverage: { includedSources: number; indexedSources: number; unindexedSourceIds: string[] }
  results: number; evidenceSupport: 'not-assessed'
}
export const useRetrievalTrace = create<{ run: RetrievalRun | null }>(() => ({ run: null }))

/** Shared page-grain votes preserve diversity while citations retain full passage UUIDs. */
export function fuseEvidence(lexical: readonly SearchHit[], semantic: readonly SearchHit[], limit = 30): SearchHit[] {
  const lexicalRanks = new Map(lexical.map((hit, index) => [hit.id, index + 1]))
  const semanticRanks = new Map(semantic.map((hit, index) => [hit.id, index + 1]))
  if (!semantic.length) return lexical.slice(0, limit).map((hit, index) => ({ ...hit, trace: { sourceVersionId: hit.versionId, scoreKind: 'lexical', lexicalRank: index + 1, fusedScore: hit.score, relevanceOnly: true, contributions: [] } }))
  const identities = new Map([...lexical, ...semantic].map((hit, index) => [hit.id, index]))
  const wrap = (hits: readonly SearchHit[]) => hits.map((hit) => ({ source_id: hit.sourceId, slug: hit.versionId, chunk_id: identities.get(hit.id), chunk_text: hit.text, hit }))
  return accumulateRrf([{ list: wrap(lexical), k: 60, arm: 'lexical' }, { list: wrap(semantic), k: 60, arm: 'semantic' }])
    .sort((a, b) => b.score - a.score || a.result.hit.id.localeCompare(b.result.hit.id)).slice(0, limit)
    .map((entry) => ({ ...entry.result.hit, score: entry.score, trace: { sourceVersionId: entry.result.hit.versionId, scoreKind: 'rrf', lexicalRank: lexicalRanks.get(entry.result.hit.id), semanticRank: semanticRanks.get(entry.result.hit.id), fusedScore: entry.score, relevanceOnly: true, contributions: entry.arms.map((vote) => ({ arm: vote.arm, rank: vote.rank + 1, weight: vote.weight, k: vote.k, contribution: vote.contribution })) } }))
}

export function retrievalCoverage(snapshot: KnowledgeSnapshot, filters: SearchFilters): RetrievalRun['coverage'] {
  const sources = snapshot.sources.filter((source) => !source.deleted && !source.excluded && (!filters.aiOnly || source.aiAllowed) && (!filters.sourceIds || filters.sourceIds.includes(source.id)) && (!filters.kinds || filters.kinds.includes(source.kind)))
  const indexed = new Set(snapshot.passages.map((passage) => `${passage.sourceId}:${passage.versionId}`))
  const missing = sources.filter((source) => !indexed.has(`${source.id}:${source.currentVersionId}`)).map((source) => source.id)
  return { includedSources: sources.length, indexedSources: sources.length - missing.length, unindexedSourceIds: missing }
}
