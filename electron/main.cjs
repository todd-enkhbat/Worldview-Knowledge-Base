const { app, BrowserWindow, dialog, ipcMain, Menu, shell, session, systemPreferences } = require('electron')
const { spawn } = require('node:child_process')
const { cloudAiIsOff, sameWorkspace, parseRecordLink } = require('./policy.cjs')
const { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } = require('node:fs')
const { join, resolve, basename } = require('node:path')
const { pathToFileURL } = require('node:url')

const base = app.isPackaged ? app.getAppPath() : resolve(__dirname, '..')
const runtime = app.isPackaged ? join(base, 'runtime') : base
const node = app.isPackaged ? join(base, 'runtime/node/bin/node') : join(base, `data/tools/desktop-node/26.5.0-${process.platform}-${process.arch}/bin/node`)
const petPage = pathToFileURL(join(__dirname, 'enki-pet.html')).href
let window = null, server = null, origin = '', workspace = '', stopping = false, changing = false
let floatingCapture = null, workspaceReady = false, pendingRecord = null
let enki = null, bracketMonitor = null, globalBracketsActive = false
const defaultShortcut = 'CommandOrControl+Alt+Shift+W'
let registeredShortcut = '', releaseShortcut = null
const preferenceFile = () => join(app.getPath('userData'),'helper-preferences.json')
function readHelperPreferences() {
  try {
    const prefs = JSON.parse(readFileSync(preferenceFile(), 'utf8'))
    return prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {}
  } catch { return {} }
}
function writeHelperPreferences(values) {
  const file = preferenceFile()
  writeFileSync(file+'.tmp',JSON.stringify({...readHelperPreferences(),...values}),{mode:0o600})
  renameSync(file+'.tmp',file)
}
async function helperShortcut(value) {
  if(value === undefined) return registeredShortcut || defaultShortcut
  if(value === registeredShortcut) return value
  if(typeof value !== 'string' || value.length > 90 || !/^(?:(?:CommandOrControl|CmdOrCtrl|Command|Control|Alt|Option|Shift|Super)\+)+(?:[a-z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Up|Down|Left|Right)$/i.test(value)) throw Error('Use a modifier and a letter or number, such as Alt+Shift+D.')
  const shortcuts = require('electron').globalShortcut
  const {reserveShortcut,shortcutIdentity}=require('./shortcut-reservation.cjs')
  if(registeredShortcut && shortcutIdentity(registeredShortcut).id===shortcutIdentity(value).id)return registeredShortcut
  const release=await reserveShortcut(app,value)
  try{if(!shortcuts.register(value,() => void showFloatingCapture(true)))throw Error('That shortcut is already in use. Choose another.')}
  catch(error){release();throw error}
  releaseShortcut?.();releaseShortcut=release
  if(registeredShortcut) shortcuts.unregister(registeredShortcut)
  registeredShortcut = value
  writeHelperPreferences({shortcut:value})
  return value
}
async function showFloatingCapture(fromShortcut, mode, anchor) {
  if (!workspaceReady || changing || stopping) return
  floatingCapture ||= require('./floating-capture.cjs').createFloatingCapture({
    electron: require('electron'), runtime, context: () => ({ origin, workspace }),
    loadRecord: showWorkspace, celebrate: () => enki?.celebrate(), preferences:{read:readHelperPreferences,write:writeHelperPreferences,shortcut:helperShortcut},
  })
  const selection = fromShortcut === true && systemPreferences.isTrustedAccessibilityClient?.(false) ? await require('./helper-native.cjs').selectedWord() : ''
  if(workspaceReady && !changing && !stopping) await floatingCapture?.show(selection, mode, anchor)
}
function summonEnki() {
  if (workspaceReady && !changing && !stopping) enki?.summon()
}
function connectBracketMonitor(request = false) {
  if (process.platform !== 'darwin' || globalBracketsActive || !readHelperPreferences().enkiGlobalBrackets) return
  const nativePath = app.isPackaged ? join(base, 'electron/enki-bracket.node') : join(base, 'data/desktop/native/enki-bracket.node')
  if (!existsSync(nativePath)) throw Error('Build the desktop bracket shortcut, then reopen Worldview.')
  bracketMonitor ||= require(nativePath)
  if (request) bracketMonitor.request()
  globalBracketsActive = bracketMonitor.start(summonEnki)
}
function resumeBracketMonitor() {
  try { connectBracketMonitor() } catch (error) { console.warn('Enki shortcut unavailable:', error.message) }
}
function shortcutMenuItem() {
  if (process.platform !== 'darwin') return []
  return [{ label: 'Use ]]] in Other Apps', type: 'checkbox', checked: !!readHelperPreferences().enkiGlobalBrackets, click: async item => {
    writeHelperPreferences({ enkiGlobalBrackets: item.checked })
    if (!item.checked) { bracketMonitor?.stop(); globalBracketsActive = false }
    else {
      try {
        connectBracketMonitor(true)
        if (!globalBracketsActive) {
          const result = await dialog.showMessageBox({ type: 'info', title: 'Enki shortcut', message: 'Allow Worldview in Input Monitoring to use ]]] in other apps.', detail: 'Enki listens for three taps of the right-bracket key. Typed brackets still go to the app you are using. macOS may ask you to reopen Worldview.', buttons: ['Open Input Monitoring', 'Done'], cancelId: 1 })
          if (result.response === 0) await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent')
        }
      } catch (error) { await dialog.showMessageBox({ type: 'error', title: 'Enki shortcut', message: error.message }) }
    }
    setMenus()
  } }]
}
function setMenus() {
  const petCommands = [
    { label: 'Open Enki TO-DO', click: summonEnki },
    { label: 'Show Enki', click: () => enki?.show() },
    { label: 'Hide Enki', click: () => enki?.hide() },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Worldview', submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Enki', submenu: [...petCommands, ...shortcutMenuItem()] },
      { label: 'Open Floating Capture', click: () => void showFloatingCapture() }, { label: 'Open Workspace…', accelerator: 'CmdOrCtrl+O', click: () => void changeWorkspace() },
      { label: 'Show Workspace in Finder', click: () => void shell.openPath(workspace) }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]))
  if (process.platform === 'darwin') app.dock.setMenu(Menu.buildFromTemplate([
    ...petCommands, { type: 'separator' }, { label: 'Quick Capture', click: () => void showFloatingCapture() },
    { label: 'Show Worldview Workspace', click: reopenWorkspace },
  ]))
}
const ownedChildren = new Set()
const arg = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
const profile = arg('--profile')
if (profile) app.setPath('userData', resolve(profile))
const locked = app.requestSingleInstanceLock()
if (!locked) { app.quit() } else {
  app.on('browser-window-created', (_event, win) => {
    require('./enki-shortcut.cjs').bindEnkiKeys(win, url => {
      if (!workspaceReady || !url) return false
      if (url.startsWith(origin + '/')) return true
      return url === petPage
    }, summonEnki)
  })
  app.on('browser-window-focus', resumeBracketMonitor)
  app.on('will-quit', () => { bracketMonitor?.stop(); globalBracketsActive = false })
  app.on('second-instance', reopenWorkspace)
  if (process.platform === 'darwin') {
    app.on('activate', reopenWorkspace)
    app.on('open-url', (event, url) => {
      const record = parseRecordLink(url)
      if (record) {
        event.preventDefault()
        if (workspaceReady) void openSavedRecord(record)
        else pendingRecord = record
        return
      }
      if (url !== 'worldview-local://open' && url !== 'worldview-local://open/') return
      event.preventDefault()
      reopenWorkspace()
    })
  }
  app.whenReady().then(start).catch(async (error) => { await dialog.showMessageBox({ type: 'error', title: 'Worldview could not open', message: error.message, detail: 'Your workspace files were not replaced. Choose the folder again, or restart the local app service.' }); app.quit() })
}
const configurationPath = () => join(app.getPath('userData'), 'workspace.json')
function remember(path) { const directory = app.getPath('userData'); mkdirSync(directory, { recursive: true, mode: 0o700 }); const temporary = `${configurationPath()}.tmp`; writeFileSync(temporary, JSON.stringify({ workspace: path, schemaVersion: 1 }), { mode: 0o600 }); renameSync(temporary, configurationPath()) }
function remembered() { try { const value = JSON.parse(readFileSync(configurationPath(), 'utf8')); return typeof value.workspace === 'string' && existsSync(value.workspace) ? value.workspace : null } catch { return null } }
async function selectWorkspace(initial) {
  const result = initial ? { canceled: false, filePaths: [initial] } : await dialog.showOpenDialog({ title: 'Open your Worldview workspace', message: 'Choose the folder containing world.sqlite and blobs. A project folder with data/world.sqlite also works.', buttonLabel: 'Open workspace', properties: ['openDirectory', 'createDirectory'] })
  if (result.canceled || !result.filePaths[0]) return null
  let selected = realpathSync(result.filePaths[0])
  if (!existsSync(join(selected, 'world.sqlite')) && existsSync(join(selected, 'data/world.sqlite'))) selected = realpathSync(join(selected, 'data'))
  if (!existsSync(join(selected, 'world.sqlite'))) { const confirmed = await dialog.showMessageBox({ type: 'question', title: 'Create a workspace here?', message: `Create a new Worldview workspace in ${basename(selected)}?`, detail: 'No existing files are replaced. To open your current work, choose its folder containing world.sqlite.', buttons: ['Choose another folder', 'Create new workspace'], defaultId: 0, cancelId: 0 }); if (confirmed.response !== 1) return initial ? null : selectWorkspace() }
  return selected
}
async function probe(url) { try { const headers = { 'x-wv-client': 'worldview-desktop-launcher' }, response = await fetch(`${url}/api/memory/clients`, { headers, signal: AbortSignal.timeout(1800) }); if (!response.ok) return null; const value = await response.json(); let cloudAiOff = false; try { const ai = await fetch(`${url}/api/ai/status`, { headers, signal: AbortSignal.timeout(1800) }); cloudAiOff = ai.ok && cloudAiIsOff(await ai.json()) } catch {} return { ...value, cloudAiOff } } catch { return null } }

