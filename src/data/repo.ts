import { create } from 'zustand'
import { useApp, useWorld } from '../app/store.ts'
import { SIGMA, STEPS_PER_YEAR, TRASH_RETENTION_MS, Y_PER_YEAR } from '../domain/constants.ts'
import { fnv1a32, minRadiusFor, nudgeAnchor, placeAnchor, quantize, replaceOnTagChange, toPlacedAnchors, anchorY } from '../domain/placement.ts'
import type { PlacedAnchor, PlacementOptions } from '../domain/placement.ts'
import { SCHEMA_VERSION } from '../domain/types.ts'
import type {
  Archetype,
  AssetMeta,
  Attachment,
  InteractionEvent,
  InteractionKind,
  LinkKind,
  NodeRecord,
  WorldSettings,
} from '../domain/types.ts'
import { applySnap, makeNodeDraft, slugify, validateNode, validateSettings } from '../domain/validate.ts'
import type { ValidationIssue, ValidationResult } from '../domain/validate.ts'
import { ArchiveError, IMPORT_MARKER_KV, exportArchive, importArchive, readImportMarker } from './archive.ts'
import type { ArchiveSink, ExportOptions, ExportResult, ImportMarker, ImportOptions, ImportResult } from './archive.ts'
import { MAX_ATTACHMENT_BYTES, cleanFileName, makeThumbnail, sniffBlob } from './attachments.ts'
import { createAutoBackup } from './autoBackup.ts'
import { defaultBackupTarget, readAnyBackup } from './backupTargets.ts'
import type { AutoBackupController } from './autoBackup.ts'
import { getEnginePreference, openSqliteStore, probeEngine, readOnlyLock } from './engine.ts'
import { openWorldStore } from './idbStore.ts'
import { ReadOnlyError, createSync, initWriterLock, withSync } from './locks.ts'
import type { Sync, WriterLock } from './locks.ts'
import { buildDemoWorld } from './seed/demo.ts'
import { initStorageStatus } from './storage.ts'
import type { StoreChange, WorldStore } from './WorldStore.ts'

// Application data façade. Every mutation goes: validate → update useWorld optimistically →
// persist → (on failure) roll useWorld back and rethrow. Actions run one at a time through a
// queue so read-modify-write sequences never interleave. Only the tab holding the writer lock
// may write (locks.ts); other tabs follow along through BroadcastChannel.

// ─── status ──────────────────────────────────────────────────────────────────────────

export interface RepoStatus {
  ready: boolean
  /** IndexedDB was unusable: the world lives in memory only and is lost on reload. */
  fallback: boolean
  /** This tab may write. */
  writer: boolean
  error: string | null
  /** An import was cut off (tab closed mid-write): the world may be partial. See recoverInterruptedImport. */
  interruptedImport: ImportMarker | null
  /** Last automatic backup failure (null after a success). Auto-backups run unattended, so the HUD shows this. */
  backupError: string | null
}

const INITIAL_STATUS: RepoStatus = { ready: false, fallback: false, writer: false, error: null, interruptedImport: null, backupError: null }

export const useRepoStatus = create<RepoStatus>()(() => ({ ...INITIAL_STATUS }))

export class RepoValidationError extends Error {
  readonly errors: ValidationIssue[]
  readonly warnings: ValidationIssue[]
  constructor(result: Pick<ValidationResult, 'errors' | 'warnings'>, what = 'record') {
    super(`Invalid ${what}: ${result.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`)
    this.name = 'RepoValidationError'
    this.errors = result.errors
    this.warnings = result.warnings
  }
}

export class RepoNotReadyError extends Error {
  constructor(message = 'The world is not loaded yet (call initRepo first)') {
    super(message)
    this.name = 'RepoNotReadyError'
  }
}

// ─── state ───────────────────────────────────────────────────────────────────────────

interface RepoState {
  raw: WorldStore
  store: WorldStore
  sync: Sync | null
  lock: WriterLock | null
  ownsStore: boolean
  now: () => number
  queue: Promise<unknown>
  autoBackup: AutoBackupController | null
  unsubscribe: (() => void)[]
  /** Remote changes are applied one at a time, in arrival order. */
  remoteQueue: Promise<void>
}

let state: RepoState | null = null
/** In-flight initRepo, so concurrent calls (React StrictMode effects, HMR) share one open. */
let initializing: Promise<RepoStatus> | null = null
const listeners = new Set<(change: StoreChange, origin: 'local' | 'remote') => void>()

function repo(): RepoState {
  if (!state) throw new RepoNotReadyError()
  return state
}

/** The (sync-wrapped) store, for modules that need direct reads (overlays, devApi). */
export function getStore(): WorldStore {
  return repo().store
}

export function isRepoReady(): boolean {
  return state !== null
}

