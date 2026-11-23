import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { getWorldGeneration, useRepoStatus } from '../data/repo.ts'
import { useKnowledge } from '../knowledge/index.ts'
import { useTranscriber } from '../ai/transcribe.ts'
import { captureVoiceOriginal, initializeVoiceInbox, setVoicePolicy, transcribeVoice, useVoiceInbox, voiceExternalId, voiceOriginal } from './voiceInbox.ts'
import type { Authorship } from '../knowledge/types.ts'
import './knowledgeCapture.css'

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
export function downloadKnowledgeFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Merely capturing never starts Whisper or requests microphone access. */
export function SourcesVoiceInbox() {
  const writer = useRepoStatus((state) => state.writer)
  const entries = useVoiceInbox((state) => state.entries)
  const sources = useKnowledge((state) => state.sources)
  const transcriber = useTranscriber()
  const [language, setLanguage] = useState('')
  const [attribution, setAttribution] = useState<Authorship>('unknown')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [recording, setRecording] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const media = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; void initializeVoiceInbox().catch((failure) => setError(message(failure))); const timer = window.setInterval(() => { if (useVoiceInbox.getState().entries.some((entry) => entry.status === 'transcribing' && entry.processor === 'telegram-server' && (entry.processingUntil ?? 0) <= Date.now())) void initializeVoiceInbox().catch((failure) => { if (mounted.current) setError(message(failure)) }) }, 15_000); return () => { clearInterval(timer); mounted.current = false; if (recorder.current?.state === 'recording' || recorder.current?.state === 'paused') recorder.current.stop(); media.current?.getTracks().forEach((track) => track.stop()) } }, [writer])

  async function capture(file: Blob, name?: string) {
    setBusy('capture'); setError('')
    try { const entry = await captureVoiceOriginal(file, { name, language, attribution }); if (mounted.current) setNotice(`Original saved: ${entry.name}. Transcribe when you are ready.`) }
    catch (failure) { if (mounted.current) setError(message(failure)) }
    finally { if (mounted.current) setBusy(null) }
  }
  async function files(event: ChangeEvent<HTMLInputElement>) {
    const chosen = [...event.target.files ?? []]; event.target.value = ''
    for (const file of chosen) await capture(file, file.name)
  }
  async function record() {
    setError(''); setBusy('microphone')
    try {
      media.current = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!mounted.current) { media.current.getTracks().forEach((track) => track.stop()); media.current = null; return }
      chunks.current = []
      const next = new MediaRecorder(media.current); recorder.current = next
      next.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data) }
      next.onstop = () => {
        media.current?.getTracks().forEach((track) => track.stop()); media.current = null
        if (!mounted.current) return
        setRecording(false)
        const blob = new Blob(chunks.current, { type: next.mimeType || 'audio/webm' })
        chunks.current = []
        void capture(blob, `Voice ${new Date().toISOString().replaceAll(':', '-')}.webm`)
      }
      next.start(1000); setRecording(true)
    } catch (failure) { media.current?.getTracks().forEach((track) => track.stop()); if (mounted.current) setError(message(failure)) }
    finally { if (mounted.current) setBusy(null) }
  }
  async function run(id: string) {
    setBusy(id); setError('')
    try { await transcribeVoice(id); if (mounted.current) setNotice('Transcript saved with timed evidence. Open it in the library.') }
    catch (failure) { if (mounted.current) setError(message(failure)) }
    finally { if (mounted.current) setBusy(null) }
  }
  return <section className="knowledge-capture-section" aria-labelledby="voice-inbox-title">
    <h2 id="voice-inbox-title">Voice & media inbox</h2>
    <p>Save original audio or video first. Local transcription is a separate action; the first use downloads the Whisper model (about 80–110 MB). Originals remain available if decoding or transcription fails.</p>
    <div className="knowledge-capture-controls">
      <label>Language <input value={language} maxLength={32} onChange={(event) => setLanguage(event.target.value)} placeholder="Auto, or en, es…" /></label>
      <label>Speaker attribution <select value={attribution} onChange={(event) => setAttribution(event.target.value as Authorship)}><option value="unknown">Unknown speaker</option><option value="human">My own voice</option><option value="third-party">Another person</option></select></label>
      <input ref={input} type="file" accept="audio/*,video/*" multiple hidden onChange={(event) => void files(event)} />
      <button type="button" disabled={!writer || !!busy || recording} onClick={() => input.current?.click()}>Save audio/video file</button>
      {typeof MediaRecorder !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function' && <button type="button" disabled={!writer || !!busy} onClick={() => recording ? recorder.current?.stop() : void record()}>{recording ? 'Stop and save recording' : 'Record voice'}</button>}
    </div>
    <p className="knowledge-capture-muted">Up to 128 MiB per file. Browser codec support varies. Speaker attribution is your declaration, separate from the transcription model.</p>
    {recording && <p role="status">Recording has not been saved yet. Stop recording to retain the original.</p>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    {(transcriber.phase === 'loading-model' || transcriber.phase === 'busy') && <p role="status">{transcriber.phase === 'loading-model' ? `Downloading local speech model · ${Math.round(transcriber.download * 100)}%` : 'Transcribing locally…'}</p>}
    {!entries.length ? <p>No voice originals saved.</p> : <ul className="knowledge-capture-list">{entries.map((entry) => {
      const source = sources.find((item) => item.id === entry.sourceId || item.externalId === voiceExternalId(entry))
      const allowed = entry.aiAllowed && (!source || !source.excluded && !source.deleted && source.aiAllowed)
      return <li key={entry.id}><div><strong>{entry.name}</strong><span>{entry.status} · {Math.ceil(entry.bytes / 1024)} KiB · {entry.language || 'automatic language'} · {entry.attribution}</span>{entry.error && <p role="status">{entry.error}</p>}</div>
        <div className="knowledge-capture-controls"><button type="button" disabled={!!busy} onClick={() => void voiceOriginal(entry.id).then(({ blob, name }) => downloadKnowledgeFile(blob, name)).catch((failure) => setError(message(failure)))}>Original</button>
          <label><input type="checkbox" checked={entry.aiAllowed} disabled={!writer} onChange={(event) => void setVoicePolicy(entry.id, event.target.checked).catch((failure) => setError(message(failure)))} /> Allow local transcription</label>
          <button type="button" disabled={!writer || !!busy || !allowed || entry.status === 'transcribing' || entry.status === 'ready'} onClick={() => void run(entry.id)}>{entry.status === 'failed' ? 'Retry transcription' : entry.status === 'ready' ? 'Transcript saved' : 'Transcribe locally'}</button>
          {source && !source.excluded && !source.deleted && <a href={`#/library?source=${encodeURIComponent(source.id)}`}>Read transcript</a>}
        </div></li>
    })}</ul>}
  </section>
}

/** Citation playback is an explicit local read of the retained original. */
export function VoiceEvidencePlayer({ sourceId, passageId }: { sourceId: string; passageId?: string | null }) {
  const entries = useVoiceInbox((state) => state.entries)
  const versions = useKnowledge((state) => state.versions)
  const passages = useKnowledge((state) => state.passages)
  const [url, setUrl] = useState(''), [error, setError] = useState('')
  const currentUrl = useRef('')
  const pendingView = useRef(0)
  useEffect(() => { void initializeVoiceInbox().catch((failure) => setError(message(failure))) }, [])
  useEffect(() => {
    const view = ++pendingView.current
    if (currentUrl.current) URL.revokeObjectURL(currentUrl.current)
    currentUrl.current = ''; setUrl(''); setError('')
    return () => { pendingView.current = view + 1; if (currentUrl.current) URL.revokeObjectURL(currentUrl.current); currentUrl.current = '' }
  }, [sourceId])
  const entry = entries.find((item) => item.sourceId === sourceId)
  if (!entry) return null
  const passage = passages.find((item) => item.id === passageId)
  const version = versions.find((item) => item.id === passage?.versionId)
  const chunk = Array.isArray(version?.metadata?.audioChunks) ? (version.metadata.audioChunks as { start: number }[])[Number(passage?.messageId?.split(':').at(-1))] : undefined
  const loaded = (media: HTMLMediaElement) => { if (chunk && Number.isFinite(chunk.start)) media.currentTime = chunk.start }
  const loadOriginal = () => {
    const view = pendingView.current, generation = getWorldGeneration()
    void voiceOriginal(entry.id).then(({ blob }) => {
      if (view !== pendingView.current || generation !== getWorldGeneration()) return
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current)
      currentUrl.current = URL.createObjectURL(blob); setUrl(currentUrl.current)
    }).catch((failure) => { if (view === pendingView.current && generation === getWorldGeneration()) setError(message(failure)) })
  }
  return <div className="knowledge-evidence-player"><button type="button" onClick={loadOriginal}>Load original {entry.mime.startsWith('video/') ? 'video' : 'audio'}{chunk ? ' at cited time' : ''}</button>{error && <p role="alert">{error}</p>}{url && (entry.mime.startsWith('video/') ? <video controls src={url} onLoadedMetadata={(event) => loaded(event.currentTarget)} /> : <audio controls src={url} onLoadedMetadata={(event) => loaded(event.currentTarget)} />)}</div>
}
