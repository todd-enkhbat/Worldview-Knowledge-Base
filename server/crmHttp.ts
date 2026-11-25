import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WorldDb } from './worldDb.ts'
import type { ChangeBus } from './changes.ts'
import { memoryOriginAllowed } from './memoryHttp.ts'
import { CrmError, SqliteCrmStore } from './crmStore.ts'
import { isCrmCollection, validateCrmFilter } from '../src/crm/model.ts'
import { CRM_COLLECTIONS, type CrmCommand, type CrmListQuery } from '../src/crm/types.ts'
import { CrmProfileMedia } from './crmProfileMedia.ts'
import { CrmPhotoCoverage } from './crmPhotoCoverage.ts'
import { CrmProfileCollection } from './crmProfileCollection.ts'
import { CrmProfileCapture } from './crmProfileCapture.ts'

const send = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) { size += chunk.length; if (size > 64 * 1024 * 1024) throw new CrmError('Import a CRM batch smaller than 64 MiB.', 413); chunks.push(chunk) }
  let value: unknown; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new CrmError('The CRM request must contain valid JSON.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CrmError('The CRM request must be an object.')
  return value as Record<string, unknown>
}
function queryFrom(url: URL): CrmListQuery {
  const params = url.searchParams, query: CrmListQuery = {}
  for (const key of ['q', 'groupId', 'entityId', 'status'] as const) if (params.has(key)) query[key] = params.get(key)!
  for (const key of ['limit', 'offset'] as const) if (params.has(key)) { const value = params.get(key)!; if (!/^\d+$/.test(value)) throw new CrmError('Choose an integer CRM page.'); query[key] = Number(value) }
  if (params.has('archived')) { if (!['true', 'false', '1', '0'].includes(params.get('archived')!)) throw new CrmError('Choose active or archived CRM records.'); query.archived = ['true', '1'].includes(params.get('archived')!) }
  if (params.has('entityType')) { const value = params.get('entityType'); if (!['person', 'company', 'object'].includes(String(value))) throw new CrmError('Choose a supported CRM entity type.'); query.entityType = value as CrmListQuery['entityType'] }
  try { if (params.has('filter')) { const value: unknown = JSON.parse(params.get('filter')!); if (!validateCrmFilter(value)) throw new Error(); query.filter = value } if (params.has('sort')) query.sort = JSON.parse(params.get('sort')!) as CrmListQuery['sort'] } catch { throw new CrmError('The CRM filter or sort is invalid.') }
  return query
}

