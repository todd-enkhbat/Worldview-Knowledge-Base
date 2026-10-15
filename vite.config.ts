import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// One canonical origin: browser storage is partitioned by origin (port included),
// so dev and preview both serve on localhost:5173 and refuse to fall back.
const PORT = 5173

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: 'localhost', port: PORT, strictPort: true },
  preview: { host: 'localhost', port: PORT, strictPort: true },
  worker: { format: 'es' },
  build: { target: 'es2023', sourcemap: true, chunkSizeWarningLimit: 4096 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    testTimeout: 60_000,
  },
})
