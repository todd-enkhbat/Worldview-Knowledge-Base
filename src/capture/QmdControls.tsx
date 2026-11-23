import { useEffect, useRef, useState } from 'react'
import { getStore, getWorldGeneration, isRepoReady, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import { useAuth } from '../data/auth.ts'
import { useKnowledge } from '../knowledge/index.ts'
import './qmdControls.css'

interface QmdStatus { installed: boolean; version: string | null; enabled: boolean; sourceIds: string[]; followNewSources: boolean; mode: 'lexical' | 'hybrid'; phase: string; busy: boolean; error: string | null; indexedPassages: number; indexedSources: number; models: { file: string; bytes: number }[]; progress: unknown }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
async function request(method = 'GET', operation = 'status', body?: unknown): Promise<QmdStatus> {
  const response = await fetch(`/api/qmd/${operation}`, { method, credentials: 'same-origin', headers: { 'x-wv-client': 'worldview-qmd-controls', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'The local QMD service is unavailable.')
  return result as QmdStatus
}

/** Indexing is an explicit source-consent choice in the same server-backed world. */
export function QmdControls() {
  const ready = useRepoStatus((state) => state.ready), writer = useRepoStatus((state) => state.writer)
  const account = useAuth((state) => state.user?.id), sources = useKnowledge((state) => state.sources)
  const engine = ready && isRepoReady() ? getStore().info.kind : null
  const [status, setStatus] = useState<QmdStatus | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [pending, setPending] = useState(false)
  const [selected, setSelected] = useState<string[]>([]), [mode, setMode] = useState<'lexical' | 'hybrid'>('lexical'), [follow, setFollow] = useState(false), [filter, setFilter] = useState(''), [visible, setVisible] = useState(100)
  const epoch = useRef({ value: 0 })
  const available = sources.filter((source) => !source.deleted && !source.excluded && source.aiAllowed)
  const displayed = available.filter((source) => source.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
  useEffect(() => {
    const lifecycle = epoch.current, token = ++lifecycle.value
    setStatus(null); setError(''); setNotice(''); setPending(false); setSelected([]); setFollow(false)
    if (!ready || engine !== 'sqlite' || !isRepoReady()) return
    const store = getStore()
    let hydrated = false
    const load = async () => {
      const generation = getWorldGeneration()
      try {
        const result = await request()
        if (token !== lifecycle.value || !isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) return
        setStatus(result)
        if (!hydrated) { hydrated = true; setSelected(result.sourceIds); setMode(result.mode); setFollow(result.followNewSources) }
      } catch (error) { if (token === lifecycle.value && isRepoReady() && getStore() === store && getWorldGeneration() === generation) setError(message(error)) }
    }
    void load()
    const timer = setInterval(() => { void load() }, 2000)
    const stop = subscribeRepo((change) => { if (change.type === 'wipe' || change.type === 'import') { setSelected([]); setFollow(false); setStatus(null); hydrated = false; void load() } })
    return () => { if (lifecycle.value === token) lifecycle.value++; clearInterval(timer); stop() }
  }, [ready, engine, account])

  async function change(disable = false) {
    if (!isRepoReady() || getStore().info.kind !== 'sqlite') return
    const store = getStore(), generation = getWorldGeneration(), token = epoch.current.value
    setPending(true); setError(''); setNotice('')
    try {
      const permitted = new Set(available.map((source) => source.id))
      const result = await request(disable ? 'DELETE' : 'POST', 'index', disable ? undefined : { sourceIds: follow ? [] : selected.filter((id) => permitted.has(id)), mode, followNewSources: follow })
      if (token !== epoch.current.value || !isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) return
      setStatus(result); setNotice(disable ? 'Local QMD mirror and index removed. Original sources are retained.' : result.phase === 'ready' ? 'Local QMD is ready for the selected source scope.' : 'QMD is not ready yet. Check its current status before searching.')
    } catch (error) { if (token === epoch.current.value && isRepoReady() && getStore() === store && getWorldGeneration() === generation) setError(message(error)) }
    finally { if (token === epoch.current.value && isRepoReady() && getStore() === store && getWorldGeneration() === generation) setPending(false) }
  }

  return <section className="knowledge-capture-section qmd-controls" aria-labelledby="qmd-controls-title"><h2 id="qmd-controls-title">Local QMD search</h2><p>Search selected sources with local embeddings, query expansion and reranking. Original sources and citations stay authoritative. Native scores rank relevance; they do not establish evidence support.</p>
    {engine !== 'sqlite' ? <p className="qmd-controls-note">This workspace uses browser storage. Open Settings → Storage engine → Move to SQLite to use QMD with this same record.</p> : <>
      <p className="qmd-controls-state" role="status">{status ? `${status.installed ? `QMD ${status.version}` : 'Runtime not installed'} · ${status.phase} · ${status.indexedPassages} passages from ${status.indexedSources} sources · ${status.models.length} cached models` : 'Checking the local QMD service…'}</p>
      {status && !status.installed && <p className="qmd-controls-note">Run <code>node scripts/qmd-setup.ts</code> in this project, then refresh. The hybrid models require about 2.3 GB once.</p>}
      <div className="knowledge-capture-controls"><label>Retrieval mode<select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="lexical">Lexical · no model inference</option><option value="hybrid">Hybrid · local models</option></select></label><label className="qmd-controls-follow"><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />Follow all included AI-permitted sources, including new captures</label></div>
      {!follow && <details><summary>Choose QMD sources ({selected.length} selected)</summary><label className="qmd-controls-filter">Find sources for QMD<input value={filter} onChange={(event) => { setFilter(event.target.value); setVisible(100) }} placeholder="Filter source titles…" /></label><div className="qmd-controls-sources">{displayed.slice(0, visible).map((source) => <label key={source.id}><input type="checkbox" checked={selected.includes(source.id)} onChange={(event) => setSelected((old) => event.target.checked ? [...old, source.id] : old.filter((id) => id !== source.id))} />{source.title}</label>)}</div>{displayed.length > visible && <button type="button" className="knowledge-text-button" onClick={() => setVisible((count) => count + 100)}>Show more sources</button>}</details>}
      <div className="knowledge-capture-controls qmd-controls-actions"><button type="button" disabled={!writer || pending || status?.busy || !status?.installed || !follow && !selected.length} onClick={() => void change()}>{pending || status?.busy ? 'Preparing local QMD…' : 'Build QMD index'}</button>{status?.enabled && <button type="button" disabled={!writer || pending} onClick={() => void change(true)}>Disable QMD and remove its index</button>}</div>
      <p className="knowledge-capture-muted">Choose QMD in Search & ask after the index is ready. Source changes refresh this disposable index; revoked or deleted evidence is checked again before results are returned. Hybrid retrieval can return nearby ideas when the exact requested fact is absent.</p>
    </>}{notice && <p role="status">{notice}</p>}{(error || status?.error) && <p className="knowledge-error" role="alert">{error || status?.error}</p>}</section>
}
