import { create } from 'zustand'
import { registerDevApi } from '../app/devApi.ts'
import { useWorld } from '../app/store.ts'
import { getEnginePreference } from '../data/engine.ts'
import { getStore, isRepoReady, subscribeRepo } from '../data/repo.ts'
import type { NodeRecord } from '../domain/types.ts'
import { nodeText, queryText, textHash } from './embedText.ts'
import type { EmbedReply, EmbedRequest } from './embed.worker.ts'
import { localVectorStore, serverVectorStore, type VectorStore } from './vectorStore.ts'

// The semantic index: one 512-d EmbeddingGemma 2 vector per live node, kept in step with
// the world. Opt-in per browser (the first run downloads ~175 MB), so it starts only after
// enableSemantic(). Changes are picked up from the repo's change feed, debounced, and only
// nodes whose embedded text changed are re-embedded (textHash).

export const SEMANTIC_PREF_KEY = 'hyperspace.semantic'
const BATCH = 8
const DEBOUNCE_MS = 1200

export type SemanticPhase = 'off' | 'loading-model' | 'indexing' | 'ready' | 'error'

export interface SemanticState {
  phase: SemanticPhase
  /** Model download progress in [0, 1] while loading. */
  download: number
  indexed: number
  total: number
  error: string | null
  backend: 'sqlite' | 'local' | null
  /** Runtime the model settled on: 'webgpu/q4' or 'wasm/q8'. */
  config: string | null
}

export const useSemantic = create<SemanticState>()(() => ({ phase: 'off', download: 0, indexed: 0, total: 0, error: null, backend: null, config: null }))

// ─── the worker ──────────────────────────────────────────────────────────────────────

let worker: Worker | null = null
/** Runtime config the worker settled on ('webgpu/q4' or 'wasm/q8'); part of every text hash. */
let modelConfig: string | null = null
const configWaiters: ((c: string) => void)[] = []

/** Load the model (if needed) and resolve with the config it runs on. */
async function ensureModel(): Promise<string> {
  if (modelConfig) return modelConfig
  const ready = new Promise<string>((r) => configWaiters.push(r))
  await embedTexts([queryText('warm-up')])
  return modelConfig ?? ready
}
let nextId = 1
const pending = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./embed.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<EmbedReply>) => {
    const m = e.data
    if (m.type === 'progress') {
      const p = m.total > 0 ? m.loaded / m.total : 0
      useSemantic.setState((s) => (s.phase === 'loading-model' ? { download: p } : {}))
      return
    }
    if (m.type === 'ready') {
      modelConfig = m.config
      useSemantic.setState({ config: m.config })
      configWaiters.splice(0).forEach((r) => r(m.config))
      return
    }
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.type === 'result') p.resolve(m.vectors)
    else p.reject(new Error(m.error))
  }
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'embedding worker failed'))
    pending.clear()
  }
  return worker
}

/** Embed raw texts (already in EmbeddingGemma's document or query format). */
export function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return Promise.resolve([])
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ id, texts } satisfies EmbedRequest)
  })
}

// ─── the index ───────────────────────────────────────────────────────────────────────

let vectors: VectorStore | null = null
/** In-memory copy of every vector (UMAP, local KNN, neighbour lookups). */
const cache = new Map<string, Float32Array>()
const hashes = new Map<string, string>()
let timer: ReturnType<typeof setTimeout> | null = null
let syncing: Promise<void> | null = null
let again = false
let unsubscribe: (() => void) | null = null

export function isSemanticEnabled(): boolean {
  try {
    return localStorage.getItem(SEMANTIC_PREF_KEY) === 'on'
  } catch {
    return false
  }
}

export function isSemanticReady(): boolean {
  return useSemantic.getState().phase === 'ready'
}

/** Vectors of live, embedded nodes (a snapshot). */
export function semanticVectors(): Map<string, Float32Array> {
  return new Map(cache)
}

export function vectorOf(id: string): Float32Array | undefined {
  return cache.get(id)
}

/** Turn the index on for this browser and start (or resume) indexing. */
export async function enableSemantic(): Promise<void> {
  localStorage.setItem(SEMANTIC_PREF_KEY, 'on')
  await startSemantic()
}

