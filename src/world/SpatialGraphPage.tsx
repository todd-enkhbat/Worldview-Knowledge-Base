import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, CornersOut, MagnifyingGlass, Minus, Pause, Play, Plus, X } from '@phosphor-icons/react'
import { useAuth } from '../data/auth.ts'
import { getWorldGeneration, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import { initializeKnowledge } from '../knowledge/index.ts'
import { buildGraphModel, type GraphEdge, type GraphNode } from '../reading/graphModel.ts'
import { usePersonalLibrary } from '../reading/personalLibrary.ts'
import { initializeReading, useReading } from '../reading/store.ts'
import { topicHref } from '../reading/topics.ts'
import { useWorkspace } from '../workspace/state.ts'
import { passageHref } from '../writing/concepts.ts'
import { initializeWriting } from '../writing/store.ts'
import SpatialGraphCanvas, { type GraphCameraCommand } from './SpatialGraphCanvas.tsx'
import { GRAPH_DAY, graph2dHref, graphAtDate, graphEdgeColor, graphHistory, graphNodeKind, spatialGraphLayout } from './spatialGraph.ts'
import './spatialGraph.css'

const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
const dateLabel = (day: number) => dateFormat.format(day * GRAPH_DAY)
const kindNames = { topic: 'Topic', source: 'Source', writing: 'Writing' }
const PAGE_SIZE = 18
const keyActions: Record<string, GraphCameraCommand['action']> = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', '+': 'in', '=': 'in', '-': 'out', '0': 'fit',
}

function originalHref(node: GraphNode) {
  if (node.source) return `#/library?source=${encodeURIComponent(node.source.id)}`
  if (node.writingId) return `#/write?doc=${encodeURIComponent(node.writingId)}`
  return topicHref(node.endpoint?.id ?? node.key)
}

function evidenceHref(edge: GraphEdge) {
  if (edge.passage && edge.writingId) return passageHref(edge.writingId, edge.passage.id, edge.passage.part)
  return edge.writingHref
}