/** Listen for committed changes from this tab ('local') or another tab ('remote'). */
export function subscribeRepo(cb: (change: StoreChange, origin: 'local' | 'remote') => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function emit(change: StoreChange, origin: 'local' | 'remote') {
  for (const cb of [...listeners]) {
    try {
      cb(change, origin)
    } catch (e) {
      console.warn('[repo] listener failed', e)
    }
  }
  if (origin === 'local' && change.type !== 'settings' && change.type !== 'wipe' && change.type !== 'import') {
    state?.autoBackup?.notifyChange()
  }
}

export interface InitRepoOptions {
  /** Use this store instead of opening IndexedDB (tests, Phase 4 adapters). */
  store?: WorldStore
  /** Writer lock. Default: the page lock (navigator.locks); null = always writer. Injected stores default to null. */
  lock?: WriterLock | null
  /** Cross-tab sync. Default: BroadcastChannel; injected stores default to none. */
  sync?: Sync | null
  now?: () => number
  /** Probe persistence / quota into useWorld.storage. Default: true unless a store is injected. */
  storageStatus?: boolean
  /** Debounced rolling backups to the user's folder. Default: true unless a store is injected. */
  autoBackup?: boolean
}

/** Open the store, hydrate useWorld and start syncing. Idempotent: a second call (even a concurrent one) returns the same repo. */
export function initRepo(opts: InitRepoOptions = {}): Promise<RepoStatus> {
  if (state) return Promise.resolve(useRepoStatus.getState())
  initializing ??= openRepo(opts).finally(() => {
    initializing = null
  })
  return initializing
}

async function openRepo(opts: InitRepoOptions): Promise<RepoStatus> {
  const injected = opts.store !== undefined
  let raw: WorldStore
  let fallback = false
  let error: string | null = null
  let lockOverride: WriterLock | null | undefined
  if (opts.store) raw = opts.store
  else if (getEnginePreference() === 'sqlite' && (await probeEngine())) {
    raw = await openSqliteStore()
  } else {
    if (getEnginePreference() === 'sqlite') {
      // The world lives in SQLite but the engine is not running (static build, server
      // stopped). Show the last IndexedDB copy read-only rather than letting it diverge.
      error = 'The SQLite engine is not running, so this is the older browser copy, read-only. Start the app with `npm run dev`.'
      lockOverride = readOnlyLock()
    }
    // A closed connection cannot write, so hand the writer lock to the next tab in line.
    const lost = (error: string) => {
      state?.lock?.release()
      useRepoStatus.setState({ writer: false, error })
    }
    const opened = await openWorldStore({
      onVersionChange: () => lost('The app was updated in another tab. Reload this tab.'),
      onTerminated: () => lost('The browser closed the database. Reload this tab.'),
    }).catch((e: unknown) => {
      // VersionError: this tab runs older code than the stored data.
      useRepoStatus.setState({ error: 'This world was saved by a newer version of the app. Reload to update.' })
      throw e
    })
    raw = opened.store
    fallback = opened.fallback
    if (opened.fallback) error = 'Browser storage is unavailable (private window?). Changes will be lost on reload; export to keep them.'
  }
  if (lockOverride !== undefined && opts.lock === undefined) opts = { ...opts, lock: lockOverride }

  // A memory fallback is private to this tab: there is nothing shared to lock or announce,
  // and waiting for another tab's lock would leave this one read-only over an empty world.
  const local = injected || fallback
  const lock = opts.lock !== undefined ? opts.lock : local ? null : initWriterLock()
  if (lock) await lock.ready
  const sync = opts.sync !== undefined ? opts.sync : local ? null : createSync({ onChange: (c) => void handleRemoteChange(c) })
  const canWrite = () => (lock ? lock.isWriter : true)
  const store = withSync(raw, { sync, canWrite })

  state = {
    raw,
    store,
    sync,
    lock,
    ownsStore: !injected,
    now: opts.now ?? Date.now,
    queue: Promise.resolve(),
    autoBackup: null,
    unsubscribe: [],
    remoteQueue: Promise.resolve(),
  }
  if (opts.autoBackup ?? !injected) {
    state.autoBackup = createAutoBackup({
      store,
      now: () => repo().now(),
      exclusive: run,
      onBackup: (s) => {
        useWorld.getState().setSettingsLocal(s)
        useRepoStatus.setState({ backupError: null })
      },
      onError: (e) => {
        console.warn('[repo] auto-backup failed', e)
        useRepoStatus.setState({ backupError: e instanceof Error ? e.message : String(e) })
      },
    })
  }
  if (lock) {
    state.unsubscribe.push(
      lock.onChange((w) => {
        useRepoStatus.setState({ writer: w })
        // Taking over from a closed writer tab: its last writes may not have reached us.
        if (w) rehydrate().catch((e) => console.warn('[repo] rehydrate after takeover failed', e))
      }),
    )
  }

  await rehydrate()
  const interruptedImport = await readImportMarker(raw).catch(() => null)
  if (interruptedImport) {
    error = 'An import was interrupted, so this world may be incomplete. Restore the automatic pre-import backup, or keep what is here.'
  }
  useRepoStatus.setState({ ready: true, fallback, writer: canWrite(), error, interruptedImport, backupError: null })
  if (opts.storageStatus ?? !injected) {
    initStorageStatus().catch((e) => console.warn('[repo] storage status failed', e))
  }
  if (canWrite()) await purgeExpiredTrash().catch((e) => console.warn('[repo] trash purge failed', e))
  return useRepoStatus.getState()
}

/** Tear down (tests, HMR). Does not release the page-wide writer lock. */
export async function closeRepo(): Promise<void> {
  await initializing?.catch(() => {})
  const s = state
  if (!s) return
  s.autoBackup?.cancel()
  // Let running actions finish against the open store before it goes away.
  await s.queue.catch(() => {})
  state = null
  for (const u of s.unsubscribe) u()
  s.sync?.close()
  if (s.ownsStore) s.raw.close()
  useRepoStatus.setState({ ...INITIAL_STATUS })
}

/** Reload useWorld from the store. */
export async function rehydrate(): Promise<void> {
  const { raw } = repo()
  const [settings, records] = await Promise.all([raw.getSettings(), raw.listNodes()])
  useWorld.getState().hydrate(settings, records)
}

/**
 * Apply a change announced by another tab. Changes are applied strictly in arrival order:
 * two handlers reading the same record concurrently could otherwise finish out of order and
 * leave the older version in useWorld. Exported for the sync wiring and tests.
 */
export function handleRemoteChange(change: StoreChange): Promise<void> {
  const s = state
  if (!s) return Promise.resolve()
  const next = s.remoteQueue.then(() => applyRemoteChange(change))
  s.remoteQueue = next
  return next
}

async function applyRemoteChange(change: StoreChange): Promise<void> {
  if (!state) return
  const { raw } = state
  const w = useWorld.getState()
  try {
    switch (change.type) {
      case 'nodes':
        for (const id of change.ids) {
          const n = await raw.getNode(id)
          if (n) w.upsertLocal(n)
          else w.removeLocal(id)
        }
        break
      case 'settings': {
        const s = await raw.getSettings()
        if (s) w.setSettingsLocal(s)
        else await rehydrate()
        break
      }
      case 'wipe':
      case 'import':
        await rehydrate()
        break
      case 'events':
      case 'assets':
        break
    }
  } catch (e) {
    console.warn('[repo] remote change failed', e)
  }
  emit(change, 'remote')
}

/** Serialise actions so read-modify-write sequences never interleave. */
function run<T>(fn: () => Promise<T>): Promise<T> {
  const s = repo()
  const next = s.queue.catch(() => {}).then(fn)
  s.queue = next
  return next
}

function requireWriter(): void {
  const { lock } = repo()
  if (lock && !lock.isWriter) throw new ReadOnlyError()
}

function requireSettings(): WorldSettings {
  const s = useWorld.getState().settings
  if (!s) throw new RepoNotReadyError('Complete the first run (set T0) before adding nodes')
  return s
}

function allRecords(): NodeRecord[] {
  const w = useWorld.getState()
  return [...w.nodes.values(), ...w.trash.values()]
}

function findLive(id: string): NodeRecord {
  const n = useWorld.getState().nodes.get(id)
  if (!n) throw new Error(`No live node ${id}`)
  return n
}

function placementOpts(s: WorldSettings): PlacementOptions {
  return { T0: s.T0, yPerYear: s.yPerYear }
}

function liveAnchors(s: WorldSettings): PlacedAnchor[] {
  return toPlacedAnchors([...useWorld.getState().nodes.values()], placementOpts(s))
}

function validate(record: NodeRecord, settings: WorldSettings, now: number): ValidationResult {
  // Trashed link targets only warn: an undo-able delete must not lock edits elsewhere.
  return validateNode(record, { settings, now, others: allRecords(), trashedLinkTargets: 'warn' })
}

type SpacingPolicy = 'reject' | 'snap' | 'nudge'

/**
 * Validate, resolving a σ conflict per policy: 'snap' applies the validator's nearby free
 * spot (≤ 2σ); 'nudge' additionally searches further out (date change, restore: the node
 * must land somewhere); 'reject' accepts no move.
 */
function settle(record: NodeRecord, settings: WorldSettings, now: number, policy: SpacingPolicy): NodeRecord {
  let r = validate(record, settings, now)
  if (!r.ok && policy !== 'reject' && r.spacing.status === 'snap') {
    record = applySnap(record, r)
    r = validate(record, settings, now)
  }
  if (!r.ok && policy === 'nudge' && r.spacing.status === 'reject') {
    const found = nudgeAnchor(record.anchorXZ, anchorY(record, placementOpts(settings)), liveAnchors(settings), {
      selfId: record.id,
      seed: fnv1a32(record.id),
      minRadius: minRadiusFor(record.archetype),
    })
    if (found) {
      record = { ...record, anchorXZ: found }
      r = validate(record, settings, now)
    }
  }
  if (!r.ok) throw new RepoValidationError(r)
  return record
}

/** Optimistically apply `next` to useWorld, persist, and roll back on failure. */
async function commit(next: NodeRecord[], persist: () => Promise<void>): Promise<void> {
  const w = useWorld.getState()
  const prev = next.map((n) => w.nodes.get(n.id) ?? w.trash.get(n.id))
  for (const n of next) w.upsertLocal(n)
  try {
    await persist()
  } catch (e) {
    const w2 = useWorld.getState()
    next.forEach((n, i) => {
      const p = prev[i]
      if (p) w2.upsertLocal(p)
      else w2.removeLocal(n.id)
    })
    throw e
  }
  emit({ type: 'nodes', ids: next.map((n) => n.id) }, 'local')
}

async function putOne(n: NodeRecord): Promise<void> {
  await commit([n], () => repo().store.putNode(n))
}

// ─── first run ───────────────────────────────────────────────────────────────────────

export function defaultSettings(T0: number, now: number): WorldSettings {
  const seed = new Uint32Array(1)
  crypto.getRandomValues(seed)
  return {
    T0,
    yPerYear: Y_PER_YEAR,
    stepsPerYear: STEPS_PER_YEAR,
    physicsSeed: seed[0],
    qualityTier: 'auto',
    firstRunComplete: true,
    lastBackupAt: null,
    autoBackupEnabled: false,
    createdAt: now,
    schemaVersion: SCHEMA_VERSION,
  }
}

export function completeFirstRun(input: { T0: number; start: 'empty' | 'demo' }): Promise<WorldSettings> {
  return run(async () => {
    requireWriter()
    const { store, now: clock } = repo()
    const now = clock()
    const w = useWorld.getState()
    if (w.settings?.firstRunComplete) throw new Error('First run is already complete; use relayoutWorld to change T0')
    const settings = defaultSettings(input.T0, now)
    const sv = validateSettings(settings, now)
    if (!sv.ok) throw new RepoValidationError(sv, 'settings')
    const records = input.start === 'demo' ? buildDemoWorld(input.T0, now, { yPerYear: settings.yPerYear }) : []

    const prevSettings = w.settings
    const prevRecords = allRecords()
    w.hydrate(settings, [...prevRecords, ...records])
    // Records first, settings last: the settings row (firstRunComplete) is the commit marker,
    // so a failure can never leave a "finished" first run without the world it promised.
    let wrote = false
    try {
      if (records.length) {
        await store.putNodes(records)
        wrote = true
      }
      await store.putSettings(settings)
    } catch (e) {
      if (wrote) for (const r of records) await store.deleteNode(r.id).catch(() => {})
      useWorld.getState().hydrate(prevSettings, prevRecords)
      throw e
    }
    emit({ type: 'settings' }, 'local')
    if (records.length) emit({ type: 'nodes', ids: records.map((r) => r.id) }, 'local')
    return settings
  })
}

/** Add the demo world to the current one (dev / "show me an example"). Ids already present are skipped. */
export function seedDemo(): Promise<NodeRecord[]> {
  return run(async () => {
    requireWriter()
    const settings = requireSettings()
    const { store, now: clock } = repo()
    const existing = allRecords()
    const have = new Set(existing.map((r) => r.id))
    const records = buildDemoWorld(settings.T0, clock(), {
      existing: liveAnchors(settings),
      existingSlugs: existing.map((r) => r.slug),
      yPerYear: settings.yPerYear,
    }).filter((r) => !have.has(r.id))
    if (records.length) await commit(records, () => store.putNodes(records))
    return records
  })
}

// ─── nodes ───────────────────────────────────────────────────────────────────────────

export type NodeDraftInput = Partial<NodeRecord> & { archetype: Archetype; title: string }

/**
 * Create a node: fill defaults, give it a unique slug, place its anchor (frozen from now on),
 * validate, persist, select it and toast "Created <title>" with Undo. The caller flies to it.
 */
export interface CreateNodeOptions {
  /**
   * Where the node should go (semantic placement, Phase 4): nudged to the nearest free spot
   * instead of the tag-hash sector. Ignored when nothing free is within SNAP range.
   */
  anchorHint?: readonly [number, number]
  /** Toast and select as usual (default true). */
  announce?: boolean
}

export function createNode(draft: NodeDraftInput, opts: CreateNodeOptions = {}): Promise<NodeRecord> {
  return run(async () => {
    requireWriter()
    const settings = requireSettings()
    const { store, now: clock } = repo()
    const now = clock()
    const given = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== undefined)) as NodeDraftInput
    const base = makeNodeDraft(draft.archetype, { ...given, title: draft.title.trim() }, { now })
    const slugs = allRecords().map((r) => r.slug)
    let record: NodeRecord = {
      ...base,
      id: given.id ?? base.id,
      slug: slugify(draft.slug ?? base.title, slugs),
      anchorXZ: [0, 0],
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      schemaVersion: SCHEMA_VERSION,
    }
    if (useWorld.getState().nodes.has(record.id) || useWorld.getState().trash.has(record.id)) {
      throw new Error(`A node with id ${record.id} already exists`)
    }
    const hinted = opts.anchorHint
      ? nudgeAnchor(opts.anchorHint, anchorY(record, placementOpts(settings)), liveAnchors(settings), {
          selfId: record.id,
          seed: fnv1a32(record.id),
          minRadius: minRadiusFor(record.archetype),
          maxDistance: 4 * SIGMA,
        })
      : null
    record.anchorXZ = hinted ?? placeAnchor(record, liveAnchors(settings), placementOpts(settings))
    record = settle(record, settings, now, 'reject')
    await commit([record], () => store.putNode(record))

    const id = record.id
    if (opts.announce !== false) {
      const app = useApp.getState()
      app.select(record.id)
      app.pushToast({ message: `Created ${record.title}`, undo: () => undoCreate(id) })
    }
    return record
  })
}