export function disableSemantic(): void {
  localStorage.removeItem(SEMANTIC_PREF_KEY)
  unsubscribe?.()
  unsubscribe = null
  worker?.terminate()
  worker = null
  modelConfig = null
  useSemantic.setState({ phase: 'off', download: 0, error: null })
}

/** Called at boot (when enabled) and by enableSemantic. Idempotent. */
export async function startSemantic(): Promise<void> {
  if (!isRepoReady()) return
  if (!vectors) {
    vectors = getStore().info.kind === 'sqlite' || getEnginePreference() === 'sqlite' ? serverVectorStore() : localVectorStore()
    useSemantic.setState({ backend: vectors.kind })
  }
  if (!unsubscribe) {
    unsubscribe = subscribeRepo((change) => {
      if (change.type === 'nodes' || change.type === 'import' || change.type === 'wipe') schedule()
    })
  }
  useSemantic.setState({ phase: cache.size ? 'indexing' : 'loading-model', error: null })
  await sync()
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void sync()
  }, DEBOUNCE_MS)
}

function sync(): Promise<void> {
  if (syncing) {
    again = true
    return syncing
  }
  syncing = runSync()
    .catch((e: unknown) => {
      console.warn('[semantic] indexing failed', e)
      useSemantic.setState({ phase: 'error', error: e instanceof Error ? e.message : String(e) })
    })
    .finally(() => {
      syncing = null
      if (again) {
        again = false
        schedule()
      }
    })
  return syncing
}

async function runSync(): Promise<void> {
  const store = vectors!
  if (hashes.size === 0) {
    const [meta, all] = await Promise.all([store.meta(), store.all()])
    for (const m of meta) hashes.set(m.id, m.hash)
    for (const [id, v] of all) cache.set(id, v)
  }
  const config = await ensureModel()
  const live = [...useWorld.getState().nodes.values()]
  const liveIds = new Set(live.map((n) => n.id))
  // Drop embeddings of nodes that are gone (trash included: they leave the layout).
  for (const id of [...hashes.keys()]) {
    if (!liveIds.has(id)) {
      await store.delete(id)
      hashes.delete(id)
      cache.delete(id)
    }
  }
  const todo: { n: NodeRecord; text: string; hash: string }[] = []
  for (const n of live) {
    const text = nodeText(n)
    const hash = textHash(text, config)
    if (hashes.get(n.id) !== hash || !cache.has(n.id)) todo.push({ n, text, hash })
  }
  const total = live.length
  useSemantic.setState({ total, indexed: total - todo.length })
  if (todo.length === 0) {
    useSemantic.setState({ phase: 'ready', download: 1 })
    return
  }
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH)
    const vs = await embedTexts(batch.map((b) => b.text))
    useSemantic.setState({ phase: 'indexing', download: 1 })
    for (let j = 0; j < batch.length; j++) {
      await store.put(batch[j].n.id, vs[j], batch[j].hash)
      hashes.set(batch[j].n.id, batch[j].hash)
      cache.set(batch[j].n.id, vs[j])
    }
    useSemantic.setState({ indexed: total - todo.length + i + batch.length })
  }
  useSemantic.setState({ phase: 'ready' })
}

// ─── queries ─────────────────────────────────────────────────────────────────────────

export interface Neighbour {
  id: string
  similarity: number
}

/** Nearest live nodes to a vector (cosine similarity, best first). */
export async function nearest(vector: Float32Array, k = 8, exclude?: ReadonlySet<string>): Promise<Neighbour[]> {
  if (!vectors) return []
  const nodes = useWorld.getState().nodes
  const hits = await vectors.knn(vector, k + (exclude?.size ?? 0) + 4)
  return hits
    .filter((h) => nodes.has(h.id) && !exclude?.has(h.id))
    .slice(0, k)
    .map((h) => ({ id: h.id, similarity: 1 - h.distance }))
}

/** Semantic search over the world. Rejects when the index is not ready. */
export async function searchSemantic(q: string, k = 8): Promise<Neighbour[]> {
  if (!isSemanticReady()) throw new Error('The semantic index is not ready')
  const [v] = await embedTexts([queryText(q)])
  return nearest(v, k)
}

registerDevApi('semantic', () => useSemantic.getState())
registerDevApi('enableSemantic', () => enableSemantic())
registerDevApi('searchSemantic', (q: string, k?: number) => searchSemantic(q, k))
