import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const fixtures: { child: ChildProcess; root: string }[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) { if (fixture.child.exitCode === null && !fixture.child.signalCode) { const exited = new Promise<void>((done) => fixture.child.once('exit', () => done())); fixture.child.kill('SIGTERM'); await exited } rmSync(fixture.root, { recursive: true, force: true }) } })

it('serves retained static files and refuses symlinks escaping the desktop client directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'worldview-desktop-static-')), dist = join(root, 'dist'), vault = join(root, 'vault')
  mkdirSync(dist); mkdirSync(vault); writeFileSync(join(dist, 'index.html'), '<html>Local workspace</html>'); writeFileSync(join(dist, 'retained.txt'), 'A retained public file'); writeFileSync(join(root, 'private.txt'), 'Never served from outside dist')
  symlinkSync(join(root, 'private.txt'), join(dist, 'escape.txt'))
  const reservation = createServer(); await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done)); const port = (reservation.address() as { port: number }).port; await new Promise<void>((done) => reservation.close(() => done()))
  const child = spawn(process.execPath, [resolve('scripts/desktop/server.mjs'), '--workspace', vault, '--dist', dist, '--port', String(port)], { cwd: resolve('.'), env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, AI_PROVIDER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'] })
  fixtures.push({ child, root })
  await new Promise<void>((done, reject) => { let output = '', diagnostics = ''; const timer = setTimeout(() => reject(new Error(`Desktop fixture did not start: ${diagnostics}`)), 5000); const finish = (error?: Error) => { clearTimeout(timer); if (error) reject(error); else done() }; child.stdout!.on('data', (bytes) => { output += String(bytes); if (output.includes('"worldviewDesktopReady":true')) finish() }); child.stderr!.on('data', (bytes) => { diagnostics = (diagnostics + String(bytes)).slice(-500) }); child.once('error', finish); child.once('exit', () => finish(new Error(`Desktop fixture exited: ${diagnostics}`))) })
  const base = `http://127.0.0.1:${port}`
  expect(await (await fetch(`${base}/retained.txt`)).text()).toBe('A retained public file')
  expect((await fetch(`${base}/escape.txt`)).status).toBe(403)
  expect(await (await fetch(`${base}/writing`)).text()).toContain('Local workspace')
  expect(await (await fetch(`${base}/api/ai/status`, { headers: { 'x-wv-client': 'desktop-static-test' } })).json()).toMatchObject({ configured: false, provider: null })
  unlinkSync(join(dist, 'index.html')); symlinkSync(join(root, 'private.txt'), join(dist, 'index.html'))
  expect((await fetch(`${base}/writing`)).status).toBe(403)
})
