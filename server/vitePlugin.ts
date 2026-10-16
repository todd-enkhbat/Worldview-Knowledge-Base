import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { createApiHandler } from './api.ts'
import { createRefiner } from './refine.ts'
import { openWorldDb, type WorldDb } from './worldDb.ts'

// Mounts the SQLite engine's API (server/api.ts) on the Vite dev and preview servers, so the
// app and its engine share one origin (localhost:5173) and storage partitioning never splits
// them. The static build has no server: the app then stays on IndexedDB.
//
// Data: <root>/data/world.sqlite and <root>/data/blobs/ (gitignored). The Anthropic key is
// read from the environment (.env.local is loaded by vite.config.ts) and stays server-side.

export interface EnginePluginOptions {
  dataDir?: string
  apiKey?: string
}

export function hyperspaceEngine(opts: EnginePluginOptions = {}): Plugin {
  let db: WorldDb | null = null
  const mount = (root: string, attach: (h: ReturnType<typeof createApiHandler>) => void) => {
    const dataDir = resolve(root, opts.dataDir ?? 'data')
    db ??= openWorldDb(resolve(dataDir, 'world.sqlite'))
    const refine = opts.apiKey ? createRefiner({ apiKey: opts.apiKey }) : undefined
    attach(createApiHandler({ db, blobDir: resolve(dataDir, 'blobs'), refine }))
  }
  return {
    name: 'hyperspace-engine',
    configureServer(server) {
      mount(server.config.root, (h) => server.middlewares.use(h))
      server.httpServer?.once('close', () => {
        db?.close()
        db = null
      })
    },
    configurePreviewServer(server) {
      mount(server.config.root, (h) => server.middlewares.use(h))
    },
  }
}