async function stopChild(child) { if (!child || child.exitCode !== null || child.signalCode) return; await new Promise((done) => { let timer; const finish = () => { clearTimeout(timer); done() }; child.once('exit', finish); timer = setTimeout(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); done() }, 3000); timer.unref(); child.kill('SIGTERM') }) }
async function stopOwnedServer() { const children = new Set([...ownedChildren, ...(server ? [server] : [])]); server = null; await Promise.all([...children].map(stopChild)) }
async function openWorkspace(path, navigate = false) {
  const previous = server, previousOrigin = origin, previousWorkspace = workspace, previousUrl = window?.webContents.getURL()
  async function activate(url, child) {
    origin = url; workspace = path; server = child
    try { if (navigate && window) await window.loadURL(`${url}/#/today`); remember(path) }
    catch (error) { origin = previousOrigin; workspace = previousWorkspace; server = previous; if (child !== previous) await stopChild(child); if (navigate && window && previousUrl && window.webContents.getURL() !== previousUrl) await window.loadURL(previousUrl).catch(() => {}); throw error }
    if (previousWorkspace !== path || previousOrigin !== url) floatingCapture?.close()
    if (previous !== child) await stopChild(previous)
    return url
  }
  for (const url of ['http://127.0.0.1:5173', 'http://localhost:5173']) { const existing = await probe(url); if (existing && sameWorkspace(path, existing.workspaceFingerprint)) { if (!existing.cloudAiOff) throw new Error('Cloud AI is enabled or could not be verified in the running local service. Set AI_PROVIDER=none and restart that service before opening it in the desktop app.'); const owned = previous && previousOrigin === url; return activate(url, owned ? previous : null) } }
  const occupied = await probe('http://127.0.0.1:5173')
  let port = 5173
  if (occupied && previous) port = 5174
  else if (occupied) { const answer = await dialog.showMessageBox({ type: 'question', title: 'Another workspace is already open', message: 'Port 5173 belongs to another local workspace.', detail: 'Open this workspace on a separate local port? Use the displayed port in Worldview Reader connection settings when pairing this workspace.', buttons: ['Cancel', 'Open on another port'], defaultId: 0, cancelId: 0 }); if (answer.response !== 1) throw new Error('Choose the workspace already running, or stop its service before opening another.'); port = 5174 }
  if (!existsSync(node)) throw new Error('The bundled Node runtime is unavailable. Rebuild the desktop app with scripts/desktop/prepare-node.mjs first.')
  let lastError = ''
  for (let attempt = 0; attempt < 12; attempt++, port++) {
    const child = spawn(node, [join(runtime, 'scripts/desktop/server.mjs'), '--workspace', path, '--dist', app.isPackaged ? join(base, 'dist') : join(base, 'dist'), '--port', String(port)], { cwd: runtime, env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG ?? 'en_US.UTF-8', AI_PROVIDER: 'none', WORLDVIEW_MODELS_DIR: join(path, 'models'), WORLDVIEW_QMD_RUNTIME_ROOT: join(path, 'tools/qmd'), WORLDVIEW_QMD_CACHE_ROOT: join(path, 'tools/qmd-cache') }, stdio: ['ignore', 'pipe', 'pipe'] })
    ownedChildren.add(child); child.once('exit', () => ownedChildren.delete(child))
    let diagnostics = '', output = ''
    const result = await new Promise((done) => { let finished = false; const finish = (value) => { if (finished) return; finished = true; clearTimeout(timer); done(value) }; const timer = setTimeout(() => { child.kill('SIGTERM'); finish(null) }, 20000); child.stdout.on('data', (bytes) => { output += bytes.toString(); for (const line of output.split('\n').slice(0, -1)) { try { const value = JSON.parse(line); if (value.worldviewDesktopReady && value.url === `http://127.0.0.1:${port}`) finish(value.url) } catch {} } }); child.stderr.on('data', (bytes) => { diagnostics = (diagnostics + bytes.toString()).slice(-3000) }); child.once('error', (error) => { diagnostics = error.message; finish(null) }); child.once('exit', () => finish(null)) })
    if (result) return activate(result, child)
    await stopChild(child)
    lastError = diagnostics
    if (!/EADDRINUSE|address already in use/i.test(diagnostics)) break
  }
  throw new Error(`The local workspace service could not start. ${lastError.slice(0, 500)}`)
}
function trusted(event) { return event.sender === window?.webContents && event.senderFrame?.url?.startsWith(`${origin}/`) && new URL(event.senderFrame.url).origin === origin }
async function changeWorkspace() { if (changing) return; changing = true; try { const selected = await selectWorkspace(); if (!selected || selected === workspace) return; await openWorkspace(selected, true) } catch (error) { await dialog.showMessageBox(window, { type: 'error', message: error.message }) } finally { changing = false } }
function createWorkspaceWindow() {
  const view = new BrowserWindow({ title: 'Worldview', width: 1400, height: 940, minWidth: 680, minHeight: 540, show: false, backgroundColor: '#171819', autoHideMenuBar: true, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, safeDialogs: true, spellcheck: true } })
  view.webContents.setWindowOpenHandler(({ url }) => { try { const target = new URL(url); if (['https:', 'http:'].includes(target.protocol) && !target.username && !target.password) void shell.openExternal(url) } catch {} return { action: 'deny' } })
  view.webContents.on('will-navigate', (event, target) => { try { if (new URL(target).origin !== origin) event.preventDefault() } catch { event.preventDefault() } })
  view.once('ready-to-show', () => view.show())
  view.on('closed', () => { if (process.platform !== 'darwin') floatingCapture?.close(); if (window === view) window = null })
  window = view
  return view
}
async function showWorkspace(hash) {
  if (!workspaceReady || stopping) return
  const existing = window, view = existing || createWorkspaceWindow()
  if (hash || !existing) await view.loadURL(origin + '/' + (hash || '#/today'))
  if (window !== view) return
  if (process.platform === 'darwin' && app.isHidden()) app.show()
  if (view.isMinimized()) view.restore()
  view.show()
  view.focus()
}
function reopenWorkspace() {
  void showWorkspace().catch(error => dialog.showMessageBox({ type: 'error', title: 'Worldview could not open', message: error.message }))
}
async function openSavedRecord(record) {
  const selected = workspace, localOrigin = origin
  try {
    const response = await fetch(localOrigin + '/api/crm/status', { headers: { 'x-wv-client': 'worldview-desktop-launcher' }, redirect: 'error', signal: AbortSignal.timeout(5000) })
    if (!response.ok || (await response.json()).workspaceFingerprint !== record.workspace) throw new Error('Open the workspace paired with Worldview Reader to view this record.')
    if (workspace === selected && origin === localOrigin && !changing && !stopping) await showWorkspace(record.hash)
  } catch (error) {
    await dialog.showMessageBox({ type: 'info', title: 'Open saved record', message: error.message })
  }
}
async function start() {
  const chosen = await selectWorkspace(arg('--workspace') ?? remembered()); if (!chosen) { app.quit(); return }
  const url = await openWorkspace(chosen)
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => { try { return contents === window?.webContents && !contents.isDestroyed() && new URL(requestingOrigin).origin === origin && new URL(details.requestingUrl ?? contents.getURL()).origin === origin && permission === 'media' && details.mediaType === 'audio' && process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') === 'granted' } catch { return false } })
  session.defaultSession.setPermissionRequestHandler(async (contents, permission, callback, details) => { const requestedWorkspaceOrigin = origin; let granted = false; try { const requestingOrigin = new URL(details.requestingUrl ?? contents.getURL()).origin; if (contents === window?.webContents && requestingOrigin === requestedWorkspaceOrigin && permission === 'media' && Array.isArray(details.mediaTypes) && details.mediaTypes.length && details.mediaTypes.every((type) => type === 'audio') && process.platform === 'darwin') granted = await systemPreferences.askForMediaAccess('microphone'); granted = granted && origin === requestedWorkspaceOrigin && contents === window?.webContents && !contents.isDestroyed() && new URL(contents.getURL()).origin === requestedWorkspaceOrigin } catch { granted = false } callback(granted) })
  createWorkspaceWindow()
  workspaceReady = true
  ipcMain.handle('worldview:desktop-info', async (event) => { if (!trusted(event)) throw new Error('Only the local workspace can use desktop controls.'); return { version: app.getVersion(), workspaceName: basename(workspace), workspace, origin, ownsService: !!server, cloudAi: (await probe(origin))?.cloudAiOff ? 'off' : 'unknown', platform: process.platform } })
  ipcMain.handle('worldview:choose-workspace', async (event) => { if (!trusted(event)) throw new Error('Only the local workspace can select a folder.'); await changeWorkspace(); return { workspaceName: basename(workspace), origin } })
  ipcMain.handle('worldview:show-workspace', async (event) => { if (!trusted(event)) throw new Error('Only the local workspace can reveal a folder.'); await shell.openPath(workspace); return { ok: true } })
  ipcMain.handle('worldview:open-floating-capture', async event => { if (!trusted(event)) throw new Error('Open floating capture from the local workspace.'); await showFloatingCapture(false, 'person'); return true })
  if (process.platform === 'darwin') require('./photo-places.cjs').registerPhotoPlaces({
    ipcMain,
    getWorkspace: () => workspaceReady && !changing && !stopping && window && { path: workspace, origin, contents: window.webContents },
    readNative: (...args) => {
      const nativePath = app.isPackaged ? join(base, 'electron/photo-places.node') : join(base, 'data/desktop/native/photo-places.node')
      if (!existsSync(nativePath)) throw new Error('Build the Mac Photos connector with node scripts/desktop/build-photo-places.mjs, then reopen Maps.')
      return require(nativePath).read(...args)
    },
  })
  try { await helperShortcut(readHelperPreferences().shortcut || defaultShortcut) } catch (error) { console.warn('Floating shortcut unavailable:',error.message) }
  enki = require('./enki-window.cjs').createEnki({
    electron: require('electron'), preferences: { read: readHelperPreferences, write: writeHelperPreferences },
    openTool: (mode, bounds) => void showFloatingCapture(false, mode, bounds).catch(error => dialog.showMessageBox({ type: 'error', title: 'Enki', message: error.message })),
    dismissPanel: () => floatingCapture?.dismissIfVisible() || false, shortcutMenuItem,
  })
  setMenus()
  resumeBracketMonitor()
  await window.loadURL(`${url}/#/today`)
  if (pendingRecord) { const record = pendingRecord; pendingRecord = null; await openSavedRecord(record) }
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', (event) => { if (stopping || !server && !ownedChildren.size) return; event.preventDefault(); stopping = true; void stopOwnedServer().finally(() => app.quit()) })
