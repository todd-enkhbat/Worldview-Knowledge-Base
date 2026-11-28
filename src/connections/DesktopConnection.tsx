import type { NativePhotoRecord } from '../places/types.ts'
import { useEffect, useState } from 'react'
import { Desktop, FolderOpen, ArrowSquareOut, DownloadSimple } from '@phosphor-icons/react'

interface DesktopInfo { version: string; workspaceName: string; workspace: string; origin: string; ownsService: boolean; cloudAi: 'off' | 'unknown'; platform: string }
declare global { interface Window { worldviewDesktop?: { info: () => Promise<DesktopInfo>; chooseWorkspace: () => Promise<{ workspaceName: string; origin: string }>; showWorkspace: () => Promise<{ ok: boolean }>; openFloatingCapture?: () => Promise<boolean>; pageZoom?: (direction: 'in' | 'out' | 'reset' | 'read') => Promise<number>
  matchContactNames?: (people: {id:string;name:string}[]) => Promise<{ids:string[];ambiguous:number}>
  readPhotoPlaces?: (input?: { offset?: number; requestAccess?: boolean; includeLabels?: boolean; snapshotToken?: string }) => Promise<{ records: NativePhotoRecord[]; snapshotToken: string; nextOffset: number | null; total: number; limited: boolean }>
  photoPlaceThumbnail?: (id: string) => Promise<string | null> } } }

export default function DesktopConnection() {
  const desktop = window.worldviewDesktop
  const macBrowser = !desktop && /Mac/.test(navigator.platform) && (navigator.maxTouchPoints ?? 0) <= 1
  const [release, setRelease] = useState<{ available: boolean; bytes: number } | null>(null)
  const [info, setInfo] = useState<DesktopInfo | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    async function load() {
      if (desktop) {
        const value = await desktop.info()
        if (active) setInfo(value)
      } else {
        const response = await fetch('/api/connections/desktop', { credentials: 'same-origin', headers: { 'x-wv-client': 'desktop-download' } })
        if (!response.ok) throw new Error()
        const value = await response.json()
        if (active) setRelease(value)
      }
    }
    void load().catch(() => {
      if (active) setError(desktop ? 'The workspace information could not be loaded.' : 'The Mac download could not be checked. Reopen Sources to try again.')
    })
    return () => { active = false }
  }, [desktop])

  async function chooseWorkspace() {
    if (!desktop) return
    setBusy(true)
    setError('')
    try { await desktop.chooseWorkspace(); setInfo(await desktop.info()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  return <section className="assistant-connections desktop-connection">
    <header><Desktop size={25} /><div>
      <h2>{desktop ? 'Your desktop workspace' : 'Worldview for Mac'}</h2>
      <p>{desktop ? 'Worldview saves your work in the folder you chose.' : 'Use your local workspace and the floating profile capture on your Mac.'}</p>
    </div></header>
    {desktop ? <>
      {info && <dl>
        <div><dt>Workspace</dt><dd>{info.workspaceName}</dd></div>
        <div><dt>Local address</dt><dd><code>{info.origin}</code></dd></div>
        <div><dt>Service</dt><dd>{info.ownsService ? 'Started by this desktop app' : 'Shared with your running local workspace'}</dd></div>
        <div><dt>Cloud AI</dt><dd>{info.cloudAi === 'off' ? 'Off' : 'Check the local service configuration'}</dd></div>
      </dl>}
      <div className="assistant-config-actions">
        <button className="knowledge-button" type="button" disabled={busy} onClick={() => void chooseWorkspace()}><FolderOpen size={16} />Open another workspace</button>
        <button className="knowledge-button" type="button" onClick={() => void desktop.showWorkspace().catch(() => setError('The workspace folder could not be opened in Finder.'))}><ArrowSquareOut size={15} />Show folder in Finder</button>
      </div>
    </> : <div className="desktop-download">
      <div className="assistant-config-actions">
        {macBrowser && <a className="knowledge-button is-primary" href="worldview-local://open"><ArrowSquareOut size={16} />Open Worldview for Mac</a>}
        {release?.available && <a className={macBrowser ? 'knowledge-button' : 'knowledge-button is-primary'} href="/api/connections/desktop/download"><DownloadSimple size={16} />Download Worldview for Mac <small>{Math.round(release.bytes / 1024 / 1024)} MB</small></a>}
      </div>
      {macBrowser && <p>You can also open the installed app with Spotlight. Press <kbd>⌘ Space</kbd> and type <strong>Worldview</strong>.</p>}
      {release?.available && <p>For a first install, unzip Worldview, move it to Applications and open it. Choose the folder containing your existing workspace. This local build is ad-hoc signed and has no Apple notarization.</p>}
      {release && !release.available && <p className="connections-notice" role="status">A Mac download is currently unavailable from this workspace.</p>}
    </div>}
    {error && <p role="alert" className="knowledge-error">{error}</p>}
  </section>
}
