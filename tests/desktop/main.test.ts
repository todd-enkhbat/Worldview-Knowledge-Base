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
const pagesFile = '/fixture/profile/workspace-pages.json'
function launcher(success: boolean, platform = 'darwin', files = new Map<string, string>()) {
  const old = new Child(), spawned: Child[] = [], events: string[] = [], permission: { handler?: (...args: unknown[]) => Promise<void>; check?: (...args: unknown[]) => boolean } = {}
  const ask = vi.fn(async () => true), capture = { show: vi.fn(), close: vi.fn(), dismissIfVisible: vi.fn() }
  const enki = { show: vi.fn(), hide: vi.fn(), summon: vi.fn() }
  const createFloatingCapture = vi.fn((_options: { loadRecord: (hash: string) => Promise<void> }) => capture)
  const dockMenu = vi.fn<(_items: { label: string; click: () => void }[]) => void>()
  class Window extends EventEmitter {
    url = ''; minimized = false
    show = vi.fn(); isMinimized() { return this.minimized }; restore = vi.fn(() => { this.minimized = false }); focus = vi.fn()
    zoomLevel = 0
    webContents = Object.assign(new EventEmitter(), { getURL: () => this.url, isDestroyed: () => false, setWindowOpenHandler: () => {}, getZoomLevel: () => this.zoomLevel, setZoomLevel: (level: number) => { this.zoomLevel = level }, getZoomFactor: () => 1.2 ** this.zoomLevel })
    async loadURL(value: string) { this.url = value; this.webContents.emit('did-navigate', {}, value) }
  }
  const electron = { app: Object.assign(new EventEmitter(), { dock: { setMenu: dockMenu }, isHidden: vi.fn(() => false), show: vi.fn(), isPackaged: false, requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), quit: vi.fn(), getPath: () => '/fixture/profile', getVersion: () => '0.1.0' }), BrowserWindow: Window, dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) }, ipcMain: { handle: () => {} }, Menu: { setApplicationMenu: () => {}, buildFromTemplate: (value: unknown) => value }, shell: { openExternal: () => {}, openPath: async () => '' }, session: { defaultSession: { setPermissionRequestHandler: (handler: (...args: unknown[]) => Promise<void>) => { permission.handler = handler }, setPermissionCheckHandler: (check: (...args: unknown[]) => boolean) => { permission.check = check } } }, systemPreferences: { askForMediaAccess: ask, getMediaAccessStatus: () => 'granted' } }
  const context = createContext({ console, URL, AbortSignal, setTimeout, clearTimeout, queueMicrotask, Buffer, __dirname: resolve('electron'), process: { argv: ['electron', 'main.cjs', '--workspace', '/vault/old'], platform, arch: 'arm64', env: {}, execPath: '/fixture/node' }, fixtureOldChild: old,
    fetch: vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/api/ai/status') ? { configured: false, provider: null } : { workspaceFingerprint: createHash('sha256').update('/vault/old').digest('hex') } })),
    require: (name: string) => {
      if (name === 'electron') return electron
      if (name === './floating-capture.cjs') return { createFloatingCapture }
      if (name === './enki-window.cjs') return { createEnki: () => enki }
      if (name === './reader-summons.cjs') return { createReaderSummons: () => ({ start: vi.fn(), stop: vi.fn() }) }
      if (name === './photo-places.cjs') return require('../../electron/photo-places.cjs')
      if (name === './screen-contacts.cjs') return require('../../electron/screen-contacts.cjs')
      if (name === './policy.cjs') return require('../../electron/policy.cjs')
      if (name === 'node:fs') return {
        existsSync: () => true, mkdirSync: () => {}, realpathSync: (value: string) => value,
        readFileSync: (file: string) => files.get(file) ?? '{}',
        writeFileSync: (file: string, value: string) => files.set(file, value),
        renameSync: (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from) },
      }
      if (name === 'node:child_process') return { spawn: (_node: string, args: string[]) => { const child = new Child(); spawned.push(child); const port = args[args.indexOf('--port') + 1]; queueMicrotask(() => { if (success) { events.push('replacement ready'); child.stdout.emit('data', Buffer.from(JSON.stringify({ worldviewDesktopReady: true, url: `http://127.0.0.1:${port}` }) + '\n')) } else { child.stderr.emit('data', Buffer.from('Could not open the new workspace')); child.exitCode = 1; child.emit('exit', 1) } }); return child } }
      return require(name)
    },
  })
  runInContext(code, context)
  old.kill.mockImplementation((signal: string) => { events.push('previous stopped'); old.signalCode = signal; queueMicrotask(() => old.emit('exit', null, signal)); return true })
  runInContext("server = fixtureOldChild; workspace = '/vault/old'; origin = 'http://127.0.0.1:5173'", context)
  return { context, old, spawned, events, permission, ask, capture, createFloatingCapture, dockMenu, electron, enki, run: (value: string) => runInContext(value, context) }
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

