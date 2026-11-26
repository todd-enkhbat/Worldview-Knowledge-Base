import { passageHref, writingPassages, writingReferenceStructure, type WritingPassage } from '../writing/concepts.ts'
import type { WritingDocument } from '../writing/types.ts'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { ArrowLeft, ArrowRight, PencilSimple, Compass, ArrowsOut, FileText, Graph, Hash, LinkSimple, MagnifyingGlass, Minus, Plus, X, Pause, Play, PushPin, Crosshair, Path } from '@phosphor-icons/react'
import { useWorld } from '../app/store.ts'
import { usePersonalLibrary } from './personalLibrary.ts'
import { readHead, sniffImageMime } from '../data/attachments.ts'
import { getStore, getWorldGeneration, isRepoReady, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import { useKnowledge } from '../knowledge/index.ts'
import { createWritingFromSource } from '../writing/store.ts'
import { GraphPresentation, fitGraphCamera, focusGraphNeighborhood, graphCurve, graphTopology, layoutGraph, placeGraphLabels, zoomGraphCamera, type GraphCamera, type GraphFrame, type GraphPosition } from './graphMotion.ts'
import { buildTypedLinks, LINK_STYLE } from '../world/links/style.ts'
import type { NodeRecord } from '../domain/types.ts'
import type { KnowledgeSource } from '../knowledge/types.ts'
import { assignTopics, connectReading, createTopic, disconnectReading, initializeReading, updateTopic, useReading } from './store.ts'
import type { ReadingConnection, ReadingItem, ReadingTopic } from './types.ts'
import { normalizeTopicName, resolveTopics, topicHref } from './topics.ts'
import './graph.css'

type Endpoint = ReadingConnection['from']
type Node = { key: string; title: string; kind: 'source' | 'topic'; endpoint: Endpoint | null; source?: KnowledgeSource; writingId?: string; tag?: string }
type Edge = { id: string; from: string; to: string; label: string; origin: 'assigned' | 'tag' | 'manual' | 'world' | 'writing'; passage?: WritingPassage; writingId?: string; writingHref?: string; connection?: ReadingConnection; worldLink?: { recordId: string; relation: ReadingConnection['relation']; directed: boolean } }
type Model = { nodes: Node[]; byKey: Map<string, Node>; edges: Edge[]; adjacent: Map<string, Set<string>> }
type Run = <T>(task: () => Promise<T>, message: string) => Promise<T | null>
const PAGE_SIZE = 80
const EDGE_LIMIT = 400
const endpointKey = (endpoint: Endpoint) => `${endpoint.kind}:${endpoint.id}`
const fold = (text: string) => text.normalize('NFKC').toLocaleLowerCase().trim()
const relationLabel = (relation: ReadingConnection['relation']) => relation.replaceAll('-', ' ')
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const labels: ReadingConnection['relation'][] = ['related', 'supports', 'contradicts', 'builds-on']

/**
 * Interaction reference: https://obsidian.md/help/plugins/graph (filters, local depth,
 * pan/zoom) and https://obsidian.md/help/links (explicit relationships). This is original
 * SVG/CSS, with no Obsidian code or assets. Lines come only from retained source tags,
 * user-assigned topic membership, and saved manual connections; proximity is not evidence.
 */
export function buildGraphModel(sources: KnowledgeSource[], topics: ReadingTopic[], items: ReadingItem[], connections: ReadingConnection[], worldRecords: ReadonlyMap<string, NodeRecord> = new Map(), writings: WritingDocument[] = []): Model {
  const byKey = new Map<string, Node>(), edges = new Map<string, Edge>()
  const canonical = resolveTopics(sources, topics, items), names = new Map(canonical.map((topic) => [normalizeTopicName(topic.name), topic]))
  const aliases = new Map<string, string>()
  for (const topic of canonical) {
    const key = topic.readingTopicIds.length ? `topic:${topic.id}` : topic.id
    const saved = topic.readingTopicIds[0]
    byKey.set(key, { key, title: topic.name, kind: 'topic', endpoint: saved ? { kind: 'topic', id: saved } : null, ...(!saved ? { tag: topic.name } : {}) })
    for (const alias of topic.aliases) aliases.set(alias.startsWith('tag:') ? alias : `topic:${alias}`, key)
  }
  for (const source of sources.filter((entry) => !entry.excluded && !entry.deleted)) {
    const key = `source:${source.id}`
    byKey.set(key, { key, title: source.title || 'Untitled source', kind: 'source', source, endpoint: { kind: 'source', id: source.id } })
    for (const tag of source.tags) {
      const topic = names.get(normalizeTopicName(tag))
      if (!topic) continue
      const target = topic.readingTopicIds.length ? `topic:${topic.id}` : topic.id
      edges.set(`membership:${key}:${target}`, { id: `membership:${key}:${target}`, from: key, to: target, label: 'source tag', origin: 'tag' })
    }
  }
  for (const item of items) {
    const from = `source:${item.sourceId}`
    if (!byKey.has(from)) continue
    for (const topicId of item.topicIds) {
      const to = aliases.get(`topic:${topicId}`) ?? `topic:${topicId}`
      if (byKey.has(to)) edges.set(`membership:${from}:${to}`, { id: `membership:${from}:${to}`, from, to, label: edges.has(`membership:${from}:${to}`) ? 'topic · source tag' : 'assigned topic', origin: 'assigned' })
    }
  }
  for (const connection of connections) {
    const from = aliases.get(endpointKey(connection.from)) ?? endpointKey(connection.from), to = aliases.get(endpointKey(connection.to)) ?? endpointKey(connection.to)
    if (from !== to && byKey.has(from) && byKey.has(to)) edges.set(connection.id, { id: connection.id, from, to, label: relationLabel(connection.relation), origin: 'manual', connection })
  }
  const sourceForRecord = new Map(sources.filter((source) => !source.deleted && !source.excluded && source.nodeId).map((source) => [source.nodeId!, `source:${source.id}`]))
  const liveRecords = new Map([...worldRecords].filter(([id, record]) => sourceForRecord.has(id) && record.deletedAt === null && !record.corpusExcluded))
  for (const link of buildTypedLinks(liveRecords)) {
    const from = sourceForRecord.get(link.from)!, to = sourceForRecord.get(link.to)!
    if (!byKey.has(from) || !byKey.has(to)) continue
    const id = `world:${link.declaredBy}:${link.target}`, directed = LINK_STYLE[link.kind].arrow
    const relation = link.kind === 'relates' ? 'related' : link.kind === 'derives' || link.kind === 'influenced-by' ? 'builds-on' : link.kind
    edges.set(id, { id, from, to, label: link.kind === 'derives' ? 'basis for · 3D world' : link.kind === 'influenced-by' ? 'influences · 3D world' : `${LINK_STYLE[link.kind].verb} · 3D world`, origin: 'world', worldLink: { recordId: link.declaredBy, directed, relation } })
  }
  for (const doc of writings) {
    if (doc.archivedAt !== null) continue
    const published = doc.sourceId && byKey.get('source:' + doc.sourceId)
    const from = published ? published.key : 'writing:' + doc.id
    function endpoint(topicId: string) {
      const to = aliases.get(topicId) ?? aliases.get('topic:' + topicId) ?? topicId
      if (!byKey.has(to)) return
      if (published) published.writingId = doc.id
      else if (!byKey.has(from)) byKey.set(from, { key: from, title: doc.title || 'Untitled writing', kind: 'source', writingId: doc.id, endpoint: null })
      return to
    }
    for (const topicId of doc.topicIds ?? []) {
      const to = endpoint(topicId)
      if (!to) continue
      const id = `membership:${from}:${to}`
      if (!edges.has(id)) edges.set(id, { id, from, to, label:'assigned topic', origin:'assigned', writingId:doc.id })
    }
    for (const passage of writingPassages(doc.content)) {
      const to = endpoint(passage.topicId)
      if (!to) continue
      const id = 'writing:' + doc.id + ':' + passage.id + ':' + passage.part
      edges.set(id, { id, from, to, label: passage.relation === 'example' ? 'example of' : 'concept passage', origin: 'writing', passage, writingId: doc.id })
    }
    for (const { node, at } of writingReferenceStructure(doc.content).atoms) {
      if (node.type !== 'writingTopicLink' || typeof node.attrs?.topicId !== 'string') continue
      const to = endpoint(node.attrs.topicId)
      if (!to) continue
      const id = 'wiki:' + doc.id + ':' + at
      edges.set(id, { id, from, to, label:'wiki link', origin:'writing', writingId:doc.id, writingHref:'#/write?doc=' + encodeURIComponent(doc.id) + '&atom=' + at + '&topic=' + encodeURIComponent(node.attrs.topicId) })
    }
  }
  const adjacent = new Map<string, Set<string>>()
  for (const edge of edges.values()) {
    if (!adjacent.has(edge.from)) adjacent.set(edge.from, new Set())
    if (!adjacent.has(edge.to)) adjacent.set(edge.to, new Set())
    adjacent.get(edge.from)!.add(edge.to); adjacent.get(edge.to)!.add(edge.from)
  }
  return { nodes: [...byKey.values()].sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key)), byKey, edges: [...edges.values()], adjacent }
}

