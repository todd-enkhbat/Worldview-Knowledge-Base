import { describe, expect, it } from 'vitest'
import { bookHref } from '../../src/bookshelf/model.ts'
import type { ShelfBook } from '../../src/bookshelf/types.ts'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import type { KnowledgeSource, SourceVersion } from '../../src/knowledge/types.ts'
import type { KnowledgePage } from '../../src/knowledge/artifacts/types.ts'
import type { SavedInvestigation } from '../../src/workspace/collections.ts'
import { exploreRecords } from '../../src/world/exploreRecords.ts'
import { defaultWritingAppearance } from '../../src/writing/model.ts'
import type { WritingDocument } from '../../src/writing/types.ts'

const source = (id: string, patch: Partial<KnowledgeSource> = {}): KnowledgeSource => ({ id, externalId: id, title: id, kind: 'document', currentVersionId: 'v-' + id, createdAt: 7, updatedAt: 8, excluded: false, aiAllowed: true, tags: [], ...patch })
const version = (id: string, authoredAt: number): SourceVersion => ({ id: 'v-' + id, sourceId: id, contentHash: id, originalBlobId: id, originalName: id + '.md', text: 'Fixture text', createdAt: 10, authoredAt, origin: 'import' })
const book = (id: string, patch: Partial<ShelfBook> = {}): ShelfBook => ({ id, title: id, subtitle: '', authors: [], kind: 'book', format: 'print', status: 'read', rating: 0, recommendedBy: '', notes: '', url: '', isbn: '', year: null, pages: null, startedAt: null, finishedAt: null, shelfIds: [], fields: [], coverAssetId: null, design: { color: '#1c2531', ink: '#ffffff', style: 'classic', pattern: 'none' }, createdAt: 12, updatedAt: 17, archivedAt: null, ...patch })
const writing = (id: string, patch: Partial<WritingDocument> = {}): WritingDocument => ({ id, title: id, subtitle: '', byline: '', format: 'essay', content: { type: 'doc' }, appearance: defaultWritingAppearance(), createdAt: 15, updatedAt: 16, archivedAt: null, ...patch })
const query = (id: string, patch: Partial<SavedInvestigation> = {}): SavedInvestigation => ({ id, title: id, query: 'What changed?', sourceIds: [], questions: [], authoredAfter: '2002-01-01', authoredBefore: '2005-01-01', role: 'human', sourceKind: 'all', updatedAt: 19, ...patch })
const page = (id: string, patch: Partial<KnowledgePage> = {}): KnowledgePage => ({ id, title: id, kind: 'project', sourceIds: [], question: null, currentRevisionId: null, projectedNodeId: null, createdAt: 22, updatedAt: 23, archivedAt: null, ...patch })

describe('Explore records', () => {
  it('links original records and includes retained sources that have no scene projection', () => {
    const thought = makeNodeDraft('idea', { id: 'thought-node', temporalOrigin: 24 })
    const records = exploreRecords({
      nodes: new Map([[thought.id, thought]]),
      sources: [source('memo'), source('file-linked-to-book'), source('snapshot', { externalId: 'writing:essay' }), source('idea', { kind: 'thought', nodeId: thought.id })],
      versions: [version('memo', 3)],
      books: [book('book', { sourceId: 'file-linked-to-book' })],
      writings: [writing('essay', { sourceId: 'snapshot' }), writing('book-note', { bookEditionId: 'book' })],
      investigations: [query('investigation', { createdAt: 11 }), query('older-investigation')],
      pages: [page('project')],
    })
    const indexed = Object.fromEntries(records.map(record => [record.key, record]))
    expect(indexed['source:memo']).toMatchObject({ kind: 'source', date: 3, href: '#/library?source=memo' })
    expect(indexed['book:book']).toMatchObject({ href: bookHref('book'), date: 12 })
    expect(indexed['source:file-linked-to-book']?.href).toBe('#/library?source=file-linked-to-book')
    expect(indexed['writing:essay']?.href).toBe('#/write?doc=essay')
    expect(indexed['writing:book-note']?.href).toBe(bookHref('book', 'book-note'))
    expect(indexed['source:idea']).toMatchObject({ kind: 'idea', nodeId: thought.id, date: 24 })
    expect(indexed['node:thought-node']).toBeUndefined()
    expect(indexed['source:snapshot']).toBeUndefined()
    expect(indexed['investigation:investigation']).toMatchObject({ investigationId: 'investigation', date: 11, dateRange: 'From 2002-01-01 through 2005-01-01' })
    expect(indexed['investigation:older-investigation']?.date).toBe(19)
    expect(indexed['page:project']?.href).toBe('#/knowledge?page=project')
  })

  it('keeps archived rows and excluded content out of the active record view', () => {
    const withheld = makeNodeDraft('document', { id: 'withheld-node' })
    const hidden = makeNodeDraft('idea', { id: 'example', libraryOrigin: 'example' })
    expect(exploreRecords({
      nodes: new Map([[withheld.id, withheld], [hidden.id, hidden]]),
      sources: [source('withheld', { excluded: true, nodeId: withheld.id }), source('removed', { deleted: true }), source('example-source', { nodeId: hidden.id })],
      versions: [],
      books: [book('archived-book', { archivedAt: 30 })],
      writings: [writing('archived-essay', { archivedAt: 30 }), writing('private-essay', { sourceId: 'withheld' })],
      investigations: [query('archived-query', { deletedAt: 31 })],
      pages: [page('archived-page', { archivedAt: 32 })],
    })).toEqual([])
  })
})