it('opens Quick Capture from the Mac Dock and restores a hidden minimized workspace without navigating', async () => {
  const app = launcher(true)
  await app.run('start()')
  const menu = app.dockMenu.mock.calls[0][0], view = app.run('window')
  const capture = menu.find(action => action.label === 'Quick Capture')!
  const workspace = menu.find(action => action.label === 'Show Worldview Workspace')!
  view.url = 'http://127.0.0.1:5173/#/people'
  capture.click()
  expect(app.capture.show).toHaveBeenCalledOnce()
  expect(view.focus).not.toHaveBeenCalled()
  app.electron.app.isHidden.mockReturnValue(true)
  view.minimized = true
  workspace.click()
  expect(app.electron.app.show).toHaveBeenCalledOnce()
  expect(view.restore).toHaveBeenCalledOnce()
  expect(view.show).toHaveBeenCalledOnce()
  expect(view.focus).toHaveBeenCalledOnce()
  expect(view.url).toBe('http://127.0.0.1:5173/#/people')
})

it('can restore a hidden pet and open its to-do list directly from the Dock', async () => {
  const app = launcher(true)
  await app.run('start()')
  const menu = app.dockMenu.mock.calls[0][0]
  for (const label of ['Hide Enki', 'Show Enki', 'Open Enki TO-DO']) menu.find(item => item.label === label)!.click()
  expect(app.enki.hide).toHaveBeenCalledOnce()
  expect(app.enki.show).toHaveBeenCalledOnce()
  expect(app.enki.summon).toHaveBeenCalledOnce()
  expect(app.run('window.url')).toBe('http://127.0.0.1:5173/#/today')
})

it('opens the current Dia page from the global bracket shortcut and preserves to-do elsewhere', async () => {
  const app = launcher(true)
  await app.run('start()')
  app.run("summonEnki({bundleId:'company.thebrowser.dia'})")
  await vi.waitFor(() => expect(app.capture.show).toHaveBeenCalledWith('', 'page', undefined, undefined))
  expect(app.enki.summon).not.toHaveBeenCalled()
  app.run("summonEnki({bundleId:'com.apple.Notes'})")
  expect(app.enki.summon).toHaveBeenCalledOnce()
})

it('reopens a closed Mac workspace through the Dock or a second launch and keeps the local service', async () => {
  const app = launcher(true)
  await app.run('start()')
  for (const event of ['activate', 'second-instance']) {
    const previous = app.run('window')
    previous.emit('closed')
    app.electron.app.emit('window-all-closed')
    expect(app.electron.app.quit).not.toHaveBeenCalled()
    app.electron.app.emit(event)
    const next = app.run('window')
    expect(next).not.toBe(previous)
    expect(next.url).toBe('http://127.0.0.1:5173/#/today')
    await vi.waitFor(() => expect(next.focus).toHaveBeenCalledOnce())
  }
  expect(app.old.kill).not.toHaveBeenCalled()
  expect(app.spawned).toHaveLength(0)
})

it('remembers the last main-window page across window close and a fresh launch', async () => {
  const files = new Map<string, string>()
  const app = launcher(true, 'darwin', files)
  await app.run('start()')
  const view = app.run('window')
  view.url = 'http://127.0.0.1:5173/#/bookshelf?new=1'
  view.webContents.emit('did-navigate-in-page', {}, view.url, true)
  view.webContents.emit('did-navigate-in-page', {}, 'http://127.0.0.1:5173/#/people', false)
  view.webContents.emit('did-navigate', {}, 'https://elsewhere.example/#/library')
  expect(JSON.parse(files.get(pagesFile)!)).toEqual({ '/vault/old': '#/bookshelf' })
  view.emit('closed')
  await app.run('showWorkspace()')
  expect(app.run('window.url')).toBe('http://127.0.0.1:5173/#/bookshelf')

  const relaunched = launcher(true, 'darwin', files)
  await relaunched.run('start()')
  expect(relaunched.run('window.url')).toBe('http://127.0.0.1:5173/#/bookshelf')
})

