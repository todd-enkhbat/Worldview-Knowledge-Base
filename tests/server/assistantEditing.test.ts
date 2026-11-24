import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createHost, type Host } from '../../server/host.ts'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'
import { createMemoryClient, revokeMemoryClient } from '../../server/memoryAccess.ts'
import { createShelfBook, emptyBookshelf } from '../../src/bookshelf/model.ts'
import { defaultReadingItem, emptyReading } from '../../src/reading/model.ts'
import { SCHEMA_VERSION } from '../../src/domain/types.ts'
import type { WritingSnapshot } from '../../src/writing/types.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'

const live: { server: Server; host: Host; directory: string; db: WorldDb }[] = []
afterEach(async () => { for (const item of live.splice(0)) { item.server.closeAllConnections(); await new Promise<void>((resolve) => item.server.close(() => resolve())); item.host.close(); item.db.close(); rmSync(item.directory, { recursive: true, force: true }) } })
const management = { 'x-wv-client': 'assistant-test', 'content-type': 'application/json' }
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'worldview-assistant-')), db = openWorldDb(join(directory, 'world.sqlite'))
  db.putSettings({ T0: 0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: 1, schemaVersion: SCHEMA_VERSION })
  const host = createHost({ dataDir: directory }), server = createServer((req, res) => host.handler(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); live.push({ server, host, directory, db })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const json = async (path: string, body?: unknown, token?: string) => { const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: token ? { 'content-type': 'application/json', authorization: `Bearer ${token}` } : management, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { response, value: await response.json() } }
  const approve = (id: string) => json(`/api/connections/assistant/${id}/approve`, {})
  const reject = (id: string) => json(`/api/connections/assistant/${id}/reject`, {})
  return { directory, db, base, json, approve, reject, server }
}