const shortTitle = (title: string) => [...title].length > 28 ? [...title].slice(0, 26).join('').trimEnd() + '…' : title
const nodeRadius = (count: number, thumbnail: boolean) => thumbnail ? 9 : Math.min(10, 5 + Math.log2(count + 1) * 1.25)
const FOCUS_LIMIT = 12

function startingNodes(model: Model) {
  // Rank authored connections ahead of imported metadata. Cover several neighborhoods
  // so one frequently tagged document cannot consume the opening view.
  const weight = new Map<string,number>()
  for (const edge of model.edges) {
    const value = edge.origin === 'tag' ? 1 : edge.origin === 'assigned' ? 4 : 12
    for (const key of [edge.from,edge.to]) weight.set(key,(weight.get(key) ?? 0)+value)
  }
  const ranked = [...model.nodes].sort((a,b) => (weight.get(b.key) ?? 0)-(weight.get(a.key) ?? 0)
    || (b.source?.updatedAt ?? 0)-(a.source?.updatedAt ?? 0) || a.key.localeCompare(b.key))
  const included = new Map<string,Node>(), hubs:Node[]=[]
  for (const hub of ranked) {
    if (included.has(hub.key)) continue
    const neighbors = [...model.adjacent.get(hub.key) ?? []].filter(key=>!included.has(key))
      .sort((a,b)=>(weight.get(b) ?? 0)-(weight.get(a) ?? 0) || a.localeCompare(b))
    if (!neighbors.length || hubs.length && neighbors.length<2 && (weight.get(hub.key) ?? 0) < 4) continue
    hubs.push(hub);included.set(hub.key,hub)
    for (const key of neighbors.slice(0,FOCUS_LIMIT-1)) included.set(key,model.byKey.get(key)!)
    if (hubs.length===6) break
  }
  return { title: hubs.length>1 ? 'Connected neighborhoods' : hubs[0]?.title ?? 'Recently updated',
    nodes: included.size ? [...included.values()] : ranked.slice(0,FOCUS_LIMIT) }

}

function useReducedGraphMotion() {
  const [reduced, setReduced] = useState(() => typeof matchMedia !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => { if (typeof matchMedia !== 'function') return; const media = matchMedia('(prefers-reduced-motion: reduce)'), change = () => setReduced(media.matches); change(); media.addEventListener?.('change', change); return () => media.removeEventListener?.('change', change) }, [])
  return reduced
}

