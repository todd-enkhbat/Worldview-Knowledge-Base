import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { createChat } from './chat.ts'
import { createHost, type Host } from './host.ts'
import { createRefiner } from './refine.ts'

// Mounts the SQLite engine's API (server/host.ts) on the Vite dev and preview servers, so the
// app and its engine share one origin (localhost:5173) and storage partitioning never splits
// them. The static build has no server: the app then stays on IndexedDB. The hosted server
// (server/main.ts) serves the same API next to the built app.
//
// Data: <root>/data/world.sqlite and <root>/data/blobs/ (gitignored). The Anthropic key is
// read from the environment (.env.local is loaded by vite.config.ts) and stays server-side.

export interface EnginePluginOptions {
  dataDir?: string
  apiKey?: string
  /** Require sign-in (as the hosted server does with HYPERSPACE_ACCOUNTS=1). */
  accounts?: boolean
}

export function hyperspaceEngine(opts: EnginePluginOptions = {}): Plugin {
  let host: Host | null = null
  const mount = (root: string) => {
    host ??= createHost({
      dataDir: resolve(root, opts.dataDir ?? 'data'),
      accounts: opts.accounts,
      refine: opts.apiKey ? createRefiner({ apiKey: opts.apiKey }) : undefined,
      chat: opts.apiKey ? createChat({ apiKey: opts.apiKey }) : undefined,
    })
    return host.handler
  }
  return {
    name: 'hyperspace-engine',
    configureServer(server) {
      server.middlewares.use(mount(server.config.root))
      server.httpServer?.once('close', () => {
        host?.close()
        host = null
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use(mount(server.config.root))
    },
  }
}