/**
 * Change a live node's archetype (the omnibox's refinement may reclassify what the
 * heuristics guessed). Per-archetype blocks are reset to the new archetype's defaults, a
 * scene survives only on a memory, and the anchor moves only if the new archetype needs
 * more room from the axis (memories) or the old spot breaks σ.
 */
export function retypeNode(id: string, archetype: Archetype): Promise<NodeRecord> {
  return run(async () => {
    requireWriter()
    const settings = requireSettings()
    const now = repo().now()
    const prev = findLive(id)
    if (prev.archetype === archetype) return prev
    const fresh = makeNodeDraft(archetype, {}, { now })
    let next: NodeRecord = { ...prev, archetype, updatedAt: now }
    delete next.entity
    delete next.demon
    if (archetype !== 'memory') delete next.splat
    if (fresh.entity) next.entity = fresh.entity
    if (fresh.demon) next.demon = { ...fresh.demon, query: prev.title }
    const minR = minRadiusFor(archetype)
    if (Math.hypot(next.anchorXZ[0], next.anchorXZ[1]) < minR) {
      const found = nudgeAnchor(next.anchorXZ, anchorY(next, placementOpts(settings)), liveAnchors(settings), {
        selfId: id,
        seed: fnv1a32(id),
        minRadius: minR,
      })
      if (found) next = { ...next, anchorXZ: found }
    }
    next = settle(next, settings, now, 'nudge')
    await putOne(next)
    return next
  })
}

