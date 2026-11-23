import { create } from 'zustand'
import { useWorld } from '../app/store.ts'
import { useAuth } from '../data/auth.ts'
import { getStore, isRepoReady } from '../data/repo.ts'
import type { KnowledgePassage, KnowledgeSnapshot, SearchFilters, SearchHit } from '../knowledge/types.ts'
import { bruteKnn, nodeText, queryText, textHash } from './embedText.ts'
import { embedTexts, isSemanticReady, useSemantic } from './semanticIndex.ts'
import { localVectorStore, serverVectorStore, type VectorStore } from './vectorStore.ts'

export const useCorpusSemantic = create<{ phase: 'off' | 'indexing' | 'ready' | 'error'; indexed: number; total: number; error: string | null }>()(() => ({ phase: 'off', indexed: 0, total: 0, error: null }))
let generation = 0
let scope = ''
let vectors: VectorStore | null = null
let cache = new Map<string, Float32Array>()
let hashes = new Map<string, string>()
let running: Promise<void> | null = null
let queued: KnowledgeSnapshot | null = null

export function eligibleSemanticPassages(snapshot: KnowledgeSnapshot, filters: SearchFilters = {}): KnowledgePassage[] {
  const live = useWorld.getState().nodes
  const sources = new Map(snapshot.sources.filter((source) => !source.excluded && !source.deleted && source.aiAllowed && (!source.nodeId || live.has(source.nodeId)) && (!filters.sourceIds || filters.sourceIds.includes(source.id)) && (!filters.kinds || filters.kinds.includes(source.kind))).map((source) => [source.id, source]))
  const versions = new Map(snapshot.versions.map((version) => [version.id, version]))
  return snapshot.passages.filter((passage) => {
    const source = sources.get(passage.sourceId)
    const version = versions.get(passage.versionId)
    return source && version && (!filters.role || passage.role === filters.role) && (filters.authoredAfter === undefined || passage.authoredAt !== null && passage.authoredAt >= filters.authoredAfter) && (filters.authoredBefore === undefined || passage.authoredAt !== null && passage.authoredAt <= filters.authoredBefore) && (filters.includeHistory || source.currentVersionId === passage.versionId) && version.text.slice(passage.start, passage.end) === passage.text
  })
}

export function invalidateCorpusSemantic(): void {
  generation++
  cache.clear()
  hashes.clear()
  useCorpusSemantic.setState({ phase: 'off', indexed: 0, total: 0, error: null })
}

/** Policy revocation removes derived vectors even with inference switched off. No model is loaded. */
export async function pruneCorpusSemantic(snapshot: KnowledgeSnapshot): Promise<void> {
  if (!isRepoReady() || typeof indexedDB === 'undefined') return
  const store = getStore()
  const settings = useWorld.getState().settings
  if (!settings || store.info.kind === 'memory') return
  const baseScope = `${store.info.kind}:${useAuth.getState().user?.id ?? 'local'}:${settings.createdAt}:${settings.physicsSeed}:`
  const allowed = new Set(eligibleSemanticPassages(snapshot).map((passage) => passage.id))
  const databases = new Set([`${baseScope}webgpu/q4`, `${baseScope}wasm/q8`])
  if (scope.startsWith(baseScope)) databases.add(scope)
  for (const database of databases) {
    const target = localVectorStore(`worldview-passage-vectors:${database}`)
    for (const meta of await target.meta()) {
      if (getStore() !== store) return
      if (!allowed.has(meta.id)) await target.delete(meta.id)
    }
  }
  const blockedNodes = new Set(snapshot.sources.filter((source) => source.excluded || source.deleted || !source.aiAllowed).flatMap((source) => source.nodeId ? [source.nodeId] : []))
  const nodeVectors = store.info.kind === 'sqlite' ? serverVectorStore() : localVectorStore()
  const liveNodes = useWorld.getState().nodes
  for (const meta of await nodeVectors.meta()) {
    if (getStore() !== store) return
    if (blockedNodes.has(meta.id) || !liveNodes.has(meta.id)) await nodeVectors.delete(meta.id)
  }
}

