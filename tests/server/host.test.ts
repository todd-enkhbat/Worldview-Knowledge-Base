import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Accounts, hashPassword, RateLimit, verifyPassword } from '../../server/accounts.ts'
import { parseEnvelope } from '../../server/changes.ts'
import { isPrivateAddress, fetchReadable } from '../../server/fetchUrl.ts'
import { cookieValue, createHost, type Host } from '../../server/host.ts'
import { createStatic } from '../../server/main.ts'

const dirs: string[] = []
const servers: { server: Server; host?: Host }[] = []
afterAll(async () => {
  for (const s of servers) {
    s.server.closeAllConnections()
    await new Promise<void>((r) => s.server.close(() => r()))
    s.host?.close()
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wv-host-'))
  dirs.push(d)
  return d
}

async function serve(host: Host): Promise<string> {
  const server = createServer((req, res) => host.handler(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  servers.push({ server, host })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
}

const json = (body: unknown, cookie?: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-wv-client': 'test', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
})
const sessionOf = (res: Response) => /wv_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? ''

describe('passwords and sessions', () => {
  it('hashes with scrypt and verifies only the right password', async () => {
    const h = await hashPassword('correct horse battery')
    expect(h.startsWith('scrypt$32768$8$1$')).toBe(true)
    expect(await verifyPassword('correct horse battery', h)).toBe(true)
    expect(await verifyPassword('wrong horse battery', h)).toBe(false)
  })

  it('stores only token hashes and expires sessions', async () => {
    let now = 1_000
    const a = new Accounts(':memory:', () => now)
    const u = await a.signUp(' Ada@Example.com ', 'a long enough password')
    expect(u.email).toBe('ada@example.com')
    await expect(a.signUp('ada@example.com', 'another long password')).rejects.toThrow(/already exists/)
    await expect(a.signUp('not-an-email', 'a long enough password')).rejects.toThrow(/email/)
    await expect(a.signUp('b@example.com', 'short')).rejects.toThrow(/at least/)
    await expect(a.signIn('ada@example.com', 'nope nope nope')).rejects.toThrow(/Wrong email or password/)
    await expect(a.signIn('nobody@example.com', 'nope nope nope')).rejects.toThrow(/Wrong email or password/)
    const s = a.createSession((await a.signIn('ADA@example.com', 'a long enough password')).id)
    expect(a.userForToken(s.token)?.id).toBe(u.id)
    expect(a.userForToken('forged')).toBeNull()
    now += 31 * 86_400_000
    expect(a.userForToken(s.token)).toBeNull()
    a.close()
  })

  it('limits attempts per key within a window', () => {
    let now = 0
    const rl = new RateLimit(2, 1000, () => now)
    expect([rl.take('k'), rl.take('k'), rl.take('k'), rl.take('other')]).toEqual([true, true, false, true])
    now = 1001
    expect(rl.take('k')).toBe(true)
  })

  it('reads cookies', () => {
    expect(cookieValue('a=1; wv_session=abc%3D; b=2', 'wv_session')).toBe('abc=')
    expect(cookieValue(undefined, 'wv_session')).toBeUndefined()
  })
})

describe('the hosted API with accounts', () => {
  it('requires sign-in, opens sign-up to the first account only, and keeps worlds apart', async () => {
    const data = tmp()
    const api = await serve(createHost({ dataDir: data, accounts: true }))

    expect(await (await fetch(`${api}/health`)).json()).toMatchObject({ auth: 'required', live: true })
    expect((await fetch(`${api}/world/nodes`)).status).toBe(401)
    expect(await (await fetch(`${api}/auth/me`)).json()).toEqual({ user: null, signup: true })

    const first = await fetch(`${api}/auth/signup`, json({ email: 'ada@example.com', password: 'a long enough password' }))
    expect(first.status).toBe(200)
    const ada = `wv_session=${sessionOf(first)}`
    expect(first.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Lax/)

    expect((await fetch(`${api}/auth/signup`, json({ email: 'eve@example.com', password: 'a long enough password' }))).status).toBe(403)
    expect(await (await fetch(`${api}/auth/me`, { headers: { cookie: ada } })).json()).toMatchObject({ user: { email: 'ada@example.com' }, signup: false })
    expect(await (await fetch(`${api}/health`, { headers: { cookie: ada } })).json()).toMatchObject({ auth: 'signed-in' })

    // Writes need the client header (a cross-site form cannot send it).
    const put = (cookie: string, header = true) =>
      fetch(`${api}/world/kv/hello`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie, ...(header ? { 'x-wv-client': 't' } : {}) },
        body: JSON.stringify({ value: 'ada' }),
      })
    expect((await put(ada, false)).status).toBe(403)
    expect((await put(ada)).status).toBe(204)
    expect(await (await fetch(`${api}/world/kv/hello`, { headers: { cookie: ada } })).json()).toEqual({ found: true, value: 'ada' })

    // A second account (sign-up opened) sees its own empty world.
    const accounts = new Accounts(join(data, 'accounts.sqlite'))
    const bob = await accounts.signUp('bob@example.com', 'another long password')
    accounts.close()
    const login = await fetch(`${api}/auth/login`, json({ email: bob.email, password: 'another long password' }))
    const bobCookie = `wv_session=${sessionOf(login)}`
    expect(await (await fetch(`${api}/world/kv/hello`, { headers: { cookie: bobCookie } })).json()).toEqual({ found: false })

    const out = await fetch(`${api}/auth/logout`, json({}, ada))
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/)
    expect((await fetch(`${api}/world/nodes`, { headers: { cookie: ada } })).status).toBe(401)
  })

  it('serves the local world with no sign-in when accounts are off', async () => {
    const api = await serve(createHost({ dataDir: tmp() }))
    expect(await (await fetch(`${api}/health`)).json()).toMatchObject({ auth: 'none' })
    expect((await fetch(`${api}/world/nodes`)).status).toBe(200)
  })
})

