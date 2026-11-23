import { useMemo, useState } from 'react'
import { ArrowUpRight, ChatCircle, MagnifyingGlass, Plus, Robot } from '@phosphor-icons/react'
import { useApp, useWorld } from '../app/store.ts'
import { createNode, updateNode, useRepoStatus } from '../data/repo.ts'
import { queryTerms } from '../overlay/bm25.ts'
import { queryAgents } from '../world/agents/model.ts'
import { selectAndFly } from './shortcuts.ts'
import { ProductDialog } from './ProductDialog.tsx'
import './Agents.css'

export function Agents({ onClose }: { onClose: () => void }) {
  const nodes = useWorld((s) => s.nodes)
  const settings = useWorld((s) => s.settings)
  const writer = useRepoStatus((s) => s.writer)
  const flow = useApp((s) => s.view.flow)
  const historyStep = useApp((s) => s.clock.step)
  const agents = useMemo(() => {
    void historyStep
    return settings ? queryAgents(nodes.values(), settings) : []
  }, [nodes, settings, historyStep])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [radius, setRadius] = useState('500')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  function inspect(id: string) { selectAndFly(id); onClose() }
  function capture() { useApp.getState().togglePanel('chat', true); onClose() }
  function refresh(id: string) {
    if (!settings) return
    const checked = queryAgents(useWorld.getState().nodes.values(), settings).find((a) => a.record.id === id)
    setExpanded(id)
    if (checked) setNotice(`${checked.record.title}: ${checked.match.hits.length} ${checked.match.hits.length === 1 ? 'match' : 'matches'} checked locally just now.`)
  }
  async function toggle(id: string) {
    const record = nodes.get(id)
    if (!record?.demon) return
    setError(null); setBusy(id)
    try { await updateNode(id, { demon: { ...record.demon, active: !record.demon.active } }) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }
  async function create() {
    setError(null)
    if (!queryTerms(query).length) { setError('Give your agent a topic to look for, such as memory, research, or design.'); return }
    const distance = Number(radius)
    if (!Number.isFinite(distance) || distance <= 0) { setError('Search radius must be greater than zero.'); return }
    setBusy('new')
    try {
      const record = await createNode({
        archetype: 'demon', title: name.trim() || `${query.trim().slice(0, 80)} scout`,
        contentMd: `Local standing query: ${query.trim()}`,
        tags: ['agent'], temporalOrigin: Math.max(settings?.T0 ?? 0, Date.now()), temporalPrecision: 'minute',
        demon: { query: query.trim(), radius: distance, active: true },
      })
      setExpanded(record.id); setCreating(false); setName(''); setQuery('')
      setNotice(`${record.title} is ready. It will match your saved notes locally as your world changes.`)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }

  return <ProductDialog title="Your world has company" description="Visible companions with a clear purpose." onClose={onClose}>
    <section className="agents-guide"><span className="agents-avatar-mark" aria-hidden="true"><Robot size={27} weight="duotone" /></span><div><h3>World guide <span>Ready</span></h3><p>The small guide in your world opens these controls. Bring in a thought or file, then follow the connections it creates.</p><button type="button" className="product-button" onClick={capture}><ChatCircle size={16} />Think out loud</button></div></section>
    <div className="agents-section-heading"><div><h3>Query agents</h3><p>Local keyword searches over your saved notes.</p></div><button type="button" className="product-button primary" disabled={!writer || !!busy} onClick={() => setCreating(!creating)} aria-expanded={creating}><Plus size={15} />New agent</button></div>
    {creating && <form className="agents-create" onSubmit={(e) => { e.preventDefault(); void create() }}><label>Name <span>optional</span><input className="product-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Research scout" maxLength={180} disabled={!!busy} /></label><label>Look for<input className="product-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Topics, names, or ideas…" required disabled={!!busy} /></label><details><summary>Search area</summary><label>Radius in world units<input type="number" className="product-input" min="1" step="1" value={radius} onChange={(e) => setRadius(e.target.value)} required disabled={!!busy} /></label><p>Uses the same saved-note radius as existing queries. Open the agent’s note to change its date, location, or query later.</p></details><div><button className="product-button primary" type="submit" disabled={!writer || !!busy}>{busy === 'new' ? 'Creating…' : 'Create local agent'}</button><button className="product-button" type="button" onClick={() => setCreating(false)}>Cancel</button></div></form>}
    <div className="agents-list">{agents.length === 0 ? <p className="agents-empty">No query agents yet. Give one a topic and it can guide you between the notes that actually match.</p> : agents.map((agent) => {
      const record = agent.record
      const active = agent.active
      const matches = agent.match.hits
      const open = expanded === record.id
      return <section key={record.id} className="agents-query"><div className="agents-query-heading"><span className={`agents-avatar-mark ${active ? '' : 'is-paused'}`} aria-hidden="true"><Robot size={23} /></span><div><h3>{record.title} <span className="agents-name-suffix">agent</span></h3><p>{!active ? 'Paused' : matches.length ? 'Watching saved notes' : 'Idle · no matches yet'}{active && !flow ? ' · animation paused' : ''}</p></div><label className="agents-toggle"><input type="checkbox" checked={record.demon!.active} onChange={() => void toggle(record.id)} disabled={!writer || busy === record.id} aria-label={`Activate ${record.title} agent`} /><span>{record.demon!.active ? 'On' : 'Off'}</span></label></div><p className="agents-query-text">“{record.demon!.query || 'No query yet'}”</p><div className="agents-query-summary"><span>{matches.length} {matches.length === 1 ? 'match' : 'matches'} from {agent.match.candidates} nearby {agent.match.candidates === 1 ? 'saved note' : 'saved notes'}</span><button type="button" onClick={() => setExpanded(open ? null : record.id)} aria-expanded={open}>{open ? 'Hide notes' : 'View notes'}</button></div><div className="agents-query-actions"><button type="button" className="product-button" onClick={() => refresh(record.id)}><MagnifyingGlass size={14} />Check matches</button><button type="button" className="agents-text-button" onClick={() => inspect(record.id)}>Edit agent <ArrowUpRight size={13} /></button></div>{open && <div className="agents-matches">{matches.length ? matches.slice(0, 12).map((hit) => <button key={hit.id} type="button" onClick={() => inspect(hit.id)}><span>{nodes.get(hit.id)?.title || 'Untitled thought'}</span><ArrowUpRight size={14} /></button>) : <p>No saved notes match this query inside its radius. Add a relevant thought, change the query, or increase its search area.</p>}{matches.length > 12 && <p>{matches.length - 12} more matches. Edit the query to narrow the results.</p>}</div>}</section>
    })}</div>
    <p className="agents-boundary">These agents run local keyword matching when your saved notes change. Their routes visit matching notes visible at the selected date. They do not browse accounts, send messages, or run background AI jobs.</p>
    {!writer && <p className="product-error" role="alert">This tab is read-only. You can review matches here; create or change agents in the writing tab.</p>}
    {error && <p className="product-error" role="alert">{error}</p>}{notice && <p className="product-status" role="status">{notice}</p>}
  </ProductDialog>
}
