// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { loadGooglePicker } from '../../src/connections/googleDriveClient.ts'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); delete window.gapi; document.querySelectorAll('script[src="https://apis.google.com/js/api.js"]').forEach((script) => script.remove()) })

it('bounds a stalled anonymous-CORS Google loader and allows a subsequent successful attempt', async () => {
  vi.useFakeTimers(); vi.stubGlobal('crossOriginIsolated', false)
  const stalled = loadGooglePicker(), failure = expect(stalled).rejects.toThrow(/timed out/)
  const script = document.querySelector<HTMLScriptElement>('script[src="https://apis.google.com/js/api.js"]')!
  expect(script.crossOrigin).toBe('anonymous')
  await vi.advanceTimersByTimeAsync(20000); await failure
  expect(document.contains(script)).toBe(false)
  window.gapi = { load: (_name, options) => options.callback() }
  await expect(loadGooglePicker()).resolves.toBeUndefined()
})
