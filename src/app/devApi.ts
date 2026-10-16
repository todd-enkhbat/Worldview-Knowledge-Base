import { ARCHETYPES } from '../domain/types.ts'
import type { Archetype, NodeRecord } from '../domain/types.ts'
import { MS_PER_YEAR } from '../domain/constants.ts'
import { bytesSink } from '../data/archive.ts'
import type { ArchiveManifest, ImportOptions, ImportResult } from '../data/archive.ts'
import { hashBytes, hashRecords } from '../data/hash.ts'
import {
  completeFirstRun,
  createNode,
  exportWorld,
  getStore,
  importWorld,
  seedDemo,
  useRepoStatus,
  wipeWorld,
} from '../data/repo.ts'
import type { NodeDraftInput, RepoStatus } from '../data/repo.ts'
import { useApp, useWorld } from './store.ts'

// window.__wv: a console / Playwright handle on the data layer in dev builds only. It is the
// U0 harness ("export → wipe → import → record hashes identical") and the hook Phase 2/3
// modules extend via registerDevApi (ingestFromUrl, flyIn, flyOut, …).

export interface DevStats {
  live: number
  trash: number
  byArchetype: Record<Archetype, number>
  events: number
  assets: number
  assetBytes: number
  storage: ReturnType<typeof useWorld.getState>['storage'] & { kind: string; blobBackend: string }
  repo: RepoStatus
}

export interface DevApi {
  /** Erase the whole world (records, events, settings, assets, kv). */
  wipe(): Promise<void>
  /** Export into memory. `hash` is the SHA-256 of the archive bytes; `recordsHash` the manifest's record hash. */
  exportArchive(): Promise<{ bytes: Uint8Array; hash: string; recordsHash: string; manifest: ArchiveManifest }>
  /** Import = replace (takes the pre-import backup first). */
  importArchive(data: Uint8Array | Blob, opts?: ImportOptions): Promise<ImportResult>
  /** hashRecords over live + trash records as stored. */
  recordHashes(): Promise<string>
  stats(): Promise<DevStats>
  /** Add the demo world (runs the first run with T0 = now − 30 y when there is none). Returns the number added. */
  seedDemo(T0?: number): Promise<number>
  createNode(draft: NodeDraftInput): Promise<NodeRecord>
  /** Live records, oldest date first. */
  list(): NodeRecord[]
  getState(): {
    app: ReturnType<typeof useApp.getState>
    world: ReturnType<typeof useWorld.getState>
    repo: RepoStatus
  }
  /** Extensions added with registerDevApi. */
  [extension: string]: unknown
}

declare global {
  interface Window {
    __wv?: DevApi
  }
  var __wv: DevApi | undefined
}

type DevFn = (...args: never[]) => unknown
const extensions = new Map<string, DevFn>()
const CORE = new Set(['wipe', 'exportArchive', 'importArchive', 'recordHashes', 'stats', 'seedDemo', 'createNode', 'list', 'getState'])

/** Add a dev command (works before or after installDevApi). Core names cannot be replaced. */
export function registerDevApi(name: string, fn: DevFn): void {
  if (CORE.has(name)) throw new Error(`__wv.${name} is a core dev command`)
  extensions.set(name, fn)
  if (globalThis.__wv) globalThis.__wv[name] = fn
}

export function createDevApi(): DevApi {
  const api: DevApi = {
    wipe: () => wipeWorld({ confirm: true }),
    async exportArchive() {
      const sink = bytesSink()
      const { manifest } = await exportWorld(sink, { markBackup: false })
      const bytes = sink.bytes()
      return { bytes, hash: await hashBytes(bytes), recordsHash: manifest.recordsHash, manifest }
    },
    importArchive(data, opts) {
      const blob = data instanceof Blob ? data : new Blob([data as Uint8Array<ArrayBuffer>], { type: 'application/zip' })
      return importWorld(blob, opts)
    },
    async recordHashes() {
      return hashRecords(await getStore().listNodes())
    },
    async stats() {
      const store = getStore()
      const [nodes, events, assets] = await Promise.all([store.listNodes(), store.listEvents(), store.listAssets()])
      const byArchetype = Object.fromEntries(ARCHETYPES.map((a) => [a, 0])) as Record<Archetype, number>
      let trash = 0
      for (const n of nodes) {
        if (n.deletedAt !== null) trash++
        else byArchetype[n.archetype]++
      }
      return {
        live: nodes.length - trash,
        trash,
        byArchetype,
        events: events.length,
        assets: assets.length,
        assetBytes: assets.reduce((s, a) => s + a.bytes, 0),
        storage: { ...useWorld.getState().storage, kind: store.info.kind, blobBackend: store.info.blobBackend },
        repo: useRepoStatus.getState(),
      }
    },
    async seedDemo(T0) {
      if (!useWorld.getState().settings) {
        const before = useWorld.getState().nodes.size
        await completeFirstRun({ T0: T0 ?? Date.now() - 30 * MS_PER_YEAR, start: 'demo' })
        return useWorld.getState().nodes.size - before
      }
      return (await seedDemo()).length
    },
    createNode: (draft) => createNode(draft),
    list: () => [...useWorld.getState().nodes.values()].sort((a, b) => a.temporalOrigin - b.temporalOrigin || (a.id < b.id ? -1 : 1)),
    getState: () => ({ app: useApp.getState(), world: useWorld.getState(), repo: useRepoStatus.getState() }),
  }
  for (const [name, fn] of extensions) api[name] = fn
  return api
}

/** Install window.__wv in dev builds (or when forced, e.g. in tests). Returns the API, or null in production. */
export function installDevApi(opts: { force?: boolean } = {}): DevApi | null {
  if (!import.meta.env.DEV && !opts.force) return null
  const api = createDevApi()
  globalThis.__wv = api
  return api
}
