import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { memoryOriginAllowed, sendMemoryJson } from '../memoryHttp.ts'

/** Only an explicitly built public application archive may be downloaded here. */
export async function handleDesktopConnectionRequest(req: IncomingMessage, res: ServerResponse, options: { releaseRoot?: string } = {}) {
  let local = false
  try { local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(`http://${req.headers.host ?? ''}`).hostname) && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') } catch { /* Invalid host. */ }
  if (!local || !memoryOriginAllowed(req) || !req.headers['x-wv-client'] && req.headers['sec-fetch-site'] !== 'same-origin') return sendMemoryJson(res, 403, { error: 'Open the local workspace to download Worldview.' })
  if (req.method !== 'GET') return sendMemoryJson(res, 405, { error: 'Use the desktop download link.' })
  const filename = `Worldview-mac-${process.arch}.zip`, archive = join(options.releaseRoot ?? fileURLToPath(new URL('../../data/desktop/releases/', import.meta.url)), filename), info = await lstat(archive).catch(() => null)
  const path = (req.url ?? '').split('?')[0]
  if (path === '/api/connections/desktop') return sendMemoryJson(res, 200, { available: !!info?.isFile(), filename, bytes: info?.size ?? 0, platform: 'macOS', architecture: process.arch, localSigning: 'ad-hoc', notarized: false, downloadPath: '/api/connections/desktop/download' })
  if (path !== '/api/connections/desktop/download') return sendMemoryJson(res, 404, { error: 'Unknown desktop download.' })
  if (!info?.isFile()) return sendMemoryJson(res, 404, { error: 'The desktop app download is not available from this local service yet.' })
  const file = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
  if (!file) return sendMemoryJson(res, 404, { error: 'The desktop app archive changed. Refresh the download status.' })
  try {
    const retained = await file.stat()
    if (!retained.isFile()) return sendMemoryJson(res, 404, { error: 'The desktop app download is not a regular archive.' })
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': retained.size, 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    await pipeline(file.createReadStream(), res)
  }
  catch { // Browser cancellation and disconnects are normal for a large app ZIP.
    // Headers may already be sent; never append JSON or leave a rejected handler.
    if (!res.destroyed) res.destroy()
  } finally { await file.close().catch(() => {}) }
}
