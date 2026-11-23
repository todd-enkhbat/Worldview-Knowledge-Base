/** Tests a scoped MCP client against the browser-produced synthetic voice in the isolated QA server. */
import { writeFile, mkdir } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { WorldSnapshot } from '../src/data/WorldStore.ts'
import type { KnowledgeSnapshot, SearchHit } from '../src/knowledge/types.ts'
const base = new URL(process.argv[2] ?? 'http://[::1]:5173')
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.port !== '5173') throw new Error('This verification is restricted to the explicitly selected isolated local QA service on port 5173.')
const headers = { 'content-type': 'application/json', 'x-wv-client': 'browser-memory-qa', 'x-wv-knowledge-format': '2' }
const snapshotResponse = await fetch(new URL('/api/world/snapshot', base), { method: 'POST', headers, body: JSON.stringify({ keys: ['knowledge.v1', 'voiceInbox.v1'] }) })
if (!snapshotResponse.ok) throw new Error('The isolated QA world is unavailable.')
const snapshot = await snapshotResponse.json() as WorldSnapshot, corpus = snapshot.kv['knowledge.v1'] as KnowledgeSnapshot | undefined
if (!corpus || corpus.sources.length !== 1) throw new Error('Expected exactly one synthetic browser voice source; no client was created in an unexpected workspace.')
const source = corpus.sources[0], version = corpus.versions.find((version) => version.id === source.currentVersionId)!
if (!version?.metadata?.voiceHash || !/aurora/i.test(version.text) || !/december\s+(?:12|twelve)/i.test(version.text)) throw new Error('The expected synthetic Aurora browser transcript is missing; no client was created.')
const passageRows = corpus.passages.filter((passage) => passage.sourceId === source.id && passage.versionId === version.id)
if (!passageRows.length || !passageRows.every((passage) => version.text.slice(passage.start, passage.end) === passage.text)) throw new Error('The browser voice citations are not exact.')
let clientId = '', revoked = false
const client = new Client({ name: 'browser-produced-voice-verification', version: '1.0.0' })
try {
  const registration = await fetch(new URL('/api/memory/clients', base), { method: 'POST', headers, body: JSON.stringify({ name: 'Synthetic browser voice MCP QA', sourceIds: [source.id], expiresInDays: 1 }) })
  if (!registration.ok) throw new Error('The scoped QA memory client could not be registered.')
  const result = await registration.json() as { client: { id: string }; token: string }; clientId = result.client.id; const token = result.token
  await client.connect(new StreamableHTTPClientTransport(new URL('/api/mcp', base), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  const searched = (await client.callTool({ name: 'search', arguments: { query: 'Aurora December', limit: 10 } })).structuredContent as { hits: SearchHit[] }
  if (!searched.hits.length || searched.hits.some((hit) => hit.sourceId !== source.id || hit.versionId !== version.id || version.text.slice(hit.start, hit.end) !== hit.text)) throw new Error('MCP search did not return current scoped exact browser evidence.')
  const reads = []
  for (const hit of searched.hits) {
    const read = (await client.callTool({ name: 'read_passage', arguments: { id: hit.id } })).structuredContent as SearchHit & { ok: boolean; citationUrl: string }
    if (!read.ok || read.text !== hit.text || read.versionId !== version.id || !read.locator?.startsWith('Audio') || read.citationUrl !== `#/library?passage=${encodeURIComponent(hit.id)}`) throw new Error('MCP passage read lost browser voice text, version or timed locator.')
    reads.push({ passageId: read.id, sourceId: read.sourceId, versionId: read.versionId, text: read.text, locator: read.locator, role: read.role, citationUrl: read.citationUrl })
  }
  const packet = (await client.callTool({ name: 'get_memory_context', arguments: { query: 'Aurora December', maxBytes: 8192 } })).structuredContent as { evidence: SearchHit[]; rendered: string; bytes: number }
  const delivered = JSON.parse(packet.rendered) as { evidence: SearchHit[] }
  if (!packet.evidence.length || packet.bytes !== Buffer.byteLength(packet.rendered) || packet.bytes > 8192 || delivered.evidence.some((hit) => hit.sourceId !== source.id || hit.versionId !== version.id || version.text.slice(hit.start, hit.end) !== hit.text)) throw new Error('The shared context packet failed exact delivery, scope or rendered-size checks.')
  const revoke = await fetch(new URL(`/api/memory/clients/${encodeURIComponent(clientId)}`, base), { method: 'DELETE', headers }); if (!revoke.ok) throw new Error('The QA memory token could not be revoked.'); revoked = true
  const denied = await fetch(new URL('/api/memory/status', base), { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` }, body: '{}' })
  if (denied.status !== 401) throw new Error('Revoked memory access was not denied.')
  const report = { checkedAt: new Date().toISOString(), origin: base.origin, corpusOrigin: 'real browser upload, AudioContext decode and local Whisper worker', transport: 'real stateless MCP with official SDK', sourceId: source.id, currentVersionId: version.id, sourceCount: corpus.sources.length, exactReads: reads, contextDeliveredPassages: delivered.evidence.length, packetBytes: packet.bytes, packetBudgetBytes: 8192, tokenRevoked: revoked, revokedRequestStatus: denied.status, corpusPolicyChanged: false, worldRecordsChanged: false }
  await mkdir('docs/evaluations', { recursive: true }); await writeFile('docs/evaluations/browser-memory-2026-11-23.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ok: true, exactReads: reads.length, contextDeliveredPassages: delivered.evidence.length, tokenRevoked: true, report: 'docs/evaluations/browser-memory-2026-11-23.json' }))
} finally {
  await client.close()
  if (clientId && !revoked) await fetch(new URL(`/api/memory/clients/${encodeURIComponent(clientId)}`, base), { method: 'DELETE', headers }).catch(() => {})
}
