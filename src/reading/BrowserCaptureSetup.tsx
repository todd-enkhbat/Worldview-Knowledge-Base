import { useEffect, useState } from 'react'
import { getStore, getWorldGeneration, isRepoReady, useRepoStatus } from '../data/repo.ts'
import './browserCaptureSetup.css'

interface Client { id: string; name: string; origin: string; createdAt: number; expiresAt: number; revokedAt: number | null }
interface ConnectionRequest { id: string; origin: string; name: string; createdAt: number; expiresAt: number }
interface Status { available: boolean; clients: Client[]; requests?: ConnectionRequest[] }
async function request(method = 'GET', body?: unknown, id = '') {
  const response = await fetch(`/api/reading-capture${id ? `/${id.split('/').map(encodeURIComponent).join('/')}` : ''}`, { method, credentials: 'same-origin', headers: { 'x-wv-client': 'worldview-browser-reader', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error ?? 'The local browser capture service is unavailable.')
  return value as Status & { token?: string }
}

/** No extension is installed or enabled by visiting this setup panel. */
export function BrowserCaptureSetup() {
  const writer = useRepoStatus((state) => state.writer)
  const [status, setStatus] = useState<Status | null>(null), [extensionId, setExtensionId] = useState(''), [name, setName] = useState('My browser')
  const [token, setToken] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  useEffect(() => {
    let active = true
    const store = isRepoReady() ? getStore() : null, generation = getWorldGeneration()
    if (store?.info.kind !== 'sqlite') { setError('This workspace uses browser storage. Open Settings → Storage engine → Move to SQLite to capture articles into this same library.'); return }
    const current = () => active && isRepoReady() && getStore() === store && getWorldGeneration() === generation
    const refresh = () => { if (document.visibilityState === 'hidden') return; void request().then((value) => { if (current()) setStatus(value) }).catch((cause: unknown) => { if (current()) setError(cause instanceof Error ? cause.message : 'Browser pairing is unavailable.') }) }
    refresh()
    const timer = window.setInterval(refresh, 3000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])
  async function change(method: 'POST' | 'DELETE', id?: string) {
    if (!isRepoReady() || getStore().info.kind !== 'sqlite') { setError('Open the local SQLite workspace before pairing this browser.'); return }
    const store = getStore(), generation = getWorldGeneration(), current = () => isRepoReady() && getStore() === store && getWorldGeneration() === generation
    setBusy(true); setError(''); setToken('')
    try {
      const origin = `chrome-extension://${extensionId.trim().replace(/^chrome-extension:\/\//, '').replace(/\/$/, '')}`
      const value = await request(method, method === 'POST' ? { origin, name } : undefined, id)
      if (current()) { setStatus(value); setToken(value.token ?? ''); setNotice(method === 'POST' ? 'Pairing created. Copy its token into Worldview Reader; it is shown only here.' : 'Browser token revoked. Saved articles and highlights remain available.') }
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : 'Pairing failed.') }
    finally { if (current()) setBusy(false) }
  }
  async function download() {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/reading-capture/download', { credentials: 'same-origin', headers: { 'x-wv-client': 'worldview-browser-reader' } })
      if (!response.ok) throw new Error('The browser companion could not be downloaded. Start the local app service and try again.')
      const url = URL.createObjectURL(await response.blob()), link = document.createElement('a')
      link.href = url; link.download = 'WorldviewReader.zip'; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice('Browser companion downloaded. Extract the ZIP, then load its WorldviewReader folder as an unpacked extension.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Download failed.') }
    finally { setBusy(false) }
  }
  async function copyToken() {
    try { if (!navigator.clipboard) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(token); setNotice('Pairing token copied.') }
    catch { setError('Select the token and copy it manually.') }
  }
  async function approve(id: string) {
    if (!writer || !isRepoReady() || getStore().info.kind !== 'sqlite') return
    const store = getStore(), generation = getWorldGeneration()
    setBusy(true); setError('')
    try { const value = await request('POST', undefined, `connect/${id}/approve`); if (getStore() === store && getWorldGeneration() === generation) { setStatus(value); setNotice('Browser approved. Open the extension again to finish connecting. No token copying needed.') } }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The browser could not be approved.') }
    finally { setBusy(false) }
  }
  return <section className="browser-capture-setup" aria-labelledby="browser-capture-title"><h2 id="browser-capture-title">Browser reader</h2>
    <p>Choose an article in Dia, Chrome, or Edge, then save it with highlights and your comments. Following a chosen tab records visible reading progress locally. It does not watch your browsing history.</p>
    <div className="browser-capture-connection-status" role="status"><span className={status ? 'is-online' : ''} />{status ? `${status.clients.filter((client) => !client.revokedAt && client.expiresAt > Date.now()).length} connected browsers · local service ready` : 'Checking your local connection…'}</div>
    <button type="button" disabled={busy || !status} onClick={() => void download()}>Download browser companion</button>
    <ol className="browser-capture-steps"><li><strong>Install once.</strong> Extract the ZIP. Open <code>chrome://extensions</code> or <code>edge://extensions</code>, enable Developer mode, choose <strong>Load unpacked</strong>, and select its <strong>WorldviewReader</strong> folder.</li><li><strong>Connect.</strong> Open the extension and choose <strong>Connect to Worldview</strong>. Approve the request below, then reopen the extension. You do not need to copy IDs or tokens.</li><li><strong>Keep what matters.</strong> On an article, choose <strong>Save and follow this article</strong>. Select a passage and save it with your comment. Pending captures stay on your browser until the local workspace confirms them.</li></ol>
    {!!status?.requests?.length && <div className="browser-capture-requests"><h3>Ready to connect</h3><p>Approve only the browser where you just clicked Connect. Each connection lasts 90 days and can be revoked below.</p>{status.requests.map((entry) => <article key={entry.id}><div><strong>{entry.name}</strong><small>{entry.origin}</small><small>Request expires {new Date(entry.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</small></div><button type="button" disabled={!writer || busy} onClick={() => void approve(entry.id)}>Approve browser</button></article>)}</div>}
    <details className="browser-capture-manual"><summary>Advanced: connect with a pairing token</summary><form onSubmit={(event) => { event.preventDefault(); void change('POST') }}><label>Extension ID<input value={extensionId} onChange={(event) => setExtensionId(event.target.value)} autoComplete="off" spellCheck={false} placeholder="32 letters shown in the extension popup" required /></label><label>Browser name<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" maxLength={80} required /></label><button type="submit" disabled={!writer || busy || !status || !extensionId.trim() || !name.trim()}>{busy ? 'Saving…' : 'Create 90-day pairing'}</button></form></details>
    {token && <div className="browser-capture-token"><label>Pairing token · shown once<input readOnly type="password" value={token} autoComplete="off" onFocus={(event) => event.target.select()} /></label><button type="button" onClick={() => void copyToken()}>Copy pairing token</button><button type="button" onClick={() => setToken('')}>Hide token</button></div>}
    {status && <ul className="browser-capture-clients">{status.clients.map((client) => <li key={client.id}><div><strong>{client.name}</strong><small>{client.revokedAt ? 'Revoked' : client.expiresAt <= Date.now() ? 'Expired' : `Expires ${new Date(client.expiresAt).toLocaleDateString()}`} · {client.origin}</small></div>{!client.revokedAt && <button type="button" disabled={!writer || busy} onClick={() => void change('DELETE', client.id)}>Revoke pairing</button>}</li>)}</ul>}
    <p className="browser-capture-muted">The app must run locally at 127.0.0.1:5173. Navigation and browser restart stop following; saving highlights remains an explicit action. PDFs, protected browser pages, iframes and paywall text may be unavailable. Reading progress is an observation, not proof of comprehension.</p>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </section>
}