it('restores each workspace separately and keeps Today as the fallback for invalid preferences', async () => {
  const files = new Map([[pagesFile, JSON.stringify({ '/vault/old': '#/bookshelf', '/vault/new': '#/write' })]])
  const app = launcher(true, 'darwin', files)
  await app.run('start()')
  await app.run("changing = true; openWorkspace('/vault/new', true)")
  expect(app.run('window.url')).toBe('http://127.0.0.1:5174/#/write')
  await app.run("openWorkspace('/vault/old', true)")
  expect(app.run('window.url')).toBe('http://127.0.0.1:5173/#/bookshelf')

  files.set(pagesFile, JSON.stringify({ '/vault/old': '#/lab' }))
  const invalid = launcher(true, 'darwin', files)
  await invalid.run('start()')
  expect(invalid.run('window.url')).toBe('http://127.0.0.1:5173/#/today')
})

it('only accepts the fixed workspace link, preserving the open route and ignoring early startup events', async () => {
  const app = launcher(true), event = { preventDefault: vi.fn() }
  app.electron.app.emit('open-url', event, 'worldview-local://open')
  expect(app.run('window')).toBeNull()
  await app.run('start()')
  const view = app.run('window')
  view.url = 'http://127.0.0.1:5173/#/people'
  for (const value of ['worldview-local://open?file=/tmp/x','worldview-local://open/#/people','worldview-local://open/path','worldview-local://other','https://example.org/']) app.electron.app.emit('open-url', event, value)
  expect(view.focus).not.toHaveBeenCalled()
  for (const value of ['worldview-local://open', 'worldview-local://open/']) app.electron.app.emit('open-url', event, value)
  expect(view.focus).toHaveBeenCalledTimes(2)
  expect(view.url).toBe('http://127.0.0.1:5173/#/people')
  expect(event.preventDefault).toHaveBeenCalledTimes(3)
})

it('opens an encoded saved record after cold launch only in the workspace that supplied the receipt', async () => {
  const files = new Map([[pagesFile, JSON.stringify({ '/vault/old': '#/bookshelf' })]])
  const app = launcher(true, 'darwin', files), event = { preventDefault: vi.fn() }
  const fingerprint = createHash('sha256').update('/vault/old').digest('hex')
  const link = 'worldview-local://record/company/acme%26co?workspace='
  app.electron.app.emit('open-url', event, link + fingerprint)
  await app.run('start()')
  expect(app.run('window.url')).toBe('http://127.0.0.1:5173/#/people?tab=companies&company=acme%26co')
  app.run("window.url = origin + '/#/library'")
  app.electron.app.emit('open-url', event, link + '0'.repeat(64))
  await vi.waitFor(() => expect(app.electron.dialog.showMessageBox).toHaveBeenCalled())
  expect(app.run('window.url')).toBe('http://127.0.0.1:5173/#/library')
})
it('keeps Dock actions exclusive to macOS and still quits after the last window closes on other platforms', async () => {
  const app = launcher(true, 'linux')
  await app.run('start()')
  expect(app.dockMenu).not.toHaveBeenCalled()
  app.electron.app.emit('window-all-closed')
  expect(app.electron.app.quit).toHaveBeenCalledOnce()
})

it('handles Command plus, minus, and actual size in the main window', () => {
  const app = launcher(true), view = app.run('createWorkspaceWindow()')
  const press = (key: string, extra = {}) => {
    const event = { preventDefault: vi.fn() }
    view.webContents.emit('before-input-event', event, { type: 'keyDown', key, meta: true, ...extra })
    return event.preventDefault
  }
  expect(press('=', { alt: true })).not.toHaveBeenCalled()
  expect(press('=', { meta: false })).not.toHaveBeenCalled()
  expect(press('=')).toHaveBeenCalledOnce()
  expect(view.zoomLevel).toBe(1)
  press('+')
  expect(view.zoomLevel).toBe(2)
  press('-')
  expect(view.zoomLevel).toBe(1)
  press('0')
  expect(view.zoomLevel).toBe(0)
})