it('stages an MCP draft, applies only after app review, then reads the same authoritative draft without changing 3D', async () => {
  const f = await fixture(), access = await f.json('/api/memory/clients', { name: 'Local editor', sourceIds: [], allowCreateWriting: true }), token = access.value.token as string
  expect(access.response.status).toBe(201)
  const client = new Client({ name: 'editing-acceptance', version: '1' }); await client.connect(new StreamableHTTPClientTransport(new URL(`${f.base}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('propose_create_writing')
    const input = { requestId: 'create-one', expectedRevision: 0, document: { title: 'A draft from my local assistant', text: 'The original words remain in my workspace.' } }
    const proposed = (await client.callTool({ name: 'propose_create_writing', arguments: input })).structuredContent as { proposalId: string; documentId: string }
    expect(f.db.getKv<WritingSnapshot>('writing.v1')?.docs ?? []).toHaveLength(0)
    expect((await f.json('/api/connections/assistant')).value.entries[0]).toMatchObject({ status: 'pending', clientName: 'Local editor' })
    expect((await f.approve(proposed.proposalId)).value).toMatchObject({ status: 'applied', result: { documentId: proposed.documentId, revision: 1 } })
    expect((await f.json('/api/connections/assistant')).value.entries[0].currentDocument).toBeUndefined()
    const read = (await client.callTool({ name: 'read_writing', arguments: { documentId: proposed.documentId } })).structuredContent
    expect(read).toMatchObject({ writingRevision: 1, complete: true, document: { title: input.document.title } })
    expect((await client.callTool({ name: 'propose_create_writing', arguments: input })).structuredContent).toMatchObject({ status: 'applied' })
    expect(f.db.getKv<WritingSnapshot>('writing.v1')?.docs).toHaveLength(1)
    expect(f.db.listNodes()).toEqual([]); expect(f.db.getKnowledgeRevision()).toBe(0)
    const registry = JSON.stringify((await f.json('/api/memory/clients')).value); expect(registry).not.toContain(token); expect(registry).not.toContain('tokenHash')
  } finally { await client.close() }
})

it('refuses stale, revoked, out-of-scope and unsafe updates, retaining a recovery snapshot for an approved edit', async () => {
  const f = await fixture(), access = await f.json('/api/memory/clients', { name: 'Draft editor', sourceIds: [], allowCreateWriting: true }), token = access.value.token as string
  const created = await f.json('/api/memory/propose_create_writing', { requestId: 'create', expectedRevision: 0, document: { title: 'Before', text: 'My original text.' } }, token)
  await f.approve(created.value.proposalId)
  const doc = f.db.getKv<WritingSnapshot>('writing.v1')!.docs[0]
  expect((await f.json('/api/memory/propose_update_writing', { requestId: 'stale', expectedRevision: 0, documentId: doc.id, expectedUpdatedAt: doc.updatedAt, patch: { title: 'Stale' } }, token)).response.status).toBeGreaterThanOrEqual(400)
  const proposed = await f.json('/api/memory/propose_update_writing', { requestId: 'update', expectedRevision: 1, documentId: doc.id, expectedUpdatedAt: doc.updatedAt, patch: { title: 'After', appendText: 'An approved addition.' } }, token)
  const denied = await fetch(`${f.base}/api/connections/assistant/${proposed.value.proposalId}/approve`, { method: 'POST', headers: { ...management, origin: 'https://untrusted.example' } }); expect(denied.status).toBe(403)
  expect((await f.approve(proposed.value.proposalId)).value.status).toBe('applied')
  expect(f.db.getKv<WritingSnapshot>('writing.v1')!.docs[0].title).toBe('After')
  expect(f.db.getKv<{ entries: { document: { title: string } }[] }>('writingHistory.v1')!.entries.at(-1)!.document.title).toBe('Before')
  const latest = f.db.getKv<WritingSnapshot>('writing.v1')!.docs[0]
  const pending = await f.json('/api/memory/propose_update_writing', { requestId: 'conflict', expectedRevision: 2, documentId: doc.id, expectedUpdatedAt: latest.updatedAt, patch: { title: 'Assistant stale comparison' } }, token)
  const changed = f.db.getKv<WritingSnapshot>('writing.v1')!; changed.docs[0].title = 'A newer human edit'; changed.docs[0].updatedAt++; changed.revision++; f.db.putKv('writing.v1', changed)
  expect((await f.approve(pending.value.proposalId)).response.status).toBeGreaterThanOrEqual(400)
  expect(f.db.getKv<WritingSnapshot>('writing.v1')!.docs[0].title).toBe('A newer human edit')
  expect((await f.reject(pending.value.proposalId)).value.status).toBe('rejected')
  const unauthorized = createMemoryClient(f.db, 'local', { name: 'Unrelated creator', sourceIds: [], allowCreateWriting: true }).token
  expect((await f.json('/api/memory/read_writing', { documentId: doc.id }, unauthorized)).response.status).toBeGreaterThanOrEqual(400)
  const malformed = await f.json('/api/memory/propose_create_writing', { requestId: 'unsafe', expectedRevision: 3, document: { title: 'Unsafe', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] } } }, token)
  expect(malformed.response.status).toBeGreaterThanOrEqual(400)
  const later = await f.json('/api/memory/propose_create_writing', { requestId: 'before-revoke', expectedRevision: 3, document: { title: 'Should not apply', text: 'Unapproved.' } }, token)
  await fetch(`${f.base}/api/memory/clients/${access.value.client.id}`, { method: 'DELETE', headers: management })
  expect((await f.approve(later.value.proposalId)).response.status).toBeGreaterThanOrEqual(400)
  expect((await f.reject(later.value.proposalId)).value.status).toBe('rejected')
})

it('reviews selected-source organization atomically, preserving originals and unrelated current reading changes', async () => {
  const f = await fixture(), source = { id: 'a', externalId: 'a', title: 'Scoped source', kind: 'document' as const, currentVersionId: 'v-a', createdAt: 1, updatedAt: 1, excluded: false, aiAllowed: true, tags: [] }
  const corpus: KnowledgeSnapshot = { schemaVersion: 1, revision: 1, sources: [source], versions: [{ id: 'v-a', sourceId: 'a', contentHash: 'h', originalBlobId: 'original', originalName: 'source.txt', text: 'Exact retained original.', createdAt: 1, authoredAt: null, origin: 'import' }], passages: [], imports: [], jobs: [], proposals: [] }; f.db.putKv('knowledge.v1', corpus)
  const access = await f.json('/api/memory/clients', { name: 'Organizer', sourceIds: ['a'], allowFiling: true }), token = access.value.token as string
  const pending = await f.json('/api/memory/propose_filing', { requestId: 'file-one', expectedRevision: 0, sourceId: 'a', patch: { favorite: true }, newTopic: 'Research', newFolder: 'Reading desk' }, token)
  expect(pending.response.status).toBe(200)
  expect(f.db.getKv('reading.v1')).toBeUndefined()
  expect((await f.approve(pending.value.proposalId)).value.status).toBe('applied')
  const reading = f.db.getKv<{ items: { favorite: boolean; folderId: string; topicIds: string[] }[]; topics: { name: string }[]; folders: { name: string }[] }>('reading.v1')!
  expect(reading.items[0]).toMatchObject({ favorite: true }); expect(reading.topics[0].name).toBe('Research'); expect(reading.folders[0].name).toBe('Reading desk')
  expect(f.db.getKv<KnowledgeSnapshot>('knowledge.v1')).toEqual(corpus); expect(f.db.listNodes()).toEqual([])
  const blocked = f.db.getKv<KnowledgeSnapshot>('knowledge.v1')!; blocked.sources[0].aiAllowed = false; blocked.revision++; f.db.putKv('knowledge.v1', blocked)
  expect((await f.json('/api/memory/propose_filing', { requestId: 'blocked', expectedRevision: 1, sourceId: 'a', patch: { favorite: false } }, token)).response.status).toBeGreaterThanOrEqual(400)
})

it('does not approve a new-folder proposal over a human move that happened after the proposal', async () => {
  const f = await fixture(), source = { id: 'a', externalId: 'a', title: 'Original source', kind: 'document', currentVersionId: 'v', createdAt: 1, updatedAt: 1, excluded: false, aiAllowed: true, tags: [] }
  f.db.putKv('knowledge.v1', { schemaVersion: 1, revision: 1, sources: [source], versions: [], passages: [], imports: [], jobs: [], proposals: [] })
  const access = await f.json('/api/memory/clients', { name: 'Filing assistant', sourceIds: ['a'], allowFiling: true })
  const pending = await f.json('/api/memory/propose_filing', { requestId: 'new-folder', expectedRevision: 0, sourceId: 'a', patch: {}, newFolder: 'Assistant folder' }, access.value.token)
  expect(pending.value.reviewUrl).toBe('#/sources?connection=memory')
  const reading = emptyReading(); reading.revision = 1; reading.folders.push({ id: 'human-folder', name: 'My new folder', parentId: null, createdAt: 2 }); reading.items.push({ ...defaultReadingItem('a'), folderId: 'human-folder' }); f.db.putKv('reading.v1', reading)
  expect((await f.approve(pending.value.proposalId)).response.status).toBeGreaterThanOrEqual(400)
  expect(f.db.getKv<typeof reading>('reading.v1')!.items[0].folderId).toBe('human-folder')
  expect(f.db.getKv<typeof reading>('reading.v1')!.folders).toHaveLength(1)
})

it('rejects new missing topic links and forged quotation attribution or provenance URLs', async () => {
  const f = await fixture(), source = { id: 'a', externalId: 'a', title: 'The retained source', kind: 'document', currentVersionId: 'v', createdAt: 1, updatedAt: 1, excluded: false, aiAllowed: true, tags: [] }, text = 'Exact words from an original.'
  f.db.putKv('knowledge.v1', { schemaVersion: 1, revision: 1, sources: [source], versions: [{ id: 'v', sourceId: 'a', text, metadata: { url: 'https://example.org/retained' } }], passages: [], imports: [], jobs: [], proposals: [] })
  const access = await f.json('/api/memory/clients', { name: 'Citation assistant', sourceIds: ['a'], allowCreateWriting: true }), token = access.value.token
  const proposed = (requestId: string, content: unknown) => f.json('/api/memory/propose_create_writing', { requestId, expectedRevision: 0, document: { title: 'A source-backed draft', content } }, token)
  expect((await proposed('missing-topic', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'writingTopicLink', attrs: { topicId: 'missing-topic', label: 'Fabricated topic' } }] }] })).response.status).toBeGreaterThanOrEqual(400)
  const citation = { sourceId: 'a', versionId: 'v', sourceTitle: 'A misleading title', quote: text, start: 0, end: text.length }
  expect((await proposed('wrong-title', { type: 'doc', content: [{ type: 'writingCitation', attrs: citation }] })).response.status).toBeGreaterThanOrEqual(400)
  expect((await proposed('wrong-url', { type: 'doc', content: [{ type: 'writingCitation', attrs: { ...citation, sourceTitle: source.title, url: 'https://attacker.example/not-the-source' } }] })).response.status).toBeGreaterThanOrEqual(400)
  expect((await proposed('exact-citation', { type: 'doc', content: [{ type: 'writingCitation', attrs: { ...citation, sourceTitle: source.title, url: 'https://example.org/retained' } }] })).value.status).toBe('pending')
})

it('rechecks an authenticated client after its request body arrives so in-flight revocation closes access', async () => {
  const f = await fixture(), access = createMemoryClient(f.db, 'local', { name: 'Revoked in flight', sourceIds: [], allowCreateWriting: true })
  const arrived = new Promise<void>((resolve) => f.server.once('request', () => resolve()))
  let finish!: () => void
  const completed = new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(`${f.base}/api/memory/list_writing`, { method: 'POST', headers: { authorization: `Bearer ${access.token}`, 'content-type': 'application/json' } }, (response) => { let body = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { body += chunk }); response.on('end', () => resolve({ status: response.statusCode!, body })) })
    request.on('error', reject); request.write('{"offset":'); finish = () => request.end('0}')
  })
  await arrived; revokeMemoryClient(f.db, access.client.id); finish()
  const response = await completed
  expect(response.status).toBeGreaterThanOrEqual(400); expect(response.body).toMatch(/revoked|expired/)
})

it('scopes bookshelf metadata, stages changes, and retains full details before an approved book edit', async () => {
  const f = await fixture(), book = createShelfBook({ title: 'A personally edited book', notes: 'My original recommendation', recommendedBy: 'A reading group', rating: 4.5 }), other = createShelfBook({ title: 'A private unrelated book' }), shelf = emptyBookshelf(); shelf.books.push(book, other); f.db.putKv('bookshelves.v1', shelf)
  const access = await f.json('/api/memory/clients', { name: 'Book assistant', sourceIds: [], bookshelfBookIds: [book.id], allowCreateBooks: true }), token = access.value.token
  expect((await f.json('/api/memory/list_books', {}, token)).value.books.map((entry: { id: string }) => entry.id)).toEqual([book.id])
  expect((await f.json('/api/memory/read_book', { bookId: other.id }, token)).response.status).toBeGreaterThanOrEqual(400)
  const pending = await f.json('/api/memory/propose_update_book', { requestId: 'book-note', expectedRevision: 0, bookId: book.id, expectedUpdatedAt: book.updatedAt, patch: { rating: 5, appendNotes: '\nA useful addition.' } }, token)
  expect(f.db.getKv<typeof shelf>('bookshelves.v1')!.books[0].rating).toBe(4.5)
  expect((await f.approve(pending.value.proposalId)).value.result.bookId).toBe(book.id)
  const saved = f.db.getKv<typeof shelf>('bookshelves.v1')!
  expect(saved.books[0]).toMatchObject({ rating: 5, recommendedBy: 'A reading group', notes: 'My original recommendation\nA useful addition.' })
  expect(saved.history.at(-1)!.book).toEqual(book)
  const create = await f.json('/api/memory/propose_create_book', { requestId: 'new-article', expectedRevision: saved.revision, book: { title: 'An article to revisit', kind: 'article', format: 'digital', recommendedBy: 'My assistant' } }, token)
  expect((await f.approve(create.value.proposalId)).value.status).toBe('applied')
  expect((await f.json('/api/memory/read_book', { bookId: create.value.bookId }, token)).value.book.title).toBe('An article to revisit')
  const unrelated = createMemoryClient(f.db, 'local', { name: 'Writing-only client', sourceIds: [], allowCreateWriting: true })
  expect((await f.json('/api/memory/list_books', {}, unrelated.token)).response.status).toBeGreaterThanOrEqual(400)
  expect(f.db.listNodes()).toEqual([])
})

it('refuses a restored proposal whose record identity differs from its reviewed target', async () => {
  const f = await fixture(), access = createMemoryClient(f.db, 'local', { name: 'Recovery assistant', sourceIds: [], allowCreateWriting: true, allowCreateBooks: true })
  const draft = await f.json('/api/memory/propose_create_writing', { requestId: 'restored-draft', expectedRevision: 0, document: { title: 'The reviewed draft', text: 'My words.' } }, access.token)
  const book = await f.json('/api/memory/propose_create_book', { requestId: 'restored-book', expectedRevision: 0, book: { title: 'The reviewed book' } }, access.token)
  const ledger = f.db.getKv<{ entries: { id: string; document?: { id: string }; book?: { id: string } }[] }>('assistantEdits.v1')!
  ledger.entries.find((entry) => entry.id === draft.value.proposalId)!.document!.id = 'a-different-draft'
  ledger.entries.find((entry) => entry.id === book.value.proposalId)!.book!.id = 'a-different-book'
  f.db.putKv('assistantEdits.v1', ledger)
  expect((await f.approve(draft.value.proposalId)).response.status).toBeGreaterThanOrEqual(400)
  expect((await f.approve(book.value.proposalId)).response.status).toBeGreaterThanOrEqual(400)
  expect(f.db.getKv<WritingSnapshot>('writing.v1')?.docs ?? []).toEqual([])
  expect(f.db.getKv('bookshelves.v1')).toBeUndefined()
  expect(f.db.getKv<typeof ledger>('assistantEdits.v1')!.entries).toHaveLength(2)
})