/**
 * Move many anchors at once in one atomic write (Phase 4 re-crystallise). Each target is
 * nudged to keep σ against the already-placed ones, in id order, so the result does not
 * depend on the input order. Toasts `label` with an Undo that restores every old anchor.
 */
export function reanchorNodes(targets: ReadonlyMap<string, readonly [number, number]>, label = 'Re-anchored'): Promise<NodeRecord[]> {
  return run(async () => {
    requireWriter()
    const settings = requireSettings()
    const { store, now: clock } = repo()
    const now = clock()
    const opts = placementOpts(settings)
    const live = [...useWorld.getState().nodes.values()]
    const moving = new Set(targets.keys())
    // Fixed nodes first; movers are placed one by one against everything placed so far.
    const placed: PlacedAnchor[] = toPlacedAnchors(live.filter((n) => !moving.has(n.id)), opts)
    const before = new Map<string, [number, number]>()
    const next: NodeRecord[] = []
    for (const id of [...moving].sort()) {
      const prev = findLive(id)
      const want = targets.get(id)!
      const y = anchorY(prev, opts)
      const xz = nudgeAnchor([quantize(want[0]), quantize(want[1])], y, placed, { selfId: id, seed: fnv1a32(id), minRadius: minRadiusFor(prev.archetype) })
      if (!xz) continue
      placed.push({ id, anchorXZ: xz, y })
      if (xz[0] === prev.anchorXZ[0] && xz[1] === prev.anchorXZ[1]) continue
      before.set(id, [prev.anchorXZ[0], prev.anchorXZ[1]])
      next.push({ ...prev, anchorXZ: xz, updatedAt: now })
    }
    if (next.length === 0) return []
    await commit(next, () => store.putNodes(next))
    useApp.getState().pushToast({
      message: `${label}: ${next.length} node${next.length === 1 ? '' : 's'} moved`,
      undo: () => void reanchorNodes(before, 'Restored').catch((e) => console.warn('[repo] undo re-anchor failed', e)),
    })
    return next
  })
}

