import type { SearchHit } from '../../knowledge/types.ts'

/** Only the fields consumed by the adapted upstream fusion helper. */
export interface SearchResult {
  source_id?: string
  slug: string
  chunk_id?: number | null
  chunk_text: string
  keyword_hit?: boolean
  keyword_relaxed?: boolean
  relational?: unknown
  relational_seed?: unknown
  relational_hop?: unknown
  relational_path?: unknown
  relational_via_link_types?: unknown
  hit: SearchHit
}
