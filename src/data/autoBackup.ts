import { BACKUP_NAG_MS } from '../domain/constants.ts'
import type { WorldSettings } from '../domain/types.ts'
import type { WorldStore } from './WorldStore.ts'
import { exportArchive, fileStamp, writableSink } from './archive.ts'

// Optional rolling backups into a folder the user picks (Chrome / Edge: File System Access).
// The directory handle is kept in the store's kv (IndexedDB can hold handles), but the
// read-write permission does not survive a reload: on load we can only *query* it, and
// re-granting needs a user gesture, so the UI shows a "re-enable backups" button when
// needsRegrant() is true. Backups run 60 s after the last change (and at least every 10 min
// during continuous activity) and the newest 5 are kept.

export const AUTO_BACKUP_KV = 'autoBackupDir'
export const AUTO_BACKUP_DEBOUNCE_MS = 60_000
export const AUTO_BACKUP_MAX_WAIT_MS = 10 * 60_000
export const AUTO_BACKUPS_KEPT = 5
const NAME_RE = /^hyperspace-backup-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/

type Mode = { mode: 'read' | 'readwrite' }
interface PermissionedHandle {
  queryPermission?(d: Mode): Promise<PermissionState>
  requestPermission?(d: Mode): Promise<PermissionState>
}
interface IterableDir {
  keys(): AsyncIterable<string>
}
interface DirectoryPickerWindow {
  showDirectoryPicker?: (o: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
}

const RW: Mode = { mode: 'readwrite' }

export function autoBackupSupported(): boolean {
  return typeof (globalThis as DirectoryPickerWindow).showDirectoryPicker === 'function'
}

/** Let the user pick the backup folder (needs a user gesture). Null when cancelled or unsupported. */
export async function chooseBackupFolder(store: WorldStore): Promise<FileSystemDirectoryHandle | null> {
  const picker = (globalThis as DirectoryPickerWindow).showDirectoryPicker
  if (typeof picker !== 'function') return null
  let dir: FileSystemDirectoryHandle
  try {
    dir = await picker({ id: 'hyperspace-backups', mode: 'readwrite' })
  } catch (e) {
    if ((e as { name?: string } | null)?.name === 'AbortError') return null
    throw e
  }
  await store.putKv(AUTO_BACKUP_KV, dir)
  return dir
}

export async function getBackupFolder(store: WorldStore): Promise<FileSystemDirectoryHandle | null> {
  const dir = await store.getKv<FileSystemDirectoryHandle>(AUTO_BACKUP_KV)
  return dir && typeof (dir as { getFileHandle?: unknown }).getFileHandle === 'function' ? dir : null
}

export async function forgetBackupFolder(store: WorldStore): Promise<void> {
  await store.deleteKv(AUTO_BACKUP_KV)
}

export type FolderPermission = 'none' | PermissionState

/** 'none' when no folder is set; otherwise the current read-write permission. */
export async function backupFolderPermission(store: WorldStore): Promise<FolderPermission> {
  const dir = await getBackupFolder(store)
  if (!dir) return 'none'
  const h = dir as unknown as PermissionedHandle
  // Without the permission API (older engines), assume the grant from the picker still holds.
  if (typeof h.queryPermission !== 'function') return 'granted'
  try {
    return await h.queryPermission(RW)
  } catch {
    return 'prompt'
  }
}

/** A folder is configured but this session has not been granted access to it yet. */
export async function needsRegrant(store: WorldStore): Promise<boolean> {
  const p = await backupFolderPermission(store)
  return p === 'prompt' || p === 'denied'
}

/** Ask again for access to the saved folder. Must run inside a user gesture (click). */
export async function regrantBackupFolder(store: WorldStore): Promise<boolean> {
  const dir = await getBackupFolder(store)
  if (!dir) return false
  const h = dir as unknown as PermissionedHandle
  if (typeof h.requestPermission !== 'function') return true
  return (await h.requestPermission(RW)) === 'granted'
}

export function backupFileName(now: number): string {
  return `hyperspace-backup-${fileStamp(now)}.zip`
}

/** Delete all but the newest `keep` auto-backups (names sort by time). Returns removed names. */
export async function pruneAutoBackups(dir: FileSystemDirectoryHandle, keep = AUTO_BACKUPS_KEPT): Promise<string[]> {
  const names: string[] = []
  for await (const name of (dir as unknown as IterableDir).keys()) if (NAME_RE.test(name)) names.push(name)
  names.sort().reverse()
  const stale = names.slice(Math.max(0, keep))
  for (const name of stale) await dir.removeEntry(name).catch(() => {})
  return stale
}

async function hasEntry(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name)
    return true
  } catch {
    return false
  }
}

/**
 * Stream one backup into the folder (atomic: createWritable swaps the file in on close).
 * getFileHandle({ create: true }) makes an empty file before a byte is written; if the export
 * then fails that file is removed again, because it matches the backup name pattern and
 * pruning would otherwise count it as a backup and evict a good one.
 */
