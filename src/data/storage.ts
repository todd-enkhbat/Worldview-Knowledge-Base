import { useWorld } from '../app/store.ts'

// Storage protection and risk visibility (PLAN § Durability). Browser storage is the only
// copy of the world, so the HUD shows whether it is persisted, how full it is, whether this
// is a private window (data dies with it), and whether Safari's 7-day eviction applies.
// Every probe degrades to null ("unknown") rather than guessing.

/** Chromium incognito caps quota near ~100 MB regardless of disk; real profiles get GBs. */
export const PRIVATE_QUOTA_THRESHOLD = 120 * 1024 * 1024

interface StorageNav {
  storage?: Partial<Pick<StorageManager, 'persist' | 'persisted' | 'estimate' | 'getDirectory'>>
  userAgent?: string
  standalone?: boolean
}

function nav(): StorageNav | undefined {
  return typeof navigator === 'undefined' ? undefined : (navigator as unknown as StorageNav)
}

/**
 * Ask for persistent storage (exempt from eviction under pressure). Chrome and Safari answer
 * silently from engagement/installation; Firefox shows a permission prompt, so callers there
 * should do this from a user gesture. Returns null when the API is missing.
 */
export async function requestPersistence(n: StorageNav | undefined = nav()): Promise<boolean | null> {
  const s = n?.storage
  if (!s || typeof s.persisted !== 'function') return null
  try {
    if (await s.persisted()) return true
    return typeof s.persist === 'function' ? await s.persist() : false
  } catch {
    return null
  }
}

/** Whether storage is already persisted, without prompting. */
export async function isPersisted(n: StorageNav | undefined = nav()): Promise<boolean | null> {
  const s = n?.storage
  if (!s || typeof s.persisted !== 'function') return null
  try {
    return await s.persisted()
  } catch {
    return null
  }
}

export async function estimate(n: StorageNav | undefined = nav()): Promise<{ usage: number | null; quota: number | null } | null> {
  const s = n?.storage
  if (!s || typeof s.estimate !== 'function') return null
  try {
    const e = await s.estimate()
    return { usage: e.usage ?? null, quota: e.quota ?? null }
  } catch {
    return null
  }
}

const ua = (n: StorageNav | undefined) => n?.userAgent ?? ''

/** Safari or another WebKit shell on iOS/iPadOS (all subject to ITP storage caps). */
export function isSafari(userAgent = ua(nav())): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true
  return /Safari\//.test(userAgent) && /Version\//.test(userAgent) && !/Chrome|Chromium|Edg\/|OPR\/|Android|Firefox/.test(userAgent)
}

export function isFirefox(userAgent = ua(nav())): boolean {
  return /Firefox\//.test(userAgent) && !/Seamonkey/i.test(userAgent)
}

/** Installed web app (Home Screen / Dock / Chrome app window). */
export function isStandalone(): boolean {
  try {
    if (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) return true
  } catch {
    // Some embedded webviews throw on unknown media features.
  }
  return nav()?.standalone === true
}

/** ITP deletes script-writable storage after 7 days without a visit, except for installed web apps. */
export function safariEvictionRisk(userAgent = ua(nav()), standalone = isStandalone()): boolean {
  return isSafari(userAgent) && !standalone
}

/**
 * Private-window heuristics. true: very likely private (OPFS refuses, as in Safari private
 * windows, or the quota is far below any real disk, as in Chromium incognito). false: the
 * probes look like a normal profile. null: not enough signal to say.
 */
export async function detectPrivateMode(n: StorageNav | undefined = nav()): Promise<boolean | null> {
  const s = n?.storage
  if (!s) return null
  if (typeof s.getDirectory === 'function') {
    try {
      await s.getDirectory()
    } catch {
      return true
    }
  }
  const e = await estimate(n)
  if (!e || e.quota === null) return null
  return e.quota < PRIVATE_QUOTA_THRESHOLD
}

export interface StorageStatusReport {
  persisted: boolean | null
  privateMode: boolean | null
  usage: number | null
  quota: number | null
  safariEvictionRisk: boolean
  standalone: boolean
}

/**
 * Probe everything and publish it to useWorld().storage. Persistence is requested unless
 * `requestPersist` is false (defaults to false on Firefox, where it would prompt on load).
 */
export async function initStorageStatus(opts: { requestPersist?: boolean } = {}): Promise<StorageStatusReport> {
  const n = nav()
  const request = opts.requestPersist ?? !isFirefox(ua(n))
  const [persisted, privateMode, e] = await Promise.all([
    request ? requestPersistence(n) : isPersisted(n),
    detectPrivateMode(n),
    estimate(n),
  ])
  const standalone = isStandalone()
  const report: StorageStatusReport = {
    persisted,
    privateMode,
    usage: e?.usage ?? null,
    quota: e?.quota ?? null,
    safariEvictionRisk: safariEvictionRisk(ua(n), standalone),
    standalone,
  }
  useWorld.getState().setStorage({
    persisted: report.persisted,
    privateMode: report.privateMode,
    usage: report.usage,
    quota: report.quota,
  })
  return report
}
