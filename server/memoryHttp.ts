import type { IncomingMessage, ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { WorldDb } from './worldDb.ts'
import { authenticateMemoryClient, createMemoryClient, listMemoryClients, revokeMemoryClient, type MemoryClient } from './memoryAccess.ts'
import { createMemoryReader, type MemoryOperation } from './memoryService.ts'
import { buildQmdMirror, qmdMirrorZip } from './qmdMirror.ts'
import type { KnowledgeSnapshot } from '../src/knowledge/types.ts'
import { assistantTools, canEdit, createAssistantEditor, type AssistantOperation } from './connections/assistant.ts'
import type { ChangeBus } from './changes.ts'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { decodeBookshelf } from '../src/bookshelf/model.ts'
import { decodeWriting } from '../src/writing/model.ts'
import { canUseCrm, createCrmAssistant, crmAssistantTools } from './crmAssistant.ts'

export const memoryToolNames = { search: 'search', read_passage: 'read_passage', read_record: 'read_record', get_project_context: 'get_project_context', get_memory_context: 'context', status: 'status' } as const
const tools = Object.entries(memoryToolNames).map(([name, operation]) => ({ name,
  description: operation === 'search' ? 'Search permitted original passages. Relevance is not factual confidence. Read exact citations before concluding.' : operation === 'context' ? 'Build a bounded packet of authorized evidence and accepted profile/project context; includes omitted evidence counts.' : operation === 'read_passage' ? 'Read exact retained evidence; current source consent and version are rechecked.' : operation === 'read_record' ? 'Read a bounded permitted record. Mixed authorship/date scope can require passage reads instead.' : operation === 'get_project_context' ? 'Read an explicitly authorized saved investigation and its open questions.' : 'Read authorized index coverage and source revision.',
  inputSchema: { type: 'object' as const, properties: { query: { type: 'string', maxLength: 2000 }, id: { type: 'string', maxLength: 256 }, projectId: { type: 'string', maxLength: 128 }, limit: { type: 'integer', minimum: 1, maximum: operation === 'read_record' ? 8000 : 40 }, offset: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 1024, maximum: 65536 }, filters: { type: 'object' } }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }))

export const sendMemoryJson = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
export async function readMemoryBody(req: IncomingMessage, limit = 128 * 1024): Promise<Record<string, unknown>> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) { size += chunk.length; if (size > limit) throw new Error('Request exceeds '+Math.round(limit/1024)+' KiB.'); chunks.push(chunk) }
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