export default function KnowledgeGraph({ initialSourceId, initialTopicId }: { initialSourceId?: string; initialTopicId?: string }) {
  const initial = new URLSearchParams(typeof location === 'undefined' ? '' : location.hash.split('?')[1] ?? '')
  const initialSelection = initialSourceId ? `source:${initialSourceId}` : initialTopicId ? initialTopicId.startsWith('tag:') ? initialTopicId : `topic:${initialTopicId}` : initial.get('writing') ? 'writing:' + initial.get('writing') : initial.get('source') ? `source:${initial.get('source')}` : initial.get('topic') ? initial.get('topic')!.startsWith('tag:') ? initial.get('topic')! : `topic:${initial.get('topic')}` : null
  const { writings, sources, nodes: worldNodes } = usePersonalLibrary()
  const reading = useReading(), versions = useKnowledge((state) => state.versions)
  const ready = useRepoStatus((state) => state.ready), writer = useRepoStatus((state) => state.writer)
  const [query, setQuery] = useState(initial.get('q') ?? ''), [showSources, setShowSources] = useState(true), [showTopics, setShowTopics] = useState(true)
  const [selectedKey, setSelectedKey] = useState<string | null>(initialSelection), [hoveredKey, setHoveredKey] = useState<string | null>(null)
  const [trail, setTrail] = useState<string[]>([])
  const [overview, setOverview] = useState(!initialSelection && initial.get('view') !== 'all' && initial.get('local') !== '0')
  const [local, setLocal] = useState(initial.get('local') === '0' ? false : !!initialSelection), [depth, setDepth] = useState(initial.get('depth') === '2' ? 2 : 1), [page, setPage] = useState(0)
  const [neighborhoodLimit, setNeighborhoodLimit] = useState(PAGE_SIZE), [pinsRevision, setPinsRevision] = useState(0), [cameraRevision, setCameraRevision] = useState(0)
  const [viewport, setViewport] = useState({ width: 1000, height: 700 }), [camera, setCamera] = useState<GraphCamera>({ x: 500, y: 350, scale: 1 })
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [paused, setPaused] = useState(false), [trace, setTrace] = useState(0)
  const reducedMotion = useReducedGraphMotion(), motion = !paused && !reducedMotion
  const canvas = useRef<SVGSVGElement>(null), layer = useRef<SVGGElement>(null), details = useRef<HTMLHeadingElement>(null), stage = useRef<HTMLDivElement>(null)
  const directCamera = useRef(false)
  const focusDetails = useRef(false), focusListKey = useRef<string | null>(null), alive = useRef(true), pins = useRef(new Map<string, GraphPosition>())
  const layoutCache = useRef({ signature: '', pinsRevision: -1, positions: new Map<string, GraphPosition>(), warm: new Map<string, GraphPosition>(), store: isRepoReady() ? getStore() : null, generation: getWorldGeneration() })
  const presentation = useRef<GraphPresentation | null>(null)
  if (!presentation.current) presentation.current = new GraphPresentation()
  const nodeElements = useRef(new Map<string, SVGGElement>()), edgeElements = useRef(new Map<string, SVGGElement>())
  const requestCamera = useRef<'fit' | 'focus' | 'keep' | null>('fit'), skippedClick = useRef<{ key: string; until: number } | null>(null)
  const gesture = useRef<{ kind: 'pan' | 'node'; pointer: number; x: number; y: number; camera: GraphCamera; key?: string; point?: GraphPosition; moved: boolean } | null>(null)
  const id = useId().replaceAll(':', '')
  useEffect(() => { alive.current = true; return () => { alive.current = false; presentation.current?.stop() } }, [])
  useEffect(() => subscribeRepo((change) => { if (change.type === 'wipe' || change.type === 'import') { setTrail([]); pins.current.clear(); layoutCache.current.signature = ''; layoutCache.current.warm.clear(); presentation.current?.stop(); requestCamera.current = 'fit'; setHoveredKey(null); setPinsRevision((value) => value + 1) } }), [])
  useLayoutEffect(() => {
    const element = canvas.current
    if (!element) return
    const measure = (width: number, height: number) => { if (width > 0 && height > 0) setViewport((old) => old.width === width && old.height === height ? old : { width, height }) }
    const box = element.getBoundingClientRect(); measure(box.width, box.height)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => { const rect = entries[0]?.contentRect; if (rect) measure(rect.width, rect.height) }); observer.observe(element); return () => observer.disconnect()
  }, [])
  useEffect(() => { if (ready) void initializeReading().catch((failure) => { if (alive.current) setError(errorText(failure)) }) }, [ready])
  useEffect(() => { if (initialSourceId) { requestCamera.current = 'focus'; setSelectedKey(`source:${initialSourceId}`); setLocal(true); setPage(0) } }, [initialSourceId])
  const model = useMemo(() => buildGraphModel(sources, reading.topics, reading.items, reading.connections, worldNodes, writings), [sources, reading.topics, reading.items, reading.connections, worldNodes, writings])
  const starting = useMemo(() => startingNodes(model), [model])
  const focusedOverview = overview && !local && !query.trim() && model.nodes.length > FOCUS_LIMIT
  const selected = selectedKey ? model.byKey.get(selectedKey) : undefined
  const appliedTopic = useRef<string | null>(null)
  useEffect(() => { if (!initialTopicId) { appliedTopic.current = null; return } if (appliedTopic.current === initialTopicId) return; const topic = resolveTopics(sources, reading.topics, reading.items).find((entry) => entry.id === initialTopicId || entry.aliases.includes(initialTopicId)); if (topic) { appliedTopic.current = initialTopicId; requestCamera.current = 'focus'; setSelectedKey(topic.readingTopicIds.length ? `topic:${topic.id}` : topic.id); setLocal(true); setPage(0) } }, [initialTopicId, sources, reading.topics, reading.items])
  useEffect(() => { if (typeof location === 'undefined' || !location.hash.startsWith('#/graph')) return; const params = new URLSearchParams(); if (!overview && !local) params.set('view', 'all'); if (selectedKey?.startsWith('writing:')) params.set('writing', selectedKey.slice(8)); else if (selectedKey?.startsWith('source:')) params.set('source', selectedKey.slice(7)); else if (selectedKey) params.set('topic', selectedKey.startsWith('topic:') ? selectedKey.slice(6) : selectedKey); if (query) params.set('q', query); if (local) params.set('local', '1'); else if (selectedKey) params.set('local', '0'); if (depth === 2) params.set('depth', '2'); history.replaceState(null, '', `#/graph${params.size ? `?${params}` : ''}`) }, [selectedKey, query, local, depth, overview])
  const filtered = useMemo(() => {
    let neighborhood: Set<string> | null = null
    if (local && !query.trim()) { neighborhood = new Set(selected ? [selected.key] : []); let frontier = selected ? [selected.key] : []; for (let level = 0; level < depth; level++) { const next: string[] = []; for (const key of frontier) for (const other of model.adjacent.get(key) ?? []) if (!neighborhood.has(other)) { neighborhood.add(other); next.push(other) } frontier = next } }
    const terms = fold(query).split(/\s+/).filter(Boolean)
    const result = (focusedOverview ? starting.nodes : model.nodes).filter((node) => (node.kind === 'source' ? showSources : showTopics) && (!neighborhood || neighborhood.has(node.key)) && terms.every((term) => fold(`${node.title} ${node.source?.tags.join(' ') ?? ''}`).includes(term)))
    if (local && selected) result.sort((a, b) => Number(b.key === selected.key) - Number(a.key === selected.key))
    return result
  }, [model, query, showSources, showTopics, selected, local, depth, starting, focusedOverview])
  const inNeighborhood = local && !query.trim()
  const pages = inNeighborhood ? 1 : Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)), currentPage = Math.min(page, pages - 1)
  const visibleNodes = useMemo(() => inNeighborhood ? filtered.slice(0, neighborhoodLimit) : filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE), [filtered, currentPage, inNeighborhood, neighborhoodLimit])
  const visibleKeys = useMemo(() => new Set(visibleNodes.map((node) => node.key)), [visibleNodes])
  const pageEdges = useMemo(() => model.edges.filter((edge) => visibleKeys.has(edge.from) && visibleKeys.has(edge.to)), [model.edges, visibleKeys])
  const outsideEdges = useMemo(() => model.edges.filter((edge) => visibleKeys.has(edge.from) !== visibleKeys.has(edge.to)), [model.edges, visibleKeys])
  const outsideSelected = selected ? [...(model.adjacent.get(selected.key) ?? [])].filter((key) => !visibleKeys.has(key)).length : 0
  const positions = useMemo(() => {
    const cache = layoutCache.current, store = isRepoReady() ? getStore() : null, generation = getWorldGeneration(), signature = graphTopology(visibleNodes, pageEdges.slice(0, EDGE_LIMIT))
    if (cache.store !== store || cache.generation !== generation) { cache.warm.clear(); pins.current.clear(); cache.signature = ''; cache.store = store; cache.generation = generation }
    if (cache.signature === signature && cache.pinsRevision === pinsRevision) return cache.positions
    const result = layoutGraph(visibleNodes, pageEdges.slice(0, EDGE_LIMIT), cache.warm, pins.current)
    cache.signature = signature; cache.positions = result; cache.pinsRevision = pinsRevision
    for (const [key, point] of result) cache.warm.set(key, point)
    for (const key of cache.warm.keys()) if (!model.byKey.has(key) || cache.warm.size > 1000 && !visibleKeys.has(key)) cache.warm.delete(key)
    return result
  }, [visibleNodes, pageEdges, pinsRevision, model.byKey, visibleKeys])
  const fit = useMemo(() => fitGraphCamera(positions, viewport.width, viewport.height), [positions, viewport])
  useLayoutEffect(() => {
    const request = requestCamera.current; requestCamera.current = null
    if (request === 'keep') return
    if (request === 'focus' && selectedKey && positions.has(selectedKey)) {
      const neighbors = [...model.adjacent.get(selectedKey) ?? []].map(key => positions.get(key)).filter((p): p is GraphPosition => !!p)
      setCamera(focusGraphNeighborhood(positions.get(selectedKey)!, neighbors, viewport.width, viewport.height, Math.min(2, fit.scale * 1.35)))
      return
    }
    setCamera(fit)
  }, [positions, fit, viewport, selectedKey, cameraRevision, model.adjacent])
  const renderedScale = Math.max(.001, camera.scale), zoomPercent = Math.round(camera.scale / fit.scale * 100)
  const drawnEdges = useMemo(() => [...pageEdges].sort((a, b) => Number(b.from === selectedKey || b.to === selectedKey) - Number(a.from === selectedKey || a.to === selectedKey)).slice(0, EDGE_LIMIT), [pageEdges, selectedKey])
  const curves = useMemo(() => { const groups = new Map<string, string[]>(); for (const edge of drawnEdges) { const pair = [edge.from, edge.to].sort().join('|'), group = groups.get(pair) ?? []; group.push(edge.id); groups.set(pair, group) } for (const group of groups.values()) group.sort(); return new Map(drawnEdges.map((edge) => { const pair = [edge.from, edge.to].sort(), group = groups.get(pair.join('|'))!, sign = pair[0] === edge.from ? 1 : -1; return [edge.id, (group.length === 1 ? 3 : (group.indexOf(edge.id) - (group.length - 1) / 2) * 30) * sign] })) }, [drawnEdges])
  const thumbnails = useMemo(() => { const found = new Map<string, string>(); for (const node of visibleNodes) { if (found.size >= 24) break; const record = node.source?.nodeId ? worldNodes.get(node.source.nodeId) : undefined, thumb = record?.attachments.find((attachment) => attachment.kind === 'image' && attachment.thumbBlobId)?.thumbBlobId; if (thumb) found.set(node.key, thumb) } return found }, [visibleNodes, worldNodes])
  const activeKey = hoveredKey && visibleKeys.has(hoveredKey) ? hoveredKey : selectedKey
  const neighbors = useMemo(() => activeKey ? model.adjacent.get(activeKey) ?? new Set<string>() : null, [activeKey, model.adjacent])
  const labels = useMemo(() => placeGraphLabels(visibleNodes.map(node => {
    const position = positions.get(node.key)!, degree = model.adjacent.get(node.key)?.size ?? 0
    return {
      key: node.key, title: shortTitle(node.title), radius: nodeRadius(degree, thumbnails.has(node.key)),
      point: { x: position.x * camera.scale + camera.x, y: position.y * camera.scale + camera.y },
      priority: Number(node.key === activeKey) * 100000 + Number(neighbors?.has(node.key)) * 10000 + Number(node.kind === 'topic' && !node.tag) * 24 + Math.min(800,degree * 3) + Number(!!node.writingId) * 12,
    }
  }), viewport.width, viewport.height, [
    { left: 0, top: 0, right: Math.min(270, viewport.width * .68), bottom: 54 },
    { left: viewport.width - 180, top: viewport.height - 56, right: viewport.width, bottom: viewport.height },
    ...(activeKey ? [{left:viewport.width*.6,top:0,right:viewport.width,bottom:55}] : []),
  ], Math.max(4, Math.ceil(viewport.width * viewport.height / 26000 * (camera.scale/fit.scale)**1.5))), [fit.scale,visibleNodes, positions, camera, viewport, model.adjacent, thumbnails, activeKey, neighbors])
  const scene = useRef({ nodes: visibleNodes, edges: drawnEdges, curves })
  useLayoutEffect(() => { scene.current = { nodes: visibleNodes, edges: drawnEdges, curves } }, [visibleNodes, drawnEdges, curves])
  const drawFrame = useCallback((frame: GraphFrame) => {
    const scale = frame.camera.scale, snapshot = scene.current
    layer.current?.setAttribute('transform', `translate(${frame.camera.x} ${frame.camera.y}) scale(${scale})`)
    stage.current?.setAttribute('data-animating', frame.progress < 1 ? 'true' : 'false')
    layer.current?.style.setProperty('--graph-inverse', String(1/scale))
    const marker = canvas.current?.querySelector('marker'); marker?.setAttribute('markerWidth', String(9 / scale)); marker?.setAttribute('markerHeight', String(7 / scale))
    if (frame.geometryChanged === false) return
    for (const node of snapshot.nodes) {
      const element = nodeElements.current.get(node.key), point = frame.positions.get(node.key)
      if (!element || !point) continue
      element.setAttribute('transform', `translate(${point.x} ${point.y})`)
    }
    for (const edge of snapshot.edges) {
      const element = edgeElements.current.get(edge.id), from = frame.positions.get(edge.from), to = frame.positions.get(edge.to)
      if (!element || !from || !to) continue
      const curve = graphCurve(from, to, snapshot.curves.get(edge.id) ?? 0)
      for (const path of element.querySelectorAll('path')) path.setAttribute('d', curve.d)
      const label = element.querySelector('text'); if (label) { label.setAttribute('x', String(curve.x)); label.setAttribute('y', String(curve.y - 8 / scale)); label.style.fontSize = `${10 / scale}px`; label.style.strokeWidth = `${4 / scale}px` }
    }
  }, [])
  useLayoutEffect(() => {
    const controller = presentation.current!, origins = new Map<string, GraphPosition>(), before = controller.frame?.positions
    if (before) for (const node of visibleNodes) if (!before.has(node.key)) { const near = [...(model.adjacent.get(node.key) ?? [])].map((key) => before.get(key)).filter((point): point is GraphPosition => !!point); if (near.length) origins.set(node.key, { x: near.reduce((sum, point) => sum + point.x, 0) / near.length, y: near.reduce((sum, point) => sum + point.y, 0) / near.length }) }
    controller.transition(positions, camera, drawFrame, { duration: motion && !directCamera.current ? 320 : 0, origins })
    directCamera.current = false
    return () => controller.stop()
  }, [positions, camera, motion, drawFrame, visibleNodes, model.adjacent])
  const resetView = () => { requestCamera.current = 'fit'; setCameraRevision((value) => value + 1) }
  const zoom = useCallback((factor: number, anchor?: GraphPosition) => setCamera((old) => zoomGraphCamera(old, factor, anchor ?? { x: viewport.width / 2, y: viewport.height / 2 }, fit.scale * .25, fit.scale * 4)), [viewport, fit.scale])
  const svgPoint = (clientX: number, clientY: number) => { const box = canvas.current?.getBoundingClientRect(); return { x: (clientX - (box?.left ?? 0)) * viewport.width / (box?.width || viewport.width), y: (clientY - (box?.top ?? 0)) * viewport.height / (box?.height || viewport.height) } }
  useEffect(() => { const element = canvas.current; if (!element) return; const wheel = (event: WheelEvent) => { event.preventDefault(); directCamera.current = true; const box = element.getBoundingClientRect(), anchor = { x: (event.clientX - box.left) * viewport.width / (box.width || viewport.width), y: (event.clientY - box.top) * viewport.height / (box.height || viewport.height) }; zoom(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * .002), anchor) }; element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel) }, [zoom, viewport])
  useEffect(() => { if (focusDetails.current && selected) { details.current?.focus({ preventScroll: true }); focusDetails.current = false } }, [selected])
  useEffect(() => { if (!focusListKey.current) return; const index = visibleNodes.findIndex((node) => node.key === focusListKey.current); if (index >= 0) document.getElementById(`${id}-list-${index}`)?.focus(); focusListKey.current = null }, [visibleNodes, selectedKey, id])
  async function run<T,>(task: () => Promise<T>, success: string): Promise<T | null> {
    if (!writer || pending || !isRepoReady()) return null
    const store = getStore(), generation = getWorldGeneration(), current = () => alive.current && isRepoReady() && getStore() === store && getWorldGeneration() === generation
    setPending(true); setError(''); setNotice('')
    try { const result = await task(); if (!current()) return null; setNotice(success); return result } catch (failure) { if (current()) setError(errorText(failure)); return null } finally { if (current()) setPending(false) }
  }
  function clearSelection() { setTrail([]); setSelectedKey(null); setHoveredKey(null); setLocal(false); resetView() }
  function choose(key: string, focus = false, remember = true) {
    if (remember && selectedKey && key !== selectedKey) setTrail(previous => [...previous.slice(-31), selectedKey])
     if (query.trim() || focusedOverview && !visibleKeys.has(key)) { setLocal(true); setQuery(''); setNeighborhoodLimit(PAGE_SIZE) } requestCamera.current = 'focus'; focusDetails.current = focus; setHoveredKey(null); if (focus && key === selectedKey) { details.current?.focus({ preventScroll: true }); focusDetails.current = false } setSelectedKey(key); setCameraRevision((value) => value + 1); setTrace((value) => value + 1); if (local) { setPage(0); setNeighborhoodLimit(PAGE_SIZE) } }
  const visited = trail.filter(key => model.byKey.has(key) && key !== selectedKey)
  function stepBack() {
    const key = visited.at(-1)
    if (!key) return
    setTrail(trail.slice(0, trail.lastIndexOf(key)))
    setQuery(''); setShowSources(true); setShowTopics(true)
    // A visited node may be on a different page of the full graph.
    if (!visibleKeys.has(key)) setLocal(true)
    choose(key, false, false)
  }
  function moveBetweenNodes(event: KeyboardEvent<SVGGElement>, key: string) {
    const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
    const candidates = [...(model.adjacent.get(key) ?? [])].filter(other => visibleKeys.has(other))
    if (!candidates.length) return
    event.preventDefault()
    const here = positions.get(key)!
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
    // Prefer a neighbor in the requested direction, then the closest real connection.
    const distance = (other: string) => {
      const point = positions.get(other)!, dx = point.x - here.x, dy = point.y - here.y
      return Math.hypot(dx, dy) * ((horizontal ? dx : dy) * direction > 0 ? 1 : 1000)
    }
    candidates.sort((a, b) => distance(a) - distance(b) || a.localeCompare(b))
    choose(candidates[0])
    nodeElements.current.get(candidates[0])?.focus({ preventScroll: true })
  }
  function filterChanged(change: () => void) { change(); requestCamera.current = 'fit'; setPage(0); setNeighborhoodLimit(PAGE_SIZE); setCameraRevision((value) => value + 1); setHoveredKey(null) }
  function pinNode(key: string, point?: GraphPosition) { const current = point ?? presentation.current?.frame?.positions.get(key) ?? positions.get(key); if (!current) return; if (!point && pins.current.has(key)) pins.current.delete(key); else pins.current.set(key, { ...current }); requestCamera.current = 'keep'; setPinsRevision((value) => value + 1) }
  function listKeys(event: KeyboardEvent<HTMLButtonElement>, index: number) { let next: number; if (event.key === 'ArrowDown') next = Math.min(visibleNodes.length - 1, index + 1); else if (event.key === 'ArrowUp') next = Math.max(0, index - 1); else if (event.key === 'Home') next = 0; else if (event.key === 'End') next = visibleNodes.length - 1; else return; event.preventDefault(); focusListKey.current = visibleNodes[next].key; choose(visibleNodes[next].key) }
  function canvasKeys(event: KeyboardEvent<SVGSVGElement>) { if (event.target !== event.currentTarget) return; const amount = event.shiftKey ? 100 : 35; if (event.key.startsWith('Arrow')) { event.preventDefault(); setCamera((old) => ({ ...old, x: old.x + (event.key === 'ArrowLeft' ? amount : event.key === 'ArrowRight' ? -amount : 0), y: old.y + (event.key === 'ArrowUp' ? amount : event.key === 'ArrowDown' ? -amount : 0) })) } else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.2) } else if (event.key === '-') { event.preventDefault(); zoom(1 / 1.2) } else if (event.key === '0') { event.preventDefault(); resetView() } else if (event.key === 'Escape') { event.preventDefault(); clearSelection() } }
  function pointerDown(event: PointerEvent<SVGSVGElement>) { if (event.button !== 0 || (event.target instanceof Element && event.target.closest('[data-graph-node]'))) return; presentation.current?.stop(); const point = svgPoint(event.clientX, event.clientY); gesture.current = { kind: 'pan', pointer: event.pointerId, x: point.x, y: point.y, camera: presentation.current?.frame?.camera ?? camera, moved: false }; event.currentTarget.setPointerCapture?.(event.pointerId) }
  function nodeDown(event: PointerEvent<SVGGElement>, key: string) { if (event.button !== 0) return; event.stopPropagation(); presentation.current?.stop(); const point = svgPoint(event.clientX, event.clientY); gesture.current = { kind: 'node', pointer: event.pointerId, x: point.x, y: point.y, camera: presentation.current?.frame?.camera ?? camera, key, point: presentation.current?.frame?.positions.get(key) ?? positions.get(key), moved: false }; event.currentTarget.setPointerCapture?.(event.pointerId) }
  function pointerMove(event: PointerEvent<SVGSVGElement>) { const current = gesture.current, frame = presentation.current?.frame; if (!current || current.pointer !== event.pointerId || !frame) return; const point = svgPoint(event.clientX, event.clientY), dx = point.x - current.x, dy = point.y - current.y; current.moved ||= Math.hypot(dx, dy) > 3; if (current.kind === 'node' && current.key && current.point) { frame.positions.set(current.key, { x: current.point.x + dx / current.camera.scale, y: current.point.y + dy / current.camera.scale }) } else frame.camera = { ...current.camera, x: current.camera.x + dx, y: current.camera.y + dy }; frame.progress = 1; frame.geometryChanged = current.kind === 'node'; frame.entering.clear(); presentation.current?.set(frame); drawFrame(frame) }
  function pointerUp(cancel = false) { const current = gesture.current, frame = presentation.current?.frame; gesture.current = null; if (!current || !frame) return; if (current.kind === 'node' && current.key && current.moved) { if (!cancel) { pinNode(current.key, frame.positions.get(current.key)); skippedClick.current = { key: current.key, until: performance.now() + 400 }; setSelectedKey(current.key); setNotice('Pinned in this graph view. Your 3D positions are unchanged.') } else { setCamera({ ...frame.camera }) } } else if (current.kind === 'pan' && current.moved) setCamera({ ...frame.camera }) }
  const disabled = !writer || reading.busy || pending || !reading.loaded, listTabKey = visibleKeys.has(selectedKey ?? '') ? selectedKey : visibleNodes[0]?.key
  const selectedReading = selected?.source ? reading.items.find((item) => item.sourceId === selected.source!.id) : undefined
  return <section className="reading-graph" aria-label="Knowledge graph" data-motion={motion ? 'on' : 'off'}>
    <header className="reading-graph-heading"><h2>Knowledge graph</h2>
      <div className="reading-graph-scope" role="group" aria-label="Graph scope">
        <button type="button" aria-pressed={overview || local} onClick={() => filterChanged(() => { setOverview(true); clearSelection(); setQuery(''); setShowSources(true); setShowTopics(true) })}>Focused view</button>
        <button type="button" aria-pressed={!overview && !local} onClick={() => filterChanged(() => { setOverview(false); clearSelection(); setQuery(''); setShowSources(true); setShowTopics(true) })}>All nodes</button>
      </div></header>
    <div className="reading-graph-filters"><label className="reading-graph-search"><MagnifyingGlass size={18} aria-hidden="true" /><span className="reading-graph-sr">Filter graph</span><input aria-label="Filter graph" name="graph-search" autoComplete="off" maxLength={100} placeholder="Find a source or concept…" value={query} onChange={(event) => filterChanged(() => setQuery(event.target.value))} onKeyDown={(event) => { if (event.key === 'Enter' && filtered[0]) { event.preventDefault(); setQuery(''); setLocal(true); setShowSources(true); setShowTopics(true); choose(filtered[0].key) } }} title="Press Enter to explore the first matching neighborhood" />{query && <button type="button" aria-label="Clear graph search" onClick={() => filterChanged(() => setQuery(''))}><X size={16} aria-hidden="true" /></button>}</label><details className="reading-graph-view-options"><summary>View options</summary><div><label><input type="checkbox" checked={showSources} onChange={(event) => filterChanged(() => setShowSources(event.target.checked))} />Sources</label><label><input type="checkbox" checked={showTopics} onChange={(event) => filterChanged(() => setShowTopics(event.target.checked))} />Topics & tags</label><span className="reading-graph-filter-divider" /><label><input type="checkbox" checked={local} disabled={!selected && !local} onChange={(event) => filterChanged(() => setLocal(event.target.checked))} />Local neighborhood</label>{local && <label className="reading-graph-depth">Depth<select aria-label="Neighborhood depth" value={depth} onChange={(event) => filterChanged(() => setDepth(Number(event.target.value)))}><option value={1}>1 link</option><option value={2}>2 links</option></select></label>}<button type="button" className="reading-graph-motion" aria-label={reducedMotion ? 'Graph uses reduced motion' : 'Toggle graph motion'} aria-pressed={motion} disabled={reducedMotion} onClick={() => setPaused((value) => !value)}>{motion ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}{reducedMotion ? 'Reduced motion' : motion ? 'Motion on' : 'Motion paused'}</button></div></details></div>
    {(error || reading.error || notice) && <p className={`reading-graph-notice ${error || reading.error ? 'is-error' : ''}`} role={error || reading.error ? 'alert' : 'status'}>{error || reading.error || notice}<button type="button" aria-label="Dismiss graph notice" onClick={() => { setNotice(''); setError('') }}><X size={14} aria-hidden="true" /></button></p>}
    <div className="reading-graph-layout"><div className="reading-graph-main"><div ref={stage} className="reading-graph-stage" data-animating="false"><div className="reading-graph-stage-label">{visited.length > 0 && <button type="button" className="reading-graph-back" aria-label="Back to previous graph node" title={model.byKey.get(visited.at(-1)!)?.title} onClick={stepBack}><ArrowLeft size={17} /></button>}<span>{query.trim() ? 'Search results' : local && selected ? selected.title : focusedOverview ? starting.title : 'Library atlas'}</span><small>{visibleNodes.length} visible · {drawnEdges.length} {drawnEdges.length === 1 ? 'connection' : 'connections'}</small></div><div className="reading-graph-canvas-tools" role="group" aria-label="Graph view controls"><button type="button" aria-label="Zoom out graph" onClick={() => zoom(1 / 1.2)}><Minus size={17} aria-hidden="true" /></button><span aria-live="off">{zoomPercent}%</span><button type="button" aria-label="Zoom in graph" onClick={() => zoom(1.2)}><Plus size={17} aria-hidden="true" /></button><button type="button" aria-label="Fit graph to view" onClick={resetView}><ArrowsOut size={17} aria-hidden="true" /></button>{selected && <button type="button" aria-label="Focus selected node" onClick={() => { if (!visibleKeys.has(selected.key)) { setQuery(''); setShowSources(true); setShowTopics(true); setLocal(true) } choose(selected.key) }}><Crosshair size={17} aria-hidden="true" /></button>}{pins.current.size > 0 && <button type="button" aria-label="Release all graph pins" title="Release graph pins" onClick={() => { pins.current.clear(); requestCamera.current = 'fit'; setPinsRevision((value) => value + 1) }}><PushPin size={16} aria-hidden="true" /></button>}</div>
      <svg ref={canvas} className="reading-graph-canvas" viewBox={`0 0 ${viewport.width} ${viewport.height}`} tabIndex={0} role="group" aria-label="Interactive knowledge graph" aria-describedby={`${id}-canvas-help`} onKeyDown={canvasKeys} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={() => pointerUp()} onPointerCancel={() => pointerUp(true)} onLostPointerCapture={() => { if (gesture.current) pointerUp(true) }} onPointerLeave={() => { if (!gesture.current) setHoveredKey(null) }}>
        <defs><marker id={`${id}-arrow`} viewBox="0 0 9 7" markerWidth={9 / renderedScale} markerHeight={7 / renderedScale} refX="16" refY="3.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 L8 3.5 L0 7 Z" fill="currentColor" /></marker><radialGradient id={`${id}-halo`}><stop offset="0" stopColor="currentColor" stopOpacity=".15" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></radialGradient><radialGradient id={`${id}-topic`} cx="30%" cy="22%"><stop offset="0" stopColor="#fff8df" /><stop offset=".5" stopColor="#e6c784" /><stop offset="1" stopColor="#b58c45" /></radialGradient><radialGradient id={`${id}-source`} cx="30%" cy="25%"><stop offset="0" stopColor="#fffdf5" /><stop offset="1" stopColor="#b9bbb4" /></radialGradient></defs>
        <g ref={layer} style={{'--graph-inverse':1/renderedScale} as React.CSSProperties} transform={`translate(${camera.x} ${camera.y}) scale(${renderedScale})`}>
          {drawnEdges.map((edge) => { const from = positions.get(edge.from)!, to = positions.get(edge.to)!, curve = graphCurve(from, to, curves.get(edge.id) ?? 0), active = edge.from === activeKey || edge.to === activeKey, directed = edge.worldLink?.directed ?? (!!edge.connection && edge.connection.relation !== 'related'), relation = edge.connection?.relation ?? edge.worldLink?.relation ?? edge.origin; return <g ref={(element) => { if (element) edgeElements.current.set(edge.id, element); else edgeElements.current.delete(edge.id) }} key={edge.id} data-graph-edge={edge.id} data-origin={edge.origin} data-relation={relation} className={`reading-graph-edge ${active ? 'is-active' : activeKey ? 'is-dimmed' : ''} is-${edge.origin} relation-${relation}`}><title>{model.byKey.get(edge.from)?.title} — {edge.label} — {model.byKey.get(edge.to)?.title}</title><path className="reading-graph-edge-line" d={curve.d} vectorEffect="non-scaling-stroke" markerEnd={directed ? `url(#${id}-arrow)` : undefined} />{(edge.origin === 'manual' || edge.origin === 'world') && (active || drawnEdges.length <= 6) && <text x={curve.x} y={curve.y - 8 / renderedScale} style={{ fontSize: 10 / renderedScale, strokeWidth: 4 / renderedScale }} textAnchor="middle">{edge.label}</text>}{motion && active && directed && <path key={`${edge.id}:${trace}`} className="reading-graph-edge-trace" d={curve.d} vectorEffect="non-scaling-stroke" pathLength={1} />}{motion && selectedKey && (edge.from === selectedKey || edge.to === selectedKey) && !directed && <path key={`glow:${edge.id}:${trace}`} className="reading-graph-edge-illuminate" d={curve.d} vectorEffect="non-scaling-stroke" />}</g> })}
          {visibleNodes.map((node) => { const position = positions.get(node.key)!, count = model.adjacent.get(node.key)?.size ?? 0, hasThumbnail = thumbnails.has(node.key), radius = nodeRadius(count, hasThumbnail) / renderedScale, connected = activeKey === node.key || !!neighbors?.has(node.key), pinned = pins.current.has(node.key), placement = labels.get(node.key); return <g ref={(element) => { if (element) nodeElements.current.set(node.key, element); else nodeElements.current.delete(node.key) }} key={node.key} data-graph-node={node.key} data-connections={count} data-pinned={pinned ? 'true' : 'false'} className={`reading-graph-node is-${node.kind} ${node.tag ? 'is-tag' : ''} ${selectedKey === node.key ? 'is-selected' : ''} ${connected ? 'is-connected' : activeKey ? 'is-dimmed' : ''} ${pinned ? 'is-pinned' : ''} ${placement ? 'has-label' : ''} ${hasThumbnail ? 'has-thumbnail' : ''}`} transform={`translate(${position.x} ${position.y})`} role="button" aria-label={`${node.title}, ${node.tag ? 'source tag' : node.kind}, ${count} connections${pinned ? ', pinned in graph' : ''}`} aria-pressed={selectedKey === node.key} tabIndex={listTabKey === node.key ? 0 : -1} onPointerDown={(event) => nodeDown(event, node.key)} onPointerEnter={() => setHoveredKey(node.key)} onPointerLeave={() => { if (!gesture.current) setHoveredKey(null) }} onClick={(event) => { if (skippedClick.current?.key === node.key && performance.now() < skippedClick.current.until) return; choose(node.key, event.detail === 0) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(node.key, true) } else if (event.key.toLowerCase() === 'p') { event.preventDefault(); pinNode(node.key) } else if (event.altKey && event.key.startsWith('Arrow')) { event.preventDefault(); event.stopPropagation(); const point = presentation.current?.frame?.positions.get(node.key) ?? position, amount = (event.shiftKey ? 45 : 18) / (presentation.current?.frame?.camera.scale ?? renderedScale); pinNode(node.key, { x: point.x + (event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0), y: point.y + (event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0) }) } else if (event.key.startsWith('Arrow')) moveBetweenNodes(event, node.key) }}><title>{node.title}</title><g className="reading-graph-node-face">{selectedKey === node.key && <circle className="reading-graph-orbit" r={radius*renderedScale+5} aria-hidden="true"/>}
            <circle className="reading-graph-node-target" r={Math.max(12,radius*renderedScale+4)} />
            <circle className="reading-graph-node-dot" r={radius*renderedScale} vectorEffect="non-scaling-stroke"/>
            {hasThumbnail && <GraphThumbnail blobId={thumbnails.get(node.key)!} radius={radius*renderedScale} clipId={`${id}-clip-${visibleNodes.indexOf(node)}`} svg/>}
            <text className="reading-graph-node-label" style={{fontSize:12}} x={placement?.x ?? 0} y={placement?.y ?? 18} textAnchor={placement?.anchor ?? 'middle'}>{shortTitle(node.title)}</text></g></g> })}
        </g>
      </svg>

      {!reading.loaded ? <div className="reading-graph-empty" role="status"><Graph size={28} aria-hidden="true" /><h3>Opening your connections…</h3></div> : !visibleNodes.length && <div className="reading-graph-empty"><Graph size={30} aria-hidden="true" /><h3>{model.nodes.length ? 'No nodes match these filters' : 'Start with a source or a topic'}</h3><p>{model.nodes.length ? 'Clear the search or widen your graph selection.' : 'Select words in a draft and choose Concept to link a passage here.'}</p>{model.nodes.length > 0 && <button type="button" onClick={() => filterChanged(() => { setQuery(''); setShowSources(true); setShowTopics(true); setLocal(false) })}>Reset filters</button>}{!model.nodes.length && <a href="#/write">Open writing</a>}</div>}
{selected && <div className="reading-graph-selection-tools"><button type="button" onClick={() => pinNode(selected.key)} aria-pressed={pins.current.has(selected.key)}><PushPin size={13} aria-hidden="true" />{pins.current.has(selected.key) ? 'Release pin' : 'Pin in graph'}</button><button type="button" disabled={!motion || !drawnEdges.some((edge) => (edge.from === selected.key || edge.to === selected.key))} onClick={() => setTrace((value) => value + 1)}><Path size={13} aria-hidden="true" />Trace saved links</button></div>}</div>
      <details className="reading-graph-guide"><summary>Legend and shortcuts</summary><div className="reading-graph-legend"><span><i className="is-source" />Source</span><span><i className="is-topic" />Topic</span><span><i className="is-tag" />Source tag</span><span><i className="is-supports" />Supports →</span><span><i className="is-contradicts" />Contradicts →</span></div>
      <div className="reading-graph-caption"><p id={`${id}-canvas-help`}>Drag the canvas to pan. Drag a node to pin it. Scroll or +/− to zoom, 0 to fit. On a node, arrows follow connections. P pins it and Alt + arrows move it.</p><span>{visibleNodes.length} of {filtered.length} nodes · {Math.min(pageEdges.length, EDGE_LIMIT)} links{pageEdges.length > EDGE_LIMIT ? ` of ${pageEdges.length}; narrow the neighborhood to see more` : ''}</span></div></details>
      {(outsideEdges.length > 0 || selected && !overview || local && selected) && <div className="reading-graph-outside" role="status"><div><strong>{outsideEdges.length ? `${outsideEdges.length} connections continue outside this view` : 'All visible connections are shown'}</strong><span>{selected ? `${selected.title}${outsideSelected ? ` has ${outsideSelected} neighbors outside the canvas.` : ' is selected.'}` : 'Choose a node to see its other connections.'}</span></div>{selected && !local && <button type="button" onClick={() => filterChanged(() => { setLocal(true); setQuery(''); setShowSources(true); setShowTopics(true) })}>Show selected neighborhood</button>}{local && visibleNodes.length < filtered.length && neighborhoodLimit < 320 && <button type="button" onClick={() => { setNeighborhoodLimit((limit) => Math.min(320, limit + PAGE_SIZE)); requestCamera.current = 'fit' }}>Expand neighborhood · {filtered.length - visibleNodes.length} more nodes</button>}{local && neighborhoodLimit >= 320 && filtered.length > visibleNodes.length && <span>Canvas limit: 320 nodes. Choose a neighbor or narrow the filters to continue.</span>}{pins.current.size > 0 && <button type="button" onClick={() => { pins.current.clear(); requestCamera.current = 'fit'; setPinsRevision((value) => value + 1) }}>Release all pins · {pins.current.size}</button>}</div>}
      <details className="reading-graph-node-list" open={!!query.trim() || undefined}><summary>Browse nodes <span>{filtered.length}</span></summary><ul role="listbox" aria-label="Graph nodes">{visibleNodes.map((node, index) => <li key={node.key} role="presentation"><button type="button" role="option" aria-selected={selectedKey === node.key} id={`${id}-list-${index}`} tabIndex={listTabKey === node.key ? 0 : -1} onKeyDown={(event) => listKeys(event, index)} onClick={() => choose(node.key)}><span className={`reading-graph-list-icon is-${node.kind}`}>{node.kind === 'source' ? <FileText size={16} aria-hidden="true" /> : <Hash size={16} aria-hidden="true" />}</span><span><strong>{node.title}</strong><small>{node.tag ? 'Source tag' : node.writingId && !node.source ? 'Writing draft' : node.kind === 'source' ? node.source?.kind : 'Saved topic'} · {model.adjacent.get(node.key)?.size ?? 0} connections{pins.current.has(node.key) ? ' · pinned' : ''}</small></span></button></li>)}</ul>{pages > 1 && <div className="reading-graph-pagination"><button type="button" disabled={currentPage === 0} onClick={() => { requestCamera.current = 'fit'; setPage(currentPage - 1) }}>Previous nodes</button><span>Page {currentPage + 1} of {pages}</span><button type="button" disabled={currentPage === pages - 1} onClick={() => { requestCamera.current = 'fit'; setPage(currentPage + 1) }}>Next nodes</button></div>}</details>
    </div><aside className="reading-graph-inspector" aria-label="Graph details">
      {selected ? <><div className="reading-graph-inspector-heading"><span>Selected {selected.kind}</span><button type="button" aria-label="Clear graph selection" onClick={clearSelection}><X size={16} aria-hidden="true" /></button></div><NodeDetails key={selected.key} node={selected} model={model} items={reading.items} topics={reading.topics} preview={selected.source ? versions.find((version) => version.id === selected.source!.currentVersionId)?.text : undefined} headingRef={details} disabled={disabled} run={run} onSelect={(key) => { choose(key); filterChanged(() => setLocal(true)) }} onSavedTopic={(topic) => { requestCamera.current = 'focus'; setSelectedKey(`topic:${topic.id}`); setShowTopics(true) }} /><div className="reading-graph-source-meta">{selectedReading && <span>{selectedReading.status === 'read' ? 'Finished reading' : selectedReading.status === 'reading' ? `${Math.round(selectedReading.progress * 100)}% read` : 'To read'}</span>}<span>{pins.current.has(selected.key) ? 'Pinned in this graph view' : 'Free in this graph view'}</span></div></> : <div className="reading-graph-detail-empty"><header><Compass size={23} weight="light" aria-hidden="true" /><h3>{starting.nodes.length ? 'Explore your library' : 'Explore a connection'}</h3></header>
        {starting.nodes.length ? <ul className="reading-graph-starters">{starting.nodes.slice(0, 5).map(node => {
          const Icon = node.kind === 'topic' ? Hash : node.writingId ? PencilSimple : FileText
          const count = model.adjacent.get(node.key)?.size ?? 0
          return <li key={node.key}><button type="button" onClick={() => choose(node.key)}><Icon size={18} aria-hidden="true" /><span><strong>{node.title}</strong><small>{node.tag ? 'Source tag' : node.kind === 'topic' ? 'Concept' : node.writingId ? 'Writing' : 'Source'} · {count} {count === 1 ? 'connection' : 'connections'}</small></span><ArrowRight size={14} aria-hidden="true" /></button></li>
        })}</ul> : <p>Choose a node to see its sources and linked passages.</p>}</div>}
      <CreateTopic disabled={disabled} run={run} onCreate={(topic) => { requestCamera.current = 'focus'; setSelectedKey(`topic:${topic.id}`); filterChanged(() => { setQuery(''); setShowTopics(true); setLocal(false) }) }} />
      <ConnectionForm model={model} selected={selected} disabled={disabled} run={run} />

    </aside></div>
  </section>
}

