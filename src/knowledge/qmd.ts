import type { SearchFilters, SearchHit } from './types.ts'

export interface QmdResult { revision: number; hits: SearchHit[]; mode: 'lexical' | 'hybrid'; candidates: number; elapsedMs: number; engine: 'qmd'; omitted: number; trace?: { results?: { passageId: string; sourceVersionId: string; nativeRank?: number; rerankScore?: number; lexicalScores?: number[]; semanticScores?: number[] }[] } }
export async function searchNativeQmd(query: string, filters: SearchFilters): Promise<QmdResult> {
  const response = await fetch('/api/qmd/search', { method: 'POST', headers: { 'content-type': 'application/json', 'x-wv-client': 'worldview-qmd-search' }, body: JSON.stringify({ query, filters, mode: filters.engine === 'qmd-lexical' ? 'lexical' : 'hybrid', candidates: 20 }) })
  const result = await response.json() as QmdResult & { error?: string }
  if (!response.ok) throw new Error(result.error ?? 'Local QMD is not ready. Configure it in Sources & activity or choose Local search.')
  if (!Number.isSafeInteger(result.revision) || !Array.isArray(result.hits)) throw new Error('Local QMD returned an invalid result. Your original record is unchanged.')
  return result
}
