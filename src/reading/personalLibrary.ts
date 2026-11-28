import { useMemo } from 'react'
import { useWorld } from '../app/store.ts'
import { useKnowledge } from '../knowledge/index.ts'
import { isArtifactProjection } from '../knowledge/derived.ts'
import type { KnowledgeSource } from '../knowledge/types.ts'
import type { NodeRecord } from '../domain/types.ts'
import { useWriting } from '../writing/store.ts'
import type { WritingDocument } from '../writing/types.ts'
import { plainTextFromWriting } from '../writing/model.ts'
import { writingTemplate } from '../writing/templates.ts'
import { useReading } from './store.ts'
import type { ReadingItem } from './types.ts'

function savedNode(node?: NodeRecord) {
  return node?.libraryOrigin === 'saved' || ['file', 'url', 'obsidian', 'chat'].includes(node?.provenance?.source ?? '')
}

export function hasWriting(doc: WritingDocument) {
  if (doc.title.trim() && doc.title.trim() !== 'Untitled writing') return true
  if (doc.subtitle.trim() || doc.byline.trim() || doc.bookEditionId || doc.basedOnSourceId || doc.sourceId) return true
  const words = plainTextFromWriting(doc.content).trim()
  return !!words && words !== plainTextFromWriting(writingTemplate(doc.format)).trim()
}

export function personalLibrary(allSources: KnowledgeSource[], allNodes: Map<string, NodeRecord>, documents: WritingDocument[], items: ReadingItem[]) {
  const visibility = new Map(items.map(item => [item.sourceId, item.libraryVisible]))
  const sources: KnowledgeSource[] = [], earlierSources: KnowledgeSource[] = []
  const represented = new Set<string>(), nodes = new Map<string, NodeRecord>()
  for (const source of allSources) {
    const node = source.nodeId ? allNodes.get(source.nodeId) : undefined
    if (source.nodeId) represented.add(source.nodeId)
    if (source.deleted || source.excluded || node?.corpusExcluded || node?.deletedAt != null || node?.libraryOrigin === 'example' || isArtifactProjection(node)) continue
    const visible = visibility.get(source.id) ?? (source.kind !== 'legacy' || savedNode(node))
    if (!visible) { earlierSources.push(source); continue }
    sources.push(source)
    if (node) nodes.set(node.id, node)
  }
  for (const node of allNodes.values()) {
    if (!represented.has(node.id) && node.deletedAt == null && !node.corpusExcluded && !isArtifactProjection(node) && node.libraryOrigin !== 'example' && savedNode(node)) nodes.set(node.id, node)
  }
  const hiddenWritings = documents.filter(doc => !doc.archivedAt && visibility.get('writing:' + doc.id) === false)
  const sourceIds = new Set(sources.map(source => source.id))
  const writings = documents.filter(doc => !doc.archivedAt && visibility.get('writing:' + doc.id) !== false && (!doc.sourceId || sourceIds.has(doc.sourceId)) && hasWriting(doc))
  return { sources, nodes, writings, earlierSources, hiddenWritings }
}

export function usePersonalLibrary(sourceOverride?: KnowledgeSource[]) {
  const sourceStore = useKnowledge(s => s.sources), nodes = useWorld(s => s.nodes)
  const docs = useWriting(s => s.docs), items = useReading(s => s.items)
  const sources = sourceOverride ?? sourceStore
  return useMemo(() => personalLibrary(sources, nodes, docs, items), [sources, nodes, docs, items])
}
