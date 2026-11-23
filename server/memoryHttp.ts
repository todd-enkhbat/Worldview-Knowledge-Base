import type { IncomingMessage, ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { WorldDb } from './worldDb.ts'
import { createMemoryClient, listMemoryClients, revokeMemoryClient, type MemoryClient } from './memoryAccess.ts'
import { createMemoryReader, type MemoryOperation } from './memoryService.ts'
import { buildQmdMirror, qmdMirrorZip } from './qmdMirror.ts'
import type { KnowledgeSnapshot } from '../src/knowledge/types.ts'

export const memoryToolNames = { search: 'search', read_passage: 'read_passage', read_record: 'read_record', get_project_context: 'get_project_context', get_memory_context: 'context', status: 'status' } as const
const tools = Object.entries(memoryToolNames).map(([name, operation]) => ({ name,
  description: operation === 'search' ? 'Search permitted original passages. Relevance is not factual confidence. Read exact citations before concluding.' : operation === 'context' ? 'Build a bounded packet of authorized evidence and accepted profile/project context; includes omitted evidence counts.' : operation === 'read_passage' ? 'Read exact retained evidence; current source consent and version are rechecked.' : operation === 'read_record' ? 'Read a bounded permitted record. Mixed authorship/date scope can require passage reads instead.' : operation === 'get_project_context' ? 'Read an explicitly authorized saved investigation and its open questions.' : 'Read authorized index coverage and source revision.',
  inputSchema: { type: 'object' as const, properties: { query: { type: 'string', maxLength: 2000 }, id: { type: 'string', maxLength: 256 }, projectId: { type: 'string', maxLength: 128 }, limit: { type: 'integer', minimum: 1, maximum: operation === 'read_record' ? 8000 : 40 }, offset: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 1024, maximum: 65536 }, filters: { type: 'object' } }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }))

export const sendMemoryJson = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
export async function readMemoryBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) { size += chunk.length; if (size > 128 * 1024) throw new Error('Memory request exceeds 128 KiB.'); chunks.push(chunk) }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Memory request must be an object.')
  return value as Record<string, unknown>
}

/** Origin checks apply to browser and MCP traffic, including authenticated requests. */
export function memoryOriginAllowed(req: IncomingMessage): boolean {
  if (!req.headers.host) return false
  const origin = req.headers.origin
  if (!origin) return true
  try { const url = new URL(origin); return ['http:', 'https:'].includes(url.protocol) && url.host.toLowerCase() === req.headers.host.toLowerCase() } catch { return false }
}

export function createMemoryHttp(db: WorldDb, worldId: string, now: () => number = Date.now) {
  const reader = createMemoryReader(db)
  return {
    async mirror(req: IncomingMessage, res: ServerResponse) {
      if (!memoryOriginAllowed(req) || !req.headers['x-wv-client']) return sendMemoryJson(res, 403, { error: 'Open the authorized workspace to export a mirror.' })
      if (req.method !== 'POST') return sendMemoryJson(res, 405, { error: 'Use POST with an explicit source selection.' })
      const body = await readMemoryBody(req)
      if (!Array.isArray(body.sourceIds) || !body.sourceIds.length || body.sourceIds.length > 1000 || !body.sourceIds.every((id) => typeof id === 'string')) return sendMemoryJson(res, 400, { error: 'Choose up to 1000 sources for this disposable mirror.' })
      const snapshot = db.getKv<KnowledgeSnapshot>('knowledge.v1')
      if (!snapshot || db.getKv('importInProgress')) return sendMemoryJson(res, 409, { error: 'Finish recovery and import sources before exporting.' })
      const mirror = buildQmdMirror(snapshot, { liveNodeIds: new Set(db.listNodes().filter((node) => node.deletedAt === null && !node.corpusExcluded).map((node) => node.id)), filters: { sourceIds: body.sourceIds as string[] } })
      const zip = qmdMirrorZip(mirror)
      res.writeHead(200, { 'content-type': 'application/zip', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="Worldview-QMD-mirror.zip"' }); res.end(zip)
    },
    async management(req: IncomingMessage, res: ServerResponse) {
      if (!memoryOriginAllowed(req) || !req.headers['x-wv-client']) return sendMemoryJson(res, 403, { error: 'Open Sources in the authorized workspace to manage memory clients.' })
      const parts = (req.url ?? '').split('?')[0].split('/').filter(Boolean)
      if (req.method === 'GET') return sendMemoryJson(res, 200, { clients: listMemoryClients(db), mcpPath: '/api/mcp' })
      if (req.method === 'POST' && parts.length === 3) {
        const body = await readMemoryBody(req)
        const sources = db.getKv<{ sources: { id: string }[] }>('knowledge.v1')?.sources ?? []
        if (Array.isArray(body.sourceIds) && body.sourceIds.some((id) => !sources.some((source) => source.id === id))) return sendMemoryJson(res, 400, { error: 'A selected source is no longer available.' })
        return sendMemoryJson(res, 201, createMemoryClient(db, worldId, body as Parameters<typeof createMemoryClient>[2], now()))
      }
      if (req.method === 'DELETE' && parts[3]) { revokeMemoryClient(db, parts[3], now()); return sendMemoryJson(res, 200, { ok: true }) }
      return sendMemoryJson(res, 405, { error: 'Method not allowed.' })
    },
    async operation(req: IncomingMessage, res: ServerResponse, client: MemoryClient, operation: string) {
      if (!memoryOriginAllowed(req)) return sendMemoryJson(res, 403, { error: 'Origin is not permitted.' })
      if (req.method !== 'POST') return sendMemoryJson(res, 405, { error: 'Use POST for a memory operation.' })
      if (!Object.values(memoryToolNames).includes(operation as MemoryOperation)) return sendMemoryJson(res, 404, { error: 'Unknown memory operation.' })
      const result = reader(operation as MemoryOperation, await readMemoryBody(req), client)
      return sendMemoryJson(res, 200, result)
    },
    async mcp(req: IncomingMessage, res: ServerResponse, client: MemoryClient) {
      if (!memoryOriginAllowed(req)) return sendMemoryJson(res, 403, { error: 'Origin is not permitted.' })
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return sendMemoryJson(res, 405, { error: 'This stateless server does not offer an SSE stream.' }) }
      const server = new Server({ name: 'worldview-memory', version: '1.0.0' }, { capabilities: { tools: {} } })
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const operation = memoryToolNames[request.params.name as keyof typeof memoryToolNames]
        if (!operation) throw new Error('Unknown memory tool.')
        const result = reader(operation, request.params.arguments, client)
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> }
      })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.once('close', () => { void transport.close(); void server.close() })
      await server.connect(transport)
      await transport.handleRequest(req, res, await readMemoryBody(req))
    },
  }
}
