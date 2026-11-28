import { bookHref } from '../bookshelf/model.ts'
import type { ShelfBook } from '../bookshelf/types.ts'
import type { NodeRecord } from '../domain/types.ts'
import { isArtifactProjection } from '../knowledge/derived.ts'
import type { KnowledgePage } from '../knowledge/artifacts/types.ts'
import type { KnowledgeSource, SourceVersion } from '../knowledge/types.ts'
import type { SavedInvestigation } from '../workspace/collections.ts'
import type { WritingDocument } from '../writing/types.ts'
import { hasWriting } from '../reading/personalLibrary.ts'

export const EXPLORE_KINDS = {
  idea: { label: 'Ideas & notes', singular: 'Note', color: '#94dbc4' },
  source: { label: 'Files & sources', singular: 'Source', color: '#88b7ed' },
  book: { label: 'Books & articles', singular: 'Bookshelf', color: '#f0c581' },
  writing: { label: 'Writing', singular: 'Writing', color: '#d2b3f7' },
  query: { label: 'Saved queries', singular: 'Saved query', color: '#f2a78e' },
  page: { label: 'Knowledge pages', singular: 'Knowledge page', color: '#9cdbe9' },
} as const

export type ExploreKind = keyof typeof EXPLORE_KINDS

export interface ExploreRecord {
  key: string
  title: string
  kind: ExploreKind
  date: number
  detail: string
  dateRange?: string
  href?: string
  investigationId?: string
  nodeId?: string
}

interface RecordsInput {
  nodes: ReadonlyMap<string, NodeRecord>
  sources: readonly KnowledgeSource[]
  versions: readonly SourceVersion[]
  books: readonly ShelfBook[]
  writings: readonly WritingDocument[]
  investigations: readonly SavedInvestigation[]
  pages: readonly KnowledgePage[]
}

/** Derive a view over active workspace records. No copies are written to the scene or the repository. */
export function exploreRecords({ nodes, sources, versions, books, writings, investigations, pages }: RecordsInput): ExploreRecord[] {
  const records: ExploreRecord[] = []
  const usedNodes = new Set<string>()
  const representedSources = new Set<string>()
  const sourcesById = new Map(sources.map(source => [source.id, source]))
  const allowedNode = (node: NodeRecord | undefined): node is NodeRecord => !!node && node.deletedAt == null && !node.corpusExcluded && node.libraryOrigin !== 'example'
  const sourceAvailable = (source: KnowledgeSource) => !source.deleted && !source.excluded && (!source.nodeId || !nodes.has(source.nodeId) || allowedNode(nodes.get(source.nodeId)))
  const dates = new Map<string, number>()
  for (const version of versions) {
    if (sourcesById.get(version.sourceId)?.currentVersionId === version.id && version.authoredAt != null) dates.set(version.sourceId, version.authoredAt)
  }
  function linkedNode(id: string | undefined) {
    const node = id ? nodes.get(id) : undefined
    if (!allowedNode(node)) return undefined
    usedNodes.add(node.id)
    return node.id
  }
  const activeBooks = new Set(books.filter(book => book.archivedAt == null).map(book => book.id))
  for (const book of books) {
    if (book.archivedAt != null) continue
    const source = book.sourceId ? sourcesById.get(book.sourceId) : undefined
    records.push({ key: 'book:' + book.id, kind: 'book', title: book.title, date: book.createdAt, detail: book.authors.join(', '), href: bookHref(book.id), nodeId: source && sourceAvailable(source) ? linkedNode(source.nodeId) : undefined })
  }
  for (const doc of writings) {
    const source = doc.sourceId ? sourcesById.get(doc.sourceId) : undefined
    if (doc.archivedAt != null || !hasWriting(doc) || source && !sourceAvailable(source)) continue
    if (source?.externalId === 'writing:' + doc.id) representedSources.add(source.id)
    records.push({ key: 'writing:' + doc.id, kind: 'writing', title: doc.title || 'Untitled writing', date: doc.createdAt, detail: doc.subtitle || doc.byline, href: doc.bookEditionId && activeBooks.has(doc.bookEditionId) ? bookHref(doc.bookEditionId, doc.id) : '#/write?doc=' + encodeURIComponent(doc.id), nodeId: linkedNode(source?.nodeId) })
  }
  for (const page of pages) {
    if (page.archivedAt != null) continue
    records.push({ key: 'page:' + page.id, kind: 'page', title: page.title, date: page.createdAt, detail: page.kind, href: '#/knowledge?page=' + encodeURIComponent(page.id), nodeId: linkedNode(page.projectedNodeId ?? undefined) })
  }
  const withheldNodes = new Set<string>()
  for (const source of sources) {
    if (!sourceAvailable(source)) { if (source.nodeId) withheldNodes.add(source.nodeId); continue }
    if (representedSources.has(source.id)) continue
    const nodeId = linkedNode(source.nodeId)
    const node = nodeId ? nodes.get(nodeId) : undefined
    const kind = node?.archetype === 'demon' ? 'query'
      : source.kind === 'thought' || source.kind === 'legacy' && node && node.archetype !== 'document' ? 'idea' : 'source'
    records.push({ key: 'source:' + source.id, kind, title: source.title, date: node?.temporalOrigin ?? dates.get(source.id) ?? source.createdAt, detail: node?.demon?.query || source.tags.slice(0, 4).join(' · '), nodeId, href: kind === 'query' ? undefined : '#/library?source=' + encodeURIComponent(source.id) })
  }
  for (const node of nodes.values()) {
    if (!allowedNode(node) || usedNodes.has(node.id) || withheldNodes.has(node.id) || isArtifactProjection(node)) continue
    const kind = node.archetype === 'demon' ? 'query' : node.archetype === 'document' ? 'source' : 'idea'
    records.push({ key: 'node:' + node.id, kind, title: node.title, date: node.temporalOrigin, detail: node.demon?.query || node.tags.slice(0, 4).join(' · '), nodeId: node.id, href: kind === 'query' ? undefined : '#/library?record=' + encodeURIComponent(node.id) })
  }
  for (const item of investigations) {
    if (item.deletedAt != null) continue
    records.push({ key: 'investigation:' + item.id, kind: 'query', title: item.title, date: item.createdAt ?? item.updatedAt, detail: item.query,
      dateRange: [item.authoredAfter && `From ${item.authoredAfter}`, item.authoredBefore && `through ${item.authoredBefore}`].filter(Boolean).join(' '), investigationId: item.id })
  }
  return records.sort((a, b) => b.date - a.date || a.title.localeCompare(b.title) || a.key.localeCompare(b.key))
}
