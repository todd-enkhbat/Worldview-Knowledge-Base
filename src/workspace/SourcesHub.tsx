import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowSquareOut, ArrowsClockwise, Browser, CaretDown, Cloud, FolderSimple, Microphone, PaperPlaneTilt, PlugsConnected, MagnifyingGlass } from '@phosphor-icons/react'
import { getStore, getWorldGeneration, isRepoReady, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import { useAuth } from '../data/auth.ts'
import { useKnowledge } from '../knowledge/index.ts'
import { AiConnection } from '../capture/AiConnection.tsx'
import { FolderCapture } from '../capture/FolderCapture.tsx'
import { PortabilityControls } from '../capture/PortabilityControls.tsx'
import { QmdControls } from '../capture/QmdControls.tsx'
import { SourcesVoiceInbox } from '../capture/SourcesVoiceInbox.tsx'
import { TelegramCaptureControls } from '../capture/TelegramCaptureControls.tsx'
import AssistantConnections from '../connections/AssistantConnections.tsx'
import DesktopConnection from '../connections/DesktopConnection.tsx'
import NotebookSources from '../connections/NotebookSources.tsx'
import GoogleDriveConnection from '../connections/GoogleDriveConnection.tsx'
import { BrowserCaptureSetup } from '../reading/BrowserCaptureSetup.tsx'
import './sourcesHub.css'

type ConnectionId = 'voice' | 'folders' | 'qmd' | 'memory' | 'export' | 'telegram' | 'cloud' | 'browser' | 'desktop' | 'drive' | 'notebooks'
type Readiness = { label: string; tone?: 'ready' | 'attention' | 'quiet' }
type Statuses = Partial<Record<ConnectionId, Readiness>>
const endpoints = {
  notebooks: '/api/connections/notebooks', voice: '/api/models/whisper/status', folders: '/api/capture/folders', qmd: '/api/qmd/status',
  memory: '/api/memory/clients', telegram: '/api/capture/telegram', cloud: '/api/ai/status',
  browser: '/api/reading-capture', drive: '/api/connections/drive', desktop: '/api/connections/desktop',
} as const

function readiness(id: keyof typeof endpoints, value: Record<string, unknown>): Readiness {
  switch (id) {
    case 'notebooks': {
      const count = Number(value.granola === true) + Number(value.wispr === true)
      return { label: count ? count + ' connected' : 'Ready to connect', tone: count ? 'ready' : 'quiet' }
    }
    case 'desktop': return { label: window.worldviewDesktop ? 'Desktop app' : value.available ? 'Ready to download' : 'Build pending', tone: value.available ? 'ready' : 'quiet' }
    case 'drive': return { label: value.connected ? 'Connected' : value.configured ? 'Ready to connect' : 'Setup needed', tone: value.connected ? 'ready' : 'quiet' }
    case 'browser': { const pairs = Array.isArray(value.clients) ? (value.clients as { revokedAt?: number | null; expiresAt?: number }[]).filter((client) => !client.revokedAt && (client.expiresAt ?? 0) > Date.now()) : []; return value.available === false ? { label: 'Local app needed', tone: 'quiet' } : { label: pairs.length ? `${pairs.length} paired` : 'Ready to pair', tone: pairs.length ? 'ready' : 'quiet' } }
    case 'voice': return value.available === true ? { label: 'Transcription ready', tone: 'ready' } : { label: value.modelReady === false ? 'Model download needed' : 'Capture available', tone: 'quiet' }
    case 'folders': {
      if (value.available !== true) return { label: 'Local service needed', tone: 'quiet' }
      const folders = Array.isArray(value.folders) ? value.folders as { paused?: boolean; error?: string; status?: string }[] : []
      if (folders.some((folder) => folder.error || !folder.paused && !['watching', 'scanning', 'deferred'].includes(folder.status ?? ''))) return { label: 'Needs attention', tone: 'attention' }
      if (folders.some((folder) => !folder.paused && folder.status === 'deferred')) return { label: 'Waiting for restore', tone: 'quiet' }
      const active = folders.filter((folder) => !folder.paused && ['watching', 'scanning'].includes(folder.status ?? '')).length
      return { label: active ? `${active} watching` : folders.length ? 'Paused' : 'Not watching', tone: active ? 'ready' : 'quiet' }
    }
    case 'qmd': return value.error ? { label: 'Needs attention', tone: 'attention' } : value.installed !== true ? { label: 'Setup needed', tone: 'quiet' } : value.enabled !== true ? { label: 'Ready to enable', tone: 'quiet' } : value.busy === true ? { label: 'Updating index', tone: 'quiet' } : value.phase === 'ready' ? { label: 'Ready locally', tone: 'ready' } : { label: 'Preparing index', tone: 'quiet' }
    case 'memory': {
      const clients = Array.isArray(value.clients) ? value.clients as { expiresAt: number; revokedAt: number | null }[] : []
      const count = clients.filter((client) => !client.revokedAt && client.expiresAt > Date.now()).length
      return { label: count ? `${count} active ${count === 1 ? 'connection' : 'connections'}` : 'No agents connected', tone: count ? 'ready' : 'quiet' }
    }
    case 'telegram': return value.lastError ? { label: 'Needs attention', tone: 'attention' } : value.configured !== true ? { label: 'Setup needed', tone: 'quiet' } : value.enabled === true ? { label: 'Capture enabled', tone: 'ready' } : { label: 'Paused', tone: 'quiet' }
    case 'cloud': return value.configured === true && (value.provider === 'openai' || value.provider === 'anthropic') ? { label: 'Configured', tone: 'ready' } : { label: value.provider ? 'Credential needed' : 'Off', tone: 'quiet' }
  }
}

function ConnectionDisclosure({ id, title, description, icon, status, requested, onClosed, children }: {
  id: ConnectionId; title: string; description: string; icon: ReactNode; status: Readiness; requested: boolean; onClosed: () => void; children: ReactNode
}) {
  const details = useRef<HTMLDetailsElement>(null), summary = useRef<HTMLElement>(null)
  const [visited, setVisited] = useState(false)
  useEffect(() => {
    if (!requested || !details.current) return
    details.current.open = true
    setVisited(true)
    summary.current?.focus()
  }, [requested])
  return <details ref={details} className="sources-hub-connection" data-connection={id} onToggle={(event) => {
    // Keep visited controls mounted: collapsing must not discard a recording or an unfinished form.
    if (event.currentTarget.open) setVisited(true)
    else if (visited) onClosed()
  }}>
    <summary ref={summary} aria-controls={`sources-${id}-panel`}>
      <span className="sources-hub-icon" aria-hidden="true">{icon}</span>
      <span className="sources-hub-copy"><strong id={`sources-${id}-title`}>{title}</strong><span>{description}</span></span>
      <span className={`sources-hub-status sources-hub-status--${status.tone ?? 'quiet'}`}>{status.label}</span>
      <CaretDown className="sources-hub-chevron" size={15} aria-hidden="true" />
    </summary>
    <div id={`sources-${id}-panel`} className="sources-hub-panel" role="region" aria-labelledby={`sources-${id}-title`}>{visited && children}</div>
  </details>
}

/** Setup stays out of routine capture; status reads never enable a connection or probe a provider. */
export function SourcesHub({ hash, importActions }: { hash?: string; importActions?: ReactNode }) {
  const ready = useRepoStatus((state) => state.ready), account = useAuth((state) => state.user?.id)
  const sourceCount = useKnowledge((state) => state.sources.filter((source) => !source.deleted && !source.excluded).length)
  const engine = ready && isRepoReady() ? getStore().info.kind : null
  const [statuses, setStatuses] = useState<Statuses>({}), [refresh, setRefresh] = useState(0), [checking, setChecking] = useState(false)
  const [observedHash, setObservedHash] = useState(() => window.location.hash)
  const locationHash = hash ?? observedHash
  const requested = new URLSearchParams(locationHash.split('?')[1] ?? '').get('connection')
  const reload = () => setRefresh((value) => value + 1)
  useEffect(() => {
    if (hash !== undefined) return
    const update = () => setObservedHash(window.location.hash)
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [hash])
  useEffect(() => subscribeRepo((change) => { if (change.type === 'wipe' || change.type === 'import') setRefresh((value) => value + 1) }), [])
  useEffect(() => {
    const controller = new AbortController(), store = isRepoReady() ? getStore() : null, generation = getWorldGeneration()
    setStatuses({})
    if (!ready || !store) { setChecking(false); return }
    setChecking(true)
    const current = () => !controller.signal.aborted && isRepoReady() && getStore() === store && getWorldGeneration() === generation
    void Promise.allSettled(Object.entries(endpoints).map(async ([key, url]) => {
      const id = key as keyof typeof endpoints
      if (engine !== 'sqlite' && id !== 'voice' && id !== 'cloud') return
      try {
        const response = await fetch(url, { credentials: 'same-origin', headers: { 'x-wv-client': 'worldview-sources-status' }, signal: controller.signal })
        if (!response.ok) throw new Error('Local service unavailable')
        const value: unknown = await response.json()
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Status unavailable')
        if (current()) setStatuses((old) => ({ ...old, [id]: readiness(id, value as Record<string, unknown>) }))
      } catch {
        if (current()) setStatuses((old) => ({ ...old, [id]: { label: id === 'voice' ? 'Capture available' : 'Status unavailable', tone: 'quiet' } }))
      }
    })).finally(() => { if (current()) setChecking(false) })
    return () => controller.abort()
  }, [ready, engine, account, refresh])
  function status(id: ConnectionId): Readiness {
    if (id === 'export') return { label: `${sourceCount} ${sourceCount === 1 ? 'source' : 'sources'}`, tone: 'quiet' }
    if (engine !== 'sqlite' && id !== 'voice' && id !== 'cloud') return { label: 'Local app needed', tone: 'quiet' }
    return statuses[id] ?? { label: checking ? 'Checking…' : 'Not checked', tone: 'quiet' }
  }
  const common = (id: ConnectionId) => ({ id, status: status(id), requested: requested === id, onClosed: reload })
  return <section className="sources-hub" aria-labelledby="sources-hub-title">
    <header className="sources-hub-heading"><div><h2 id="sources-hub-title">Connections</h2><p>Capture locally. Connect other tools when you need them.</p></div><button type="button" className="sources-hub-refresh" disabled={checking || !ready} onClick={reload} aria-label="Refresh connection status" title="Refresh connection status"><ArrowsClockwise size={17} aria-hidden="true" /></button></header>
    <div className="sources-hub-groups">
      <section className="sources-hub-group" aria-labelledby="sources-hub-local"><h3 id="sources-hub-local">Local capture</h3>
        <ConnectionDisclosure {...common('desktop')} title="Desktop workspace" description="Open a local folder as your Worldview vault" icon={<FolderSimple size={21} />}><DesktopConnection /></ConnectionDisclosure>
        <ConnectionDisclosure {...common('browser')} title="Browser reading" description="Keep articles, highlights and comments from a tab you choose" icon={<Browser size={21} />}><BrowserCaptureSetup /></ConnectionDisclosure>
        <ConnectionDisclosure {...common('voice')} title="Voice & media" description="Keep originals and transcribe on this device" icon={<Microphone size={21} />}><SourcesVoiceInbox /></ConnectionDisclosure>
        <ConnectionDisclosure {...common('folders')} title="Watched folders" description="Bring new and edited local files into your library" icon={<FolderSimple size={21} />}><FolderCapture /></ConnectionDisclosure>
      </section>
      <section className="sources-hub-group" aria-labelledby="sources-hub-memory"><h3 id="sources-hub-memory">Search & memory</h3>
        <ConnectionDisclosure {...common('notebooks')} title="Granola & Wispr Flow" description="Select meeting notes and scratchpad entries for your library" icon={<PlugsConnected size={21} />}><NotebookSources onChange={reload} /></ConnectionDisclosure>
        <ConnectionDisclosure {...common('drive')} title="Google Drive" description="Import selected files and send writing back to your Drive" icon={<Cloud size={21} />}><GoogleDriveConnection /></ConnectionDisclosure>
        <ConnectionDisclosure {...common('qmd')} title="Local search" description="Choose sources for QMD’s optional search index" icon={<MagnifyingGlass size={21} />}><QmdControls /></ConnectionDisclosure>
        <ConnectionDisclosure {...common('memory')} title="Agent access" description="Connect ChatGPT, Claude, or Cursor to chosen sources and review proposed edits" icon={<PlugsConnected size={21} />}><AssistantConnections /></ConnectionDisclosure>
      </section>
      <section className="sources-hub-group" aria-labelledby="sources-hub-portable"><h3 id="sources-hub-portable">Import & export</h3>
        {importActions && <div className="sources-hub-import"><p>Bring in files, notes or chat exports.</p><div className="sources-hub-import-actions">{importActions}</div></div>}
        <ConnectionDisclosure {...common('export')} title="Export your knowledge" description="Take readable notes, source history and maps with you" icon={<ArrowSquareOut size={21} />}><PortabilityControls /></ConnectionDisclosure>
      </section>
      <section className="sources-hub-group" aria-labelledby="sources-hub-optional"><h3 id="sources-hub-optional">Optional connections</h3>
        <ConnectionDisclosure {...common('telegram')} title="Telegram inbox" description="Send notes and media from an allowed chat" icon={<PaperPlaneTilt size={21} />}><TelegramCaptureControls /></ConnectionDisclosure>
        <ConnectionDisclosure {...common('cloud')} title="Cloud AI" description="Connect a provider for conversations with your sources" icon={<Cloud size={21} />}><AiConnection /></ConnectionDisclosure>
      </section>
    </div>
  </section>
}
