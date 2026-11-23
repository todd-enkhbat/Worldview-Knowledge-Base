import type { NodeRecord } from '../domain/types.ts'
import { isArtifactProjection } from '../knowledge/derived.ts'

export interface SemanticSourcePolicy { nodeId?: string; excluded?: boolean; aiAllowed?: boolean; deleted?: boolean }

/** A local embedding is model use too; exclusions apply before indexing or retrieval. */
export function semanticAllowedNodeIds(records: readonly NodeRecord[], sources: readonly SemanticSourcePolicy[]): Set<string> {
  const blocked = new Set(sources.filter((source) => source.excluded || source.deleted || source.aiAllowed === false).flatMap((source) => source.nodeId ? [source.nodeId] : []))
  return new Set(records.filter((record) => record.deletedAt === null && !record.corpusExcluded && !isArtifactProjection(record) && !blocked.has(record.id)).map((record) => record.id))
}
