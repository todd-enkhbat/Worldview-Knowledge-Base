import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { WHISPER_FILES, WHISPER_MODEL, WHISPER_REVISION } from '../src/ai/transcribeConfig.ts'
import { localTranscriptionAvailability, whisperModelRoot } from './localTranscription.ts'

/** Only pinned public model assets are served; never arbitrary paths or original media. */
export async function handleWhisperModelRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const pathname = (req.url ?? '').split('?')[0]
  if (!pathname.startsWith('/api/models/')) return false
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true }
  const available = localTranscriptionAvailability()
  if (pathname === '/api/models/whisper/status') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(available)); return true }
  const prefix = `/api/models/${WHISPER_REVISION}/${WHISPER_MODEL}/`
  const file = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : ''
  if (!available.modelReady || !WHISPER_FILES.includes(file as typeof WHISPER_FILES[number])) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return true }
  const path = join(whisperModelRoot(), WHISPER_MODEL, file), info = await stat(path)
  let start = 0, end = info.size - 1, status = 200
  if (req.headers.range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range)
    if (!match) { res.writeHead(416, { 'content-range': `bytes */${info.size}` }); res.end(); return true }
    start = Number(match[1]); end = match[2] ? Number(match[2]) : end
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= info.size) { res.writeHead(416, { 'content-range': `bytes */${info.size}` }); res.end(); return true }
    end = Math.min(end, info.size - 1); status = 206
  }
  res.writeHead(status, { 'content-type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=604800, immutable', ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${info.size}` } : {}) })
  if (req.method === 'HEAD') res.end()
  else await pipeline(createReadStream(path, { start, end }), res)
  return true
}
