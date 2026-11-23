/** Optional stdio bridge. The authoritative memory stays in the running Worldview app. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const endpoint = new URL(process.env.WORLDVIEW_MCP_URL ?? 'http://localhost:5173/api/mcp')
const token = process.env.WORLDVIEW_MEMORY_TOKEN
if (!token) throw new Error('Set WORLDVIEW_MEMORY_TOKEN to a read token created in Sources & activity.')
if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new Error('Use HTTPS for a remote memory endpoint.')
const client = new Client({ name: 'worldview-stdio-bridge', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
const server = new Server({ name: 'worldview-memory', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, () => client.listTools())
server.setRequestHandler(CallToolRequestSchema, (request) => client.callTool(request.params))
await server.connect(new StdioServerTransport())
let closing = false
const close = async () => { if (closing) return; closing = true; await Promise.allSettled([server.close(), client.close()]) }
process.once('SIGINT', () => { void close() }); process.once('SIGTERM', () => { void close() })
