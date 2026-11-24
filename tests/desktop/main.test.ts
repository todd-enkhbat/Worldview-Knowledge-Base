import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url), code = readFileSync(resolve('electron/main.cjs'), 'utf8')
class Child extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); exitCode: number | null = null; signalCode: string | null = null
  kill = vi.fn((signal: string) => { this.signalCode = signal; queueMicrotask(() => this.emit('exit', null, signal)); return true })
}
function launcher(success: boolean) {
  const old = new Child(), spawned: Child[] = [], events: string[] = [], permission: { handler?: (...args: unknown[]) => Promise<void>; check?: (...args: unknown[]) => boolean } = {}
  const ask = vi.fn(async () => true)
  class Window extends EventEmitter {
    url = ''; show() {}; isMinimized() { return false }; restore() {}; focus() {}
    webContents = Object.assign(new EventEmitter(), { getURL: () => this.url, isDestroyed: () => false, setWindowOpenHandler: () => {} })
    async loadURL(value: string) { this.url = value }
  }
  const electron = { app: { isPackaged: false, requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), on: () => {}, quit: () => {}, getPath: () => '/fixture/profile', getVersion: () => '0.1.0' }, BrowserWindow: Window, dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) }, ipcMain: { handle: () => {} }, Menu: { setApplicationMenu: () => {}, buildFromTemplate: (value: unknown) => value }, shell: { openExternal: () => {}, openPath: async () => '' }, session: { defaultSession: { setPermissionRequestHandler: (handler: (...args: unknown[]) => Promise<void>) => { permission.handler = handler }, setPermissionCheckHandler: (check: (...args: unknown[]) => boolean) => { permission.check = check } } }, systemPreferences: { askForMediaAccess: ask, getMediaAccessStatus: () => 'granted' } }
  const context = createContext({ console, URL, AbortSignal, setTimeout, clearTimeout, queueMicrotask, Buffer, __dirname: resolve('electron'), process: { argv: ['electron', 'main.cjs', '--workspace', '/vault/old'], platform: 'darwin', arch: 'arm64', env: {}, execPath: '/fixture/node' }, fixtureOldChild: old,
    fetch: vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/api/ai/status') ? { configured: false, provider: null } : { workspaceFingerprint: createHash('sha256').update('/vault/old').digest('hex') } })),
    require: (name: string) => {
      if (name === 'electron') return electron
      if (name === './policy.cjs') return require('../../electron/policy.cjs')
      if (name === 'node:fs') return { existsSync: () => true, mkdirSync: () => {}, readFileSync: () => '{}', realpathSync: (value: string) => value, renameSync: () => {}, writeFileSync: () => {} }
      if (name === 'node:child_process') return { spawn: (_node: string, args: string[]) => { const child = new Child(); spawned.push(child); const port = args[args.indexOf('--port') + 1]; queueMicrotask(() => { if (success) { events.push('replacement ready'); child.stdout.emit('data', Buffer.from(JSON.stringify({ worldviewDesktopReady: true, url: `http://127.0.0.1:${port}` }) + '\n')) } else { child.stderr.emit('data', Buffer.from('Could not open the new workspace')); child.exitCode = 1; child.emit('exit', 1) } }); return child } }
      return require(name)
    },
  })
  runInContext(code, context)
  old.kill.mockImplementation((signal: string) => { events.push('previous stopped'); old.signalCode = signal; queueMicrotask(() => old.emit('exit', null, signal)); return true })
  runInContext("server = fixtureOldChild; workspace = '/vault/old'; origin = 'http://127.0.0.1:5173'", context)
  return { context, old, spawned, events, permission, ask, electron, run: (value: string) => runInContext(value, context) }
}

it('keeps the current service and desktop context intact when another workspace fails to open', async () => {
  const app = launcher(false)
  await expect(app.run("openWorkspace('/vault/new')")).rejects.toThrow('Could not open the new workspace')
  expect(app.old.kill).not.toHaveBeenCalled()
  expect(app.run('({ workspace, origin, retained: server === fixtureOldChild })')).toMatchObject({ workspace: '/vault/old', origin: 'http://127.0.0.1:5173', retained: true })
})

