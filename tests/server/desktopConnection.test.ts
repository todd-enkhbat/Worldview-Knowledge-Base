import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { handleDesktopConnectionRequest } from '../../server/connections/desktop.ts'
const live: { server: Server; root: string }[] = []
afterEach(async () => { for (const item of live.splice(0)) { item.server.closeAllConnections(); await new Promise<void>((done) => item.server.close(() => done())); rmSync(item.root, { recursive: true, force: true }) } })
it('downloads only the fixed public desktop release and rejects foreign origins or arbitrary paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'worldview-desktop-download-')), filename = `Worldview-mac-${process.arch}.zip`, bytes = Buffer.from('PK\x03\x04synthetic-public-app')
  writeFileSync(join(root, filename), bytes); writeFileSync(join(root, 'private.txt'), 'never expose another file')
  const server = createServer((req, res) => { void handleDesktopConnectionRequest(req, res, { releaseRoot: root }) }); live.push({ server, root }); await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/connections/desktop`, headers = { 'x-wv-client': 'desktop-test' }
  expect((await fetch(base)).status).toBe(403)
  expect((await fetch(base, { headers: { ...headers, origin: 'https://untrusted.example' } })).status).toBe(403)
  expect(await (await fetch(base, { headers })).json()).toMatchObject({ available: true, filename, notarized: false })
  const download = await fetch(`${base}/download?file=private.txt`, { headers })
  expect(download.status).toBe(200); expect(download.headers.get('content-disposition')).toContain(filename); expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes)
  expect((await fetch(`${base}/private.txt`, { headers })).status).toBe(404)
  const sameOrigin = await fetch(`${base}/download`, { headers: { 'sec-fetch-site': 'same-origin' } }); expect(sameOrigin.status).toBe(200); await sameOrigin.arrayBuffer()
})

it('settles a canceled download without rejecting its handler or breaking the next status request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'worldview-desktop-abort-'))
  writeFileSync(join(root, `Worldview-mac-${process.arch}.zip`), Buffer.alloc(8 * 1024 * 1024, 1))
  let finish: () => void = () => {}, rejected: unknown
  const settled = new Promise<void>((done) => { finish = done })
  const server = createServer((req, res) => { const handled = handleDesktopConnectionRequest(req, res, { releaseRoot: root }); if ((req.url ?? '').endsWith('/download')) void handled.then(finish, (error: unknown) => { rejected = error; finish() }); else void handled })
  live.push({ server, root }); await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/connections/desktop`, headers = { 'x-wv-client': 'desktop-abort-test' }
  const response = await fetch(`${base}/download`, { headers }); expect(response.status).toBe(200)
  const reader = response.body!.getReader(); await reader.read(); await reader.cancel()
  await settled
  expect(rejected).toBeUndefined()
  expect((await fetch(base, { headers })).status).toBe(200)
})

it('does not treat a symlink to another local file as a public release archive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'worldview-desktop-symlink-'))
  writeFileSync(join(root, 'private.txt'), 'This is not an application archive.')
  symlinkSync(join(root, 'private.txt'), join(root, `Worldview-mac-${process.arch}.zip`))
  const server = createServer((req, res) => { void handleDesktopConnectionRequest(req, res, { releaseRoot: root }) })
  live.push({ server, root }); await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/connections/desktop`, headers = { 'x-wv-client': 'desktop-symlink-test' }
  expect(await (await fetch(base, { headers })).json()).toMatchObject({ available: false })
  expect((await fetch(`${base}/download`, { headers })).status).toBe(404)
})
