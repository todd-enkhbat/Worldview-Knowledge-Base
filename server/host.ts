import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { Accounts, AccountError, RateLimit, type User } from './accounts.ts'
import { createApiHandler } from './api.ts'
import { ChangeBus } from './changes.ts'
import { openWorldDb, EMBEDDING_DIM, type WorldDb } from './worldDb.ts'
import { FolderCapture, handleFolderRequest } from './folderCapture.ts'
import { authenticateMemoryClient, memoryTokenWorld } from './memoryAccess.ts'
import { createCrmHttp } from './crmHttp.ts'
import { CrmConnections, handleCrmConnectionsRequest } from './crmConnections.ts'
import { createMemoryHttp, memoryOriginAllowed, sendMemoryJson } from './memoryHttp.ts'
import { createQmdHttp } from './qmdHttp.ts'
import { TelegramCapture, handleTelegramRequest, type TelegramOptions } from './telegramCapture.ts'
import { transcribeLocalMedia, closeLocalTranscription } from './localTranscription.ts'
import { handleWhisperModelRequest } from './whisperModels.ts'
import type { AiRuntime } from './ai.ts'
import { ArticleCapture, handleArticleCaptureRequest } from './articleCapture.ts'
import { GoogleDriveConnection, handleGoogleDriveRequest } from './connections/googleDrive.ts'
import { handleDesktopConnectionRequest } from './connections/desktop.ts'

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
  ai?: Pick<AiRuntime, 'status' | 'probe'>
  now?: () => number
  telegram?: Pick<TelegramOptions, 'token' | 'allowedUserIds' | 'allowedChatIds' | 'autoPoll' | 'fetch'>
}