/** Only existing, bounded local image thumbnails. No remote preview or generated asset fetches. */
function GraphThumbnail({ blobId, radius, clipId, svg = false }: { blobId: string; radius: number; clipId: string; svg?: boolean }) {
  const [original, setOriginal] = useState<{ url: string; store: ReturnType<typeof getStore>; generation: number } | null>(null)
  const store = isRepoReady() ? getStore() : null, generation = getWorldGeneration()
  useEffect(() => { setOriginal(null); let alive = true, objectUrl: string | null = null; if (!store || !isRepoReady()) return; void (async () => { const meta = await store.getAssetMeta(blobId); if (!meta || meta.bytes > 1024 * 1024 || !/^image\/(png|jpeg|webp|gif|avif)$/.test(meta.mime)) return; const blob = await store.getBlob(blobId); if (!blob || !alive || !isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) return; const mime = sniffImageMime(await readHead(blob)); if (!mime || mime === 'image/svg+xml' || !alive || !isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) return; objectUrl = URL.createObjectURL(blob); setOriginal({ url: objectUrl, store, generation }) })().catch(() => {}); return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl) } }, [blobId, store, generation])
  const url = original && original.store === store && original.generation === generation ? original.url : null
  if (!url) return null
  return svg ? <><defs><clipPath id={clipId}><circle r={radius} /></clipPath></defs><image className="reading-graph-node-thumbnail" href={url} x={-radius} y={-radius} width={radius * 2} height={radius * 2} clipPath={`url(#${clipId})`} preserveAspectRatio="xMidYMid slice" aria-hidden="true" /></> : <img className="reading-graph-source-thumbnail" src={url} alt="" width={320} height={180} loading="lazy" />
}

