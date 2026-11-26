const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const petSize = { width: 132, height: 136 }
function petPosition(point, area) {
  const clamp = (value, min, max) => Math.round(Math.max(min, Math.min(value, max)))
  return {
    x: clamp(point.x, area.x, area.x + area.width - petSize.width),
    y: clamp(point.y, area.y, area.y + area.height - petSize.height),
  }
}
function createEnki({ electron, preferences, openTool, dismissPanel, shortcutMenuItem }) {
  const { BrowserWindow, ipcMain, Menu, screen } = electron
  const file = join(__dirname, 'enki-pet.html')
  const fileUrl = pathToFileURL(file).href
  let window = null
  let dragging = null
  function initialPosition() {
    const saved = preferences.read().enkiPosition
    if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) return petPosition(saved, screen.getDisplayNearestPoint(saved).workArea)
    const area = screen.getPrimaryDisplay().workArea
    return petPosition({ x: area.x + area.width - petSize.width - 16, y: area.y + area.height - petSize.height - 12 }, area)
  }
  function show() {
    if (preferences.read().enkiHidden === true) preferences.write({ enkiHidden: false })
    if (window) {
      if (!window.webContents.isLoading()) window.showInactive()
      return
    }
    const win = window = new BrowserWindow({
      title: 'Enki', ...petSize, ...initialPosition(), frame: false, show: false,
      alwaysOnTop: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: true, hasShadow: false, transparent: true, backgroundColor: '#00000000', acceptFirstMouse: true,
      webPreferences: { preload: join(__dirname, 'enki-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
    })
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.once('ready-to-show', () => { if (preferences.read().enkiHidden !== true) win.showInactive() })
    win.on('closed', () => { window = null; dragging = null })
    void win.loadFile(file).catch(error => console.warn('Enki could not open:', error.message))
  }
  function hide() {
    preferences.write({ enkiHidden: true })
    dismissPanel()
    window?.hide()
    dragging = null
  }
  function open(mode) {
    show()
    openTool(mode, window.getBounds())
  }
  function onPet(name, callback) {
    ipcMain.on('enki:' + name, (event, ...args) => {
      if (window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === fileUrl) callback(...args)
    })
  }
  onPet('activate', () => { if (!dismissPanel()) open('todo') })
  onPet('hide', hide)
  onPet('menu', () => {
    Menu.buildFromTemplate([
      { label: 'TO-DO', click: () => open('todo') }, { label: 'Dictionary', click: () => open('word') },
      { label: 'People (CRM)', click: () => open('person') }, { label: 'Application capture', click: () => open('application') },
      { type: 'separator' }, { label: 'Face forward', click: () => window?.webContents.send('enki:orient', 'reset') },
      ...shortcutMenuItem(), { label: 'Hide Enki', click: hide },
    ]).popup({ window })
  })
  onPet('drag', phase => {
    if (phase === 'end') {
      if (dragging?.moved) {
        const { x, y } = window.getBounds()
        preferences.write({ enkiPosition: { x, y } })
      }
      dragging = null
      return
    }
    const pointer = screen.getCursorScreenPoint()
    if (phase === 'start') { dragging = { pointer, bounds: window.getBounds(), moved: false }; return }
    if (phase !== 'move' || !dragging) return
    const point = { x: dragging.bounds.x + pointer.x - dragging.pointer.x, y: dragging.bounds.y + pointer.y - dragging.pointer.y }
    const pos = petPosition(point, screen.getDisplayNearestPoint(pointer).workArea)
    window.setPosition(pos.x, pos.y, false)
    dragging.moved = true
  })
  function fitDisplay() {
    if (!window || dragging) return
    const { x, y } = window.getBounds()
    const bounds = petPosition({ x, y }, screen.getDisplayNearestPoint({ x, y }).workArea)
    if (x !== bounds.x || y !== bounds.y) window.setPosition(bounds.x, bounds.y)
  }
  screen.on('display-removed', fitDisplay)
  screen.on('display-metrics-changed', fitDisplay)
  if (preferences.read().enkiHidden !== true) show()
  return { show, hide, summon: () => open('todo'), celebrate: () => {
    if (window?.isVisible()) window.webContents.send('enki:celebrate')
  } }
}
module.exports = { createEnki, petPosition }