export async function writeAutoBackup(
  store: WorldStore,
  dir: FileSystemDirectoryHandle,
  now: number,
): Promise<{ name: string; bytes: number }> {
  const name = backupFileName(now)
  const existed = await hasEntry(dir, name)
  try {
    const file = await dir.getFileHandle(name, { create: true })
    const writable = await file.createWritable()
    const { bytes } = await exportArchive(store, writableSink(writable as unknown as WritableStream<Uint8Array>), { now })
    return { name, bytes }
  } catch (e) {
    if (!existed) await dir.removeEntry(name).catch(() => {})
    throw e
  }
}

export type AutoBackupOutcome =
  | { status: 'written'; name: string; bytes: number; settings: WorldSettings }
  | { status: 'skipped'; reason: 'disabled' | 'no-settings' | 'no-folder' | 'needs-regrant' }

export interface AutoBackupOptions {
  store: WorldStore
  delayMs?: number
  maxWaitMs?: number
  keep?: number
  now?: () => number
  /** New settings after lastBackupAt was updated (mirror into useWorld). */
  onBackup?: (settings: WorldSettings) => void
  onError?: (error: unknown) => void
  /**
   * Runs each backup exclusively with other store work (repo.ts passes its action queue), so
   * the archive is a consistent snapshot and the lastBackupAt write cannot race a settings edit.
   */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>
}

export interface AutoBackupController {
  /** Call after every record / event / asset change. Do not call for the settings write a backup itself makes. */
  notifyChange(): void
  /** Run now (skipping the debounce). */
  flush(): Promise<AutoBackupOutcome>
  cancel(): void
  readonly pending: boolean
}

export function createAutoBackup(opts: AutoBackupOptions): AutoBackupController {
  const delay = opts.delayMs ?? AUTO_BACKUP_DEBOUNCE_MS
  const maxWait = opts.maxWaitMs ?? AUTO_BACKUP_MAX_WAIT_MS
  const keep = opts.keep ?? AUTO_BACKUPS_KEPT
  const clock = opts.now ?? Date.now
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstChangeAt: number | null = null
  let running: Promise<AutoBackupOutcome> = Promise.resolve({ status: 'skipped', reason: 'disabled' })

  const run = async (): Promise<AutoBackupOutcome> => {
    const { store } = opts
    const settings = await store.getSettings()
    if (!settings) return { status: 'skipped', reason: 'no-settings' }
    if (!settings.autoBackupEnabled) return { status: 'skipped', reason: 'disabled' }
    const dir = await getBackupFolder(store)
    if (!dir) return { status: 'skipped', reason: 'no-folder' }
    if ((await backupFolderPermission(store)) !== 'granted') return { status: 'skipped', reason: 'needs-regrant' }
    const now = clock()
    const { name, bytes } = await writeAutoBackup(store, dir, now)
    await pruneAutoBackups(dir, keep)
    // Re-read: settings may have changed while the archive streamed.
    const latest = (await store.getSettings()) ?? settings
    const next = { ...latest, lastBackupAt: now }
    await store.putSettings(next)
    opts.onBackup?.(next)
    return { status: 'written', name, bytes, settings: next }
  }

  const flush = (): Promise<AutoBackupOutcome> => {
    if (timer) clearTimeout(timer)
    timer = null
    firstChangeAt = null
    // Serialise: a backup never overlaps another.
    const exclusive = opts.exclusive ?? ((fn) => fn())
    running = running.catch(() => undefined).then(() => exclusive(run))
    return running
  }

  return {
    notifyChange() {
      const now = clock()
      firstChangeAt ??= now
      if (timer) clearTimeout(timer)
      const wait = Math.max(0, Math.min(delay, firstChangeAt + maxWait - now))
      timer = setTimeout(() => {
        flush().catch((e) => opts.onError?.(e))
      }, wait)
    },
    flush,
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      firstChangeAt = null
    },
    get pending() {
      return timer !== null
    },
  }
}

let pageController: AutoBackupController | null = null
let pageStore: WorldStore | null = null

/**
 * Page-level debounced auto-backup. The first call fixes the options; later calls just
 * report a change. Pass a different store (e.g. after a re-open) to start over.
 */
export function scheduleAutoBackup(store: WorldStore, opts: Omit<AutoBackupOptions, 'store'> = {}): AutoBackupController {
  if (!pageController || pageStore !== store) {
    pageController?.cancel()
    pageController = createAutoBackup({ ...opts, store })
    pageStore = store
  }
  pageController.notifyChange()
  return pageController
}

export function cancelAutoBackup(): void {
  pageController?.cancel()
  pageController = null
  pageStore = null
}

/** Whole days since the last backup, or null when there has never been one. */
export function backupAgeDays(settings: Pick<WorldSettings, 'lastBackupAt'>, now: number): number | null {
  if (settings.lastBackupAt === null) return null
  return Math.max(0, Math.floor((now - settings.lastBackupAt) / 86_400_000))
}

/**
 * Nag once the last backup (or, never backed up, the world's creation) is ≥ 3 days old.
 * A brand-new world is not nagged on day one.
 */
export function shouldNag(settings: Pick<WorldSettings, 'lastBackupAt' | 'createdAt'>, now: number): boolean {
  const since = settings.lastBackupAt ?? settings.createdAt
  return now - since >= BACKUP_NAG_MS
}
