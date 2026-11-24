const { app, BrowserWindow, dialog, ipcMain, Menu, shell, session, systemPreferences } = require('electron')
const { spawn } = require('node:child_process')
const { cloudAiIsOff, sameWorkspace } = require('./policy.cjs')
const { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } = require('node:fs')
const { join, resolve, basename } = require('node:path')

const base = app.isPackaged ? app.getAppPath() : resolve(__dirname, '..')
const runtime = app.isPackaged ? join(base, 'runtime') : base
const node = app.isPackaged ? join(base, 'runtime/node/bin/node') : join(base, `data/tools/desktop-node/26.5.0-${process.platform}-${process.arch}/bin/node`)
let window = null, server = null, origin = '', workspace = '', stopping = false, changing = false
const ownedChildren = new Set()
const arg = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
const profile = arg('--profile')
if (profile) app.setPath('userData', resolve(profile))
const locked = app.requestSingleInstanceLock()
if (!locked) { app.quit() } else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus() } })
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
    if (previous !== child) await stopChild(previous)
    return url
  }
  for (const url of ['http://127.0.0.1:5173', 'http://localhost:5173']) { const existing = await probe(url); if (existing && sameWorkspace(path, existing.workspaceFingerprint)) { if (!existing.cloudAiOff) throw new Error('Cloud AI is enabled or could not be verified in the running local service. Set AI_PROVIDER=none and restart that service before opening it in the desktop app.'); const owned = previous && previousOrigin === url; return activate(url, owned ? previous : null) } }
  const occupied = await probe('http://127.0.0.1:5173')
  let port = 5173
  if (occupied && previous) port = 5174
  else if (occupied) { const answer = await dialog.showMessageBox({ type: 'question', title: 'Another workspace is already open', message: 'Port 5173 belongs to another local workspace.', detail: 'Open this workspace on a separate local port? MCP configuration must use the displayed port; the browser companion uses port 5173.', buttons: ['Cancel', 'Open on another port'], defaultId: 0, cancelId: 0 }); if (answer.response !== 1) throw new Error('Choose the workspace already running, or stop its service before opening another.'); port = 5174 }
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
async function start() {
  const chosen = await selectWorkspace(arg('--workspace') ?? remembered()); if (!chosen) { app.quit(); return }
  const url = await openWorkspace(chosen)
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => { try { return contents === window?.webContents && !contents.isDestroyed() && new URL(requestingOrigin).origin === origin && new URL(details.requestingUrl ?? contents.getURL()).origin === origin && permission === 'media' && details.mediaType === 'audio' && process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') === 'granted' } catch { return false } })
  session.defaultSession.setPermissionRequestHandler(async (contents, permission, callback, details) => { const requestedWorkspaceOrigin = origin; let granted = false; try { const requestingOrigin = new URL(details.requestingUrl ?? contents.getURL()).origin; if (contents === window?.webContents && requestingOrigin === requestedWorkspaceOrigin && permission === 'media' && Array.isArray(details.mediaTypes) && details.mediaTypes.length && details.mediaTypes.every((type) => type === 'audio') && process.platform === 'darwin') granted = await systemPreferences.askForMediaAccess('microphone'); granted = granted && origin === requestedWorkspaceOrigin && contents === window?.webContents && !contents.isDestroyed() && new URL(contents.getURL()).origin === requestedWorkspaceOrigin } catch { granted = false } callback(granted) })
  window = new BrowserWindow({ title: 'Worldview', width: 1400, height: 940, minWidth: 680, minHeight: 540, show: false, backgroundColor: '#171819', autoHideMenuBar: true, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, safeDialogs: true, spellcheck: true } })
  window.webContents.setWindowOpenHandler(({ url }) => { try { const target = new URL(url); if (['https:', 'http:'].includes(target.protocol) && !target.username && !target.password) void shell.openExternal(url) } catch {} return { action: 'deny' } })
  window.webContents.on('will-navigate', (event, target) => { try { if (new URL(target).origin !== origin) event.preventDefault() } catch { event.preventDefault() } })
  window.once('ready-to-show', () => window.show())
  ipcMain.handle('worldview:desktop-info', async (event) => { if (!trusted(event)) throw new Error('Only the local workspace can use desktop controls.'); return { version: app.getVersion(), workspaceName: basename(workspace), workspace, origin, ownsService: !!server, cloudAi: (await probe(origin))?.cloudAiOff ? 'off' : 'unknown', platform: process.platform } })
  ipcMain.handle('worldview:choose-workspace', async (event) => { if (!trusted(event)) throw new Error('Only the local workspace can select a folder.'); await changeWorkspace(); return { workspaceName: basename(workspace), origin } })
  ipcMain.handle('worldview:show-workspace', async (event) => { if (!trusted(event)) throw new Error('Only the local workspace can reveal a folder.'); await shell.openPath(workspace); return { ok: true } })
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Worldview', submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Open Workspace…', accelerator: 'CmdOrCtrl+O', click: () => void changeWorkspace() }, { label: 'Show Workspace in Finder', click: () => void shell.openPath(workspace) }, { type: 'separator' }, { role: 'quit' }] }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]))
  await window.loadURL(`${url}/#/today`)
}
app.on('window-all-closed', () => app.quit())
app.on('before-quit', (event) => { if (stopping || !server && !ownedChildren.size) return; event.preventDefault(); stopping = true; void stopOwnedServer().finally(() => app.quit()) })