interface World {
  db: WorldDb
  bus: ChangeBus
  handler: ReturnType<typeof createApiHandler>
  memory: ReturnType<typeof createMemoryHttp>
  qmd: ReturnType<typeof createQmdHttp>
  telegram: TelegramCapture
  articles: ArticleCapture
  drive: GoogleDriveConnection
  crm: ReturnType<typeof createCrmHttp>
  crmConnections: CrmConnections
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
      const crm = createCrmHttp(db, { store: db.crm, bus, now: opts.now, worldId: key, blobDir: join(dir, 'blobs') })
      w = { db, bus, crm, crmConnections: new CrmConnections({ db, blobDir: join(dir, 'blobs'), stageBatch: (batch) => db.crm.stageBatch(batch) }), drive: new GoogleDriveConnection({ db, blobDir: join(dir, 'blobs'), bus, now: opts.now }), articles: new ArticleCapture({ db, blobDir: join(dir, 'blobs'), bus, now: opts.now, saveContactPhoto: input => crm.photos!.saveCapturedProfile(input), saveFolkPhotos: input => crm.photos!.saveFolkPhotos(input), saveProfileData: input => crm.capture!.stage(input, { authorize: input.current, captureMethod: 'browser-extension' }) }), handler: createApiHandler({ db, blobDir: join(dir, 'blobs'), refine: opts.refine, chat: opts.chat, bus, now: opts.now }), memory: createMemoryHttp(db, key, opts.now, { bus, directory: dir }), qmd: createQmdHttp({ db, directory: join(dir, 'qmd') }), telegram: new TelegramCapture({ db, blobDir: join(dir, 'blobs'), bus, now: opts.now, ...(key === 'local' ? opts.telegram : {}), transcribe: transcribeLocalMedia }) }
      worlds.set(key, w)
    }
    return w
  }
  const worldFor = (user: User | null): World => (user ? world(user.id, join(dataDir, 'users', user.id)) : world('local', dataDir))

  // Persisted, explicitly registered folders resume with the local service even before
  // a browser opens. Hosted accounts never construct a filesystem capture service.
  let capture: FolderCapture | null = null
  let captureError: string | null = null
  if (!accounts) {
    try { const local = worldFor(null); capture = new FolderCapture({ dataDir, db: local.db, bus: local.bus }) }
    catch (error) { captureError = error instanceof Error ? error.message : String(error) }
  }

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
      if (seg[0] === 'reading-capture') {
        if (accounts) return sendJson(res, 403, { available: false, error: 'Browser reading capture is available only in the local app.' })
        return handleArticleCaptureRequest(worldFor(null).articles, req, res)
      }
      if (seg[0] === 'models' && await handleWhisperModelRequest(req, res)) return
      if (seg[0] === 'capture' && seg[1] !== 'telegram') {
        if (accounts) return sendJson(res, 403, { available: false, error: 'Local folder capture is disabled on account-hosted servers.' })
        if (seg[1] !== 'folders') return sendJson(res, 404, { available: false, error: 'Unknown capture route.' })
        if (!capture) return sendJson(res, 503, { available: false, error: captureError ?? 'Local folder capture is unavailable.' })
        return handleFolderRequest(capture, req, res)
      }
      if (seg[0] === 'auth') return auth(req, res, seg[1] ?? '')
      const user = accounts ? accounts.userForToken(cookieValue(req.headers.cookie, SESSION_COOKIE)) : null
      if (!accounts && (seg[0] === 'connections' || seg[0] === 'memory' || seg[0] === 'mcp' || seg[0] === 'qmd' || seg[0] === 'ai' || seg[0] === 'capture' && seg[1] === 'telegram')) {
        let hostname = ''
        try { hostname = new URL(`http://${req.headers.host ?? ''}`).hostname } catch { /* invalid host is refused */ }
        if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return sendMemoryJson(res, 403, { error: 'Local memory requires a loopback host.' })
      }
      if (seg[0] === 'mcp' || seg[0] === 'memory' && seg[1] !== 'clients' && seg[1] !== 'mirror') {
        if (!memoryOriginAllowed(req)) return sendMemoryJson(res, 403, { error: 'Origin is not permitted.' })
        const token = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? ''
        const key = memoryTokenWorld(token)
        const tokenUser = key && key !== 'local' && accounts ? accounts.userById(key) : null
        if (!key || accounts && !tokenUser || !accounts && key !== 'local') return sendMemoryJson(res, 401, { error: 'A memory client token is required.' })
        const selected = worldFor(tokenUser)
        const client = authenticateMemoryClient(selected.db, token, key, opts.now?.() ?? Date.now())
        if (!client) return sendMemoryJson(res, 401, { error: 'This memory client is expired, revoked or unavailable.' })
        return seg[0] === 'mcp' ? selected.memory.mcp(req, res, client) : selected.memory.operation(req, res, client, seg[1] ?? '')
      }
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
      if (seg[0] === 'ai' && seg[1] === 'status') {
        if (!memoryOriginAllowed(req) || !req.headers['x-wv-client']) return sendJson(res, 403, { error: 'Open the authorized workspace to check AI.' })
        if (method === 'GET') return sendJson(res, 200, opts.ai?.status() ?? { provider: null, model: null, configured: false })
        if (method === 'POST') return sendJson(res, 200, await opts.ai?.probe() ?? { provider: null, model: null, configured: false, ok: false, message: 'No AI provider is configured.' })
        return sendJson(res, 405, { error: 'Method not allowed.' })
      }
      if (seg[0] === 'connections' && seg[1] === 'assistant') return worldFor(user).memory.connections(req, res)
      if (seg[0] === 'connections' && seg[1] === 'desktop') { if (accounts) return sendJson(res, 403, { error: 'Desktop downloads are available from the local workspace.' }); return handleDesktopConnectionRequest(req, res) }
      if (seg[0] === 'connections' && seg[1] === 'drive') { if (accounts) return sendJson(res, 403, { error: 'Google Drive is available only in the local workspace.' }); return handleGoogleDriveRequest(worldFor(user).drive, req, res) }
      if (seg[0] === 'crm' && seg[1] === 'connections') { if (accounts) return sendJson(res, 403, { error: 'People connectors are available only in the local workspace.' }); return handleCrmConnectionsRequest(worldFor(user).crmConnections, req, res) }
      if (seg[0] === 'crm') { await worldFor(user).crm.handle(req, res); return }
      if (seg[0] === 'qmd') return worldFor(user).qmd.handle(req, res)
      if (seg[0] === 'capture' && seg[1] === 'telegram') return handleTelegramRequest(worldFor(user).telegram, req, res)
      if (seg[0] === 'memory' && seg[1] === 'mirror') return worldFor(user).memory.mirror(req, res)
      if (seg[0] === 'memory' && seg[1] === 'clients') return worldFor(user).memory.management(req, res)
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
      capture?.close()
      for (const w of worlds.values()) {
        w.qmd.close()
        w.telegram.close()
        w.bus.close()
        w.db.close()
      }
      worlds.clear()
      accounts?.close()
      closeLocalTranscription()
    },
  }
}
