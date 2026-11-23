import { blobSink, exportArchive, importArchive, WORLD_KV_KEYS, type ImportResult } from './archive.ts'
import { defaultBackupTarget } from './backupTargets.ts'
import { createHttpStore, probeEngine, type EngineHealth } from './httpStore.ts'
import { openIdbStore, openWorldStore } from './idbStore.ts'
import type { WriterLock } from './locks.ts'
import type { WorldStore } from './WorldStore.ts'

// Which engine holds the world: IndexedDB (default; works in the static build) or the
// SQLite engine behind the dev/preview server (Phase 4, opt-in). The choice is per browser
// profile (localStorage) and only changes through migrateWorld(), which copies the whole
// world through the export archive and checks its records hash, so the two engines never
// diverge silently. The engine moved away from keeps its copy untouched: that copy is the
// fallback if anything goes wrong later.

export type EngineKind = 'idb' | 'sqlite'
export const ENGINE_PREF_KEY = 'hyperspace.engine'
/** Separate IndexedDB database for device-local kv while the world lives in SQLite. */
export const DEVICE_DB_NAME = 'hyperspace-device'

export function getEnginePreference(): EngineKind {
  try {
    return localStorage.getItem(ENGINE_PREF_KEY) === 'sqlite' ? 'sqlite' : 'idb'
  } catch {
    return 'idb'
  }
}

/** Failed/unfinished imports and retained originals are data, even before a first note. */
export async function hasWorldData(store: WorldStore): Promise<boolean> {
  const [settings, nodes, events, assets, values] = await Promise.all([
    store.getSettings(), store.listNodes(), store.listEvents(), store.listAssets(),
    Promise.all(WORLD_KV_KEYS.map((key) => store.getKv(key))),
  ])
  return settings !== null || nodes.length > 0 || events.length > 0 || assets.length > 0 || values.some((value) => value !== undefined)
}

/**
 * With no saved preference, a browser whose own storage holds no world uses the server
 * engine when it is running: the world then lives in one place every device can reach.
 * A browser that already has a world keeps it (moving it is migrateWorld's job, in Settings).
 */
export async function adoptServerDefault(health: EngineHealth | null): Promise<EngineKind> {
  const saved = (() => {
    try {
      return localStorage.getItem(ENGINE_PREF_KEY)
    } catch {
      return null
    }
  })()
  if (saved || !health) return getEnginePreference()
  const { store, fallback } = await openWorldStore()
  try {
    if (fallback) return 'idb'
    if (await hasWorldData(store)) return 'idb'
  } finally {
    store.close()
  }
  setEnginePreference('sqlite')
  return 'sqlite'
}

function setEnginePreference(kind: EngineKind): void {
  if (kind === 'idb') localStorage.removeItem(ENGINE_PREF_KEY)
  else localStorage.setItem(ENGINE_PREF_KEY, kind)
}

export { probeEngine, type EngineHealth }

export async function openSqliteStore(): Promise<WorldStore> {
  const device = await openIdbStore({ name: DEVICE_DB_NAME, opfsRoot: null })
  return createHttpStore({ deviceKv: device })
}

/** A lock that never grants writing: the world is shown, and every write is refused. */
export function readOnlyLock(): WriterLock {
  return { isWriter: false, supported: true, ready: Promise.resolve(false), onChange: () => () => {}, release: () => {} }
}

export interface MigrationPlan {
  from: EngineKind
  to: EngineKind
  /** The target already holds a world (it will be replaced, after a backup). */
  targetHasWorld: boolean
  targetNodes: number
}

async function openEngine(kind: EngineKind): Promise<WorldStore> {
  if (kind === 'sqlite') {
    if (!(await probeEngine())) throw new Error('The SQLite engine is not running. Start the app with `npm run dev` (or `npm run serve`).')
    return openSqliteStore()
  }
  return (await openWorldStore()).store
}

/** What a move to `to` would do (for the confirmation dialog). */
export async function planMigration(to: EngineKind): Promise<MigrationPlan> {
  const from = getEnginePreference()
  const target = await openEngine(to)
  try {
    const [occupied, nodes] = await Promise.all([hasWorldData(target), target.listNodes()])
    return { from, to, targetHasWorld: occupied, targetNodes: nodes.length }
  } finally {
    target.close()
  }
}

export interface MigrationResult extends ImportResult {
  to: EngineKind
}

/**
 * Copy the world from `source` (the open store) into engine `to`, replacing whatever is
 * there (the target's old contents go to a pre-import backup first), then switch the
 * preference. The import re-validates every record and checks the archive's records hash,
 * so a lossy copy throws instead of switching. The caller reloads the page afterwards.
 */
export async function migrateWorld(source: WorldStore, to: EngineKind, opts: { confirmReplace?: boolean } = {}): Promise<MigrationResult> {
  if (getEnginePreference() === to) throw new Error(`The world is already in ${to}`)
  const target = await openEngine(to)
  try {
    const existing = await hasWorldData(target)
    if (existing && !opts.confirmReplace) throw new Error('The target engine already holds a world: confirm replacing it')
    const sink = blobSink()
    await exportArchive(source, sink)
    const backup = (await defaultBackupTarget()) ?? undefined
    const result = await importArchive(target, sink.blob(), { backup, allowWithoutBackup: !existing })
    setEnginePreference(to)
    return { ...result, to }
  } finally {
    target.close()
  }
}
