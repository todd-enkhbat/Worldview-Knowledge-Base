import type { WorldDb } from './worldDb.ts'
import type { MemoryClient } from './memoryAccess.ts'
import type { KnowledgeSnapshot, SearchFilters, SearchHit } from '../src/knowledge/types.ts'
import { eligibleEvidence } from '../src/knowledge/evidencePolicy.ts'
import { buildEvidencePacket } from '../src/knowledge/contextPacket.ts'
import { artifactContext } from '../src/knowledge/artifacts/policy.ts'
import { ARTIFACTS_KV, emptyArtifacts, type ArtifactSnapshot } from '../src/knowledge/artifacts/types.ts'
import { retrievalCoverage, fuseEvidence } from '../src/knowledge/retrievalTrace.ts'
import { isArtifactProjection } from '../src/knowledge/derived.ts'

export type MemoryOperation = 'search' | 'read_passage' | 'read_record' | 'get_project_context' | 'context' | 'status'
const empty = (): KnowledgeSnapshot => ({ schemaVersion: 1, revision: 0, sources: [], versions: [], passages: [], imports: [], proposals: [], jobs: [] })
const bounded = (value: unknown, fallback: number, max: number) => typeof value === 'number' && Number.isSafeInteger(value) ? Math.max(1, Math.min(max, value)) : fallback
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const citation = (hit: SearchHit) => ({ ...hit, citationUrl: `#/library?passage=${encodeURIComponent(hit.id)}` })

