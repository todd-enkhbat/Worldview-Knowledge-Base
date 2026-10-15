import { describe, expect, it } from 'vitest'
import { TRASH_RETENTION_MS } from '../../src/domain/constants.ts'
import { minT0 } from '../../src/domain/validate.ts'
import {
  DAY_MS,
  activeBanners,
  backupAgeLabel,
  errorSuggestsReload,
  errorText,
  formatBytes,
  formatDay,
  installHint,
  parseDateInput,
  percent,
  storageKind,
  t0Problem,
  toastRemaining,
  trashDaysLeft,
  usageFraction,
  wipeConfirmed,
} from '../../src/hud/durability.ts'
import type { BannerInput } from '../../src/hud/durability.ts'

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0)

describe('parseDateInput', () => {
  it('accepts a year, a month and a day as UTC starts', () => {
    expect(parseDateInput('1990')).toEqual({ ok: true, epochMs: Date.UTC(1990, 0, 1), precision: 'year' })
    expect(parseDateInput(' 1990-3 ')).toEqual({ ok: true, epochMs: Date.UTC(1990, 2, 1), precision: 'month' })
    expect(parseDateInput('1990-03-14')).toEqual({ ok: true, epochMs: Date.UTC(1990, 2, 14), precision: 'day' })
    expect(parseDateInput('1990/03/14')).toMatchObject({ ok: true, precision: 'day' })
    expect(parseDateInput('1990.03.14')).toMatchObject({ ok: true, precision: 'day' })
  })

  it('rejects empty, malformed and impossible dates', () => {
    expect(parseDateInput('').ok).toBe(false)
    expect(parseDateInput('90').ok).toBe(false)
    expect(parseDateInput('0999').ok).toBe(false)
    expect(parseDateInput('1990-13').ok).toBe(false)
    expect(parseDateInput('1990-00-10').ok).toBe(false)
    expect(parseDateInput('1990-02-30').ok).toBe(false)
    expect(parseDateInput('1990-02-00').ok).toBe(false)
    expect(parseDateInput('March 1990').ok).toBe(false)
  })

  it('knows leap days', () => {
    expect(parseDateInput('2000-02-29').ok).toBe(true)
    expect(parseDateInput('1900-02-29').ok).toBe(false)
  })
})

describe('t0Problem', () => {
  it('accepts a birth date in range', () => {
    expect(t0Problem(Date.UTC(1990, 2, 14), NOW)).toBeNull()
  })

  it('rejects a future start', () => {
    expect(t0Problem(NOW + DAY_MS, NOW)).toMatch(/future/)
  })

  it('rejects a span over 250 years and names the earliest date', () => {
    const msg = t0Problem(Date.UTC(1700, 0, 1), NOW)
    expect(msg).toMatch(/250 years/)
    expect(msg).toContain(formatDay(minT0(NOW)))
    expect(t0Problem(minT0(NOW) + DAY_MS, NOW)).toBeNull()
  })
})

describe('storage helpers', () => {
  it('maps fallback and persistence to a badge kind', () => {
    expect(storageKind({ fallback: true, persisted: true })).toBe('memory')
    expect(storageKind({ fallback: false, persisted: true })).toBe('persisted')
    expect(storageKind({ fallback: false, persisted: false })).toBe('best-effort')
    expect(storageKind({ fallback: false, persisted: null })).toBe('unknown')
  })

  it('formats bytes in decimal units', () => {
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1500)).toBe('1.5 kB')
    expect(formatBytes(2_400_000)).toBe('2.4 MB')
    expect(formatBytes(250_000_000_000)).toBe('250 GB')
  })

  it('computes usage fraction only when both numbers are known', () => {
    expect(usageFraction(null, 100)).toBeNull()
    expect(usageFraction(10, 0)).toBeNull()
    expect(usageFraction(25, 100)).toBe(0.25)
    expect(usageFraction(200, 100)).toBe(1)
  })
})