/** Undo of a creation: the node never existed, so it is removed outright (with its blobs). */
function undoCreate(id: string): Promise<void> {
  return run(async () => {
    requireWriter()
    const w = useWorld.getState()
    const n = w.nodes.get(id) ?? w.trash.get(id)
    if (!n) return
    await purge([n])
    if (useApp.getState().selectedId === id) useApp.getState().select(null)
  })
}

const FROZEN_FIELDS = ['id', 'createdAt', 'deletedAt', 'anchorXZ', 'schemaVersion', 'attachments', 'archetype'] as const

/**
 * Edit a live node. Anchors stay frozen except: a primary-tag change re-places this node
 * only, and a date change keeps XZ (snapping/nudging only if the new height breaks σ).
 * Use moveAnchor to drag, add/removeAttachment for files, softDelete/restore for trash.
 */
export function updateNode(id: string, patch: Partial<NodeRecord>, opts: { keepAnchor?: boolean } = {}): Promise<NodeRecord> {
  return run(async () => {
    requireWriter()
    const settings = requireSettings()
    const now = repo().now()
    const prev = findLive(id)
    const clean: Partial<NodeRecord> = { ...patch }
    for (const k of FROZEN_FIELDS) delete clean[k]
    let next: NodeRecord = { ...prev, ...clean, updatedAt: now }
    if (patch.thermo) next.thermo = { ...prev.thermo, ...patch.thermo }
    if (typeof next.title === 'string') next.title = next.title.trim()
    // keepAnchor: the anchor was placed semantically (omnibox), so a new primary tag must not
    // send it back to a tag-hash sector.
    if (!opts.keepAnchor) next = replaceOnTagChange(prev, next, liveAnchors(settings), placementOpts(settings))
    const dateChanged = next.temporalOrigin !== prev.temporalOrigin
    next = settle(next, settings, now, dateChanged ? 'nudge' : 'snap')
    await putOne(next)
    return next
  })
}

/** XZ-constrained drag. Y stays locked to the date. A spot within σ of another anchor snaps or is rejected. */
export function moveAnchor(id: string, xz: readonly [number, number]): Promise<NodeRecord> {
  return run(async () => {
    requireWriter()
    const settings = requireSettings()
    const now = repo().now()
    const prev = findLive(id)
    let [x, z] = [quantize(xz[0]), quantize(xz[1])]
    // Memories need room for their catwalk spur: keep them outside the helix.
    const minR = minRadiusFor(prev.archetype)
    const r = Math.hypot(x, z)
    if (r < minR) {
      const a = r > 0 ? Math.atan2(z, x) : 0
      x = quantize((minR + 1e-3) * Math.cos(a))
      z = quantize((minR + 1e-3) * Math.sin(a))
    }
    const next = settle({ ...prev, anchorXZ: [x, z], updatedAt: now }, settings, now, 'snap')
    await putOne(next)
    return next
  })
}

