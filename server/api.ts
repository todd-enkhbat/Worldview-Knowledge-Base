import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { AssetMeta, InteractionEvent, NodeRecord, WorldSettings } from '../src/domain/types.ts'
import { bytesF32, EMBEDDING_DIM, StoreInputError, type WorldDb } from './worldDb.ts'

// HTTP surface of the SQLite engine, mounted by the Vite plugin under /api on the app's own
// origin (no CORS, no second port). JSON in and out, except blob bytes, which stream raw.
//
//   GET  /api/health
//   /api/world/…        the WorldStore contract (src/data/httpStore.ts is the client)
//   /api/embeddings/…   the semantic index (512-d, sqlite-vec)
//   POST /api/refine    omnibox refinement (server/refine.ts; the API key never leaves here)
//
// Local only: the dev and preview servers bind to localhost (vite.config.ts).

export interface ApiOptions {
  db: WorldDb
  blobDir: string
  refine?: (body: unknown) => Promise<unknown>
  now?: () => number
}

type Handler = (req: IncomingMessage, res: ServerResponse, next?: () => void) => void

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function readJson<T>(req: IncomingMessage, limit = 256 * 1024 * 1024): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length
    if (size > limit) throw new HttpError(413, 'request body too large')
    chunks.push(c)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  } catch {
    throw new HttpError(400, 'body is not valid JSON')
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(text)
}

const blobFile = (dir: string, id: string) => join(dir, encodeURIComponent(id))

function decodeVector(v: unknown): Float32Array {
  if (typeof v === 'string') return bytesF32(new Uint8Array(Buffer.from(v, 'base64')))
  if (Array.isArray(v) && v.every((x) => typeof x === 'number')) return Float32Array.from(v)
  throw new HttpError(400, 'vector must be a base64 float32 string or a number array')
}

const encodeVector = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')

