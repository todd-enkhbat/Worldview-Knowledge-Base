import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createChat } from './chat.ts'
import { createHost } from './host.ts'
import { createRefiner } from './refine.ts'

// The app as one Node process: the built client (dist/, `npm run build`) plus the /api engine,
// on one origin. This is what runs when the app is hosted (Dockerfile, docs/HOSTING.md) and
// inside the desktop app (desktop/). Node ≥ 26 runs it directly: `node server/main.ts`.
//
// Environment:
//   PORT (5173) · HOST (127.0.0.1; 0.0.0.0 in a container)
//   HYPERSPACE_DATA (./data) · HYPERSPACE_DIST (./dist)
//   HYPERSPACE_ACCOUNTS=1 to require sign-in, one world per account
//   HYPERSPACE_SIGNUP=open to let anyone sign up (default: only the first account)
//   ANTHROPIC_API_KEY for the chat and refinement (optional)

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.spz': 'application/octet-stream',
  '.ply': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
}

export interface StaticOptions {
  dist: string
}

/** Serves dist/ with an index.html fallback for client routes; hashed assets are cached for a year. */
export function createStatic({ dist }: StaticOptions) {
  const root = resolve(dist)
  let index: Buffer | null = null
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, SECURITY_HEADERS).end()
      return
    }
    let path: string
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    } catch {
      res.writeHead(400, SECURITY_HEADERS).end()
      return
    }
    const file = normalize(join(root, path))
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403, SECURITY_HEADERS).end()
      return
    }
    const s = await stat(file).catch(() => null)
    if (s?.isFile()) {
      const immutable = path.startsWith('/assets/')
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(s.size),
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      })
      if (method === 'HEAD') return void res.end()
      await pipeline(createReadStream(file), res)
      return
    }
    // A client route (or a missing file without an extension): the app.
    if (extname(path)) {
      res.writeHead(404, SECURITY_HEADERS).end()
      return
    }
    index ??= await readFile(join(root, 'index.html'))
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME['.html'], 'cache-control': 'no-cache' })
    res.end(method === 'HEAD' ? undefined : index)
  }
}

export function startServer(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.ANTHROPIC_API_KEY || undefined
  const host = createHost({
    dataDir: env.HYPERSPACE_DATA ?? 'data',
    accounts: env.HYPERSPACE_ACCOUNTS === '1',
    signup: env.HYPERSPACE_SIGNUP === 'open' ? 'open' : 'first',
    refine: apiKey ? createRefiner({ apiKey }) : undefined,
    chat: apiKey ? createChat({ apiKey }) : undefined,
  })
  const serveStatic = createStatic({ dist: env.HYPERSPACE_DIST ?? 'dist' })
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/api/')) return host.handler(req, res)
    serveStatic(req, res).catch((e: unknown) => {
      console.error('[static]', e)
      if (!res.headersSent) res.writeHead(500).end()
      else res.destroy()
    })
  })
  const port = Number(env.PORT ?? 5173)
  const bind = env.HOST ?? '127.0.0.1'
  server.listen(port, bind, () => {
    const a = server.address()
    const shown = typeof a === 'object' && a ? `${bind}:${a.port}` : `${bind}:${port}`
    console.log(`[hyperspace] serving on http://${shown} · accounts ${host.accounts ? 'on' : 'off'} · AI ${apiKey ? 'on' : 'off'}`)
  })
  const stop = () => {
    server.close()
    host.close()
  }
  return { server, host, stop }
}

if (import.meta.main) {
  const { stop } = startServer()
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stop(), process.exit(0)))
}