/** Move to trash (30-day retention) with an Undo toast. */
export function softDelete(id: string): Promise<NodeRecord> {
  return run(async () => {
    requireWriter()
    const now = repo().now()
    const prev = findLive(id)
    const next: NodeRecord = { ...prev, deletedAt: now, updatedAt: now }
    await putOne(next)
    const app = useApp.getState()
    if (app.selectedId === id) app.select(null)
    app.pushToast({ message: `Deleted ${prev.title}`, undo: () => restore(id).then(() => {}) })
    return next
  })
}

/** Bring a node back from the trash. Its old spot may be taken by now, so σ conflicts are resolved. */
export function restore(id: string): Promise<NodeRecord> {
  return run(async () => {
    requireWriter()
    const settings = requireSettings()
    const now = repo().now()
    const prev = useWorld.getState().trash.get(id)
    if (!prev) throw new Error(`Node ${id} is not in the trash`)
    const next = settle({ ...prev, deletedAt: null, updatedAt: now }, settings, now, 'nudge')
    await putOne(next)
    return next
  })
}

/**
 * Hard-delete records and everything they own: blobs (by AssetMeta.nodeId and by
 * attachment/splat references) and links pointing at them from other records. Persists
 * first, then updates useWorld (a hard delete is not optimistic).
 */
async function purge(records: readonly NodeRecord[]): Promise<string[]> {
  if (records.length === 0) return []
  const { store } = repo()
  const ids = new Set(records.map((r) => r.id))
  const blobIds = new Set<string>()
  for (const r of records) {
    for (const a of r.attachments) {
      blobIds.add(a.blobId)
      if (a.thumbBlobId) blobIds.add(a.thumbBlobId)
    }
    for (const b of [r.splat?.proxyAssetId, r.splat?.interiorAssetId, r.splat?.thumbAssetId]) if (b) blobIds.add(b)
  }
  for (const m of await store.listAssets()) if (m.nodeId !== null && ids.has(m.nodeId)) blobIds.add(m.id)

  const now = repo().now()
  const relinked = allRecords()
    .filter((r) => !ids.has(r.id) && r.links.some((l) => ids.has(l.targetId)))
    .map((r) => ({ ...r, links: r.links.filter((l) => !ids.has(l.targetId)), updatedAt: now }))
  try {
    if (relinked.length) await store.putNodes(relinked)
    for (const id of ids) await store.deleteNode(id)
  } catch (e) {
    // Part of the purge may have landed: reload the mirror from the store rather than guess.
    await rehydrate().catch(() => {})
    throw e
  }
  for (const b of blobIds) await store.deleteBlob(b).catch((e) => console.warn('[repo] blob delete failed', b, e))

  const w = useWorld.getState()
  for (const r of relinked) w.upsertLocal(r)
  for (const id of ids) w.removeLocal(id)
  emit({ type: 'nodes', ids: [...ids, ...relinked.map((r) => r.id)] }, 'local')
  return [...ids]
}

/** Hard-delete trash older than TRASH_RETENTION_MS. Returns the purged ids. */
export function purgeExpiredTrash(now?: number): Promise<string[]> {
  return run(async () => {
    requireWriter()
    const t = now ?? repo().now()
    const expired = [...useWorld.getState().trash.values()].filter((r) => r.deletedAt !== null && r.deletedAt + TRASH_RETENTION_MS <= t)
    return purge(expired)
  })
}

/** Hard-delete the whole trash. Irreversible, so the caller must pass { confirm: true }. */
export function emptyTrash(opts: { confirm: boolean }): Promise<string[]> {
  return run(async () => {
    if (opts?.confirm !== true) throw new Error('emptyTrash is irreversible: pass { confirm: true }')
    requireWriter()
    return purge([...useWorld.getState().trash.values()])
  })
}

// ─── links ───────────────────────────────────────────────────────────────────────────

export function link(a: string, b: string, kind: LinkKind = 'relates', label?: string): Promise<NodeRecord> {
  return run(async () => {
    requireWriter()
    const settings = requireSettings()
    const now = repo().now()
    if (a === b) throw new Error('A node cannot link to itself')
    const prev = findLive(a)
    findLive(b)
    if (prev.links.some((l) => l.targetId === b && l.kind === kind)) return prev
    const l: NodeRecord['links'][number] = { targetId: b, kind, createdAt: now }
    if (label) l.label = label
    const next = settle({ ...prev, links: [...prev.links, l], updatedAt: now }, settings, now, 'snap')
    await putOne(next)
    return next
  })
}

/** Remove links from a to b (all kinds, or only `kind`). */
export function unlink(a: string, b: string, kind?: LinkKind): Promise<NodeRecord> {
  return run(async () => {
    requireWriter()
    const now = repo().now()
    const prev = findLive(a)
    const links = prev.links.filter((l) => !(l.targetId === b && (kind === undefined || l.kind === kind)))
    if (links.length === prev.links.length) return prev
    const next = { ...prev, links, updatedAt: now }
    await putOne(next)
    return next
  })
}

// ─── attachments ─────────────────────────────────────────────────────────────────────

/**
 * Store a file on a node. Images get a ≤256 px webp thumbnail when the runtime can make one;
 * text files are stored as-is. Blobs are written first and removed again if the record
 * update fails, so no orphan survives a failed attach.
 */