export function createApiHandler(opts: ApiOptions): Handler {
  const { db, blobDir } = opts
  const now = opts.now ?? Date.now
  let ready: Promise<void> | null = null
  const ensureDir = () => (ready ??= mkdir(blobDir, { recursive: true }).then(() => {}))

  async function route(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const seg = path.split('/').filter(Boolean).map(decodeURIComponent) // after /api

    if (seg[0] === 'health' && method === 'GET') {
      send(res, 200, { ok: true, engine: 'sqlite', embeddingDim: EMBEDDING_DIM, refine: opts.refine !== undefined })
      return true
    }

    if (seg[0] === 'world') {
      const [, what, id] = seg
      if (what === 'settings') {
        if (method === 'GET') return send(res, 200, db.getSettings()), true
        if (method === 'PUT') return db.putSettings(await readJson<WorldSettings>(req)), send(res, 204, undefined), true
      }
      if (what === 'nodes') {
        if (method === 'GET' && !id) return send(res, 200, db.listNodes()), true
        if (method === 'GET' && id) return send(res, 200, db.getNode(id) ?? null), true
        if (method === 'PUT' && !id) return db.putNodes(await readJson<NodeRecord[]>(req)), send(res, 204, undefined), true
        if (method === 'DELETE' && id) return db.deleteNode(id), send(res, 204, undefined), true
      }
      if (what === 'events') {
        const since = url.searchParams.get('since')
        const before = url.searchParams.get('before')
        if (method === 'GET') return send(res, 200, db.listEvents(since === null ? undefined : Number(since))), true
        if (method === 'POST') return db.appendEvent(await readJson<InteractionEvent>(req)), send(res, 204, undefined), true
        if (method === 'DELETE') return send(res, 200, { cleared: db.clearEvents(before === null ? undefined : Number(before)) }), true
      }
      if (what === 'assets') {
        if (method === 'GET' && !id) return send(res, 200, db.listAssets()), true
        if (method === 'GET' && id) return send(res, 200, db.getAssetMeta(id) ?? null), true
      }
      if (what === 'blobs' && id) {
        await ensureDir()
        const file = blobFile(blobDir, id)
        if (method === 'PUT') {
          const metaParam = url.searchParams.get('meta')
          if (!metaParam) throw new HttpError(400, 'meta query parameter is required')
          const meta = JSON.parse(metaParam) as AssetMeta
          if (typeof meta?.id !== 'string' || meta.id !== id) throw new HttpError(400, 'meta.id must match the path')
          // Write to a temp file and rename: a failed or aborted upload never replaces good bytes.
          const tmp = `${file}.${process.pid}.${now()}.part`
          try {
            await pipeline(req, createWriteStream(tmp))
            const { size } = await stat(tmp)
            await rename(tmp, file)
            db.putAssetMeta({ ...meta, bytes: size })
          } catch (e) {
            await rm(tmp, { force: true })
            throw e
          }
          return send(res, 204, undefined), true
        }
        if (method === 'GET') {
          const meta = db.getAssetMeta(id)
          if (!meta) return send(res, 404, { error: 'no such blob' }), true
          res.writeHead(200, { 'content-type': meta.mime || 'application/octet-stream', 'content-length': String(meta.bytes), 'cache-control': 'no-store' })
          await pipeline(createReadStream(file), res)
          return true
        }
        if (method === 'DELETE') {
          db.deleteAssetMeta(id)
          await rm(file, { force: true })
          return send(res, 204, undefined), true
        }
      }
      if (what === 'kv' && id) {
        if (method === 'GET') {
          const v = db.getKv(id)
          return send(res, 200, v === undefined ? { found: false } : { found: true, value: v }), true
        }
        if (method === 'PUT') return db.putKv(id, (await readJson<{ value: unknown }>(req)).value), send(res, 204, undefined), true
        if (method === 'DELETE') return db.deleteKv(id), send(res, 204, undefined), true
      }
      if (what === 'wipe' && method === 'POST') {
        db.wipe()
        await ensureDir()
        for (const f of await readdir(blobDir)) await rm(join(blobDir, f), { force: true })
        return send(res, 204, undefined), true
      }
    }

    if (seg[0] === 'embeddings') {
      const [, what] = seg
      if (what === 'meta' && method === 'GET') return send(res, 200, db.embeddingMeta()), true
      if (what === 'all' && method === 'GET') {
        return send(res, 200, db.allEmbeddings().map((e) => ({ id: e.id, vector: encodeVector(e.vector) }))), true
      }
      if (what === 'knn' && method === 'POST') {
        const b = await readJson<{ vector: unknown; k?: number }>(req)
        return send(res, 200, db.knn(decodeVector(b.vector), b.k ?? 8)), true
      }
      if (what === 'wipe' && method === 'POST') return db.wipeEmbeddings(), send(res, 204, undefined), true
      if (what && what !== 'meta' && what !== 'all' && what !== 'knn') {
        if (method === 'PUT') {
          const b = await readJson<{ vector: unknown; hash: string; model: string }>(req)
          if (typeof b.hash !== 'string' || typeof b.model !== 'string') throw new HttpError(400, 'hash and model are required')
          db.putEmbedding(what, decodeVector(b.vector), b.hash, b.model, now())
          return send(res, 204, undefined), true
        }
        if (method === 'DELETE') return db.deleteEmbedding(what), send(res, 204, undefined), true
      }
    }

    if (seg[0] === 'refine' && method === 'POST') {
      if (!opts.refine) return send(res, 503, { error: 'refinement is not configured (no ANTHROPIC_API_KEY)' }), true
      return send(res, 200, await opts.refine(await readJson<unknown>(req, 1024 * 1024))), true
    }
    return false
  }

  return (req, res, next) => {
    const url = req.url ?? '/'
    if (!url.startsWith('/api/')) return next ? next() : send(res, 404, { error: 'not found' })
    const path = url.slice('/api'.length).split('?', 1)[0]
    route(req, res, path, req.method ?? 'GET')
      .then((handled) => {
        if (!handled) send(res, 404, { error: `no route for ${req.method} ${path}` })
      })
      .catch((e: unknown) => {
        const status = e instanceof HttpError ? e.status : e instanceof StoreInputError ? 400 : isConstraint(e) ? 400 : 500
        if (status === 500) console.error('[api]', e)
        if (!res.headersSent) send(res, status, { error: e instanceof Error ? e.message : String(e) })
        else res.destroy()
      })
  }
}

function isConstraint(e: unknown): boolean {
  return e instanceof Error && /constraint|NOT NULL/i.test(e.message)
}