export function createMemoryReader(db: WorldDb) {
  let cached: KnowledgeSnapshot | null = null
  let cachedGeneration = ''
  const snapshot = (): KnowledgeSnapshot => {
    const revision = db.getKnowledgeRevision()
    // Restores may reuse a revision number. Track this connection and other writers,
    // rather than retaining an old world's evidence behind a coincidentally equal head.
    const generation = JSON.stringify([db.db.prepare('SELECT total_changes() AS n').get(), db.db.prepare('PRAGMA data_version').get()])
    if (!cached || cached.revision !== revision || cachedGeneration !== generation) { cached = db.getKv<KnowledgeSnapshot>('knowledge.v1') ?? empty(); cachedGeneration = generation }
    return cached
  }
  const liveSource = (corpus: KnowledgeSnapshot, id: string): boolean => {
    const source = corpus.sources.find((source) => source.id === id)
    if (!source || source.excluded || source.deleted || !source.aiAllowed) return false
    if (!source.nodeId) return true
    const node = db.getNode(source.nodeId)
    return !!node && node.deletedAt === null && !node.corpusExcluded && !isArtifactProjection(node)
  }
  function filtersFor(client: MemoryClient, input: Record<string, unknown>): SearchFilters {
    const requested = obj(input.filters)
    const requestedIds = Array.isArray(requested.sourceIds) ? requested.sourceIds.filter((id): id is string => typeof id === 'string').slice(0, 1000) : undefined
    let sourceIds = client.sourceIds === null ? requestedIds : requestedIds ? requestedIds.filter((id) => client.sourceIds!.includes(id)) : [...client.sourceIds]
    if (client.projectId) {
      const project = db.getKv<{ collections: { id: string; sourceIds: string[]; deletedAt?: number | null }[] }>('collections.v1')?.collections.find((project) => project.id === client.projectId && !project.deletedAt)
      sourceIds = project ? sourceIds ? sourceIds.filter((id) => project.sourceIds.includes(id)) : [...project.sourceIds] : []
    }
    const filters: SearchFilters = { aiOnly: true, sourceIds, limit: bounded(input.limit ?? requested.limit, 12, 40) }
    if (['human', 'assistant', 'third-party', 'unknown'].includes(String(requested.role))) filters.role = requested.role as SearchFilters['role']
    if (Array.isArray(requested.kinds)) filters.kinds = requested.kinds.filter((kind) => ['thought', 'document', 'chatgpt', 'claude', 'obsidian', 'legacy', 'conversation'].includes(String(kind))) as SearchFilters['kinds']
    for (const field of ['authoredAfter', 'authoredBefore'] as const) if (typeof requested[field] === 'number' && Number.isFinite(requested[field])) filters[field] = requested[field]
    return filters
  }
  function search(query: string, filters: SearchFilters, corpus: KnowledgeSnapshot) {
    return fuseEvidence(db.searchKnowledge(query, filters).hits.filter((hit) => liveSource(corpus, hit.sourceId) && eligibleEvidence(corpus, hit, filters)), [], filters.limit)
  }
  return function read(operation: MemoryOperation, raw: unknown, client: MemoryClient): unknown {
    const input = obj(raw), filters = filtersFor(client, input), corpus = snapshot()
    if (db.getKv('importInProgress')) throw new Error('Memory is unavailable while workspace recovery is in progress.')
    if (operation === 'status') return { revision: corpus.revision, coverage: retrievalCoverage(corpus, filters), scope: { sourceIds: client.sourceIds, projectId: client.projectId, writingDocumentIds: client.writingDocumentIds ?? [], allowCreateWriting: !!client.allowCreateWriting, allowFiling: !!client.allowFiling, bookshelfBookIds: client.bookshelfBookIds ?? [], allowCreateBooks: !!client.allowCreateBooks, crmPersonIds: client.crmPersonIds ?? [], crmGroupIds: client.crmGroupIds ?? [], allowCreateCrmPeople: !!client.allowCreateCrmPeople }, readOnly: !(client.allowCreateWriting || client.allowFiling || client.writingDocumentIds?.length || client.allowCreateBooks || client.bookshelfBookIds?.length || client.crmPersonIds?.length || client.crmGroupIds?.length || client.allowCreateCrmPeople), reviewRequired: true }
    if (operation === 'read_passage') {
      const passage = corpus.passages.find((passage) => passage.id === input.id)
      if (!passage || !liveSource(corpus, passage.sourceId) || !eligibleEvidence(corpus, passage, filters)) return { ok: false, error: 'not_available' }
      return { ok: true, ...citation({ ...passage, score: 0 }) }
    }
    if (operation === 'read_record') {
      const source = corpus.sources.find((source) => source.nodeId === input.id)
      const node = typeof input.id === 'string' ? db.getNode(input.id) : undefined
      const passages = corpus.passages.filter((passage) => passage.sourceId === source?.id && passage.versionId === source?.currentVersionId)
      if (!node || node.deletedAt !== null || node.corpusExcluded || isArtifactProjection(node) || !source || !passages.length || !passages.every((passage) => eligibleEvidence(corpus, passage, filters))) return { ok: false, error: 'not_available' }
      const version = corpus.versions.find((version) => version.id === source.currentVersionId && version.sourceId === source.id)
      if (!version) return { ok: false, error: 'not_available' }
      const offset = typeof input.offset === 'number' && Number.isSafeInteger(input.offset) ? Math.max(0, input.offset) : 0
      const end = Math.min(version.text.length, offset + bounded(input.limit, 4000, 8000))
      return { ok: true, id: node.id, sourceId: source.id, versionId: source.currentVersionId, title: source.title, text: version.text.slice(offset, end), offset, nextOffset: end < version.text.length ? end : null, citationUrl: `#/library?source=${source.id}` }
    }
    if (operation === 'get_project_context') {
      const id = typeof input.projectId === 'string' ? input.projectId : client.projectId
      const collections = db.getKv<{ collections: { id: string; title: string; sourceIds: string[]; query: string; questions: string[]; deletedAt?: number | null }[] }>('collections.v1')?.collections ?? []
      const project = collections.find((project) => project.id === id && !project.deletedAt)
      if (!project || client.projectId && project.id !== client.projectId || client.sourceIds && (!project.sourceIds.length || project.sourceIds.some((id) => !client.sourceIds!.includes(id)))) return { ok: false, error: 'not_available' }
      const permitted = project.sourceIds.filter((id) => liveSource(corpus, id))
      if (permitted.length !== project.sourceIds.length) return { ok: false, error: 'not_available' }
      return { ok: true, id: project.id, title: project.title, query: project.query, questions: project.questions, sourceIds: permitted }
    }
    const query = typeof input.query === 'string' ? input.query.trim().slice(0, 2000) : ''
    if (!query) throw new Error('Provide a search question.')
    const started = performance.now(), hits = search(query, filters, corpus)
    if (operation === 'search') return { revision: corpus.revision, hits: hits.map(citation), coverage: retrievalCoverage(corpus, filters), trace: { mode: 'lexical', elapsedMs: performance.now() - started, relevanceOnly: true } }
    const artifacts = db.getKv<ArtifactSnapshot>(ARTIFACTS_KV) ?? emptyArtifacts()
    const scopedArtifacts = { ...artifacts, pages: artifacts.pages.filter((page) => page.sourceIds.every((id) => liveSource(corpus, id))) }
    const context = artifactContext(scopedArtifacts, corpus, { sourceIds: filters.sourceIds, aiOnly: true }).filter((entry) => entry.evidence.every((ref) => { const passage = corpus.passages.find((passage) => passage.id === ref.passageId); return !!passage && liveSource(corpus, passage.sourceId) }))
    return buildEvidencePacket(query, corpus, hits, context, { filters, maxBytes: bounded(input.maxBytes, 16_384, 65_536) })
  }
}
