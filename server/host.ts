import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { Accounts, AccountError, RateLimit, type User } from './accounts.ts'
import { createApiHandler } from './api.ts'
import { ChangeBus } from './changes.ts'
import { openWorldDb, EMBEDDING_DIM, type WorldDb } from './worldDb.ts'

// The /api surface for either way of running the app:
//
// - Local (default): one world, <data>/world.sqlite and <data>/blobs, no sign-in. This is
//   what `npm run dev` has always served on localhost.
// - Accounts (HYPERSPACE_ACCOUNTS=1, the hosted server): every request but /api/health and
//   /api/auth/* needs a session cookie, and each account has its own world under
//   <data>/users/<id>/. Sign-up is open to the first account and then only if
//   HYPERSPACE_SIGNUP=open.
//
// Either way, each world gets a ChangeBus, so devices with the world open see each other's
// edits live (server/changes.ts).
//
// Cross-site requests: the session cookie is SameSite=Lax, and every request that changes
// anything must carry the `x-wv-client` header (the app's httpStore always sends it), which
// a plain cross-site form or image cannot set.

export const SESSION_COOKIE = 'wv_session'

export interface HostOptions {
  dataDir: string
  accounts?: boolean
  /** 'open' lets anyone sign up; 'first' (default) only the first account. */
  signup?: 'open' | 'first'
  refine?: (body: unknown) => Promise<unknown>
  chat?: (body: unknown, res: ServerResponse) => Promise<void>
  now?: () => number
}

interface World {
  db: WorldDb
  bus: ChangeBus
  handler: ReturnType<typeof createApiHandler>
}

type Handler = (req: IncomingMessage, res: ServerResponse, next?: () => void) => void

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return undefined
}

function sessionCookie(req: IncomingMessage, token: string, maxAgeS: number): string {
  const secure = (req.headers['x-forwarded-proto'] ?? '') === 'https' || (req.socket as { encrypted?: boolean }).encrypted ? '; Secure' : ''
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure}`
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length
    if (size > limit) throw new AccountError(413, 'request body too large')
    chunks.push(c)
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    throw new AccountError(400, 'body is not valid JSON')
  }
}

const clientIp = (req: IncomingMessage) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '?'
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface Host {
  handler: Handler
  accounts: Accounts | null
  close(): void
}

export function createHost(opts: HostOptions): Host {
  const dataDir = resolve(opts.dataDir)
  const accounts = opts.accounts ? new Accounts(join(dataDir, 'accounts.sqlite'), opts.now) : null
  const limiter = new RateLimit(10, 15 * 60_000, opts.now)
  const worlds = new Map<string, World>()

  const world = (key: string, dir: string): World => {
    let w = worlds.get(key)
    if (!w) {
      const db = openWorldDb(join(dir, 'world.sqlite'))
      const bus = new ChangeBus()
      w = { db, bus, handler: createApiHandler({ db, blobDir: join(dir, 'blobs'), refine: opts.refine, chat: opts.chat, bus, now: opts.now }) }
      worlds.set(key, w)
    }
    return w
  }
  const worldFor = (user: User | null): World => (user ? world(user.id, join(dataDir, 'users', user.id)) : world('local', dataDir))

  async function auth(req: IncomingMessage, res: ServerResponse, action: string): Promise<void> {
    if (!accounts) return sendJson(res, 404, { error: 'accounts are off on this server' })
    const method = req.method ?? 'GET'
    const token = cookieValue(req.headers.cookie, SESSION_COOKIE)
    if (action === 'me' && method === 'GET') {
      const user = accounts.userForToken(token)
      return sendJson(res, 200, { user, signup: opts.signup === 'open' || accounts.count() === 0 })
    }
    if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (!req.headers['x-wv-client']) return sendJson(res, 403, { error: 'missing x-wv-client header' })
    if (action === 'logout') {
      accounts.endSession(token)
      return sendJson(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, '', 0) })
    }
    if (action !== 'login' && action !== 'signup') return sendJson(res, 404, { error: 'no such route' })
    const body = await readBody(req)
    const email = typeof body.email === 'string' ? body.email : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!limiter.take(`${clientIp(req)}|${email.trim().toLowerCase()}`)) return sendJson(res, 429, { error: 'Too many attempts. Wait 15 minutes and try again.' })
    let user: User
    if (action === 'signup') {
      if (opts.signup !== 'open' && accounts.count() > 0) return sendJson(res, 403, { error: 'Sign-up is closed on this server.' })
      user = await accounts.signUp(email, password)
    } else user = await accounts.signIn(email, password)
    const s = accounts.createSession(user.id)
    return sendJson(res, 200, { user }, { 'set-cookie': sessionCookie(req, s.token, Math.round((s.expiresAt - Date.now()) / 1000)) })
  }

  const handler: Handler = (req, res, next) => {
    const url = req.url ?? '/'
    if (!url.startsWith('/api/')) return next ? next() : sendJson(res, 404, { error: 'not found' })
    const path = url.slice('/api'.length).split('?', 1)[0]
    const seg = path.split('/').filter(Boolean)
    const method = req.method ?? 'GET'
    const run = async () => {
      if (seg[0] === 'auth') return auth(req, res, seg[1] ?? '')
      const user = accounts ? accounts.userForToken(cookieValue(req.headers.cookie, SESSION_COOKIE)) : null
      if (seg[0] === 'health' && method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          engine: 'sqlite',
          embeddingDim: EMBEDDING_DIM,
          refine: opts.refine !== undefined,
          auth: accounts ? (user ? 'signed-in' : 'required') : 'none',
          live: true,
        })
      }
      if (accounts && !user) return sendJson(res, 401, { error: 'Sign in first.' })
      if (accounts && !SAFE.has(method) && !req.headers['x-wv-client']) return sendJson(res, 403, { error: 'missing x-wv-client header' })
      worldFor(user).handler(req, res)
    }
    run().catch((e: unknown) => {
      const status = e instanceof AccountError ? e.status : 500
      if (status === 500) console.error('[host]', e)
      if (!res.headersSent) sendJson(res, status, { error: e instanceof Error ? e.message : String(e) })
      else res.destroy()
    })
  }

  return {
    handler,
    accounts,
    close() {
      for (const w of worlds.values()) {
        w.bus.close()
        w.db.close()
      }
      worlds.clear()
      accounts?.close()
    },
  }
}
