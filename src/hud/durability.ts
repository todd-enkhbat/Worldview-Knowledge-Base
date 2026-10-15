import { STEPS_PER_YEAR, TRASH_RETENTION_MS, Y_PER_YEAR } from '../domain/constants.ts'
import { formatByPrecision } from '../domain/time.ts'
import { SCHEMA_VERSION } from '../domain/types.ts'
import type { WorldSettings } from '../domain/types.ts'
import { minT0, validateSettings } from '../domain/validate.ts'

// Pure helpers behind the durability HUD (first run, settings, trash, banners). Kept free
// of React and of the repo so they can be unit-tested in node.

export const DAY_MS = 86_400_000

// ─── dates ─────────────────────────────────────────────────────────────────────────

export type DateInputPrecision = 'year' | 'month' | 'day'

export type DateParse = { ok: true; epochMs: number; precision: DateInputPrecision } | { ok: false; message: string }

const DATE_RE = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/

/**
 * Parse "YYYY", "YYYY-MM" or "YYYY-MM-DD" (also / or . as separators) to UTC midnight at
 * the start of that year / month / day. UTC because every date in the domain is UTC.
 */
export function parseDateInput(raw: string): DateParse {
  const s = raw.trim()
  if (s === '') return { ok: false, message: 'Enter a year, or a full date.' }
  const m = DATE_RE.exec(s)
  if (!m) return { ok: false, message: 'Use YYYY, YYYY-MM or YYYY-MM-DD.' }
  const year = Number(m[1])
  if (year < 1000) return { ok: false, message: 'Use a four-digit year.' }
  if (m[2] === undefined) return { ok: true, epochMs: Date.UTC(year, 0, 1), precision: 'year' }
  const month = Number(m[2])
  if (month < 1 || month > 12) return { ok: false, message: 'Month must be 01–12.' }
  if (m[3] === undefined) return { ok: true, epochMs: Date.UTC(year, month - 1, 1), precision: 'month' }
  const day = Number(m[3])
  const t = Date.UTC(year, month - 1, day)
  // Date.UTC rolls 02-31 over into March: a round trip catches impossible days.
  if (day < 1 || new Date(t).getUTCDate() !== day) return { ok: false, message: 'That day does not exist in that month.' }
  return { ok: true, epochMs: t, precision: 'day' }
}

/** YYYY-MM-DD (UTC). */
export function formatDay(epochMs: number): string {
  return formatByPrecision(epochMs, 'day')
}

/** Settings as completeFirstRun would build them, for validating a candidate T0. */
function candidateSettings(T0: number, now: number): WorldSettings {
  return {
    T0,
    yPerYear: Y_PER_YEAR,
    stepsPerYear: STEPS_PER_YEAR,
    physicsSeed: 0,
    qualityTier: 'auto',
    firstRunComplete: true,
    lastBackupAt: null,
    autoBackupEnabled: false,
    createdAt: now,
    schemaVersion: SCHEMA_VERSION,
  }
}

/**
 * Plain-language problem with a T0, or null when it is valid. Mirrors validateSettings
 * (the repo re-validates on write), translating its codes for a first-time user.
 */
export function t0Problem(T0: number, now: number, yPerYear = Y_PER_YEAR): string | null {
  const r = validateSettings({ ...candidateSettings(T0, now), yPerYear }, now)
  const issue = r.errors.find((e) => e.field === 'T0')
  if (!issue) return null
  if (issue.code === 't0-future') return 'That date is in the future. The worldline has to start today or earlier.'
  if (issue.code === 'span') return `The worldline holds at most 250 years. Start on or after ${formatDay(minT0(now, yPerYear))}.`
  return issue.message
}

// ─── storage ───────────────────────────────────────────────────────────────────────

export type StorageKind = 'persisted' | 'best-effort' | 'memory' | 'unknown'

export const STORAGE_LABEL: Readonly<Record<StorageKind, string>> = {
  persisted: 'PERSISTED',
  'best-effort': 'BEST-EFFORT',
  memory: 'MEMORY',
  unknown: 'UNKNOWN',
}

export const STORAGE_EXPLAIN: Readonly<Record<StorageKind, string>> = {
  persisted: 'The browser has promised not to evict this world under storage pressure.',
  'best-effort': 'The browser may evict this world when the disk fills up or after long disuse. Keep exports.',
  memory: 'Browser storage is unavailable. Nothing will be saved: export before closing this tab.',
  unknown: 'This browser does not say whether storage is persistent. Treat it as best-effort.',
}

export function storageKind(input: { fallback: boolean; persisted: boolean | null }): StorageKind {
  if (input.fallback) return 'memory'
  if (input.persisted === true) return 'persisted'
  if (input.persisted === false) return 'best-effort'
  return 'unknown'
}

