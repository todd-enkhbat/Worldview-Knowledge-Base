import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { hyperspaceEngine } from './server/vitePlugin.ts'

// One canonical origin: browser storage is partitioned by origin (port included),
// so dev and preview both serve on localhost:5173 and refuse to fall back.
const PORT = 5173

export default defineConfig(({ mode }) => {
  // '' prefix: read ANTHROPIC_API_KEY too. It goes to the server plugin only; nothing
  // without the VITE_ prefix reaches the client bundle.
  const env = loadEnv(mode, process.cwd(), '')
  const apiKey = env.ANTHROPIC_API_KEY || undefined
  return {
    // Vitest starts a Vite server too: keep tests off the real data/world.sqlite.
    plugins: [react(), tailwindcss(), ...(process.env.VITEST ? [] : [hyperspaceEngine({ apiKey })])],
    server: { host: 'localhost', port: PORT, strictPort: true },
    preview: { host: 'localhost', port: PORT, strictPort: true },
    worker: { format: 'es' as const },
    build: { target: 'es2023', sourcemap: true, chunkSizeWarningLimit: 4096 },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
      testTimeout: 60_000,
    },
  }
})
