import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createHost, type Host } from '../../server/host.ts'
import { openWorldDb } from '../../server/worldDb.ts'
import { createMemoryClient } from '../../server/memoryAccess.ts'
import { createMemoryReader } from '../../server/memoryService.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'

const running: { server: HttpServer; host: Host; dir: string }[] = []
afterEach(async () => { for (const item of running.splice(0)) { item.server.closeAllConnections(); await new Promise<void>((resolve) => item.server.close(() => resolve())); item.host.close(); rmSync(item.dir, { recursive: true, force: true }) } })
const json = (body: unknown, token?: string) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : { 'x-wv-client': 'test' }) }, body: JSON.stringify(body) })
function corpus(): KnowledgeSnapshot {
  const sources = ['a', 'b'].map((id) => ({ id, externalId: id, title: `Project ${id}`, kind: 'document' as const, currentVersionId: `v-${id}`, createdAt: 1, updatedAt: 1, excluded: false, aiAllowed: true, tags: [] }))
  const versions = sources.map((source) => ({ id: source.currentVersionId, sourceId: source.id, contentHash: 'hash', originalBlobId: 'raw', originalName: 'note.md', text: `The amber lighthouse decision for ${source.id} is ${source.id === 'a' ? '312' : '917'}.`, createdAt: 1, authoredAt: 100, origin: 'import' as const }))
  const passages = versions.map((version) => ({ id: `p-${version.sourceId}`, sourceId: version.sourceId, versionId: version.id, title: `Project ${version.sourceId}`, text: version.text, start: 0, end: version.text.length, role: 'human' as const, authoredAt: 100 }))
  return { schemaVersion: 1, revision: 1, sources, versions, passages, imports: [], jobs: [], proposals: [] }
}
async function serve(accounts = false, now?: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'wv-memory-')), host = createHost({ dataDir: dir, accounts, signup: 'open', now })
  const server = createServer((req, res) => host.handler(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  running.push({ server, host, dir })
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, host }
}