it('stops its previous service only after the new local workspace is ready', async () => {
  const app = launcher(true)
  expect(await app.run("openWorkspace('/vault/new')")).toBe('http://127.0.0.1:5174')
  expect(app.events).toEqual(['replacement ready', 'previous stopped'])
  expect(app.run('({ workspace, origin })')).toMatchObject({ workspace: '/vault/new', origin: 'http://127.0.0.1:5174' })
  expect(app.electron.dialog.showMessageBox).not.toHaveBeenCalled()
})

it('does not stop the owned service when reopening the same workspace', async () => {
  const app = launcher(true)
  expect(await app.run("openWorkspace('/vault/old')")).toBe('http://127.0.0.1:5173')
  expect(app.old.kill).not.toHaveBeenCalled(); expect(app.spawned).toHaveLength(0)
  expect(app.run('server === fixtureOldChild')).toBe(true)
})

it('retains the previous service and frame trust when unsaved work cancels native navigation', async () => {
  const app = launcher(true)
  await app.run('start()')
  app.run("server = fixtureOldChild; window.loadURL = async () => { throw new Error('Unsaved work canceled navigation') }")
  await expect(app.run("openWorkspace('/vault/new', true)")).rejects.toThrow('Unsaved work canceled navigation')
  expect(app.old.kill).not.toHaveBeenCalled()
  expect(app.spawned[0].kill).toHaveBeenCalledWith('SIGTERM')
  expect(app.run('({ workspace, origin, retained: server === fixtureOldChild, frame: window.webContents.getURL() })')).toMatchObject({ workspace: '/vault/old', origin: 'http://127.0.0.1:5173', retained: true, frame: 'http://127.0.0.1:5173/#/today' })
})

it('denies microphone permission if the OS prompt rejects or the requesting URL is malformed', async () => {
  const app = launcher(true)
  await app.run('start()')
  const contents = app.run('window.webContents'), callback = vi.fn()
  app.ask.mockRejectedValueOnce(new Error('Microphone prompt unavailable'))
  await app.permission.handler!(contents, 'media', callback, { requestingUrl: 'http://127.0.0.1:5173/', mediaTypes: ['audio'] })
  expect(callback).toHaveBeenLastCalledWith(false)
  await app.permission.handler!(contents, 'media', callback, { requestingUrl: 'an invalid URL', mediaTypes: ['audio'] })
  expect(callback).toHaveBeenCalledTimes(2); expect(callback).toHaveBeenLastCalledWith(false)
})

it('does not grant a delayed microphone prompt to a replacement workspace', async () => {
  const app = launcher(true); await app.run('start()')
  let resolvePrompt!: (allowed: boolean) => void
  app.ask.mockImplementationOnce(() => new Promise<boolean>((done) => { resolvePrompt = done }))
  const callback = vi.fn(), pending = app.permission.handler!(app.run('window.webContents'), 'media', callback, { requestingUrl: 'http://127.0.0.1:5173/', mediaTypes: ['audio'] })
  app.run("origin = 'http://127.0.0.1:5174'"); resolvePrompt(true); await pending
  expect(callback).toHaveBeenCalledExactlyOnceWith(false)
})

it('handles permission checks as well as requests, permitting only OS-approved audio in the local window', async () => {
  const app = launcher(true); await app.run('start()'); const contents = app.run('window.webContents')
  expect(app.permission.check!(contents, 'media', 'http://127.0.0.1:5173', { mediaType: 'audio' })).toBe(true)
  expect(app.permission.check!(contents, 'media', 'http://127.0.0.1:5173', { mediaType: 'video' })).toBe(false)
  expect(app.permission.check!(contents, 'notifications', 'http://127.0.0.1:5173', {})).toBe(false)
  expect(app.permission.check!(contents, 'media', 'https://another.example', { mediaType: 'audio' })).toBe(false)
  expect(app.permission.check!(contents, 'media', 'a malformed origin', { mediaType: 'audio' })).toBe(false)
})