function NodeDetails({ node, model, items, topics, preview, headingRef, disabled, run, onSelect, onSavedTopic }: { node: Node; model: Model; items: ReadingItem[]; topics: ReadingTopic[]; preview?: string; headingRef: RefObject<HTMLHeadingElement | null>; disabled: boolean; run: Run; onSelect: (key: string) => void; onSavedTopic: (topic: ReadingTopic) => void }) {
  const [topicFilter, setTopicFilter] = useState(''), [name, setName] = useState(node.title)
  const record = useWorld((state) => node.source?.nodeId ? state.nodes.get(node.source.nodeId) : undefined)
  const thumbnail = record?.attachments.find((attachment) => attachment.kind === 'image' && attachment.thumbBlobId)?.thumbBlobId
  const annotations = useReading((state) => state.highlights.filter((entry) => entry.sourceId === node.source?.id).length + (state.pdfHighlights ?? []).filter((entry) => entry.sourceId === node.source?.id).length)
  const [expandedPreview, setExpandedPreview] = useState(false)
  const [connectionQuery, setConnectionQuery] = useState(''), [connectionPage, setConnectionPage] = useState(0)
  const connectionsHeading = useRef<HTMLHeadingElement>(null)
  const edges = model.edges.filter((edge) => edge.from === node.key || edge.to === node.key)
  const matchingEdges = edges.filter((edge) => fold(`${model.byKey.get(edge.from === node.key ? edge.to : edge.from)?.title ?? ''} ${edge.label}`).includes(fold(connectionQuery)))
  const lastConnectionPage = Math.max(0, Math.ceil(matchingEdges.length / 50) - 1), currentConnectionPage = Math.min(connectionPage, lastConnectionPage)
  const incoming = edges.filter((edge) => edge.to === node.key || edge.connection?.relation === 'related').length
  const item = items.find((entry) => entry.sourceId === node.source?.id)
  const chosen = item?.topicIds ?? []
  const matchingTopics = topics.filter((topic) => fold(topic.name).includes(fold(topicFilter)))
  function submitName(event: FormEvent) { event.preventDefault(); if (node.endpoint?.kind === 'topic') void run(() => updateTopic(node.endpoint!.id, name), 'Topic renamed.') }
  return <div className="reading-graph-detail">{node.kind === 'topic' && <a className="reading-graph-open" href={topicHref(node.endpoint?.id ?? node.key)}>Open topic home<ArrowRight size={15} aria-hidden="true" /></a>}<span className="reading-graph-kicker">{node.tag ? 'Source tag' : node.writingId && !node.source ? 'Writing draft' : node.kind === 'source' ? 'Original source' : 'Saved topic'}</span><h3 tabIndex={-1} ref={headingRef}>{node.title}</h3><dl className="reading-graph-counts"><div><dt>Neighbors</dt><dd>{model.adjacent.get(node.key)?.size ?? 0}</dd></div><div><dt>Backlinks</dt><dd>{incoming}</dd></div><div><dt>Links out</dt><dd>{edges.length - incoming}</dd></div></dl>
    {node.writingId && <a className="reading-graph-open" href={'#/write?doc=' + encodeURIComponent(node.writingId)}>Open writing <ArrowRight size={15} /></a>}
    {edges.some(edge => edge.passage) && <section className="topic-passage-list"><h4>Linked passages</h4>{edges.filter(edge => edge.passage && edge.writingId).slice(0, 10).map(edge => <article key={edge.id}><a href={passageHref(edge.writingId!, edge.passage!.id, edge.passage!.part)}>{edge.label} · {model.byKey.get(edge.from)?.title}</a><blockquote>{edge.passage!.text}</blockquote><small>{new Date(edge.passage!.updatedAt).toLocaleString()}</small></article>)}</section>}
    {node.source && <><a className="reading-graph-open" href={`#/library?source=${encodeURIComponent(node.source.id)}`} onClick={(event) => { if (!useKnowledge.getState().sources.some((source) => source.id === node.source!.id && !source.excluded && !source.deleted)) event.preventDefault() }}>Open original source<ArrowRight size={16} aria-hidden="true" /></a>{thumbnail && <GraphThumbnail blobId={thumbnail} radius={0} clipId="" />}<div className="reading-graph-source-actions"><button type="button" disabled={disabled} onClick={() => void run(() => createWritingFromSource(node.source!.id), 'Writing draft opened.').then((doc) => { if (doc) location.hash = `#/write?doc=${encodeURIComponent(doc.id)}` })}>{node.source.externalId?.startsWith('writing:') ? 'Edit document' : 'Write from this source'}<ArrowRight size={14} aria-hidden="true" /></button><a href={`#/library?source=${encodeURIComponent(node.source.id)}&tab=highlights`}>{annotations} {annotations === 1 ? 'highlight' : 'highlights'}</a></div>{preview && <div className="reading-graph-excerpt"><h4>From the original</h4><p className="reading-graph-preview">{preview.slice(0, expandedPreview ? 1600 : 300)}{preview.length > (expandedPreview ? 1600 : 300) ? '…' : ''}</p>{preview.length > 300 && <button type="button" className="reading-graph-excerpt-toggle" aria-expanded={expandedPreview} onClick={() => setExpandedPreview((value) => !value)}>{expandedPreview ? 'Less' : 'Read more of the excerpt'}</button>}</div>}<details className="reading-graph-assignment"><summary>Assigned topics{chosen.length ? ` · ${chosen.length}` : ''}</summary>{chosen.length > 0 && <p className="reading-graph-assigned-names">{topics.filter((topic) => chosen.includes(topic.id)).map((topic) => topic.name).join(' · ')}</p>}{topics.length ? <><label>Find topics<input aria-label="Find topics to assign" value={topicFilter} onChange={(event) => setTopicFilter(event.target.value)} autoComplete="off" /></label><div className="reading-graph-topic-choices">{matchingTopics.slice(0, 60).map((topic) => <label key={topic.id}><input type="checkbox" checked={chosen.includes(topic.id)} disabled={disabled} onChange={(event) => { const next = event.target.checked ? [...chosen, topic.id] : chosen.filter((id) => id !== topic.id); void run(() => assignTopics(node.source!.id, next), 'Topic membership saved.') }} />{topic.name}</label>)}</div>{matchingTopics.length > 60 && <p>Showing 60 topics. Refine the name to find another.</p>}</> : <p>Create a topic below to organize this source.</p>}</details></>}
    {node.tag && <div className="reading-graph-tag-note"><p>This node comes from source metadata. Save it as a topic to add manual relationships.</p><button type="button" disabled={disabled} onClick={() => { void run(() => createTopic(node.title), 'Topic saved.').then((topic) => { if (topic) onSavedTopic(topic) }) }}>Save as topic</button></div>}
    {node.endpoint?.kind === 'topic' && <form className="reading-graph-rename" onSubmit={submitName}><label>Topic name<input aria-label="Topic name" value={name} maxLength={160} onChange={(event) => setName(event.target.value)} /></label><button type="submit" disabled={disabled || !name.trim() || name.trim() === node.title}>Rename</button></form>}
    <section className="reading-graph-connections"><h4 ref={connectionsHeading} tabIndex={-1}>Connections <span>{edges.length}</span></h4>{edges.length > 10 && <label>Find a connection<input aria-label="Filter node connections" value={connectionQuery} onChange={(event) => { setConnectionQuery(event.target.value); setConnectionPage(0) }} autoComplete="off" /></label>}{matchingEdges.length ? <ul>{matchingEdges.slice(currentConnectionPage * 50, (currentConnectionPage + 1) * 50).map((edge) => { const outgoing = edge.from === node.key; const other = model.byKey.get(outgoing ? edge.to : edge.from)!; return <li key={edge.id}><button type="button" className="reading-graph-neighbor" onClick={() => onSelect(other.key)}><span>{edge.origin === 'manual' ? `${outgoing ? '→' : '←'} ${edge.label}` : edge.label}</span><strong>{other.title}</strong></button>{edge.writingHref && <a className="reading-graph-remove" href={edge.writingHref} aria-label={`Open wiki link in ${model.byKey.get(edge.from)?.title}`}><ArrowRight size={15} /></a>}{edge.worldLink && <a className="reading-graph-remove" aria-label={`Open ${other.title} relationship in 3D`} href={`#/explore?record=${encodeURIComponent(edge.worldLink.recordId)}`}><Path size={15} aria-hidden="true" /></a>}{edge.connection && <button type="button" className="reading-graph-remove" aria-label={`Remove ${edge.label} connection to ${other.title}`} disabled={disabled} onClick={() => { void run(() => disconnectReading(edge.connection!.id), 'Connection removed.').then(() => connectionsHeading.current?.focus({ preventScroll: true })) }}><X size={15} aria-hidden="true" /></button>}</li> })}</ul> : <p>{connectionQuery ? 'No matching connections.' : 'No connections yet. Add a topic or save a relationship below.'}</p>}{lastConnectionPage > 0 && <div className="reading-graph-pagination"><button type="button" disabled={currentConnectionPage === 0} onClick={() => setConnectionPage(currentConnectionPage - 1)}>Previous links</button><span>{currentConnectionPage + 1}/{lastConnectionPage + 1}</span><button type="button" disabled={currentConnectionPage === lastConnectionPage} onClick={() => setConnectionPage(currentConnectionPage + 1)}>Next links</button></div>}</section>
  </div>
}

