import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHost } from '../../server/host.ts'
import { SCHEMA_VERSION } from '../../src/domain/types.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function serve(accounts = false, invalidRegistry = false) {
  const root = mkdtempSync(join(tmpdir(), 'wv-capture-endpoint-'))
  const data = join(root, 'data')
  const notes = join(root, 'notes')
  mkdirSync(data)
  mkdirSync(notes)
  if (invalidRegistry) writeFileSync(join(data, 'capture-folders.json'), 'broken registry')
  const host = createHost({ dataDir: data, accounts })
  const server = createServer((request, response) => host.handler(request, response))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); host.close(); rmSync(root, { recursive: true, force: true }) })
  const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({ method, headers: { 'content-type': 'application/json', 'x-wv-client': 'capture-test', origin, ...headers }, body: JSON.stringify(body) })
  if (!accounts) await fetch(`${origin}/api/world/settings`, json('PUT', { T0: Date.UTC(2000, 0, 1), yPerYear: 12, stepsPerYear: 600, physicsSeed: 123, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: Date.now(), schemaVersion: SCHEMA_VERSION }))
  return { origin, notes, data, json }
}

describe('local folder API', () => {
  it('registers only an explicit folder and exposes real pause/resume/remove controls', async () => {
    const f = await serve()
    writeFileSync(join(f.notes, 'intent.md'), '# My intent\nA real background source.')
    expect(await (await fetch(`${f.origin}/api/capture/folders`)).json()).toMatchObject({ available: true, folders: [] })
    const added = await fetch(`${f.origin}/api/capture/folders`, f.json('POST', { path: f.notes }))
    expect(added.status).toBe(201)
    const { folders } = await added.json() as { folders: { id: string; status: string }[] }
    expect(folders[0].status).toBe('watching')
    const id = folders[0].id
    const nodes = await (await fetch(`${f.origin}/api/world/nodes`)).json() as { contentMd: string }[]
    expect(nodes[0].contentMd).toContain('real background source')
    const paused = await fetch(`${f.origin}/api/capture/folders/${id}`, f.json('PATCH', { paused: true }))
    expect(await paused.json()).toMatchObject({ folders: [{ paused: true, status: 'paused' }] })
    const resumed = await fetch(`${f.origin}/api/capture/folders/${id}`, f.json('PATCH', { paused: false }))
    expect(await resumed.json()).toMatchObject({ folders: [{ paused: false, status: 'watching' }] })
    const removed = await fetch(`${f.origin}/api/capture/folders/${id}`, { method: 'DELETE', headers: { origin: f.origin, 'x-wv-client': 'capture-test' } })
    expect(await removed.json()).toMatchObject({ folders: [] })
    expect((await (await fetch(`${f.origin}/api/world/nodes`)).json() as unknown[])).toHaveLength(1)
  })

  it('rejects missing clients, foreign origins and rebound hosts before registering any path', async () => {
    const f = await serve()
    const url = `${f.origin}/api/capture/folders`
    expect((await fetch(url, { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json' }, body: JSON.stringify({ path: f.notes }) })).status).toBe(403)
    expect((await fetch(url, f.json('POST', { path: f.notes }, { origin: 'https://evil.example' }))).status).toBe(403)
    expect((await fetch(url, f.json('POST', { path: f.notes }, { host: `evil.example:${new URL(f.origin).port}`, origin: `http://evil.example:${new URL(f.origin).port}` }))).status).toBe(403)
    expect((await fetch(url, f.json('POST', null))).status).toBe(400)
    expect((await fetch(url, f.json('POST', { path: '../notes' }))).status).toBe(400)
    expect(await (await fetch(url)).json()).toMatchObject({ folders: [] })
  })

  it('disables filesystem capture on account-hosted servers and isolates an invalid registry from the normal world API', async () => {
    const hosted = await serve(true)
    expect((await fetch(`${hosted.origin}/api/capture/folders`)).status).toBe(403)
    expect((await fetch(`${hosted.origin}/api/capture/folders`, hosted.json('POST', { path: hosted.notes }))).status).toBe(403)
    const local = await serve(false, true)
    expect((await fetch(`${local.origin}/api/capture/folders`)).status).toBe(503)
    expect((await fetch(`${local.origin}/api/world/nodes`)).status).toBe(200)
  })
})
