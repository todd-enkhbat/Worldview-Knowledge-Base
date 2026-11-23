import type { AssetMeta, InteractionEvent, NodeRecord, WorldSettings } from '../domain/types.ts'
import { DEVICE_KV_KEYS } from './archive.ts'
import { createMemoryStore } from './memoryStore.ts'
import { CLIENT_ID } from './serverSync.ts'
import type { BlobInput, StoreInfo, WorldSnapshot, WorldStore } from './WorldStore.ts'
import { WorldStateConflictError } from './worldState.ts'

// WorldStore over the SQLite engine's HTTP API (server/api.ts), same origin. Each call is
// one request, and the server makes each one atomic (putNodes is one transaction). Records
// are structured-cloned before they leave, so an unclonable record fails here exactly as it
// would in IndexedDB, and JSON round-trips give callers private copies by construction.
//
// Device-local kv keys (DEVICE_KV_KEYS: e.g. the auto-backup folder handle, which cannot be
// serialised) stay in this browser: `deviceKv`, by default an in-memory map.

export class EngineUnavailableError extends Error {
  override name = 'EngineUnavailableError'
}

export class EngineRequestError extends Error {
  readonly status: number
  override name = 'EngineRequestError'
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface HttpStoreOptions {
  /** API root. Default '/api' (same origin). */
  base?: string
  fetch?: typeof fetch
  deviceKv?: Pick<WorldStore, 'getKv' | 'putKv' | 'deleteKv'>
}

export interface EngineHealth {
  ok: boolean
  engine: 'sqlite'
  embeddingDim: number
  refine: boolean
  /** 'none' on a local server; 'required' / 'signed-in' when it has accounts (server/host.ts). */
  auth?: 'none' | 'required' | 'signed-in'
  /** The server relays live changes between devices. */
  live?: boolean
}

/** Is the SQLite engine reachable? Resolves null when it is not (static build, server down). */
export async function probeEngine(base = '/api', f: typeof fetch = fetch, timeoutMs = 2500): Promise<EngineHealth | null> {
  try {
    const res = await f(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const body = (await res.json()) as EngineHealth
    return body?.engine === 'sqlite' ? body : null
  } catch {
    return null
  }
}

export function createHttpStore(opts: HttpStoreOptions = {}): WorldStore {
  const base = opts.base ?? '/api'
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const device = opts.deviceKv ?? createMemoryStore()
  const deviceKeys = new Set(DEVICE_KV_KEYS)
  const info: StoreInfo = { kind: 'sqlite', blobBackend: 'server' }
  let closed = false

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    if (closed) throw new EngineUnavailableError('The SQLite store is closed')
    let res: Response
    try {
      res = await f(`${base}/world${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), 'x-wv-client': CLIENT_ID, 'x-wv-knowledge-format': '2' } })
    } catch (e) {
      throw new EngineUnavailableError(`The SQLite engine is unreachable: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`
      try {
        message = ((await res.json()) as { error?: string }).error ?? message
      } catch {
        // not JSON
      }
      throw new EngineRequestError(res.status, message)
    }
    return res
  }
  const getJson = async <T>(path: string): Promise<T> => (await (await call(path)).json()) as T
  const sendJson = (path: string, method: string, body: unknown) =>
    call(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const enc = encodeURIComponent

  return {
    info,

    async readWorldSnapshot(keys) {
      return await (await sendJson('/snapshot', 'POST', { keys })).json() as WorldSnapshot
    },
    async getKnowledgeRevision() { return (await getJson<{ revision: number }>('/knowledge-revision')).revision },
    async commitKnowledge(delta, options) {
      return (await (await sendJson('/knowledge-commit', 'POST', { delta: structuredClone(delta), options: structuredClone(options) })).json() as { applied: boolean }).applied
    },

    async getSettings() {
      return getJson<WorldSettings | null>('/settings')
    },
    async putSettings(s) {
      await sendJson('/settings', 'PUT', structuredClone(s))
    },

    async listNodes() {
      return getJson<NodeRecord[]>('/nodes')
    },
    async getNode(id) {
      return (await getJson<NodeRecord | null>(`/nodes/${enc(id)}`)) ?? undefined
    },
    async putNode(n) {
      await this.putNodes([n])
    },
    async putNodes(ns) {
      // structuredClone throws DataCloneError on functions etc., before anything is sent.
      const staged = structuredClone(ns)
      for (const n of staged) {
        if (typeof n?.id !== 'string') throw new DOMException('putNodes: id must be a string key', 'DataError')
      }
      if (staged.length) await sendJson('/nodes', 'PUT', staged)
    },
    async deleteNode(id) {
      await call(`/nodes/${enc(id)}`, { method: 'DELETE' })
    },

    async appendEvent(e: InteractionEvent) {
      if (typeof e?.id !== 'string') throw new DOMException('appendEvent: id must be a string key', 'DataError')
      await sendJson('/events', 'POST', structuredClone(e))
    },
    async listEvents(sinceT) {
      return getJson<InteractionEvent[]>(sinceT === undefined ? '/events' : `/events?since=${sinceT}`)
    },
    async clearEvents(beforeT) {
      const res = await call(beforeT === undefined ? '/events' : `/events?before=${beforeT}`, { method: 'DELETE' })
      return ((await res.json()) as { cleared: number }).cleared
    },

    async putBlob({ meta, data }: BlobInput) {
      if (typeof meta?.id !== 'string') throw new DOMException('putBlob: id must be a string key', 'DataError')
      // A Uint8Array may view a larger buffer: send exactly its bytes, copied.
      const body = data instanceof Uint8Array ? new Blob([data.slice()]) : data
      await call(`/blobs/${enc(meta.id)}?meta=${enc(JSON.stringify(meta))}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body,
      })
    },
    async getBlob(id) {
      const meta = await this.getAssetMeta(id)
      if (!meta) return undefined
      const res = await call(`/blobs/${enc(id)}`)
      const bytes = await res.arrayBuffer()
      return new Blob([bytes], { type: meta.mime })
    },
    async getAssetMeta(id) {
      return (await getJson<AssetMeta | null>(`/assets/${enc(id)}`)) ?? undefined
    },
    async listAssets() {
      return getJson<AssetMeta[]>('/assets')
    },
    async deleteBlob(id) {
      await call(`/blobs/${enc(id)}`, { method: 'DELETE' })
    },

    async getKv<T = unknown>(key: string) {
      if (deviceKeys.has(key)) return device.getKv<T>(key)
      const r = await getJson<{ found: boolean; value?: T }>(`/kv/${enc(key)}`)
      return r.found ? r.value : undefined
    },
    async putKv(key, value) {
      if (deviceKeys.has(key)) return device.putKv(key, value)
      await sendJson(`/kv/${enc(key)}`, 'PUT', { value: structuredClone(value) })
    },
    async compareAndSwapKv(key, value, expectedRevision) {
      if (deviceKeys.has(key)) throw new Error('Versioned world state cannot use a device-local key')
      const res = await sendJson(`/kv/${enc(key)}/compare`, 'POST', { value: structuredClone(value), expectedRevision })
      return ((await res.json()) as { applied: boolean }).applied
    },
    async deleteKv(key) {
      if (deviceKeys.has(key)) return device.deleteKv(key)
      await call(`/kv/${enc(key)}`, { method: 'DELETE' })
    },

    async wipe() {
      await call('/wipe', { method: 'POST' })
      for (const k of deviceKeys) await device.deleteKv(k)
    },
    async resetWithKv(key, value, preserveKeys = [], expectedKnowledgeRevision) {
      if (deviceKeys.has(key)) throw new Error('Recovery marker must be world-owned state')
      try {
        await sendJson('/reset', 'POST', { key, value: structuredClone(value), preserveKeys: preserveKeys.filter((name) => !deviceKeys.has(name)), ...(expectedKnowledgeRevision !== undefined ? { expectedKnowledgeRevision } : {}) })
      } catch (error) { if (error instanceof EngineRequestError && error.status === 409) throw new WorldStateConflictError(); throw error }
      for (const name of deviceKeys) if (!preserveKeys.includes(name)) await device.deleteKv(name)
    },
    close() {
      closed = true
    },
  }
}
