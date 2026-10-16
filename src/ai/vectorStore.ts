import { openDB, type IDBPDatabase } from 'idb'
import { bruteKnn, EMBED_DIM, fromBase64, toBase64 } from './embedText.ts'

// Where embeddings live. With the SQLite engine: its vec0 table (server-side KNN). With
// IndexedDB: a separate database in this browser ('hyperspace-embeddings'), brute-force KNN.
// Either way embeddings are derived data: never exported, never hashed, rebuilt on demand.

export interface VectorMeta {
  id: string
  hash: string
}

export interface VectorStore {
  readonly kind: 'sqlite' | 'local'
  meta(): Promise<VectorMeta[]>
  all(): Promise<Map<string, Float32Array>>
  put(id: string, vector: Float32Array, hash: string): Promise<void>
  delete(id: string): Promise<void>
  knn(vector: Float32Array, k: number): Promise<{ id: string; distance: number }[]>
  clear(): Promise<void>
}

export function serverVectorStore(base = '/api', f: typeof fetch = (...a) => fetch(...a)): VectorStore {
  const call = async (path: string, init?: RequestInit) => {
    const res = await f(`${base}/embeddings${path}`, init)
    if (!res.ok) throw new Error(`embeddings ${path}: ${res.status} ${await res.text()}`)
    return res
  }
  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return {
    kind: 'sqlite',
    async meta() {
      return ((await (await call('/meta')).json()) as { id: string; hash: string }[]).map((m) => ({ id: m.id, hash: m.hash }))
    },
    async all() {
      const rows = (await (await call('/all')).json()) as { id: string; vector: string }[]
      return new Map(rows.map((r) => [r.id, fromBase64(r.vector)]))
    },
    async put(id, vector, hash) {
      await call(`/${encodeURIComponent(id)}`, { ...json({ vector: toBase64(vector), hash, model: hash.split(':')[0] }), method: 'PUT' })
    },
    async delete(id) {
      await call(`/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
    async knn(vector, k) {
      return (await (await call('/knn', json({ vector: toBase64(vector), k }))).json()) as { id: string; distance: number }[]
    },
    async clear() {
      await call('/wipe', { method: 'POST' })
    },
  }
}

interface Row {
  id: string
  hash: string
  v: Float32Array
}

export function localVectorStore(name = 'hyperspace-embeddings'): VectorStore {
  let db: Promise<IDBPDatabase> | null = null
  const open = () =>
    (db ??= openDB(name, 1, {
      upgrade(d) {
        d.createObjectStore('vectors', { keyPath: 'id' })
      },
    }))
  let cache: Map<string, Float32Array> | null = null
  const all = async () => {
    if (cache) return cache
    const rows = (await (await open()).getAll('vectors')) as Row[]
    cache = new Map(rows.filter((r) => r.v.length === EMBED_DIM).map((r) => [r.id, r.v]))
    return cache
  }
  return {
    kind: 'local',
    async meta() {
      return ((await (await open()).getAll('vectors')) as Row[]).map((r) => ({ id: r.id, hash: r.hash }))
    },
    async all() {
      return new Map(await all())
    },
    async put(id, v, hash) {
      await (await open()).put('vectors', { id, hash, v } satisfies Row)
      ;(await all()).set(id, v)
    },
    async delete(id) {
      await (await open()).delete('vectors', id)
      ;(await all()).delete(id)
    },
    async knn(v, k) {
      return bruteKnn(v, await all(), k)
    },
    async clear() {
      await (await open()).clear('vectors')
      cache = new Map()
    },
  }
}
