import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { createHost, type Host } from './host.ts'
import { createAi } from './ai.ts'
import { telegramIds } from './telegramCapture.ts'

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
  env?: NodeJS.ProcessEnv
  /** Require sign-in (as the hosted server does with HYPERSPACE_ACCOUNTS=1). */
  accounts?: boolean
}

export function hyperspaceEngine(opts: EnginePluginOptions = {}): Plugin {
  let host: Host | null = null
  const mount = (root: string) => {
    const env = opts.env ?? { ...process.env, ANTHROPIC_API_KEY: opts.apiKey ?? process.env.ANTHROPIC_API_KEY }
    const ai = createAi({ env })
    host ??= createHost({
      dataDir: resolve(root, opts.dataDir ?? 'data'),
      accounts: opts.accounts,
      ai,
      refine: ai.refine,
      chat: ai.chat,
      telegram: { token: env.TELEGRAM_BOT_TOKEN, allowedUserIds: telegramIds(env.TELEGRAM_ALLOWED_USER_IDS), allowedChatIds: telegramIds(env.TELEGRAM_ALLOWED_CHAT_IDS) },
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
      server.httpServer?.once('close', () => { host?.close(); host = null })
    },
  }
}