export function addAttachment(nodeId: string, file: Blob, name?: string): Promise<Attachment> {
  return run(async () => {
    requireWriter()
    const { store, now: clock } = repo()
    const now = clock()
    const prev = findLive(nodeId)
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`Attachments are limited to ${MAX_ATTACHMENT_BYTES >> 20} MB`)
    const displayName = cleanFileName(name ?? (file as Partial<File>).name)
    const { mime, kind } = await sniffBlob(file, displayName)
    if (!kind) throw new Error(`Unsupported attachment type ${mime}: only images and text files can be attached`)

    const blobId = crypto.randomUUID()
    const meta: AssetMeta = { id: blobId, kind, mime, bytes: file.size, createdAt: now, nodeId }
    const thumb = kind === 'image' ? await makeThumbnail(file) : null
    const attachment: Attachment = { id: crypto.randomUUID(), kind, name: displayName, mime, bytes: file.size, blobId, createdAt: now }
    const written: string[] = []
    try {
      await store.putBlob({ meta, data: file })
      written.push(blobId)
      if (thumb) {
        const thumbId = crypto.randomUUID()
        await store.putBlob({
          meta: { id: thumbId, kind: 'image-thumb', mime: 'image/webp', bytes: thumb.size, createdAt: now, nodeId },
          data: thumb,
        })
        written.push(thumbId)
        attachment.thumbBlobId = thumbId
      }
      await putOne({ ...prev, attachments: [...prev.attachments, attachment], updatedAt: now })
    } catch (e) {
      for (const id of written) await store.deleteBlob(id).catch(() => {})
      throw e
    }
    emit({ type: 'assets', ids: written }, 'local')
    return attachment
  })
}

export function removeAttachment(nodeId: string, attachmentId: string): Promise<NodeRecord> {
  return run(async () => {
    requireWriter()
    const { store, now: clock } = repo()
    const now = clock()
    const prev = findLive(nodeId)
    const att = prev.attachments.find((a) => a.id === attachmentId)
    if (!att) throw new Error(`Node ${nodeId} has no attachment ${attachmentId}`)
    const next = { ...prev, attachments: prev.attachments.filter((a) => a.id !== attachmentId), updatedAt: now }
    await putOne(next)
    const blobs = [att.blobId, ...(att.thumbBlobId ? [att.thumbBlobId] : [])]
    for (const b of blobs) await store.deleteBlob(b).catch((e) => console.warn('[repo] blob delete failed', b, e))
    emit({ type: 'assets', ids: blobs }, 'local')
    return next
  })
}

// ─── settings ────────────────────────────────────────────────────────────────────────

/** Patch settings. T0 cannot change here: that is relayoutWorld, an explicit full recompute. */
export function updateSettings(patch: Partial<WorldSettings>): Promise<WorldSettings> {
  return run(async () => {
    requireWriter()
    const prev = requireSettings()
    const now = repo().now()
    if (patch.T0 !== undefined && patch.T0 !== prev.T0) throw new Error('Changing T0 re-lays out the world: use relayoutWorld')
    const next: WorldSettings = { ...prev, ...patch, schemaVersion: prev.schemaVersion, createdAt: prev.createdAt }
    const r = validateSettings(next, now)
    if (!r.ok) throw new RepoValidationError(r, 'settings')
    // Unlike a T0 shift, a new yPerYear rescales every height, so anchors that were σ apart
    // can end up closer. Refuse rather than re-place nodes the user positioned.
    if (next.yPerYear !== prev.yPerYear) {
      const live = [...useWorld.getState().nodes.values()]
      const crowded = live
        .map((n) => validateNode(n, { settings: next, now, others: live, trashedLinkTargets: 'warn' }).errors)
        .flat()
        .filter((e) => e.field === 'anchorXZ')
      if (crowded.length) throw new RepoValidationError({ errors: crowded, warnings: [] }, 'yPerYear change (anchors would be closer than σ)')
    }
    await commitSettings(prev, next)
    return next
  })
}

async function commitSettings(prev: WorldSettings, next: WorldSettings): Promise<void> {
  useWorld.getState().setSettingsLocal(next)
  try {
    await repo().store.putSettings(next)
  } catch (e) {
    useWorld.getState().setSettingsLocal(prev)
    throw e
  }
  emit({ type: 'settings' }, 'local')
}

export interface OutOfRange {
  id: string
  title: string
  temporalOrigin: number
  issues: ValidationIssue[]
}

export interface RelayoutResult {
  applied: boolean
  /** Problems with the new T0 itself (in the future, span over 250 y, …). */
  settingsIssues: ValidationIssue[]
  /** Live records whose date would fall outside [T0, now + 5 y]. Never clamped silently. */
  outOfRange: OutOfRange[]
}

/**
 * Change T0, the start of the worldline. Validates every live record against the new T0 and
 * applies only when all fit (and `apply` is not false); otherwise reports the records that
 * would fall outside so the user can fix their dates. Anchors keep their XZ: a T0 shift moves
 * every height by the same amount, so σ spacing is preserved.
 */
export function relayoutWorld(newT0: number, opts: { apply?: boolean } = {}): Promise<RelayoutResult> {
  return run(async () => {
    requireWriter()
    const prev = requireSettings()
    const now = repo().now()
    const next: WorldSettings = { ...prev, T0: newT0 }
    const sv = validateSettings(next, now)
    const outOfRange: OutOfRange[] = []
    for (const r of useWorld.getState().nodes.values()) {
      const issues = validateNode(r, { settings: next, now, others: [], trashedLinkTargets: 'warn' }).errors.filter(
        (e) => e.field === 'temporalOrigin',
      )
      if (issues.length) outOfRange.push({ id: r.id, title: r.title, temporalOrigin: r.temporalOrigin, issues })
    }
    outOfRange.sort((a, b) => a.temporalOrigin - b.temporalOrigin)
    const ok = sv.ok && outOfRange.length === 0
    if (ok && opts.apply !== false && newT0 !== prev.T0) await commitSettings(prev, next)
    return { applied: ok && opts.apply !== false, settingsIssues: sv.errors, outOfRange }
  })
}

