import type { IncomingMessage, ServerResponse } from 'node:http'
import { QmdService } from './qmdService.ts'
import type { WorldDb } from './worldDb.ts'
import type { SearchFilters, SourceKind } from '../src/knowledge/types.ts'
import { memoryOriginAllowed, readMemoryBody, sendMemoryJson } from './memoryHttp.ts'

function filtersFrom(raw: unknown): SearchFilters {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const input = raw as Record<string, unknown>, filters: SearchFilters = { aiOnly: true }
  if (input.sourceIds !== undefined) {
    if (!Array.isArray(input.sourceIds) || input.sourceIds.length > 1000 || !input.sourceIds.every((id) => typeof id === 'string')) throw new Error('Source scope must contain at most 1000 IDs.')
    filters.sourceIds = input.sourceIds as string[]
  }
  if (input.role !== undefined) { if (!['human', 'assistant', 'third-party', 'unknown'].includes(String(input.role))) throw new Error('Choose a valid authorship scope.'); filters.role = input.role as SearchFilters['role'] }
  if (input.kinds !== undefined) { if (!Array.isArray(input.kinds) || !input.kinds.every((kind) => ['thought', 'document', 'chatgpt', 'claude', 'obsidian', 'legacy', 'conversation'].includes(String(kind)))) throw new Error('Choose valid source kinds.'); filters.kinds = input.kinds as SourceKind[] }
  for (const key of ['authoredAfter', 'authoredBefore'] as const) if (input[key] !== undefined) { if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) throw new Error('Authored dates must be finite timestamps.'); filters[key] = input[key] }
  if (input.includeHistory === true) filters.includeHistory = true
  if (input.limit !== undefined) { if (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 50) throw new Error('QMD result limit is 1–50.'); filters.limit = Number(input.limit) }
  return filters
}

export function createQmdHttp(options: { db: WorldDb; directory: string }) {
  const service = new QmdService(options.db, options.directory)
  return {
    service,
    close: () => service.close(),
    async handle(req: IncomingMessage, res: ServerResponse) {
      if (!memoryOriginAllowed(req) || !req.headers['x-wv-client']) return sendMemoryJson(res, 403, { error: 'Open the authorized workspace to use local QMD.' })
      const operation = (req.url ?? '').split('?')[0].split('/')[3] ?? ''
      try {
        if (operation === 'status' && req.method === 'GET') return sendMemoryJson(res, 200, await service.status())
        if (operation === 'index' && req.method === 'DELETE') return sendMemoryJson(res, 200, await service.disable())
        if (req.method !== 'POST') return sendMemoryJson(res, 405, { error: 'Method not allowed.' })
        const body = await readMemoryBody(req)
        if (operation === 'index') {
          if (!Array.isArray(body.sourceIds) || !body.sourceIds.every((id) => typeof id === 'string') || !['lexical', 'hybrid'].includes(String(body.mode)) || body.followNewSources !== undefined && typeof body.followNewSources !== 'boolean') throw new Error('Choose explicit sources and lexical or hybrid mode.')
          return sendMemoryJson(res, 200, await service.configure(body.sourceIds as string[], body.mode as 'lexical' | 'hybrid', body.followNewSources === true))
        }
        if (operation === 'search') {
          if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 2000) throw new Error('Provide a search question of 1–2000 characters.')
          if (body.mode !== undefined && !['lexical', 'hybrid'].includes(String(body.mode))) throw new Error('Choose lexical or hybrid mode.')
          if (body.candidates !== undefined && ![10, 20, 40].includes(Number(body.candidates))) throw new Error('Candidate count must be 10, 20 or 40.')
          const controller = new AbortController()
          const cancel = () => { if (!res.writableEnded) controller.abort() }
          res.once('close', cancel)
          try { return sendMemoryJson(res, 200, await service.search(body.query, filtersFrom(body.filters), { mode: body.mode as 'lexical' | 'hybrid' | undefined, candidates: body.candidates === undefined ? undefined : Number(body.candidates), signal: controller.signal })) }
          finally { res.off('close', cancel) }
        }
        return sendMemoryJson(res, 404, { error: 'Unknown QMD operation.' })
      } catch (error) { if (!res.headersSent && !res.destroyed) return sendMemoryJson(res, 409, { error: error instanceof Error ? error.message : String(error) }) }
    },
  }
}
