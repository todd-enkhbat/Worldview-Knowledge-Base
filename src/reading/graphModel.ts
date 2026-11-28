import { writingPassages, writingReferenceStructure, type WritingPassage } from '../writing/concepts.ts'
import type { WritingDocument } from '../writing/types.ts'
import { buildTypedLinks, LINK_STYLE } from '../world/links/style.ts'
import type { NodeRecord } from '../domain/types.ts'
import type { KnowledgeSource } from '../knowledge/types.ts'
import type { ReadingConnection, ReadingItem, ReadingTopic } from './types.ts'
import { normalizeTopicName, resolveTopics } from './topics.ts'

type Endpoint = ReadingConnection['from']
export type GraphNode = { key: string; title: string; kind: 'source' | 'topic'; endpoint: Endpoint | null; source?: KnowledgeSource; writingId?: string; tag?: string; at?: number }
export type GraphEdge = { id: string; from: string; to: string; label: string; origin: 'assigned' | 'tag' | 'manual' | 'world' | 'writing'; passage?: WritingPassage; writingId?: string; writingHref?: string; at?: number; connection?: ReadingConnection; worldLink?: { recordId: string; relation: ReadingConnection['relation']; directed: boolean } }
export type GraphModel = { nodes: GraphNode[]; byKey: Map<string, GraphNode>; edges: GraphEdge[]; adjacent: Map<string, Set<string>> }
const endpointKey = (endpoint: Endpoint) => `${endpoint.kind}:${endpoint.id}`
const relationLabel = (relation: ReadingConnection['relation']) => relation.replaceAll('-', ' ')

export function buildGraphModel(sources: KnowledgeSource[], topics: ReadingTopic[], items: ReadingItem[], connections: ReadingConnection[], worldRecords: ReadonlyMap<string, NodeRecord> = new Map(), writings: WritingDocument[] = []): GraphModel {
  const byKey = new Map<string, GraphNode>(), edges = new Map<string, GraphEdge>()
  const canonical = resolveTopics(sources, topics, items), names = new Map(canonical.map((topic) => [normalizeTopicName(topic.name), topic]))
  const topicsById = new Map(topics.map((topic) => [topic.id, topic]))
  const aliases = new Map<string, string>()
  for (const topic of canonical) {
    const key = topic.readingTopicIds.length ? `topic:${topic.id}` : topic.id
    const saved = topic.readingTopicIds[0]
    byKey.set(key, { key, title: topic.name, kind: 'topic', endpoint: saved ? { kind: 'topic', id: saved } : null, at: saved ? topicsById.get(saved)?.createdAt : undefined, ...(!saved ? { tag: topic.name } : {}) })
    for (const alias of topic.aliases) aliases.set(alias.startsWith('tag:') ? alias : `topic:${alias}`, key)
  }
  for (const source of sources.filter((entry) => !entry.excluded && !entry.deleted)) {
    const key = `source:${source.id}`
    byKey.set(key, { key, title: source.title || 'Untitled source', kind: 'source', source, at: (source.nodeId ? worldRecords.get(source.nodeId)?.temporalOrigin : undefined) ?? source.createdAt, endpoint: { kind: 'source', id: source.id } })
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
    if (from !== to && byKey.has(from) && byKey.has(to)) edges.set(connection.id, { id: connection.id, from, to, label: relationLabel(connection.relation), origin: 'manual', at: connection.createdAt, connection })
  }
  const sourceForRecord = new Map(sources.filter((source) => !source.deleted && !source.excluded && source.nodeId).map((source) => [source.nodeId!, `source:${source.id}`]))
  const liveRecords = new Map([...worldRecords].filter(([id, record]) => sourceForRecord.has(id) && record.deletedAt === null && !record.corpusExcluded))
  for (const link of buildTypedLinks(liveRecords)) {
    const from = sourceForRecord.get(link.from)!, to = sourceForRecord.get(link.to)!
    if (!byKey.has(from) || !byKey.has(to)) continue
    const id = `world:${link.declaredBy}:${link.target}`, directed = LINK_STYLE[link.kind].arrow
    const relation = link.kind === 'relates' ? 'related' : link.kind === 'derives' || link.kind === 'influenced-by' ? 'builds-on' : link.kind
    edges.set(id, { id, from, to, label: link.kind === 'derives' ? 'basis for · 3D world' : link.kind === 'influenced-by' ? 'influences · 3D world' : `${LINK_STYLE[link.kind].verb} · 3D world`, origin: 'world', at: liveRecords.get(link.declaredBy)?.links.find((entry) => entry.targetId === link.target && entry.kind === link.kind)?.createdAt, worldLink: { recordId: link.declaredBy, directed, relation } })
  }
  for (const doc of writings) {
    if (doc.archivedAt !== null) continue
    const published = doc.sourceId && byKey.get('source:' + doc.sourceId)
    const from = published ? published.key : 'writing:' + doc.id
    function endpoint(topicId: string) {
      const to = aliases.get(topicId) ?? aliases.get('topic:' + topicId) ?? topicId
      if (!byKey.has(to)) return
      if (published) published.writingId = doc.id
      else if (!byKey.has(from)) byKey.set(from, { key: from, title: doc.title || 'Untitled writing', kind: 'source', writingId: doc.id, at: doc.createdAt, endpoint: null })
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
      edges.set(id, { id, from, to, label: passage.relation === 'example' ? 'example of' : 'concept passage', origin: 'writing', at: passage.createdAt, passage, writingId: doc.id })
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