/** 1.2 MB style (decimal units, like the browser's own storage settings). */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '—'
  if (n < 1000) return `${n} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let v = n / 1000
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

/** Usage as a fraction of quota in [0, 1], or null when either is unknown. */
export function usageFraction(usage: number | null, quota: number | null): number | null {
  if (usage === null || quota === null || !(quota > 0)) return null
  return Math.min(1, Math.max(0, usage / quota))
}

// ─── backups and trash ─────────────────────────────────────────────────────────────

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "never", "today", "1 day ago", "N days ago". */
export function backupAgeLabel(lastBackupAt: number | null, now: number): string {
  if (lastBackupAt === null) return 'never'
  const days = Math.max(0, Math.floor((now - lastBackupAt) / DAY_MS))
  return days === 0 ? 'today' : `${plural(days, 'day')} ago`
}

/** Whole days left before a trashed record is purged (rounded up, never negative). */
export function trashDaysLeft(deletedAt: number, now: number, retentionMs = TRASH_RETENTION_MS): number {
  return Math.max(0, Math.ceil((deletedAt + retentionMs - now) / DAY_MS))
}

export const WIPE_PHRASE = 'wipe world'

/** Typed confirmation for the danger zone: the exact phrase, ignoring case and outer spaces. */
export function wipeConfirmed(typed: string): boolean {
  return typed.trim().toLowerCase() === WIPE_PHRASE
}

// ─── banners ───────────────────────────────────────────────────────────────────────

export type BannerKind = 'error' | 'memory' | 'interrupted-import' | 'read-only' | 'backup-error' | 'backup-regrant' | 'backup-nag'

export interface BannerInput {
  ready: boolean
  fallback: boolean
  writer: boolean
  error: string | null
  interruptedImport: boolean
  backupError: string | null
  /** An auto-backup folder is set but this session lost permission to it. */
  needsRegrant: boolean
  /** shouldNag(settings, now) */
  nag: boolean
  nagDismissed: boolean
  /** Settings exist and the first run is done (the nag means nothing before that). */
  firstRunDone: boolean
}

/**
 * Which banners to show, most urgent first. The memory fallback and an interrupted import
 * set RepoStatus.error themselves, so those banners replace the generic error one. A read-only
 * tab with an error (lost the lock on a version change) shows the error, which says to reload.
 */
export function activeBanners(i: BannerInput): BannerKind[] {
  const out: BannerKind[] = []
  if (i.fallback) out.push('memory')
  if (i.interruptedImport) out.push('interrupted-import')
  if (i.error && !i.fallback && !i.interruptedImport) out.push('error')
  if (!i.ready) return out
  if (!i.writer && !i.fallback && !i.error) out.push('read-only')
  if (i.writer && i.backupError) out.push('backup-error')
  if (i.writer && i.needsRegrant) out.push('backup-regrant')
  if (i.writer && !i.fallback && i.firstRunDone && i.nag && !i.nagDismissed) out.push('backup-nag')
  return out
}

/** Repo error strings that only a reload can fix (version change, closed database, newer data). */
export function errorSuggestsReload(message: string): boolean {
  return /reload/i.test(message)
}

// ─── install ───────────────────────────────────────────────────────────────────────

export type InstallHint = 'installed' | 'prompt' | 'ios' | 'safari-mac' | 'chromium' | 'none'

/**
 * How this browser can install the app (installing is what wins durable storage in Safari
 * and makes persistence likely in Chrome). 'prompt' means a captured beforeinstallprompt.
 */
export function installHint(userAgent: string, standalone: boolean, canPrompt: boolean): InstallHint {
  if (standalone) return 'installed'
  if (canPrompt) return 'prompt'
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios'
  const chromium = /Chrome\/|Chromium\/|Edg\//.test(userAgent)
  if (/Safari\//.test(userAgent) && /Version\//.test(userAgent) && !chromium && !/Firefox|Android/.test(userAgent)) return 'safari-mac'
  if (chromium) return 'chromium'
  return 'none'
}

export const INSTALL_TEXT: Readonly<Record<InstallHint, string>> = {
  installed: 'Installed. This app window keeps its own durable storage.',
  prompt: 'Install it as an app: installed apps get durable storage.',
  ios: 'Install it: Share → Add to Home Screen. Home Screen apps are exempt from Safari’s 7-day deletion.',
  'safari-mac': 'Install it: File → Add to Dock. Dock apps are exempt from Safari’s 7-day deletion.',
  chromium: 'Install it from the install icon in the address bar (or the browser menu → Install). Installed apps keep storage.',
  none: 'This browser cannot install web apps. Export backups regularly.',
}

// ─── errors and toasts ─────────────────────────────────────────────────────────────

/** A user-facing line for anything a repo action can throw. Repo and archive errors are already worded for people. */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.name === 'AbortError' ? 'Cancelled.' : e.message
  if (typeof e === 'string') return e
  return 'Something went wrong.'
}

/** Remaining toast time, never negative. */
export function toastRemaining(expiresAt: number, now: number): number {
  return Math.max(0, expiresAt - now)
}

/** Progress as a 0–100 integer, or null when the total is unknown. */
export function percent(done: number, total: number): number | null {
  if (!(total > 0)) return null
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
}
