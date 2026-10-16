import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { createApiHandler, type ApiOptions } from '../../server/api.ts'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'

// A throwaway SQLite engine on a random localhost port: in-memory database, temp blob dir.
// Every engine started in a test file is closed after that file.

export interface TestEngine {
  base: string
  db: WorldDb
  blobDir: string
  server: Server
}

const started: TestEngine[] = []
let hooked = false

export async function startTestEngine(opts: Partial<Omit<ApiOptions, 'db' | 'blobDir'>> = {}): Promise<TestEngine> {
  if (!hooked) {
    hooked = true
    afterAll(async () => {
      for (const e of started.splice(0)) {
        await new Promise<void>((r) => e.server.close(() => r()))
        e.db.close()
        rmSync(e.blobDir, { recursive: true, force: true })
      }
    })
  }
  const db = openWorldDb(':memory:')
  const blobDir = mkdtempSync(join(tmpdir(), 'hs-engine-'))
  const server = createServer(createApiHandler({ db, blobDir, ...opts }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const { port } = server.address() as AddressInfo
  const engine = { base: `http://127.0.0.1:${port}/api`, db, blobDir, server }
  started.push(engine)
  return engine
}