/** Rebuildable per-passage vectors use the existing explicitly enabled on-device model. */
export function syncCorpusSemantic(snapshot: KnowledgeSnapshot): Promise<void> {
  if (!isRepoReady() || !isSemanticReady()) return Promise.resolve()
  if (running) { queued = snapshot; return running }
  running = build(snapshot).catch((error: unknown) => {
    useCorpusSemantic.setState({ phase: 'error', error: error instanceof Error ? error.message : String(error) })
  }).finally(() => {
    running = null
    const next = queued
    queued = null
    if (next) void syncCorpusSemantic(next)
  })
  return running
}

async function build(snapshot: KnowledgeSnapshot): Promise<void> {
  const store = getStore()
  const settings = useWorld.getState().settings
  const config = useSemantic.getState().config
  if (!settings || !config) return
  const worldScope = `${store.info.kind}:${useAuth.getState().user?.id ?? 'local'}:${settings.createdAt}:${settings.physicsSeed}:${config}`
  if (worldScope !== scope || !vectors) {
    scope = worldScope
    vectors = localVectorStore(`worldview-passage-vectors:${worldScope}`)
    cache.clear(); hashes.clear()
  }
  const gen = generation
  const vectorStore = vectors
  const stale = () => gen !== generation || getStore() !== store || !isSemanticReady()
  const passages = eligibleSemanticPassages(snapshot)
  const allowed = new Set(passages.map((passage) => passage.id))
  const [metadata, saved] = await Promise.all([vectorStore.meta(), vectorStore.all()])
  if (stale()) return
  hashes = new Map(metadata.map((meta) => [meta.id, meta.hash]))
  cache = new Map([...saved].filter(([id]) => allowed.has(id)))
  for (const meta of metadata) if (!allowed.has(meta.id)) { await vectorStore.delete(meta.id); hashes.delete(meta.id); if (stale()) return }
  const todo = passages.map((passage) => {
    const text = nodeText({ title: passage.title, tags: [], contentMd: passage.text, archetype: 'document' })
    return { passage, text, hash: textHash(text, config) }
  }).filter((item) => hashes.get(item.passage.id) !== item.hash || !cache.has(item.passage.id))
  useCorpusSemantic.setState({ phase: 'indexing', total: passages.length, indexed: passages.length - todo.length, error: null })
  for (let offset = 0; offset < todo.length; offset += 8) {
    const batch = todo.slice(offset, offset + 8)
    const embedded = await embedTexts(batch.map((item) => item.text))
    if (stale()) return
    for (const [index, item] of batch.entries()) {
      await vectorStore.put(item.passage.id, embedded[index], item.hash)
      if (stale()) return
      hashes.set(item.passage.id, item.hash); cache.set(item.passage.id, embedded[index])
    }
    useCorpusSemantic.setState({ indexed: passages.length - todo.length + offset + batch.length })
  }
  if (!stale()) useCorpusSemantic.setState({ phase: 'ready', indexed: passages.length, total: passages.length })
}

export async function searchCorpusSemantic(query: string, snapshot: KnowledgeSnapshot, filters: SearchFilters = {}): Promise<SearchHit[]> {
  if (!query.trim() || !isSemanticReady() || useCorpusSemantic.getState().phase !== 'ready') return []
  const gen = generation
  const passages = eligibleSemanticPassages(snapshot, filters)
  const allowed = new Map(passages.map((passage) => [passage.id, passage]))
  const candidates = new Map([...cache].filter(([id]) => allowed.has(id)))
  if (!candidates.size) return []
  const [queryVector] = await embedTexts([queryText(query)])
  if (gen !== generation || !isSemanticReady()) return []
  return bruteKnn(queryVector, candidates, Math.min(200, filters.limit ?? 30)).filter((hit) => hit.distance < 0.8).map((hit) => ({ ...allowed.get(hit.id)!, score: 1 - hit.distance }))
}

/** Reciprocal rank fusion keeps exact lexical matches and semantic recall in one list. */
export function mergePassageRanks(lexical: readonly SearchHit[], semantic: readonly SearchHit[], limit = 30): SearchHit[] {
  if (!semantic.length) return lexical.slice(0, limit)
  const ranked = new Map<string, SearchHit>()
  for (const list of [lexical, semantic]) for (const [index, hit] of list.entries()) {
    const previous = ranked.get(hit.id)
    ranked.set(hit.id, { ...hit, score: (previous?.score ?? 0) + 1 / (60 + index + 1) })
  }
  return [...ranked.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit)
}
