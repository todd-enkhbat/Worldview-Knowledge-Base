import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect,it,vi } from 'vitest'
import { NotebookConnection } from '../../server/connections/notebooks.ts'
it('requires a real provider grant and a matching pending callback before reading notes', async () => {
  const root=mkdtempSync(join(tmpdir(),'worldview-notebook-grant-'))
  try {
    const service=new NotebookConnection(root),redirect='http://127.0.0.1:5173/api/connections/notebooks/granola/callback'
    expect(service.status()).toEqual({granola:false,wispr:false})
    await expect(service.action('granola','callback',{state:'missing',code:'unused'},redirect)).rejects.toThrow('expired')
    await expect(service.action('granola','search',{},redirect)).rejects.toThrow('Connect')
    expect(readdirSync(root)).toEqual([])
  } finally {rmSync(root,{recursive:true,force:true})}
})

const notebookProviders = [
  { key: 'granola', issuer: 'https://mcp-auth.granola.ai', server: 'https://mcp.granola.ai/mcp', scopes: ['mcp'], kind: 'meeting', tool: 'search_meetings' },
  { key: 'wispr', issuer: 'https://mcp-auth.wisprflow.com', server: 'https://api.wisprflow.ai/connect/mcp', scopes: ['openid', 'offline_access'], kind: 'scratchpad', tool: 'search_scratchpad_notes' },
] as const

it.each(notebookProviders)('checks PKCE and state, then searches, refreshes and disconnects a persisted $key grant', async ({ key, issuer, server, scopes, kind, tool }) => {
  const directory = mkdtempSync(join(tmpdir(), 'worldview-notebook-oauth-'))
  const redirect = 'http://127.0.0.1:5173/api/connections/notebooks/' + key + '/callback'
  const resource = new URL(server), discovery = resource.origin + '/.well-known/oauth-protected-resource' + resource.pathname
  const status = { granola: false, wispr: false }, connected = { ...status, [key]: true }
  const json = (data: unknown) => Response.json(data)
  let challenge = '', exchanges = 0, searches = 0, refreshes = 0, expired = false
  const provider = vi.fn<typeof fetch>(async (input, init) => {
    const req = new Request(input, init), url = req.url
    if (url === discovery) return json({ resource: server, authorization_servers: [issuer], scopes_supported: scopes, bearer_methods_supported: ['header'] })
    if (url === issuer + '/.well-known/oauth-authorization-server') return json({
      issuer, authorization_endpoint: issuer + '/oauth2/authorize', token_endpoint: issuer + '/oauth2/token', registration_endpoint: issuer + '/oauth2/register',
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
    })
    if (url === issuer + '/oauth2/register') {
      const registration = await req.json()
      expect(registration.redirect_uris).toEqual([redirect]); expect(registration.token_endpoint_auth_method).toBe('none')
      expect(registration.scope).toBe(scopes.join(' '))
      return json({ ...registration, client_id: 'fixture-public-client' })
    }
    if (url === issuer + '/oauth2/token') {
      const params = new URLSearchParams(await req.text())
      if (params.get('grant_type') === 'refresh_token') {
        expect(params.get('refresh_token')).toBe('fixture-refresh-token')
        expect(params.get('resource')).toBe(server)
        refreshes++
        return json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 })
      }
      expect(params.get('grant_type')).toBe('authorization_code')
      expect(params.get('client_id')).toBe('fixture-public-client')
      expect(params.get('code')).toBe('fixture-code')
      expect(params.get('redirect_uri')).toBe(redirect)
      expect(params.get('resource')).toBe(server)
      const verifier = params.get('code_verifier')!
      expect(verifier.length).toBeGreaterThanOrEqual(43)
      expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge)
      exchanges++
      return json({ access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', token_type: 'Bearer', expires_in: 3600 })
    }
    if (url !== server) throw new Error('Unexpected mock provider endpoint: ' + url)
    const bearer = req.headers.get('authorization')
    if (expired && bearer === 'Bearer fixture-access-token') return new Response(null, {
      status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="' + discovery + '"' },
    })
    expect(bearer).toBe(expired ? 'Bearer rotated-access' : 'Bearer fixture-access-token')
    if (req.method === 'GET') return new Response(null, { status: 405 })
    const packet = await req.json()
    if (packet.method === 'initialize') return json({ jsonrpc: '2.0', id: packet.id, result: { protocolVersion: packet.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: key, version: '1' } } })
    if (packet.method === 'notifications/initialized') return new Response(null, { status: 202 })
    expect(packet.method).toBe('tools/call')
    expect(packet.params).toEqual({ name: tool, arguments: { limit: 20, query: 'book outline', ...(key === 'granola' ? { include_shared: false, max_participants: 0 } : {}) } })
    searches++
    return json({ jsonrpc: '2.0', id: packet.id, result: { content: [{ type: 'text', text: 'Only the requested result.' }] } })
  })
  vi.stubGlobal('fetch', provider)
  try {
    const service = new NotebookConnection(directory)
    const start = await service.action(key, 'connect', {}, redirect)
    if (!('authorizationUrl' in start) || !start.authorizationUrl) throw new Error('Missing interactive authorization URL')
    const url = new URL(start.authorizationUrl)
    expect(url.origin).toBe(issuer)
    expect(url.searchParams.get('redirect_uri')).toBe(redirect)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe(scopes.join(' '))
    challenge = url.searchParams.get('code_challenge')!
    const state = url.searchParams.get('state')!
    expect(state).toBeTruthy(); expect(challenge).toBeTruthy()
    expect(service.status()).toEqual(status)
    await expect(service.action(key, 'callback', { state: 'wrong-state', code: 'fixture-code' }, redirect)).rejects.toThrow(/expired/)
    expect(exchanges).toBe(0)
    await expect(service.action(key, 'callback', { state, code: 'fixture-code' }, redirect)).resolves.toEqual(connected)
    expect(exchanges).toBe(1)
    await expect(service.action(key, 'callback', { state, code: 'fixture-code' }, redirect)).rejects.toThrow(/expired/)
    expect(exchanges).toBe(1)
    const path = join(directory, 'connections', 'notebook-' + key + '.private.json')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8')).tokens).toMatchObject({ access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token' })
    const reopened = new NotebookConnection(directory)
    expect(reopened.status()).toEqual(connected)
    await expect(reopened.action(key, 'search', { kind, query: 'book outline' }, redirect)).resolves.toEqual({ content: 'Only the requested result.', structured: null })
    expect(searches).toBe(1)
    expired = true
    await expect(reopened.action(key, 'search', { kind, query: 'book outline' }, redirect)).resolves.toEqual({ content: 'Only the requested result.', structured: null })
    expect(refreshes).toBe(1); expect(searches).toBe(2)
    expect(JSON.parse(readFileSync(path, 'utf8')).tokens).toMatchObject({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' })
    expect(reopened.status()).toEqual(connected)
    await expect(reopened.action(key, 'disconnect', {}, redirect)).resolves.toEqual(status)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({})
    const retry = new NotebookConnection(directory)
    await expect(retry.action(key, 'search', { kind, query: 'book outline' }, redirect)).rejects.toThrow(/connect/i)
    expect(searches).toBe(2)
  } finally {
    vi.unstubAllGlobals()
    rmSync(directory, { recursive: true, force: true })
  }
})
