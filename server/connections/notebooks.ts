import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { memoryOriginAllowed, readMemoryBody, sendMemoryJson } from '../memoryHttp.ts'

const providers = {
  granola: { name: 'Granola', server: 'https://mcp.granola.ai/mcp', issuer: 'https://mcp-auth.granola.ai' },
  wispr: { name: 'Wispr Flow', server: 'https://api.wisprflow.ai/connect/mcp', issuer: 'https://mcp-auth.wisprflow.com' },
} as const
type Provider = keyof typeof providers
interface Saved { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; redirect?: string }
interface Pending { value: string; expires: number; verifier?: string; url?: string }
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w:-]{1,160}$/.test(id)
class NoteError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status } }

export class NotebookConnection {
  private directory: string
  private busy = new Set<Provider>()
  private pending = new Map<Provider, Pending>()
  constructor(workspace: string) { this.directory = join(workspace, 'connections') }
  private path(key: Provider) { return join(this.directory, 'notebook-' + key + '.private.json') }
  private read(key: Provider): Saved {
    if (!existsSync(this.path(key))) return {}
    try { return JSON.parse(readFileSync(this.path(key), 'utf8')) as Saved }
    catch { throw new NoteError('The local connection settings could not be read.', 500) }
  }
  private save(key: Provider, data: Saved) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const temporary = this.path(key) + '.' + randomUUID()
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 })
    renameSync(temporary, this.path(key))
  }
  status() {
    return { granola: !!this.read('granola').tokens?.access_token, wispr: !!this.read('wispr').tokens?.access_token }
  }
  private sdk(key: Provider, redirect: string, saved: Saved, pending?: Pending) {
    const service = providers[key]
    const allowed = new Set([new URL(service.server).origin, service.issuer])
    const guardedFetch: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (!allowed.has(url.origin) || url.username || url.password) throw new NoteError('The provider returned an unexpected sign-in address.')
      const timeout = AbortSignal.timeout(25000)
      return fetch(input, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([timeout, init.signal]) : timeout })
    }
    const provider: OAuthClientProvider = {
      redirectUrl: redirect,
      clientMetadata: { client_name: 'Worldview', redirect_uris: [redirect], grant_types: ['authorization_code','refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
      clientInformation: () => saved.client,
      saveClientInformation: value => { saved.client = value; saved.redirect = redirect; this.save(key, saved) },
      tokens: () => saved.tokens,
      saveTokens: value => { saved.tokens = value; this.save(key, saved) },
      state: () => { if (!pending) throw new NoteError('Reconnect this account in Sources.', 401); return pending.value },
      saveCodeVerifier: value => { if (!pending) throw new NoteError('Reconnect this account in Sources.', 401); pending.verifier = value },
      codeVerifier: () => { if (!pending?.verifier) throw new NoteError('Start sign-in again.'); return pending.verifier },
      redirectToAuthorization: url => {
        if (!pending || url.origin !== service.issuer) throw new NoteError('Reconnect this account in Sources.', 401)
        pending.url = url.href
      },
      invalidateCredentials: scope => {
        if (scope === 'all' || scope === 'client') delete saved.client
        if (scope === 'all' || scope === 'tokens') delete saved.tokens
        if (scope === 'all' || scope === 'verifier') { if (pending) delete pending.verifier }
        this.save(key, saved)
      },
    }
    const url = new URL(service.server)
    return { provider, guardedFetch, options: { serverUrl: url, resourceMetadataUrl: new URL('/.well-known/oauth-protected-resource' + url.pathname, url), fetchFn: guardedFetch } }
  }
  async action(key: Provider, action: string, body: Record<string, unknown>, redirect: string) {
    if (this.busy.has(key)) throw new NoteError('A request is in progress. Try again in a moment.', 409)
    this.busy.add(key)
    try {
      if (action === 'disconnect') { this.pending.delete(key); this.save(key, {}); return this.status() }
      const saved = this.read(key)
      if (action === 'connect') {
        const pending = { value: randomUUID(), expires: Date.now() + 600000 } as Pending
        this.pending.set(key, pending)
        if (saved.redirect !== redirect) delete saved.client
        const { provider, options } = this.sdk(key, redirect, saved, pending)
        await auth(provider, options)
        return { connected: !!saved.tokens?.access_token && !pending.url, authorizationUrl: pending.url }
      }
      if (action === 'callback') {
        const pending = this.pending.get(key)
        if (!pending || pending.expires <= Date.now() || pending.value !== body.state || !pending.verifier) throw new NoteError('This sign-in has expired. Start again in Worldview.')
        this.pending.delete(key)
        if (typeof body.code !== 'string' || !body.code || body.code.length > 4096) throw new NoteError('Sign-in was not completed.')
        const { provider, options } = this.sdk(key, redirect, saved, pending)
        await auth(provider, { ...options, authorizationCode: body.code })
        return this.status()
      }
      if (!saved.tokens?.access_token) throw new NoteError('Connect this account to select a note.', 401)
      const scratch = key === 'wispr' && body.kind === 'scratchpad'
      let tool: string, args: Record<string, unknown>
      if (action === 'search') {
        tool = scratch ? 'search_scratchpad_notes' : 'search_meetings'
        if (body.query !== undefined && (typeof body.query !== 'string' || body.query.length > 300)) throw new NoteError('Use a shorter search.')
        if (body.cursor !== undefined && (typeof body.cursor !== 'string' || body.cursor.length > 4096)) throw new NoteError('Invalid search page.')
        args = body.cursor ? { cursor: body.cursor, limit: 20 } : { limit: 20, ...(body.query ? { query: body.query } : {}), ...(key === 'granola' ? { include_shared: false, max_participants: 0, ...(body.query ? {} : { updated_after: '1970-01-01' }) } : {}) }
      } else if (action === 'read') {
        if (!validId(body.id)) throw new NoteError('Choose a note from the results.')
        tool = key === 'granola' ? 'get_meetings' : scratch ? 'get_scratchpad_note' : 'get_meeting'
        args = key === 'granola' ? { meeting_ids: [body.id], attachments: 'none', max_participants: 0 } : { [scratch ? 'note_id' : 'meeting_id']: body.id, view_content: { start_char: 0, char_limit: 40000 } }
      } else throw new NoteError('Unknown notes action.', 404)
      const { provider, guardedFetch } = this.sdk(key, saved.redirect ?? redirect, saved)
      const client = new Client({ name: 'worldview-notebooks', version: '1.0.0' })
      const transport = new StreamableHTTPClientTransport(new URL(providers[key].server), { authProvider: provider, fetch: guardedFetch })
      try {
        await client.connect(transport)
        const result = await client.callTool({ name: tool, arguments: args })
        if (result.isError) throw new NoteError('The provider could not read these notes. Check access in its app or try a narrower search.', 502)
        const content = Array.isArray(result.content) ? result.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : ''
        const reply = { content, structured: result.structuredContent ?? null }
        if (JSON.stringify(reply).length > 2_000_000) throw new NoteError('This result is too large. Choose a smaller note.', 413)
        return reply
      } finally { await client.close() }
    } finally { this.busy.delete(key) }
  }
}
export async function handleNotebooks(service: NotebookConnection, req: IncomingMessage, res: ServerResponse) {
  const local = req.socket.remoteAddress
  if (!local || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(local)) return sendMemoryJson(res, 403, { error: 'Open the local Worldview workspace.' })
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const [, , , , key, action] = url.pathname.split('/')
  const callback = action === 'callback' && req.method === 'GET'
  if (!callback && (!memoryOriginAllowed(req) || !req.headers['x-wv-client'])) return sendMemoryJson(res, 403, { error: 'Open Sources in the local workspace.' })
  try {
    if (url.pathname === '/api/connections/notebooks' && req.method === 'GET') return sendMemoryJson(res, 200, service.status())
    if (key !== 'granola' && key !== 'wispr' || !action) throw new NoteError('Unknown notebook provider.', 404)
    if (!callback && (req.method !== 'POST' || action === 'callback')) throw new NoteError('Unsupported notes action.', 405)
    const redirect = 'http://127.0.0.1:' + req.socket.localPort + '/api/connections/notebooks/' + key + '/callback'
    const result = await service.action(key, action, callback ? Object.fromEntries(url.searchParams) : await readMemoryBody(req), redirect)
    if (callback) { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy':'no-referrer' }); res.end(providers[key].name + ' is connected. Return to Worldview to choose a note.'); return }
    sendMemoryJson(res, 200, result)
  } catch (e) {
    sendMemoryJson(res, e instanceof NoteError ? e.status : 502, { error: e instanceof NoteError ? e.message : 'The notes service could not complete this request. Try connecting again.' })
  }
}