/** Parent routing retains account authentication; browser requests also require same-origin and x-wv-client. */
export function createCrmHttp(db: WorldDb, options: { store?: SqliteCrmStore; bus?: ChangeBus; now?: () => number; worldId?: string; blobDir?: string; profileMediaFetch?: typeof fetch; profileMediaLookup?: (host: string) => Promise<string[]> } = {}) {
  const store = options.store ?? new SqliteCrmStore(db, { bus: options.bus, now: options.now })
  if (options.bus) store.setChangeBus(options.bus)
  const media = options.blobDir ? new CrmProfileMedia({ db, store, blobDir: options.blobDir, now: options.now, fetch: options.profileMediaFetch, lookup: options.profileMediaLookup }) : null
  const photos = options.blobDir ? new CrmPhotoCoverage({ db, store, blobDir: options.blobDir, now: options.now, fetch: options.profileMediaFetch, lookup: options.profileMediaLookup }) : null
  const capture = options.blobDir ? new CrmProfileCapture({ db, store, blobDir: options.blobDir, now: options.now }) : null
  const collect = options.blobDir && capture ? new CrmProfileCollection({ db, capture, blobDir: options.blobDir, fetch: options.profileMediaFetch, lookup: options.profileMediaLookup }) : null
  return {
    store, photos, capture,
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const url = new URL(req.url ?? '/', 'http://worldview.local'), pathname = url.pathname.replace(/\/$/, '')
      if (pathname !== '/api/crm' && !pathname.startsWith('/api/crm/')) return false
      try {
        if (!memoryOriginAllowed(req) || !req.headers['x-wv-client']) throw new CrmError('Open People in the authorized Worldview workspace.', 403)
        const parts = pathname.slice('/api/crm'.length).split('/').filter(Boolean).map(decodeURIComponent)
        if (parts[0] === 'profile-capture') {
          if (!capture) throw new CrmError('Profile capture storage is unavailable in this workspace.', 503)
          if (req.method === 'GET' && parts.length === 1) {
            const integer = (key: string, fallback: number) => { const value = url.searchParams.get(key); if (value !== null && !/^\d+$/.test(value)) throw new CrmError('Choose a valid profile capture page.'); return value === null ? fallback : Number(value) }
            send(res, 200, capture.list({ offset: integer('offset', 0), limit: integer('limit', 20), ...(url.searchParams.has('status') ? { status: url.searchParams.get('status')! } : {}) }))
          } else if (req.method === 'GET' && parts.length === 2) send(res, 200, capture.detail(parts[1]))
          else if (req.method === 'POST') {
            const generation = db.getReplacementGeneration(), body = await readBody(req)
            if (generation !== db.getReplacementGeneration()) throw new CrmError('The workspace changed while this capture request was read.', 409)
            if (parts.length === 2 && parts[1] === 'from-url') send(res, 200, await collect!.fromUrl(body))
            else if (parts.length === 2 && parts[1] === 'scan-saved') send(res, 200, await collect!.scanSaved(body))
            else if (parts.length === 1) send(res, 200, await capture.stage(body))
            else if (parts.length === 3 && parts[2] === 'apply') send(res, 200, await capture.apply(parts[1], body))
            else if (parts.length === 3 && parts[2] === 'dismiss') send(res, 200, capture.dismiss(parts[1], body))
            else throw new CrmError('Choose a supported profile capture operation.', 405)
          } else throw new CrmError('Choose a supported profile capture operation.', 405)
          return true
        }
        if (parts[0] === 'photo-coverage' && parts.length === 1 && req.method === 'GET') {
          if (!photos) throw new CrmError('Photo original auditing is unavailable in this workspace.', 503)
          const integer = (key: string, fallback: number) => { const value = url.searchParams.get(key); if (value !== null && !/^\d+$/.test(value)) throw new CrmError('Choose a valid photo coverage page.'); return value === null ? fallback : Number(value) }
          send(res, 200, await photos.inspect({ offset: integer('offset', 0), limit: integer('limit', 500), ...(url.searchParams.has('status') ? { status: url.searchParams.get('status')! } : {}) })); return true
        }
        if (parts[0] === 'profile-media') {
          if (!media) throw new CrmError('Profile image downloads are unavailable in this workspace.', 503)
          if (req.method === 'GET' && parts.length === 2 && parts[1] !== 'populate') send(res, 200, await media.inspect(parts[1], url.searchParams.get('discover') === 'true', url.searchParams.get('sourceUrl') || undefined))
          else if (req.method === 'POST' && parts.length === 2) {
            const generation = db.getReplacementGeneration(), body = await readBody(req)
            if (generation !== db.getReplacementGeneration()) throw new CrmError('The workspace changed while this request was read.', 409)
            send(res, 200, parts[1] === 'populate' ? await media.populate(body) : await media.populatePerson(parts[1], body))
          } else throw new CrmError('Choose a supported profile media operation.', 405)
          return true
        }
        if (req.method === 'GET') {
          if (!parts.length || parts[0] === 'status') send(res, 200, store.status())
          else if (parts[0] === 'collections') send(res, 200, { collections: CRM_COLLECTIONS, maxPageSize: 500 })
          else if (parts[0] === 'duplicates') send(res, 200, { revision: store.revision(), duplicates: store.duplicates() })
          else if (parts[0] === 'snapshot' || parts[0] === 'export') { res.setHeader('content-disposition', 'attachment; filename="Worldview-people.json"'); send(res, 200, store.portableSnapshot() ?? { schemaVersion: 1, revision: 0, ...Object.fromEntries(CRM_COLLECTIONS.map((key) => [key, []])) }) }
          else if (isCrmCollection(parts[0]) && parts.length === 1) send(res, 200, store.list(parts[0], queryFrom(url)))
          else if (isCrmCollection(parts[0]) && parts.length === 2) send(res, 200, store.detail(parts[0], parts[1]))
          else throw new CrmError('This CRM view is unavailable.', 404)
        } else if (req.method === 'POST' && parts[0] === 'command' && parts.length === 1) {
          const generation = db.getReplacementGeneration(), body = await readBody(req)
          if (generation !== db.getReplacementGeneration()) throw new CrmError('The workspace changed while the edit was being read. Refresh People and retry.', 409)
          send(res, 200, store.command(body as CrmCommand))
        } else { res.setHeader('Allow', 'GET, POST'); throw new CrmError('Choose a supported CRM operation.', 405) }
      } catch (error) {
        const status = error instanceof CrmError ? error.status : error instanceof URIError ? 400 : 400
        send(res, status, { error: error instanceof Error ? error.message : 'This CRM operation could not be completed.' })
      }
      return true
    },
  }
}
export const createCrmService = createCrmHttp