describe('shared agent memory end to end', () => {
  it('discards cached evidence when a restored world reuses the same revision', () => {
    const db = openWorldDb(':memory:'), read = createMemoryReader(db)
    try {
      db.putKv('knowledge.v1', corpus())
      const token = createMemoryClient(db, 'local', { name: 'reader', sourceIds: ['a'] }).client
      const client = { ...token, tokenHash: '' }
      expect(read('search', { query: 'lighthouse' }, client)).toMatchObject({ hits: [{ id: 'p-a' }] })
      db.wipe()
      const restored = corpus(); restored.versions[0].text = 'A new violet receiver decision.'; restored.passages[0] = { ...restored.passages[0], text: restored.versions[0].text, end: restored.versions[0].text.length }
      db.putKv('knowledge.v1', restored)
      expect(read('search', { query: 'lighthouse' }, client)).toMatchObject({ hits: [] })
      expect(read('search', { query: 'violet' }, client)).toMatchObject({ hits: [{ text: 'A new violet receiver decision.' }] })
    } finally { db.close() }
  })
  it('negotiates MCP with a real SDK client and returns exact scoped evidence shared by two clients', async () => {
    const service = await serve(), db = openWorldDb(join(service.dir, 'world.sqlite')); db.putKv('knowledge.v1', corpus()); db.close()
    const register = async (name: string) => { const response = await fetch(`${service.base}/api/memory/clients`, json({ name, sourceIds: ['a'] })); expect(response.status).toBe(201); return (await response.json()).token as string }
    const first = await register('Agent one'), second = await register('Agent two')
    const client = new Client({ name: 'integration-test', version: '1.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${service.base}/api/mcp`), { requestInit: { headers: { Authorization: `Bearer ${first}` } } }))
    try {
      const tools = await client.listTools(); expect(tools.tools.map((tool) => tool.name)).toEqual(['search', 'read_passage', 'read_record', 'get_project_context', 'get_memory_context', 'status'])
      const result = await client.callTool({ name: 'search', arguments: { query: 'lighthouse' } })
      expect(result.structuredContent).toMatchObject({ hits: [{ id: 'p-a', sourceId: 'a', text: corpus().versions[0].text }] })
      const read = await client.callTool({ name: 'read_passage', arguments: { id: 'p-a' } })
      expect(read.structuredContent).toMatchObject({ ok: true, citationUrl: '#/library?passage=p-a', text: corpus().versions[0].text })
      const denied = await client.callTool({ name: 'read_passage', arguments: { id: 'p-b' } }); expect(denied.structuredContent).toMatchObject({ ok: false })
      const other = await (await fetch(`${service.base}/api/memory/search`, json({ query: 'lighthouse' }, second))).json(); expect(other.hits.map((hit: { id: string }) => hit.id)).toEqual(['p-a'])
      const context = await client.callTool({ name: 'get_memory_context', arguments: { query: 'lighthouse', maxBytes: 1024 } }); expect(context.structuredContent).toMatchObject({ budgetUnit: 'utf8-bytes', evidence: [{ id: 'p-a' }] })
    } finally { await client.close() }
    expect((await fetch(`${service.base}/api/mcp`, { headers: { authorization: `Bearer ${first}` } })).status).toBe(405)
  })

  it('rechecks consent, project membership, role/date scope, expiry and revocation on every request', async () => {
    let now = 1000
    const service = await serve(false, () => now), db = openWorldDb(join(service.dir, 'world.sqlite'))
    db.putKv('knowledge.v1', corpus()); db.putKv('collections.v1', { collections: [{ id: 'project-a', title: 'Private project', query: 'lighthouse', questions: ['Why?'], sourceIds: ['a'] }] })
    const { token, client } = createMemoryClient(db, 'local', { name: 'project agent', allSources: true, projectId: 'project-a' }, now)
    const call = async (operation: string, input: unknown = {}) => (await fetch(`${service.base}/api/memory/${operation}`, json(input, token))).json()
    expect((await call('search', { query: 'lighthouse', filters: { sourceIds: ['b'] } })).hits).toEqual([])
    expect((await call('search', { query: 'lighthouse', filters: { role: 'assistant' } })).hits).toEqual([])
    expect((await call('search', { query: 'lighthouse', filters: { authoredAfter: 101 } })).hits).toEqual([])
    expect(await call('get_project_context')).toMatchObject({ ok: true, sourceIds: ['a'] })
    const changed = corpus(); changed.revision = 2; changed.sources[0].aiAllowed = false; db.putKv('knowledge.v1', changed)
    expect((await call('search', { query: 'lighthouse' })).hits).toEqual([])
    expect(await call('read_passage', { id: 'p-a' })).toMatchObject({ ok: false })
    expect(await call('get_project_context')).toMatchObject({ ok: false })
    now = client.expiresAt; expect((await fetch(`${service.base}/api/memory/status`, json({}, token))).status).toBe(401)
    now = 1000
    expect((await fetch(`${service.base}/api/memory/clients/${client.id}`, { method: 'DELETE', headers: { 'x-wv-client': 'test' } })).status).toBe(200)
    expect((await fetch(`${service.base}/api/memory/status`, json({}, token))).status).toBe(401)
    const registry = JSON.stringify(db.getKv('memory.clients.v1')); expect(registry).not.toContain(token)
    db.close()
  })

  it('rejects cross-origin management, DNS rebinding hosts, missing tokens, and credential writes', async () => {
    const service = await serve()
    expect((await fetch(`${service.base}/api/memory/clients`, { headers: { 'x-wv-client': 'test', origin: 'https://attacker.example' } })).status).toBe(403)
    const rebound = await new Promise<number | undefined>((resolve, reject) => { const request = httpRequest(`${service.base}/api/memory/clients`, { headers: { 'x-wv-client': 'test', host: 'attacker.example' } }, (response) => { response.resume(); resolve(response.statusCode) }); request.once('error', reject); request.end() })
    expect(rebound).toBe(403)
    expect((await fetch(`${service.base}/api/mcp`, json({}))).status).toBe(401)
    expect((await fetch(`${service.base}/api/memory/clients`)).status).toBe(403)
    expect((await fetch(`${service.base}/api/memory/clients`, json({ name: 'writer', allSources: true, allowObservations: true }))).status).toBeGreaterThanOrEqual(400)
  })

  it('selects the token account without leaking another signed-in account or creating forged worlds', async () => {
    const service = await serve(true), a = await service.host.accounts!.signUp('a@example.com', 'long password 123'), b = await service.host.accounts!.signUp('b@example.com', 'long password 456')
    const dbA = openWorldDb(join(service.dir, 'users', a.id, 'world.sqlite')), dbB = openWorldDb(join(service.dir, 'users', b.id, 'world.sqlite'))
    dbA.putKv('knowledge.v1', corpus()); const changed = corpus(); changed.versions[0].text = 'Other private record'; changed.passages = []; dbB.putKv('knowledge.v1', changed)
    const { token } = createMemoryClient(dbA, a.id, { name: 'account a', sourceIds: ['a'] })
    const session = service.host.accounts!.createSession(b.id)
    const response = await fetch(`${service.base}/api/memory/search`, { ...json({ query: 'lighthouse' }, token), headers: { ...json({}, token).headers, cookie: `wv_session=${session.token}` } })
    expect((await response.json()).hits.map((hit: { id: string }) => hit.id)).toEqual(['p-a'])
    const forged = `wvm.${crypto.randomUUID()}.${'A'.repeat(43)}`
    expect((await fetch(`${service.base}/api/memory/status`, json({}, forged))).status).toBe(401)
    expect((await fetch(`${service.base}/api/memory/clients`, { headers: { 'x-wv-client': 'test' } })).status).toBe(401)
    dbA.close(); dbB.close()
  })
})