describe('live changes between devices', () => {
  it('validates notices', () => {
    expect(parseEnvelope({ from: 'a', change: { type: 'nodes', ids: ['x'] } })).toEqual({ v: 1, from: 'a', change: { type: 'nodes', ids: ['x'] } })
    expect(parseEnvelope({ from: 'a', change: { type: 'settings', extra: 1 } })).toEqual({ v: 1, from: 'a', change: { type: 'settings' } })
    expect(parseEnvelope({ from: 'a', change: { type: 'drop-tables' } })).toBeNull()
    expect(parseEnvelope({ from: 'a', change: { type: 'nodes', ids: [1] } })).toBeNull()
  })

  it("relays a device's notice to the world's other devices, not back to it", async () => {
    const api = await serve(createHost({ dataDir: tmp() }))
    const listen = async (client: string) => {
      const res = await fetch(`${api}/world/changes?client=${client}`)
      const reader = res.body!.getReader()
      const got: unknown[] = []
      let buf = ''
      void (async () => {
        for (;;) {
          const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }))
          if (done) return
          buf += new TextDecoder().decode(value)
          for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
            const ev = buf.slice(0, i)
            buf = buf.slice(i + 2)
            if (ev.startsWith('data: ')) got.push(JSON.parse(ev.slice(6)))
          }
        }
      })()
      return { got, stop: () => reader.cancel() }
    }
    const laptop = await listen('laptop')
    const phone = await listen('phone')
    await new Promise((r) => setTimeout(r, 50))
    const posted = await fetch(`${api}/world/changes`, json({ from: 'laptop', change: { type: 'nodes', ids: ['n1'] } }))
    expect(await posted.json()).toEqual({ relayed: 1 })
    await new Promise((r) => setTimeout(r, 50))
    expect(phone.got).toEqual([{ v: 1, from: 'laptop', change: { type: 'nodes', ids: ['n1'] } }])
    expect(laptop.got).toEqual([])
    await laptop.stop()
    await phone.stop()
  })
})

describe('static app server', () => {
  it('serves files, falls back to index.html for routes, and refuses traversal', async () => {
    const dist = tmp()
    mkdirSync(join(dist, 'assets'))
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>')
    writeFileSync(join(dist, 'assets', 'app-123.js'), 'console.log(1)')
    writeFileSync(join(tmp(), 'secret.txt'), 'no')
    const handle = createStatic({ dist })
    const server = createServer((req, res) => void handle(req, res))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    servers.push({ server })
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const js = await fetch(`${base}/assets/app-123.js`)
    expect(js.headers.get('content-type')).toMatch(/javascript/)
    expect(js.headers.get('cache-control')).toMatch(/immutable/)
    expect(await (await fetch(`${base}/sandbox/field`)).text()).toContain('<title>app</title>')
    expect((await fetch(`${base}/missing.png`)).status).toBe(404)
    expect((await fetch(`${base}/..%2f..%2fsecret.txt`)).status).toBe(403)
  })
})

describe('page links stay out of private networks', () => {
  it('classifies addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.5', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    for (const ip of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946', '8.8.8.8']) expect(isPrivateAddress(ip), ip).toBe(false)
  })

  it('refuses a private host and a redirect into one', async () => {
    const lookup = async (h: string) => (h === 'evil.example' ? ['10.0.0.7'] : ['93.184.216.34'])
    const page = (async () => new Response('<title>ok</title>hi', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
    await expect(fetchReadable('http://evil.example/', page, lookup)).rejects.toThrow(/private network/)
    await expect(fetchReadable('http://169.254.169.254/latest/meta-data', page, lookup)).rejects.toThrow(/private network/)
    const redirect = (async (u: URL) =>
      u.hostname === 'nice.example' ? new Response(null, { status: 302, headers: { location: 'http://evil.example/admin' } }) : page(u)) as unknown as typeof fetch
    await expect(fetchReadable('http://nice.example/', redirect, lookup)).rejects.toThrow(/private network/)
    expect((await fetchReadable('http://nice.example/', page, lookup)).title).toBe('ok')
  })
})
