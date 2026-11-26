import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { bracketSequence } = require('../../electron/enki-shortcut.cjs')
const { petPosition } = require('../../electron/enki-window.cjs')
const { createFloatingCapture, captureBounds } = require('../../electron/floating-capture.cjs')

it('summons once after three consecutive taps within the shortcut window', () => {
  const tap = bracketSequence()
  expect([0, 140, 360, 440].map(t => tap(true, t))).toEqual([false, false, true, false])
  tap(false, 480)
  expect([550, 620].map(t => tap(true, t))).toEqual([false, false])
  expect(tap(true, 2200)).toBe(false)
  expect(tap(true, 2330)).toBe(false)
  expect(tap(true, 2490)).toBe(true)
})
it('keeps the full pet on its display, including a monitor left of the main screen', () => {
  const area = { x: -1500, y: 40, width: 1500, height: 1000 }
  expect(petPosition({ x: -1700, y: -85 }, area)).toEqual({ x: -1500, y: 40 })
  expect(petPosition({ x: -32, y: 1000 }, area)).toEqual({ x: -132, y: 904 })
  expect(petPosition({ x: -700, y: 200 }, area)).toEqual({ x: -700, y: 200 })
})

it('keeps the capture window and its user-sized bounds when switching tools or summoning TO-DO again', async () => {
  const origin = 'http://127.0.0.1:5173', workArea = { x: 0, y: 24, width: 900, height: 680 }
  const screen = { getPrimaryDisplay: () => ({ workArea }), getDisplayMatching: () => ({ workArea }), getDisplayNearestPoint: () => ({ workArea }) }
  const ipc = new Map(), prefs: Record<string, unknown> = {}, windows: Panel[] = []
  class Panel extends EventEmitter {
    visible = false
    bounds = { x: 160, y: 80, width: 500, height: 390 }
    webContents = Object.assign(new EventEmitter(), { mainFrame: { url: '' }, getURL: () => this.webContents.mainFrame.url, send: vi.fn(), setWindowOpenHandler: vi.fn() })
    constructor() { super(); windows.push(this) }
    loadURL = vi.fn(async (url: string) => { this.webContents.mainFrame.url = url })
    getBounds = () => this.bounds
    setBounds = vi.fn()
    setVisibleOnAllWorkspaces() {}
    isDestroyed() { return false }
    isMinimized() { return false }
    isVisible() { return this.visible }
    focus() {}
    show() { this.visible = true }
    hide() { this.visible = false; this.emit('hide') }
  }
  const control = createFloatingCapture({ electron: { BrowserWindow: Panel, ipcMain: { handle: (name: string, fn: unknown) => ipc.set(name, fn) }, screen },
    runtime: '.', context: () => ({ origin, workspace: '/vault' }), loadRecord: vi.fn(),
    preferences: { read: () => prefs, write: (next: object) => Object.assign(prefs, next) } })
  const anchor = { x: 700, y: 560, width: 132, height: 136 }
  await control.show('', 'word', anchor)
  const [win] = windows
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  win.emit('resized')
  expect(captureBounds(screen, prefs, anchor)).toEqual(win.bounds)
  for (const mode of ['person', 'application', 'todo']) {
    await ipc.get('worldview:capture-mode')(event, mode)
    expect(prefs.mode).toBe(mode)
  }
  // The last resize can precede hiding without a native `resized` event on macOS.
  win.bounds = { ...win.bounds, width: 610 }
  expect(control.dismissIfVisible()).toBe(true)
  expect(prefs.panelBounds).toEqual(win.bounds)
  await control.show('', 'todo', anchor)
  expect(windows).toHaveLength(1)
  expect(win.loadURL).toHaveBeenCalledExactlyOnceWith(origin + '/study-helper.html?mode=word')
  expect(win.setBounds).not.toHaveBeenCalled()
  expect(win.webContents.send).toHaveBeenCalledWith('worldview:show-mode', { mode: 'todo', hasSelection: false })
})