describe('backups and trash', () => {
  it('labels backup age', () => {
    expect(backupAgeLabel(null, NOW)).toBe('never')
    expect(backupAgeLabel(NOW - 3600_000, NOW)).toBe('today')
    expect(backupAgeLabel(NOW - DAY_MS, NOW)).toBe('1 day ago')
    expect(backupAgeLabel(NOW - 5 * DAY_MS - 1, NOW)).toBe('5 days ago')
  })

  it('counts trash days left, rounding up and never below zero', () => {
    expect(trashDaysLeft(NOW, NOW)).toBe(TRASH_RETENTION_MS / DAY_MS)
    expect(trashDaysLeft(NOW - DAY_MS / 2, NOW)).toBe(30)
    expect(trashDaysLeft(NOW - 29.5 * DAY_MS, NOW)).toBe(1)
    expect(trashDaysLeft(NOW - 31 * DAY_MS, NOW)).toBe(0)
  })

  it('requires the exact wipe phrase', () => {
    expect(wipeConfirmed('wipe world')).toBe(true)
    expect(wipeConfirmed('  WIPE World ')).toBe(true)
    expect(wipeConfirmed('wipe')).toBe(false)
    expect(wipeConfirmed('wipe  world')).toBe(false)
  })
})

describe('activeBanners', () => {
  const base: BannerInput = {
    ready: true,
    fallback: false,
    writer: true,
    error: null,
    interruptedImport: false,
    backupError: null,
    needsRegrant: false,
    nag: false,
    nagDismissed: false,
    firstRunDone: true,
  }

  it('shows nothing for a healthy writer', () => {
    expect(activeBanners(base)).toEqual([])
  })

  it('lets the memory fallback replace its own error message', () => {
    expect(activeBanners({ ...base, fallback: true, error: 'Browser storage is unavailable', nag: true })).toEqual(['memory'])
  })

  it('lets an interrupted import replace its own error message', () => {
    expect(activeBanners({ ...base, interruptedImport: true, error: 'An import was interrupted' })).toEqual(['interrupted-import'])
  })

  it('shows a reload error instead of read-only after a version change', () => {
    expect(activeBanners({ ...base, writer: false, error: 'The app was updated in another tab. Reload this tab.' })).toEqual(['error'])
    expect(activeBanners({ ...base, writer: false })).toEqual(['read-only'])
  })

  it('shows an open error before the repo is ready, and nothing else', () => {
    expect(activeBanners({ ...base, ready: false, writer: false, error: 'newer version', nag: true })).toEqual(['error'])
    expect(activeBanners({ ...base, ready: false, writer: false })).toEqual([])
  })

  it('shows backup problems and the nag to the writer only', () => {
    const all = { ...base, backupError: 'disk full', needsRegrant: true, nag: true }
    expect(activeBanners(all)).toEqual(['backup-error', 'backup-regrant', 'backup-nag'])
    expect(activeBanners({ ...all, writer: false })).toEqual(['read-only'])
  })

  it('hides the nag when dismissed or before the first run', () => {
    expect(activeBanners({ ...base, nag: true, nagDismissed: true })).toEqual([])
    expect(activeBanners({ ...base, nag: true, firstRunDone: false })).toEqual([])
  })

  it('recognises errors only a reload fixes', () => {
    expect(errorSuggestsReload('The browser closed the database. Reload this tab.')).toBe(true)
    expect(errorSuggestsReload('Disk full')).toBe(false)
  })
})

describe('installHint', () => {
  const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
  const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:140.0) Gecko/20100101 Firefox/140.0'

  it('picks the install route per browser', () => {
    expect(installHint(CHROME_MAC, true, true)).toBe('installed')
    expect(installHint(CHROME_MAC, false, true)).toBe('prompt')
    expect(installHint(CHROME_MAC, false, false)).toBe('chromium')
    expect(installHint(SAFARI_MAC, false, false)).toBe('safari-mac')
    expect(installHint(IPHONE, false, false)).toBe('ios')
    expect(installHint(FIREFOX, false, false)).toBe('none')
  })
})

describe('misc', () => {
  it('words errors for people', () => {
    expect(errorText(new Error('Disk full'))).toBe('Disk full')
    expect(errorText(new DOMException('x', 'AbortError'))).toBe('Cancelled.')
    expect(errorText('plain')).toBe('plain')
    expect(errorText(42)).toBe('Something went wrong.')
  })

  it('clamps toast time and progress', () => {
    expect(toastRemaining(NOW + 500, NOW)).toBe(500)
    expect(toastRemaining(NOW - 500, NOW)).toBe(0)
    expect(percent(5, 10)).toBe(50)
    expect(percent(5, 0)).toBeNull()
    expect(percent(20, 10)).toBe(100)
  })
})
