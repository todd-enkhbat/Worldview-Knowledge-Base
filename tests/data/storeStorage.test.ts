import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWorld } from '../../src/app/store.ts'
import {
  PRIVATE_QUOTA_THRESHOLD,
  detectPrivateMode,
  estimate,
  initStorageStatus,
  isFirefox,
  isSafari,
  isStandalone,
  requestPersistence,
  safariEvictionRisk,
} from '../../src/data/storage.ts'

const MB = 1024 * 1024
const UA = {
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  safariIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1',
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:140.0) Gecko/20100101 Firefox/140.0',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
}

describe('storage probes', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('requestPersistence: already persisted, granted, denied, missing', async () => {
    const persist = vi.fn(async () => true)
    expect(await requestPersistence({ storage: { persisted: async () => true, persist } })).toBe(true)
    expect(persist).not.toHaveBeenCalled()
    expect(await requestPersistence({ storage: { persisted: async () => false, persist } })).toBe(true)
    expect(await requestPersistence({ storage: { persisted: async () => false, persist: async () => false } })).toBe(false)
    expect(await requestPersistence({ storage: { persisted: async () => Promise.reject(new Error('x')) } })).toBeNull()
    expect(await requestPersistence({})).toBeNull()
    expect(await requestPersistence(undefined)).toBeNull()
  })

  it('estimate', async () => {
    expect(await estimate({ storage: { estimate: async () => ({ usage: 5, quota: 10 }) } })).toEqual({ usage: 5, quota: 10 })
    expect(await estimate({ storage: { estimate: async () => ({}) } })).toEqual({ usage: null, quota: null })
    expect(await estimate({})).toBeNull()
  })

  it('detectPrivateMode heuristics', async () => {
    const big = async () => ({ usage: 0, quota: 50_000 * MB })
    const getDirectory = async () => ({}) as FileSystemDirectoryHandle
    // Safari / Firefox private: OPFS refuses.
    expect(await detectPrivateMode({ storage: { getDirectory: () => Promise.reject(new DOMException('', 'SecurityError')), estimate: big } })).toBe(true)
    // Chromium incognito: tiny quota.
    expect(await detectPrivateMode({ storage: { getDirectory, estimate: async () => ({ quota: 100 * MB }) } })).toBe(true)
    expect(await detectPrivateMode({ storage: { getDirectory, estimate: async () => ({ quota: PRIVATE_QUOTA_THRESHOLD }) } })).toBe(false)
    expect(await detectPrivateMode({ storage: { getDirectory, estimate: big } })).toBe(false)
    // Not enough signal.
    expect(await detectPrivateMode({ storage: { getDirectory } })).toBeNull()
    expect(await detectPrivateMode({})).toBeNull()
  })

  it('browser detection for the Safari 7-day eviction warning', () => {
    expect(isSafari(UA.safariMac)).toBe(true)
    expect(isSafari(UA.safariIos)).toBe(true)
    expect(isSafari(UA.chromeIos)).toBe(true) // WebKit on iOS: ITP applies
    expect(isSafari(UA.chrome)).toBe(false)
    expect(isSafari(UA.edge)).toBe(false)
    expect(isSafari(UA.firefox)).toBe(false)
    expect(isSafari(UA.android)).toBe(false)
    expect(isFirefox(UA.firefox)).toBe(true)
    expect(isFirefox(UA.chrome)).toBe(false)
    expect(safariEvictionRisk(UA.safariMac, false)).toBe(true)
    expect(safariEvictionRisk(UA.safariMac, true)).toBe(false)
    expect(safariEvictionRisk(UA.chrome, false)).toBe(false)
  })

  it('isStandalone: display-mode media query or navigator.standalone', () => {
    expect(isStandalone()).toBe(false)
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(display-mode: standalone)' }))
    expect(isStandalone()).toBe(true)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    vi.stubGlobal('navigator', { standalone: true })
    expect(isStandalone()).toBe(true)
  })

  it('initStorageStatus publishes to useWorld().storage', async () => {
    const persist = vi.fn(async () => true)
    vi.stubGlobal('navigator', {
      userAgent: UA.safariMac,
      storage: {
        persisted: async () => false,
        persist,
        estimate: async () => ({ usage: 12 * MB, quota: 8000 * MB }),
        getDirectory: async () => ({}),
      },
    })
    const report = await initStorageStatus()
    expect(persist).toHaveBeenCalledOnce()
    expect(report).toEqual({ persisted: true, privateMode: false, usage: 12 * MB, quota: 8000 * MB, safariEvictionRisk: true, standalone: false })
    expect(useWorld.getState().storage).toMatchObject({ persisted: true, privateMode: false, usage: 12 * MB, quota: 8000 * MB })
  })

  it('initStorageStatus does not prompt on Firefox by default, and tolerates no storage API', async () => {
    const persist = vi.fn(async () => true)
    vi.stubGlobal('navigator', { userAgent: UA.firefox, storage: { persisted: async () => false, persist } })
    const r = await initStorageStatus()
    expect(persist).not.toHaveBeenCalled()
    expect(r.persisted).toBe(false)
    expect(r.privateMode).toBeNull()

    vi.stubGlobal('navigator', { userAgent: UA.chrome })
    expect(await initStorageStatus()).toMatchObject({ persisted: null, privateMode: null, usage: null, quota: null })
    expect(useWorld.getState().storage.persisted).toBeNull()
  })
})
