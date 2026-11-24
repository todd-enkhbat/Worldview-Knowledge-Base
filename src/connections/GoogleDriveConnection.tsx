import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowSquareOut, ArrowsClockwise, Check, Cloud, DownloadSimple, FileText, FolderOpen, LinkSimple, PlugsConnected, ShieldCheck, UploadSimple } from '@phosphor-icons/react'
import { getStore, getWorldGeneration, isRepoReady, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import { refreshKnowledge } from '../knowledge/index.ts'
import { useWriting } from '../writing/store.ts'
import { exportWritingDocument } from '../writing/export.ts'
import { driveBase64, driveMessage as message, driveRequest as request, loadGooglePicker, type DriveStatus, type DriveTarget, type DriveFile } from './googleDriveClient.ts'
import './googleDrive.css'

export function GoogleDriveConnection() {
  const ready = useRepoStatus((state) => state.ready), writer = useRepoStatus((state) => state.writer), docs = useWriting((state) => state.docs)
  const local = ready && isRepoReady() && getStore().info.kind === 'sqlite'
  const [status, setStatus] = useState<DriveStatus | null>(null), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [epoch, setEpoch] = useState(0)
  const [client, setClient] = useState<Record<string, unknown> | null>(null), [clientName, setClientName] = useState(''), [pickerKey, setPickerKey] = useState(''), [appId, setAppId] = useState(''), [authorizationUrl, setAuthorizationUrl] = useState('')
  const [files, setFiles] = useState<DriveFile[]>([]), [query, setQuery] = useState(''), [nextPage, setNextPage] = useState<string | null>(null), [target, setTarget] = useState<DriveTarget | null>(null), [documentId, setDocumentId] = useState(''), [native, setNative] = useState(true), [replace, setReplace] = useState(false), [result, setResult] = useState<{ sourceId?: string; file?: DriveFile } | null>(null)
  const alive = useRef(true), statusRequest = useRef(0), pendingAuthorization = useRef<number | null>(null), handledSelection = useRef('')
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const refresh = useCallback(async () => {
    const store = isRepoReady() ? getStore() : null, generation = getWorldGeneration(), requestId = ++statusRequest.current
    const value = await request<DriveStatus>()
    if (alive.current && requestId === statusRequest.current && isRepoReady() && getStore() === store && getWorldGeneration() === generation) {
      setStatus(value)
      if (pendingAuthorization.current !== null && (value.authorizationRevision ?? value.connectionRevision) !== pendingAuthorization.current) {
        pendingAuthorization.current = null; setAuthorizationUrl('')
        if (value.authorizationResult === 'cancelled') setNotice('Google file selection was cancelled. You can try again.')
      }
    }
  }, [])
  useEffect(() => subscribeRepo((change) => { if (change.type === 'wipe' || change.type === 'import') { statusRequest.current++; pendingAuthorization.current = null; handledSelection.current = ''; setEpoch((value) => value + 1); setStatus(null); setTarget(null); setFiles([]); setNextPage(null); setDocumentId(''); setResult(null); setReplace(false); setBusy(''); setClient(null); setClientName(''); setPickerKey(''); setAppId(''); setAuthorizationUrl(''); setQuery(''); setError(''); setNotice('') } }), [])
  useEffect(() => {
    if (!local) return
    let active = true
    void refresh().catch((cause) => { if (active) setError(message(cause)) })
    const focus = () => { void refresh().catch(() => {}) }
    window.addEventListener('focus', focus)
    return () => { active = false; window.removeEventListener('focus', focus) }
  }, [local, epoch, refresh])
  useEffect(() => { if (!authorizationUrl) return; const timer = window.setInterval(() => { if (!document.hidden) void refresh().catch(() => {}) }, 3000); return () => window.clearInterval(timer) }, [authorizationUrl, refresh])
  const run = useCallback(async (name: string, task: (assert: () => void) => Promise<void>) => {
    if (!local || !writer || busy) return
    const scope = { store: getStore(), generation: getWorldGeneration() }
    const assert = () => { if (!alive.current || !isRepoReady() || getStore() !== scope.store || getWorldGeneration() !== scope.generation) throw new Error('The workspace changed. Open the Google connection again.') }
    statusRequest.current++; setBusy(name); setError(''); setNotice('')
    try { await task(assert) } catch (cause) { try { assert(); setError(message(cause)) } catch { /* A new workspace must not inherit an earlier result. */ } }
    finally { if (alive.current && isRepoReady() && getStore() === scope.store && getWorldGeneration() === scope.generation) setBusy('') }
  }, [local, writer, busy])
  const choose = useCallback(async (id: string) => { await run('select', async (assert) => { const value = await request<DriveTarget>('inspect', 'POST', { fileId: id }); assert(); setTarget(value); setReplace(false); setResult(null) }) }, [run])
  const selectionId = status?.selection?.id, selectionFile = status?.selection?.fileIds[0]
  useEffect(() => {
    if (!status?.connected || !selectionId || !selectionFile || busy || !writer || handledSelection.current === selectionId) return
    handledSelection.current = selectionId
    void choose(selectionFile)
  }, [status?.connected, selectionId, selectionFile, busy, writer, choose])
  async function prepareAuthorization(assert: () => void, pickFiles: boolean) {
    const value = await request<{ authorizationUrl: string; connectionRevision?: number; authorizationRevision?: number }>('connect', 'POST', { pickFiles }); assert()
    const url = new URL(value.authorizationUrl)
    if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com') throw new Error('The Google sign-in link is invalid.')
    pendingAuthorization.current = value.authorizationRevision ?? value.connectionRevision ?? status?.authorizationRevision ?? status?.connectionRevision ?? -1; setAuthorizationUrl(url.href)
  }
  async function browse(more = false) { await run('files', async (assert) => {
    const value = await request<{ files: DriveFile[]; nextPageToken: string | null }>('files?' + new URLSearchParams({ q: query, ...(more && nextPage ? { pageToken: nextPage } : {}) }))
    assert(); setFiles((previous) => more ? [...new Map([...previous, ...value.files].map((file) => [file.id, file])).values()] : value.files); setNextPage(value.nextPageToken)
  }) }
  async function picker() { await run('picker', async (assert) => {
    if (status?.pickerMode === 'desktop') { await prepareAuthorization(assert, true); return }
    await loadGooglePicker(); assert()
    const credentials = await request<{ accessToken: string; developerKey: string; appId: string }>('picker', 'POST', {})
    assert()
    const api = window.google?.picker
    if (!api) throw new Error('Google Picker is unavailable. Try again.')
    const view = new api.PickerBuilder().setDeveloperKey(credentials.developerKey).setAppId(credentials.appId).setOAuthToken(credentials.accessToken).setOrigin(location.origin).addView(api.ViewId.DOCS).setCallback((data) => {
      if (data.action !== api.Action.PICKED || !data.docs?.[0]?.id) return
      try {
        assert()
        void request<DriveTarget>('inspect', 'POST', { fileId: data.docs[0].id }).then((value) => { assert(); setTarget(value); setReplace(false); setResult(null) }).catch((cause) => { try { assert(); setError(message(cause)) } catch { /* Picker belongs to an earlier workspace. */ } })
      } catch { /* Picker belongs to an earlier workspace. */ }
    }).build()
    view.setVisible(true)
  }) }
  async function keep() { if (!target) return; await run('import', async (assert) => {
    const value = await request<{ sourceId: string; extraction: string; extractionMessage?: string; unchanged?: boolean }>('import', 'POST', { fileId: target.file.id })
    assert(); await refreshKnowledge(); assert(); setResult({ sourceId: value.sourceId })
    setNotice(value.unchanged ? 'This exact Google version is already kept locally.' : value.extraction === 'complete' ? 'Original and readable text saved in your library.' : value.extractionMessage || 'Original saved locally; text extraction is unavailable for this file.')
  }) }
  async function exportToDrive(update = false) {
    const chosen = useWriting.getState().docs.find((doc) => doc.id === documentId && !doc.archivedAt)
    if (!chosen) { setError('Choose a saved writing document first.'); return }
    if (update && (!target?.updateAvailable || !replace)) return
    await run(update ? 'update' : 'export', async (assert) => {
      const exported = await exportWritingDocument(chosen, 'html'); assert()
      if (exported.blob.size > 5 * 1024 * 1024) throw new Error('Google transfer supports up to 5 MiB of formatted HTML. Keep larger originals in your verified local backup.')
      const htmlBase64 = driveBase64(new Uint8Array(await exported.blob.arrayBuffer())); assert()
      if (useWriting.getState().docs.find((doc) => doc.id === chosen.id)?.updatedAt !== chosen.updatedAt) throw new Error('This writing changed during export. Choose its latest saved version.')
      const value = await request<{ file: DriveFile }>('export', 'POST', { documentId: chosen.id, expectedUpdatedAt: chosen.updatedAt, htmlBase64, nativeDocument: native, ...(update ? { ticket: target!.ticket } : {}) })
      assert(); setResult({ file: value.file }); setTarget(null); setReplace(false); setNotice(update ? 'Selected Google file updated and verified.' : 'New Google file created and verified.')
      await refresh(); assert()
    })
  }
  const writing = docs.filter((doc) => !doc.archivedAt)
  if (!local) return <div className="google-drive-connection"><p>Google Drive connects through the local Worldview service. Open this workspace in the local app to set it up.</p></div>
  return <div className="google-drive-connection">
    <header className="google-drive-heading"><span><Cloud size={24} aria-hidden="true" /><strong>Google Drive</strong></span><span className={'google-drive-state ' + (status?.connected ? 'is-connected' : '')}>{status?.connected ? <><Check size={13} aria-hidden="true" />Connected</> : status?.configured ? 'Ready to connect' : 'Setup needed'}</span></header>
    <p>Choose what comes in. Send writing back when it is ready. This connection uses Google’s selected-file permission and does not enable cloud AI.</p>
    {error && <p className="knowledge-error" role="alert">{error}</p>}{notice && <p className="google-drive-notice" role="status">{notice}</p>}
    {result?.sourceId && <a className="knowledge-button" href={'#/library?source=' + encodeURIComponent(result.sourceId)}><FileText size={15} />Open local copy</a>}
    {result?.file?.webViewLink && <a className="knowledge-button" href={result.file.webViewLink} target="_blank" rel="noreferrer noopener"><ArrowSquareOut size={15} />Open {result.file.name} in Google</a>}
    {!status?.connected && <div className="google-drive-connect"><div><PlugsConnected size={21} aria-hidden="true" /><span><strong>{status?.configured ? 'Connect your Google account' : 'Give this app its own Google connection'}</strong><small>{status?.configured ? 'Google will ask which files this app may use.' : 'Google gives you a small connection file. You only need to set it up once. Existing ChatGPT or Codex connections are separate.'}</small></span></div>
      {status?.configured && <button type="button" className="knowledge-button is-primary" disabled={!writer || !!busy} onClick={() => void run('connect', async (assert) => { await prepareAuthorization(assert, status.pickerMode === 'desktop') })}>{busy === 'connect' ? 'Preparing…' : 'Connect Google Drive'}</button>}
    </div>}
    {authorizationUrl && <div className="google-drive-connect"><p>Continue in your browser, finish Google’s permission steps, then return here. Nothing is imported until you choose to keep a local copy.</p><a className="knowledge-button is-primary" href={authorizationUrl} target="_blank" rel="noreferrer noopener">Continue to Google <ArrowSquareOut size={14} /></a></div>}
    <details className="google-drive-setup" open={status?.configured === false}><summary>Google connection setup</summary>
      <ol><li><a href="https://console.cloud.google.com/auth/overview/personal" target="_blank" rel="noreferrer noopener">Open Google’s personal setup <ArrowSquareOut size={12} /></a> with the account you want to use. Choose <strong>Desktop app</strong>, review Google’s terms yourself, continue, then choose <strong>Download JSON</strong>. Leave the AI-agent option off.</li><li>In that same project, open <strong>APIs &amp; Services → Library</strong> and enable <strong>Google Drive API</strong> and <strong>Google Picker API</strong>.</li><li>Choose the downloaded file below, select <strong>Save Google client</strong>, then <strong>Connect Google Drive</strong>. Desktop setup needs no API key or project number.</li></ol>
      <p className="google-drive-hint">Personal setup works only with the Google account that creates it. Google may ask you to sign in or accept its terms; those steps are yours to complete.</p>
      <form onSubmit={(event) => { event.preventDefault(); if (!client) return; void run('configure', async (assert) => { const value = await request<DriveStatus>('configure', 'POST', { oauthClient: client, ...(pickerKey ? { pickerKey } : {}), ...(appId ? { appId } : {}) }); assert(); statusRequest.current++; setStatus(value); setClient(null); setClientName(''); setPickerKey(''); setAppId(''); setTarget(null); setFiles([]); setNotice('Google client saved privately on this device. Connect your account next.') }) }}>
        <label>Connection file from Google (.json)<input type="file" accept="application/json,.json" disabled={!writer || !!busy} onChange={(event) => {
          const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
          const scope = { store: getStore(), generation: getWorldGeneration() }
          if (file.size > 65536) { setError('Choose an OAuth JSON file under 64 KiB.'); return }
          void file.text().then((text) => { if (!alive.current || !isRepoReady() || getStore() !== scope.store || getWorldGeneration() !== scope.generation) return; const value: unknown = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose the JSON downloaded from Google Cloud.'); setClient(value as Record<string, unknown>); setClientName(file.name) }).catch((cause) => { if (alive.current && isRepoReady() && getStore() === scope.store && getWorldGeneration() === scope.generation) setError(message(cause)) })
        }} /></label>
        {clientName && <small>{clientName} selected. Its secret stays in the local service.</small>}
        <details><summary>Advanced: web app connection</summary><p>A web client needs its local callback registered. Its embedded picker also needs an API key restricted to Google Picker API and website referrers for this local origin and https://docs.google.com/*. <a href="https://developers.google.com/workspace/drive/api/quickstart/nodejs" target="_blank" rel="noreferrer noopener">Standard setup guide</a></p><div className="google-drive-setup-grid"><label>Web Picker API key<input type="password" value={pickerKey} onChange={(event) => setPickerKey(event.target.value)} autoComplete="off" maxLength={1000} /></label><label>Google Cloud project number<input value={appId} onChange={(event) => setAppId(event.target.value)} inputMode="numeric" autoComplete="off" maxLength={30} placeholder="123456789012" /></label></div></details>
        <button type="submit" className="knowledge-button" disabled={!writer || !!busy || !client}>{busy === 'configure' ? 'Saving…' : 'Save Google client'}</button>
      </form>
    </details>
    {status?.connected && <>
      <section className="google-drive-files"><header><div><h3>Files you choose</h3><p>Only files opened with this app or created by it are available. Your whole Drive is not scanned.</p></div>{status.pickerConfigured && <button type="button" className="knowledge-button" disabled={!writer || !!busy} onClick={() => void picker()}><FolderOpen size={15} />Choose in Google</button>}</header>
        {status.pickerMode === 'desktop' && <p className="google-drive-hint">File selection opens in your browser with Google. No extra API key is needed.</p>}
        {!status.pickerConfigured && <p className="google-drive-hint">Add web Picker details in advanced setup to choose existing Google files. You can already create files from your writing below.</p>}
        <form className="google-drive-search" onSubmit={(event) => { event.preventDefault(); void browse() }}><label className="knowledge-sr-only" htmlFor="drive-query">Find authorized Google files</label><input id="drive-query" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={200} placeholder="Find files available to this app…" autoComplete="off" /><button type="submit" className="knowledge-button" disabled={!writer || !!busy}><ArrowsClockwise size={14} />{busy === 'files' ? 'Finding…' : 'Find files'}</button></form>
        <div className="google-drive-file-list">{files.map((file) => <button type="button" key={file.id} className={target?.file.id === file.id ? 'is-selected' : ''} disabled={!!busy} aria-pressed={target?.file.id === file.id} onClick={() => void choose(file.id)}><FileText size={18} aria-hidden="true" /><span><strong>{file.name}</strong><small>{file.mimeType === 'application/vnd.google-apps.document' ? 'Google document' : file.mimeType} · revision {file.version}</small></span><LinkSimple size={14} aria-hidden="true" /></button>)}</div>
        {nextPage && <button type="button" className="knowledge-button" disabled={!!busy} onClick={() => void browse(true)}>More files</button>}
        {target && <div className="google-drive-selected"><span>Selected Google file</span><h4>{target.file.name}</h4><small>Revision {target.file.version}{target.file.modifiedTime ? ' · ' + new Date(target.file.modifiedTime).toLocaleString() : ''}</small><div><button type="button" className="knowledge-button" disabled={!writer || !!busy || target.file.capabilities?.canDownload === false} onClick={() => void keep()}><DownloadSimple size={15} />{busy === 'import' ? 'Keeping original…' : 'Keep a local copy'}</button>{target.file.webViewLink && <a href={target.file.webViewLink} target="_blank" rel="noreferrer noopener">Open in Google <ArrowSquareOut size={12} /></a>}</div></div>}
      </section>
      <section className="google-drive-writing"><h3>Send writing to Google</h3><p>Choose a saved draft. Google Docs conversion may change page design or unsupported media; the original designed document stays here.</p>
        <label>Saved writing<select aria-label="Writing to send to Google" value={documentId} onChange={(event) => { setDocumentId(event.target.value); setReplace(false) }}><option value="">Choose a document</option>{writing.map((doc) => <option key={doc.id} value={doc.id}>{doc.title || 'Untitled writing'}</option>)}</select></label>
        <label className="google-drive-checkbox"><input type="checkbox" checked={native} onChange={(event) => setNative(event.target.checked)} /><span>Create a native Google document<small>Turn off to keep a formatted HTML file in Drive.</small></span></label>
        <button type="button" className="knowledge-button is-primary" disabled={!writer || !!busy || !documentId} onClick={() => void exportToDrive()}><UploadSimple size={15} />{busy === 'export' ? 'Creating…' : 'Create a new Google copy'}</button>
        {target && <div className="google-drive-update"><strong>Update the selected file</strong>{target.updateAvailable ? <><p>This replaces the full contents of <b>{target.file.name}</b> at revision {target.file.version}. A changed Google revision stops the update.</p><label className="google-drive-checkbox"><input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} /><span>Replace this selected file with the saved writing above.</span></label><button type="button" className="knowledge-button" disabled={!writer || !!busy || !documentId || !replace} onClick={() => void exportToDrive(true)}>{busy === 'update' ? 'Updating…' : 'Update selected Google file'}</button></> : <p>This file has no usable revision guard or cannot accept a writing replacement. Create a new Google copy instead.</p>}</div>}
      </section>
      <footer className="google-drive-footer"><span><ShieldCheck size={15} />Selected-file permission · private local credentials · no background sync</span><button type="button" className="knowledge-text-button" disabled={!writer || !!busy} onClick={() => void run('disconnect', async (assert) => { await request('disconnect', 'POST', {}); assert(); setFiles([]); setTarget(null); setResult(null); setAuthorizationUrl(''); await refresh(); assert(); setNotice('Disconnected locally. Retained copies stay in your library.') })}>Disconnect Google Drive</button></footer>
    </>}
  </div>
}
export default GoogleDriveConnection