function CreateTopic({ disabled, run, onCreate }: { disabled: boolean; run: Run; onCreate: (topic: ReadingTopic) => void }) {
  const [name, setName] = useState('')
  async function submit(event: FormEvent) { event.preventDefault(); const submitted = name.trim(); if (!submitted) return; const topic = await run(() => createTopic(submitted), 'Topic created.'); if (topic) { setName((current) => current.trim() === submitted ? '' : current); onCreate(topic) } }
  return <details className="reading-graph-edit-section"><summary><Plus size={16} aria-hidden="true" />New topic</summary><form onSubmit={(event) => void submit(event)}><label>Topic name<input aria-label="New topic name" value={name} maxLength={160} onChange={(event) => setName(event.target.value)} required placeholder="A subject you’re exploring…" /></label><button type="submit" disabled={disabled || !name.trim()}>Create topic</button></form></details>
}

function EndpointPicker({ label, nodes, value, onChange }: { label: string; nodes: Node[]; value: string; onChange: (value: string) => void }) {
  const [query, setQuery] = useState('')
  const matching = nodes.filter((node) => node.endpoint && fold(node.title).includes(fold(query)))
  const options = matching.slice(0, 60)
  const selected = nodes.find((node) => node.key === value && node.endpoint)
  if (selected && !options.some((node) => node.key === selected.key)) options.unshift(selected)
  return <div className="reading-graph-endpoint"><label>Find {label.toLocaleLowerCase()}<input aria-label={`Find ${label.toLocaleLowerCase()}`} value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} autoComplete="off" placeholder="Source or topic name…" /></label><label>{label}<select aria-label={label} value={selected?.key ?? ''} required onChange={(event) => onChange(event.target.value)}><option value="">Choose a source or topic</option>{options.map((node) => <option key={node.key} value={node.key}>{node.kind === 'source' ? 'Source' : 'Topic'} · {node.title}</option>)}</select></label>{matching.length > 60 && <small>First 60 matches. Search by name to find another.</small>}</div>
}