export default function SpatialGraphPage({ hash }: { hash: string }) {
  const initial = new URLSearchParams(hash.split('?')[1]).get('node') ?? undefined
  const returnHash = useWorkspace(state => state.returnHash)
  const ready = useRepoStatus(state => state.ready)
  const account = useAuth(state => state.user?.id)
  const { sources, nodes, writings } = usePersonalLibrary()
  const { items, topics, connections, error: readingError } = useReading()
  const [generation, setGeneration] = useState(getWorldGeneration)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [selectedKey, setSelectedKey] = useState(initial)
  const [command, setCommand] = useState<GraphCameraCommand>({ action: initial ? 'focus' : 'fit', key: initial, animate: false })
  const [date, setDate] = useState<number>()
  const [playing, setPlaying] = useState(false)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const pageTitle = useRef<HTMLHeadingElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const selectionTitle = useRef<HTMLHeadingElement>(null)
  const moveFocus = useRef(false)

  useEffect(() => { pageTitle.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const change = () => setReduced(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  useEffect(() => subscribeRepo(event => {
    if (event.type !== 'import' && event.type !== 'wipe') return
    setGeneration(getWorldGeneration())
    setSelectedKey(undefined)
    setCommand({ action: 'fit', animate: false })
    setDate(undefined)
    setPlaying(false)
    setQuery('')
  }), [])
  useEffect(() => {
    if (!ready) return
    let active = true
    setStatus('loading')
    void Promise.all([initializeKnowledge(), initializeReading(), initializeWriting()]).then(
      () => { if (active) setStatus('ready') },
      () => { if (active) setStatus('error') },
    )
    return () => { active = false }
  }, [ready, account, generation, attempt])

  const model = useMemo(() => buildGraphModel(sources, topics, items, connections, nodes, writings), [sources, topics, items, connections, nodes, writings])
  const layout = useMemo(() => spatialGraphLayout(model), [model])
  const history = useMemo(() => graphHistory(model, Date.now()), [model])
  const day = Math.max(history.start, Math.min(history.end, date ?? history.end))
  const marks = useMemo(() => {
    const span = history.end - history.start
    return span ? [...new Set(history.dates.slice(1, -1).map(day => Math.round((day - history.start) / span * 100)))].filter(value => value > 0 && value < 100) : []
  }, [history])
  const view = useMemo(() => graphAtDate(model, history, day), [model, history, day])
  const selected = selectedKey && (history.births.get(selectedKey) ?? Infinity) <= day ? model.byKey.get(selectedKey) : undefined
  const incident = useMemo(() => selected ? view.edges.filter(edge => edge.from === selected.key || edge.to === selected.key) : [], [selected, view])
  const neighbors = useMemo(() => new Set(incident.map(edge => edge.from === selected?.key ? edge.to : edge.from)), [incident, selected])
  const shownNodes = useMemo(() => new Set(view.nodes.map(node => node.key)), [view])
  const labels = useMemo(() => {
    const ranked = layout.ranked.filter(node => shownNodes.has(node.key))
    if (!selected) {
      const connected = ranked.filter(node => model.adjacent.has(node.key))
      return (connected.length ? connected : ranked).slice(0, 28)
    }
    return [selected, ...ranked.filter(node => neighbors.has(node.key)).slice(0, 27)]
  }, [layout, model, shownNodes, selected, neighbors])
  const matches = useMemo(() => {
    const terms = query.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return layout.ranked.filter(node => shownNodes.has(node.key))
    return model.nodes.filter(node => {
      const text = [node.title, ...node.source?.tags ?? []].join(' ').normalize('NFKC').toLocaleLowerCase()
      return terms.every(term => text.includes(term))
    })
  }, [layout, shownNodes, model, query])
  const opened = ready && status === 'ready' && !readingError
  const error = ready && (status === 'error' || !!readingError)
  const showList = !!query.trim() || !selected

  useEffect(() => {
    if (!playing) return
    const next = history.dates.find(value => value > day)
    const timer = window.setTimeout(() => {
      if (next === undefined) setPlaying(false)
      else setDate(next)
    }, 460)
    return () => window.clearTimeout(timer)
  }, [playing, day, history])
  useEffect(() => {
    if (!selected || !moveFocus.current) return
    moveFocus.current = false
    selectionTitle.current?.focus({ preventScroll: true })
  }, [selected])

  function choose(key: string, animate: boolean, focus = false) {
    const birth = history.births.get(key)
    if (birth === undefined) return
    setPlaying(false)
    if (birth > day) setDate(birth)
    setQuery('')
    setLimit(PAGE_SIZE)
    if (focus && selected?.key === key) selectionTitle.current?.focus({ preventScroll: true })
    else moveFocus.current = focus
    setSelectedKey(key)
    setCommand({ action: 'focus', key, animate })
    window.history.replaceState(null, '', `#/explore?${new URLSearchParams({ node: key })}`)
  }

  function overview(animate: boolean) {
    setSelectedKey(undefined)
    setCommand({ action: 'fit', animate })
    setLimit(PAGE_SIZE)
    if (location.hash.includes('?')) window.history.replaceState(null, '', '#/explore')
  }

  function handleStageKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return
    const action = keyActions[event.key]
    if (!action) return
    event.preventDefault()
    if (action === 'fit') overview(false)
    else setCommand({ action, animate: false })
  }

  return <main className="spatial-graph"
    onKeyDown={event => {
      if (event.key !== 'Escape') return
      if (query) setQuery('')
      else if (selected) overview(false)
      else return
      event.preventDefault()
      input.current?.focus()
    }}>
    <header className="spatial-header">
      <div className="spatial-header-main">
        <a className="spatial-back" href={returnHash || '#/today'}><ArrowLeft size={15} aria-hidden="true" /> Workspace</a>
        <h1 ref={pageTitle} tabIndex={-1}>Knowledge Graph</h1>
        <p className="spatial-summary">{opened ? `${model.nodes.length.toLocaleString()} nodes · ${model.edges.length.toLocaleString()} connections` : 'Explore your saved knowledge'}</p>
      </div>
      <nav className="spatial-views" aria-label="Graph views">
        <a href={graph2dHref(selected?.key)}>2D graph</a>
        <span aria-current="page">3D graph</span>
        <a href="#/explore?view=scene">World scene <ArrowUpRight size={13} aria-hidden="true" /></a>
      </nav>
    </header>

    <div className="spatial-content">
      <section className="spatial-main" aria-label="Graph and timeline">
        <div className="spatial-stage" role="group" aria-label="3D graph canvas" aria-describedby="spatial-controls-help"
          tabIndex={opened && model.nodes.length ? 0 : -1} onKeyDown={handleStageKeys}>
          {opened && model.nodes.length > 0 && <SpatialGraphCanvas nodes={view.nodes} edges={view.edges} layout={layout} labels={labels}
            selected={selected?.key} neighbors={neighbors} command={command} reduced={reduced} onSelect={choose} />}
          {!opened && <div className="spatial-stage-message" role={error ? 'alert' : 'status'}>
            <p>{error ? 'The graph couldn’t finish loading.' : 'Opening your knowledge graph…'}</p>
            {error && <button type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button>}
          </div>}
          {opened && !model.nodes.length && <div className="spatial-stage-message">
            <h2>Your graph is empty</h2><a href="#/library">Open Library <ArrowUpRight size={14} aria-hidden="true" /></a>
          </div>}
          {opened && model.nodes.length > 0 && !view.nodes.length && <p className="spatial-stage-message">No nodes at this date.</p>}
          {opened && model.nodes.length > 0 && <div className="spatial-legend" aria-label="Node colors">
            {Object.entries(kindNames).map(([kind, label]) => <span key={kind} data-kind={kind}><i aria-hidden="true" />{label}</span>)}
          </div>}
          {opened && model.nodes.length > 0 && <div className="spatial-tools" role="group" aria-label="Camera controls">
            <button type="button" title="Zoom out (−)" aria-label="Zoom out" onClick={event => setCommand({ action: 'out', animate: event.detail > 0 })}><Minus size={17} aria-hidden="true" /></button>
            <button type="button" title="Zoom in (+)" aria-label="Zoom in" onClick={event => setCommand({ action: 'in', animate: event.detail > 0 })}><Plus size={17} aria-hidden="true" /></button>
            <button type="button" title="Fit whole graph (0)" aria-label="Fit whole graph" onClick={event => overview(event.detail > 0)}><CornersOut size={17} aria-hidden="true" /></button>
          </div>}
        </div>
        <footer className="spatial-timeline">
          <div className="spatial-time-heading"><h2>Timeline</h2>
            {opened && model.nodes.length > 0 && <output>{dateLabel(day)} <span>· {view.nodes.length.toLocaleString()} nodes · {view.edges.length.toLocaleString()} connections</span></output>}
          </div>
          <div className="spatial-time-controls">
            <button type="button" disabled={!opened || history.start === history.end}
              aria-label={playing ? 'Pause timeline' : 'Play timeline'} title={playing ? 'Pause timeline' : 'Play timeline'}
              onClick={() => {
                if (!playing && day === history.end) setDate(history.start)
                setPlaying(value => !value)
              }}>{playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} weight="fill" aria-hidden="true" />}</button>
            <div className="spatial-scrubber">
              <input type="range" aria-label="Graph date" aria-valuetext={dateLabel(day)} value={day} min={history.start} max={history.end}
                disabled={!opened || history.start === history.end}
                onChange={event => { setDate(Number(event.target.value)); setPlaying(false) }} />
              {opened && marks.length > 0 && <div className="spatial-date-marks" aria-hidden="true">
                {marks.map(mark => <i key={mark} style={{ left: `${mark}%` }} />)}
              </div>}
            </div>
            <button type="button" disabled={!opened || day === history.end && !playing}
              onClick={() => { setDate(undefined); setPlaying(false) }}>All dates</button>
          </div>
          <p className="spatial-stage-help" id="spatial-controls-help">Drag or use arrow keys to rotate. Scroll or use + and − to zoom. Dates follow your saved records and links.</p>
        </footer>
      </section>

      <aside className="spatial-inspector" aria-label="Graph records and connections">
        <form role="search" className="spatial-search" onSubmit={event => {
          event.preventDefault()
          const match = matches[0]
          if (opened && query.trim() && match) choose(match.key, false, true)
        }}>
          <MagnifyingGlass size={17} aria-hidden="true" />
          <input ref={input} type="search" value={query} autoComplete="off" placeholder="Find a node…" aria-label="Find a graph node"
            onChange={event => { setQuery(event.target.value); setLimit(PAGE_SIZE) }} />
        </form>
        {opened && showList && <section className="spatial-discovery" aria-label={query.trim() ? 'Matching graph nodes' : 'Graph nodes'}>
          <div className="spatial-section-label"><h2>{query.trim() ? 'Matches' : 'Nodes'}</h2><span>{matches.length.toLocaleString()}</span></div>
          {matches.length > 0 ? <ul className="spatial-list">
            {matches.slice(0, limit).map(node => <li key={node.key}><button type="button" onClick={event => choose(node.key, event.detail > 0, true)}>
              <span className="spatial-record-dot" data-kind={graphNodeKind(node)} aria-hidden="true" />
              <span><strong>{node.title}</strong><small>{kindNames[graphNodeKind(node)]}{!shownNodes.has(node.key) ? ` · ${dateLabel(history.births.get(node.key)!)}` : ''}</small></span>
              <ArrowRight size={15} aria-hidden="true" />
            </button></li>)}
          </ul> : <p className="spatial-muted">{query.trim() ? 'No matching nodes.' : 'Nodes will appear here as you move through the timeline.'}</p>}
          {matches.length > limit && <button className="spatial-more" type="button" onClick={() => setLimit(value => value + PAGE_SIZE)}>Show more nodes</button>}
        </section>}
        {opened && !showList && selected && <section className="spatial-selection" aria-label="Selected node">
          <div className="spatial-selection-heading">
            <span className="spatial-kind" data-kind={graphNodeKind(selected)}><i aria-hidden="true" />{kindNames[graphNodeKind(selected)]}</span>
            <button type="button" aria-label="Clear selected node" title="Clear selection" onClick={event => { overview(event.detail > 0); input.current?.focus() }}><X size={16} aria-hidden="true" /></button>
          </div>
          <h2 ref={selectionTitle} tabIndex={-1}>{selected.title}</h2>
          <a className="spatial-original" href={originalHref(selected)}>Open {kindNames[graphNodeKind(selected)].toLowerCase()} <ArrowUpRight size={14} aria-hidden="true" /></a>
          <div className="spatial-section-label"><h3>Connections</h3><span>{incident.length.toLocaleString()}</span></div>
          {incident.length ? <ul className="spatial-list spatial-connections">
            {incident.slice(0, limit).map(edge => {
              const outgoing = edge.from === selected.key
              const node = model.byKey.get(outgoing ? edge.to : edge.from)!
              const evidence = evidenceHref(edge)
              const directed = edge.worldLink?.directed ?? (edge.connection && edge.connection.relation !== 'related')
              return <li key={edge.id}>
                <button type="button" onClick={event => choose(node.key, event.detail > 0, true)}>
                  <span className="spatial-relationship-dot" style={{ backgroundColor: graphEdgeColor(edge) }} aria-hidden="true" />
                  <span><strong>{node.title}</strong><small>{directed && <>{outgoing ? <ArrowUp size={10} aria-label="Outgoing" /> : <ArrowDown size={10} aria-label="Incoming" />} </>}{edge.label}</small></span>
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
                {evidence && <a className="spatial-evidence" href={evidence}>{edge.passage ? 'Open exact passage' : 'Open wiki link'} <ArrowUpRight size={12} aria-hidden="true" /></a>}
                {edge.passage && <blockquote>{edge.passage.text.slice(0, 220)}{edge.passage.text.length > 220 ? '…' : ''}</blockquote>}
              </li>
            })}
          </ul> : <p className="spatial-muted">No connections at this date.</p>}
          {incident.length > limit && <button className="spatial-more" type="button" onClick={() => setLimit(value => value + PAGE_SIZE)}>Show more connections</button>}
        </section>}
      </aside>
    </div>
  </main>
}