export function createMemoryHttp(db: WorldDb, worldId: string, now: () => number = Date.now, options: { bus?: ChangeBus; directory?: string } = {}) {
  const reader = createMemoryReader(db)
  const editor = createAssistantEditor(db, { bus: options.bus, now })
  const crmAssistant = createCrmAssistant(db, now)
  const reauthorize = (req: IncomingMessage, previous: MemoryClient) => { const token = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? ''; const current = authenticateMemoryClient(db, token, worldId, now()); if (!current || current.id !== previous.id) throw new Error('This memory client expired or was revoked before its request completed.'); return current }
  return {
    async connections(req: IncomingMessage, res: ServerResponse) {
      if (worldId !== 'local' || !memoryOriginAllowed(req) || !req.headers['x-wv-client']) return sendMemoryJson(res, 403, { error: 'Open the local workspace to review assistant editing.' })
      const parts = (req.url ?? '').split('?')[0].split('/').filter(Boolean)
      if (req.method === 'GET') return sendMemoryJson(res, 200, editor.status())
      if (req.method === 'POST' && parts[3] && ['approve', 'reject'].includes(parts[4])) return sendMemoryJson(res, 200, editor.review(decodeURIComponent(parts[3]), parts[4] as 'approve' | 'reject'))
      return sendMemoryJson(res, 405, { error: 'Choose an assistant change to approve or reject.' })
    },
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
      if (req.method === 'GET') return sendMemoryJson(res, 200, { clients: listMemoryClients(db), mcpPath: '/api/mcp', editingAvailable: worldId === 'local', reviewRequired: true, ...(options.directory ? { workspaceFingerprint: createHash('sha256').update(realpathSync(options.directory)).digest('hex') } : {}) })
      if (req.method === 'POST' && parts.length === 3) {
        const body = await readMemoryBody(req)
        const sources = db.getKv<{ sources: { id: string }[] }>('knowledge.v1')?.sources ?? []
        if (Array.isArray(body.sourceIds) && body.sourceIds.some((id) => !sources.some((source) => source.id === id))) return sendMemoryJson(res, 400, { error: 'A selected source is no longer available.' })
        const documents = decodeWriting(db.getKv('writing.v1')).docs
        if (Array.isArray(body.writingDocumentIds) && body.writingDocumentIds.some((id) => !documents.some((doc) => doc.id === id && !doc.archivedAt))) return sendMemoryJson(res, 400, { error: 'A selected writing document is no longer available.' })
        const shelf = decodeBookshelf(db.getKv('bookshelves.v1'))
        if (Array.isArray(body.bookshelfBookIds) && body.bookshelfBookIds.some((id) => !shelf.books.some((book) => book.id === id && !book.archivedAt))) return sendMemoryJson(res, 400, { error: 'A selected bookshelf record is no longer available.' })
        for (const [scope, collection] of [['crmPersonIds', 'people'], ['crmGroupIds', 'groups']] as const) if (Array.isArray(body[scope]) && (body[scope] as unknown[]).some(id => typeof id !== 'string' || db.crm.get(collection, id)?.archivedAt !== null)) return sendMemoryJson(res, 400, { error: 'A selected People scope is unavailable. Refresh your selections.' })
        return sendMemoryJson(res, 201, createMemoryClient(db, worldId, body as Parameters<typeof createMemoryClient>[2], now()))
      }
      if (req.method === 'DELETE' && parts[3]) { revokeMemoryClient(db, parts[3], now()); return sendMemoryJson(res, 200, { ok: true }) }
      return sendMemoryJson(res, 405, { error: 'Method not allowed.' })
    },
    async operation(req: IncomingMessage, res: ServerResponse, client: MemoryClient, operation: string) {
      if (!memoryOriginAllowed(req)) return sendMemoryJson(res, 403, { error: 'Origin is not permitted.' })
      if (req.method !== 'POST') return sendMemoryJson(res, 405, { error: 'Use POST for a memory operation.' })
      const writingOperation = assistantTools.some((tool) => tool.name === operation), crmOperation = crmAssistantTools.some(tool => tool.name === operation)
      if (!Object.values(memoryToolNames).includes(operation as MemoryOperation) && !writingOperation && !crmOperation) return sendMemoryJson(res, 404, { error: 'Unknown memory operation.' })
      const input = await readMemoryBody(req), active = reauthorize(req, client), result = crmOperation ? crmAssistant.operation(operation, input, active) : writingOperation ? editor.operation(operation as AssistantOperation, input, active) : reader(operation as MemoryOperation, input, active)
      return sendMemoryJson(res, 200, result)
    },
    async mcp(req: IncomingMessage, res: ServerResponse, client: MemoryClient) {
      if (!memoryOriginAllowed(req)) return sendMemoryJson(res, 403, { error: 'Origin is not permitted.' })
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return sendMemoryJson(res, 405, { error: 'This stateless server does not offer an SSE stream.' }) }
      const server = new Server({ name: 'worldview-memory', version: '1.0.0' }, { capabilities: { tools: {} } })
      server.setRequestHandler(ListToolsRequestSchema, async () => { const active = reauthorize(req, client); return { tools: [...tools, ...(canEdit(active) && worldId === 'local' ? assistantTools : []), ...(canUseCrm(active) && worldId === 'local' ? crmAssistantTools : [])] } })
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const operation = memoryToolNames[request.params.name as keyof typeof memoryToolNames], writingOperation = assistantTools.some((tool) => tool.name === request.params.name), crmOperation = crmAssistantTools.some(tool => tool.name === request.params.name)
        if (!operation && !writingOperation && !crmOperation) throw new Error('Unknown memory tool.')
        const active = reauthorize(req, client), result = crmOperation ? crmAssistant.operation(request.params.name, request.params.arguments, active) : writingOperation ? editor.operation(request.params.name as AssistantOperation, request.params.arguments, active) : reader(operation!, request.params.arguments, active)
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> }
      })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.once('close', () => { void transport.close(); void server.close() })
      await server.connect(transport)
      const body = await readMemoryBody(req); reauthorize(req, client); await transport.handleRequest(req, res, body)
    },
  }
}
