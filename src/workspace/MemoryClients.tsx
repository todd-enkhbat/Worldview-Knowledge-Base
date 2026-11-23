import { useEffect, useState, type FormEvent } from 'react'
import { useKnowledge } from '../knowledge/index.ts'
import { useRepoStatus } from '../data/repo.ts'

interface Client { id: string; name: string; sourceIds: string[] | null; expiresAt: number; revokedAt: number | null }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
async function request(method = 'GET', body?: unknown, id = '') {
  const response = await fetch(`/api/memory/clients${id ? `/${encodeURIComponent(id)}` : ''}`, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-wv-client': 'workspace-memory' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'The local memory service is unavailable.')
  return result as { clients?: Client[]; client?: Client; token?: string }
}

export function MemoryClients() {
  const sources = useKnowledge((s) => s.sources)
  const writer = useRepoStatus((s) => s.writer)
  const [filter, setFilter] = useState(''), [visible, setVisible] = useState(100)
  const available = sources.filter((s) => !s.deleted && !s.excluded && s.aiAllowed && s.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
  const [clients, setClients] = useState<Client[]>([]), [name, setName] = useState(''), [selected, setSelected] = useState<string[]>([])
  const [token, setToken] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => { let active = true; void request().then((result) => { if (active) setClients(result.clients ?? []) }).catch((e) => { if (active) setError(errorText(e)) }); return () => { active = false } }, [])
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setToken('')
    try { const result = await request('POST', { name, sourceIds: selected, expiresInDays: 30 }); setToken(result.token ?? ''); setClients((await request()).clients ?? []); setName('') } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  async function revoke(id: string) { setBusy(true); setError(''); try { await request('DELETE', undefined, id); setClients((await request()).clients ?? []); setToken('') } catch (e) { setError(errorText(e)) } finally { setBusy(false) } }
  async function mirror() {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/memory/mirror', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-wv-client': 'workspace-memory' }, body: JSON.stringify({ sourceIds: selected }) })
      if (!response.ok) throw new Error((await response.json()).error ?? 'Unable to export the selected sources.')
      const url = URL.createObjectURL(await response.blob()), anchor = document.createElement('a'); anchor.href = url; anchor.download = 'Worldview-QMD-mirror.zip'; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <section className="knowledge-section knowledge-memory-clients"><h2>Shared agent memory</h2><p>Give an agent read access to selected AI-permitted sources. Each client has its own revocable token and reads the same originals, citations, and accepted knowledge pages.</p>
    <form autoComplete="off" onSubmit={(e) => void create(e)}><label>Client name<input required maxLength={100} value={name} placeholder="Research assistant" onChange={(e) => setName(e.target.value)} /></label><details><summary>Choose sources ({selected.length} selected)</summary><label>Find sources for this agent<input value={filter} onChange={(e) => { setFilter(e.target.value); setVisible(100) }} /></label><div className="knowledge-memory-scope">{available.slice(0, visible).map((s) => <label key={s.id}><input type="checkbox" checked={selected.includes(s.id)} onChange={(e) => setSelected((old) => e.target.checked ? [...old, s.id] : old.filter((id) => id !== s.id))} />{s.title}</label>)}</div>{available.length > visible && <button type="button" className="knowledge-text-button" onClick={() => setVisible((n) => n + 100)}>Show more sources</button>}</details><button className="knowledge-button" disabled={!writer || busy || !selected.length || !name.trim()}>Create 30-day read token</button></form>
    {token && <div className="knowledge-notice" role="status"><strong>Copy this token now; it is shown once.</strong><label>Memory client token<input readOnly value={token} onFocus={(e) => e.target.select()} autoComplete="off" spellCheck={false} /></label><p>MCP endpoint: <code>{location.origin}/api/mcp</code></p><p>Set this token as the client’s Bearer authorization header. For a stdio client, use the bridge described in <code>docs/MEMORY-INTEGRATION.md</code>.</p><button className="knowledge-text-button" onClick={() => setToken('')}>Hide token</button></div>}
    <p className="knowledge-search-caption">Compare optional local QMD retrieval with a disposable mirror of the same selected sources. Native QMD and its models are separate installations.</p><button type="button" className="knowledge-button" disabled={busy || !selected.length} onClick={() => void mirror()}>Export selected QMD mirror</button>
    {error && <p className="knowledge-error" role="alert">{error}</p>}
    <div className="knowledge-job-list">{clients.map((client) => <div key={client.id}><span><strong>{client.name}</strong><small>{client.revokedAt ? 'Revoked' : `Expires ${new Date(client.expiresAt).toLocaleDateString()}`} · {client.sourceIds?.length ?? 'All'} sources</small></span>{!client.revokedAt && <button className="knowledge-button" disabled={busy || !writer} onClick={() => void revoke(client.id)}>Revoke access</button>}</div>)}</div>
  </section>
}