function ConnectionForm({ model, selected, disabled, run }: { model: Model; selected?: Node; disabled: boolean; run: Run }) {
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [relation, setRelation] = useState<ReadingConnection['relation']>('related')
  const fromKey = from || (selected?.endpoint ? selected.key : '')
  const endpoints = model.nodes.filter((node) => node.endpoint)
  async function submit(event: FormEvent) {
    event.preventDefault()
    const a = model.byKey.get(fromKey)?.endpoint, b = model.byKey.get(to)?.endpoint
    if (!a || !b || fromKey === to) return
    const submittedTo = to
    const connection = await run(() => connectReading({ from: a, to: b, relation }), 'Connection saved locally.')
    if (connection) setTo((current) => current === submittedTo ? '' : current)
  }
  return <details className="reading-graph-edit-section"><summary><LinkSimple size={16} aria-hidden="true" />Connect sources & topics</summary><form onSubmit={(event) => void submit(event)}><EndpointPicker label="Connection from" nodes={endpoints} value={fromKey} onChange={setFrom} /><label>Relationship<select aria-label="Connection relationship" value={relation} onChange={(event) => setRelation(event.target.value as ReadingConnection['relation'])}>{labels.map((label) => <option key={label} value={label}>{relationLabel(label)}</option>)}</select></label><EndpointPicker label="Connection to" nodes={endpoints} value={to} onChange={setTo} />{fromKey && fromKey === to && <p>Choose two different nodes.</p>}<button type="submit" disabled={disabled || !model.byKey.get(fromKey)?.endpoint || !model.byKey.get(to)?.endpoint || fromKey === to}>Save connection</button></form></details>
}
