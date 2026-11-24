export interface DriveStatus { available: boolean; configured: boolean; connected: boolean; pickerConfigured: boolean; connectedAt: number | null; connectionRevision?: number; authorizationRevision?: number; authorizationResult?: 'connected' | 'cancelled' | null; pickerMode?: 'desktop' | 'web'; selection?: { id: string; fileIds: string[] } }
export interface DriveFile { id: string; name: string; mimeType: string; version: string; modifiedTime?: string; webViewLink?: string; capabilities?: { canDownload?: boolean; canEdit?: boolean } }
export interface DriveTarget { file: DriveFile; ticket: string; updateAvailable: boolean }
interface PickerResult { action?: string; docs?: { id?: string }[] }
interface PickerBuilder { setDeveloperKey(value: string): PickerBuilder; setAppId(value: string): PickerBuilder; setOAuthToken(value: string): PickerBuilder; setOrigin(value: string): PickerBuilder; addView(value: string): PickerBuilder; setCallback(callback: (data: PickerResult) => void): PickerBuilder; build(): { setVisible(value: boolean): void } }
interface PickerApi { PickerBuilder: new () => PickerBuilder; ViewId: { DOCS: string }; Action: { PICKED: string } }
declare global { interface Window { google?: { picker?: PickerApi }; gapi?: { load(name: string, options: { callback: () => void; onerror: () => void; timeout: number; ontimeout: () => void }): void } } }
export const driveMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
export async function driveRequest<T>(action = '', method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api/connections/drive' + (action ? '/' + action : ''), { method, credentials: 'same-origin', headers: { 'x-wv-client': 'worldview-google-drive', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const value = await response.json() as { error?: string }
  if (!response.ok) throw new Error(value.error ?? 'The Google connection is unavailable.')
  return value as T
}
export function driveBase64(bytes: Uint8Array): string { const parts: string[] = []; for (let offset = 0; offset < bytes.length; offset += 32768) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768))); return btoa(parts.join('')) }
let pickerLoading: Promise<void> | null = null
export function loadGooglePicker(): Promise<void> {
  if (globalThis.crossOriginIsolated) return Promise.reject(new Error('Google Picker cannot open inside this isolated app window. Open the local app in a regular browser window without a Cross-Origin-Embedder-Policy header; creating and updating already authorized files still works here.'))
  if (window.google?.picker) return Promise.resolve()
  if (!pickerLoading) pickerLoading = new Promise<void>((resolve, reject) => {
    let script: HTMLScriptElement | null = null, settled = false
    const finish = (error?: Error) => { if (settled) return; settled = true; window.clearTimeout(timer); if (error) { script?.remove(); reject(error) } else resolve() }
    const timer = window.setTimeout(() => finish(new Error('Google Picker timed out. Check the network and try again.')), 20000)
    const load = () => { if (!window.gapi) { finish(new Error('Google Picker could not load. Check the network and try again.')); return } window.gapi.load('picker', { callback: () => finish(), onerror: () => finish(new Error('Google Picker could not load.')), timeout: 15000, ontimeout: () => finish(new Error('Google Picker timed out. Try again.')) }) }
    if (window.gapi) load()
    else { script = document.createElement('script'); script.src = 'https://apis.google.com/js/api.js'; script.async = true; script.crossOrigin = 'anonymous'; script.referrerPolicy = 'strict-origin-when-cross-origin'; script.onload = load; script.onerror = () => finish(new Error('Google Picker could not load. Check the network and try again.')); document.head.append(script) }
  }).catch((error: unknown) => { pickerLoading = null; throw error })
  return pickerLoading
}