// ─── interaction log ─────────────────────────────────────────────────────────────────

/** Default activation amplitude A_k per interaction kind. */
export const DEFAULT_AMPLITUDE: Readonly<Record<InteractionKind, number>> = {
  dwell: 0.5,
  inspect: 1,
  enter: 2,
  'demon-match': 0.25,
}

/**
 * Append an interaction. Logging is ambient, so a read-only tab drops events (returns null)
 * instead of throwing.
 */
export function logEvent(
  kind: InteractionKind,
  nodeId: string,
  extra: Partial<Pick<InteractionEvent, 'amplitude' | 'demonId' | 'bits' | 't'>> = {},
): Promise<InteractionEvent | null> {
  return run(async () => {
    const { lock, store, now } = repo()
    if (lock && !lock.isWriter) return null
    const e: InteractionEvent = { id: crypto.randomUUID(), t: extra.t ?? now(), kind, nodeId, amplitude: extra.amplitude ?? DEFAULT_AMPLITUDE[kind] }
    if (extra.demonId !== undefined) e.demonId = extra.demonId
    if (extra.bits !== undefined) e.bits = extra.bits
    await store.appendEvent(e)
    emit({ type: 'events' }, 'local')
    return e
  })
}

// ─── whole-world operations ──────────────────────────────────────────────────────────

/** Export the world. A completed export counts as a backup (settings.lastBackupAt) unless markBackup is false. */
export function exportWorld(sink: ArchiveSink, opts: ExportOptions & { markBackup?: boolean } = {}): Promise<ExportResult> {
  return run(async () => {
    const { raw, now } = repo()
    const result = await exportArchive(raw, sink, { now: now(), ...opts })
    const s = useWorld.getState().settings
    const { lock } = repo()
    if (opts.markBackup !== false && s && (!lock || lock.isWriter)) {
      await commitSettings(s, { ...s, lastBackupAt: result.manifest.exportedAt })
    }
    return result
  })
}

/**
 * Import = replace (archive.ts takes the pre-import backup first). Writes bypass the per-call
 * broadcast; other tabs get one 'import' notice and reload everything.
 */
export function importWorld(file: Blob, opts: ImportOptions = {}): Promise<ImportResult> {
  return run(async () => {
    requireWriter()
    const { raw, now } = repo()
    // OPFS where it is writable, else a separate IndexedDB database (older Safari).
    const backup = opts.backup ?? (await defaultBackupTarget()) ?? undefined
    let result: ImportResult
    try {
      result = await importArchive(raw, file, { now: now(), ...opts, backup })
    } catch (e) {
      // Only 'import-failed' happens after the wipe; every other error left the store untouched.
      if (e instanceof ArchiveError && e.code === 'import-failed') await afterReplace()
      throw e
    }
    await afterReplace()
    return result
  })
}

/** The store was replaced wholesale: reload, tell other tabs, clear the selection. */
async function afterReplace(): Promise<void> {
  const { raw, sync } = repo()
  await rehydrate().catch((e) => console.warn('[repo] rehydrate after import failed', e))
  useRepoStatus.setState({ interruptedImport: await readImportMarker(raw).catch(() => null) })
  sync?.post({ type: 'import' })
  emit({ type: 'import' }, 'local')
  useApp.getState().select(null)
}

/**
 * Restore the pre-import backup named by an interrupted import's marker (the import itself
 * replaces the partial world, taking a fresh backup of it first). Resolves false when the
 * import ran without a backup or the backup is gone.
 */
export async function recoverInterruptedImport(opts: Omit<ImportOptions, 'now'> = {}): Promise<boolean> {
  const marker = useRepoStatus.getState().interruptedImport
  if (!marker?.backupName) return false
  const blob = await readAnyBackup(marker.backupName)
  if (!blob) return false
  await importWorld(blob, opts)
  useRepoStatus.setState({ error: null })
  return true
}

/** Keep the (possibly partial) world as it is and forget the interrupted import. */
export function dismissInterruptedImport(): Promise<void> {
  return run(async () => {
    requireWriter()
    await repo().raw.deleteKv(IMPORT_MARKER_KV)
    useRepoStatus.setState({ interruptedImport: null, error: null })
  })
}

/** Erase everything (dev / "start over"). Irreversible, so the caller must pass { confirm: true }. */
export function wipeWorld(opts: { confirm: boolean }): Promise<void> {
  return run(async () => {
    if (opts?.confirm !== true) throw new Error('wipeWorld is irreversible: pass { confirm: true }')
    requireWriter()
    await repo().store.wipe()
    useWorld.getState().hydrate(null, [])
    useRepoStatus.setState({ interruptedImport: null })
    useApp.getState().select(null)
    emit({ type: 'wipe' }, 'local')
  })
}

/** Run a backup to the auto-backup folder now (e.g. right after the user picked it). */
export async function backupNow() {
  const ab = repo().autoBackup
  return ab ? ab.flush() : null
}
