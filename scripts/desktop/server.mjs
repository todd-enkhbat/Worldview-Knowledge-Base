import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createHost } from '../../server/host.ts'

// The desktop child is the normal authoritative API. Its environment is explicit:
// no .env files, provider credentials, cloud generation, or hosted account mode.
const values = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) => index % 2 ? pairs : [...pairs, [value.replace(/^--/, ''), args[index + 1]]], []))
const directory = resolve(values.workspace ?? ''), dist = await realpath(resolve(values.dist ?? 'dist')), port = Number(values.port ?? 5173)
if (!values.workspace || !Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a local workspace folder and a valid desktop port.')
const host = createHost({ dataDir: directory, accounts: false, ai: { status: () => ({ provider: null, model: null, configured: false }), probe: async () => ({ provider: null, model: null, configured: false, ok: false, message: 'Cloud AI is off in the desktop app.' }) } })
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.txt': 'text/plain' }
const headers = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'DENY' }
const server = createServer((req, res) => {
  if ((req.url ?? '').startsWith('/api/')) return host.handler(req, res)
  void (async () => {
    if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) { res.writeHead(405, headers).end(); return }
    let path; try { path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname) } catch { res.writeHead(400, headers).end(); return }
    const file = normalize(join(dist, path)); if (file !== dist && !file.startsWith(dist + sep)) { res.writeHead(403, headers).end(); return }
    const retained = await realpath(file).catch(() => null)
    if (retained && retained !== dist && !retained.startsWith(dist + sep)) { res.writeHead(403, headers).end(); return }
    const info = retained ? await stat(retained).catch(() => null) : null
    if (info?.isFile()) { res.writeHead(200, { ...headers, 'content-type': mime[extname(file)] ?? 'application/octet-stream', 'content-length': info.size, 'cache-control': path.startsWith('/assets/') ? 'public,max-age=31536000,immutable' : 'no-cache' }); if (req.method === 'HEAD') res.end(); else await pipeline(createReadStream(retained), res); return }
    if (extname(path)) { res.writeHead(404, headers).end(); return }
    const index = await realpath(join(dist, 'index.html')); if (!index.startsWith(dist + sep)) { res.writeHead(403, headers).end(); return }
    const html = await readFile(index); res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : html)
  })().catch(() => { if (!res.headersSent) res.writeHead(500, headers).end(); else res.destroy() })
})
server.once('error', (error) => { console.error(`Desktop local service failed: ${error.message}`); process.exitCode = 1; host.close() })
server.listen(port, '127.0.0.1', () => { console.log(JSON.stringify({ worldviewDesktopReady: true, url: `http://127.0.0.1:${port}` })) })
let stopping = false
function stop() { if (stopping) return; stopping = true; server.closeAllConnections(); server.close(() => { host.close(); process.exit(0) }); setTimeout(() => process.exit(0), 2500).unref() }
process.on('SIGINT', stop); process.on('SIGTERM', stop)
