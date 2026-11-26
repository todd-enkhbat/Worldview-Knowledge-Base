const { join, basename } = require('node:path')
const { pathToFileURL } = require('node:url')
const { createHash, randomUUID } = require('node:crypto')
const { publicPage, assertSource, diaSource, ownedSource, snapshot, visibleEducation, collect } = require('./profile-source.cjs')

const schoolLabel = { student: 'Attending', graduate: 'Graduated', alum: 'Alum', attended: 'Attended' }
function preview(data, status, saved) {
  const p = data.profile, rows = p.affiliations || []
  const companies = [...new Set(rows.filter(row => row.kind === 'employment' && row.current === true).map(row => row.organization))]
  const schools = [...new Set(rows.filter(row => row.kind === 'education').map(row => {
    return row.organization + ' · ' + schoolLabel[status(row)]
  }))]
  const image = p.images?.find(row => row.isProfile === true && row.subjectName === p.name && publicPage(row.url))
  const website = (p.urls || []).map(publicPage).find(url => url && !/(^|\.)(?:linkedin\.com|instagram\.com|facebook\.com|x\.com|twitter\.com)$/.test(new URL(url).hostname))
  const savedCompanies = p.entityType === 'person' && !companies.length && saved?.companies?.length > 0
  const savedSchools = p.entityType === 'person' && !schools.length && saved?.schools?.length > 0
  return {
    name: p.name, headline: p.headline || '', entityType: p.entityType, url: data.url,
    companies: savedCompanies ? saved.companies : companies, savedCompanies,
    schools: savedSchools ? [...new Set(saved.schools.map(row => row.organization + ' · ' + schoolLabel[row.status]))] : schools, savedSchools,
    website: website || '', industry: p.industry || '', photo: image?.url || '',
  }
}

function createFloatingCapture({ electron, runtime, context, loadRecord, preferences = {} }) {
  const { BrowserWindow, ipcMain, session } = electron
  let panel = null, browser = null, current = null, destination = null, active = false, epoch = 0
  const panelFile = join(__dirname, 'capture-panel.html'), panelUrl = pathToFileURL(panelFile).href
  const dia = diaSource(), owned = ownedSource(() => browser)
  const moduleAt = path => import(pathToFileURL(join(runtime, path)).href)
  const extract = () => moduleAt('extensions/worldview-reader/extract.js')
  const secure = { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false }
  const sameWorkspace = (a,b) => a.origin === b.origin && a.workspace === b.workspace && a.epoch === b.epoch
  const here = () => ({ ...context(), epoch })
  const verify = expected => { if (!panel || !sameWorkspace(expected, here())) throw new Error('The workspace changed. Read the selected profile again.') }
  const api = async (state, route, body) => {
    verify(state)
    const u = new URL(state.origin)
    if (u.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(u.hostname) || u.username || u.password) throw new Error('Open the local Worldview workspace first.')
    const headers = { 'x-wv-client': 'desktop-profile-capture', 'x-wv-workspace-fingerprint': createHash('sha256').update(state.workspace).digest('hex') }
    if (body) headers['content-type'] = 'application/json'
    const response = await fetch(u.origin + '/api/crm/profile-capture/' + route, { method: body ? 'POST' : 'GET', credentials: 'omit', redirect: 'error', headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(body ? 60000 : 10000) })
    const result = await response.json()
    verify(state)
    if (response.status === 401) throw new Error('Open the local Worldview workspace to use floating capture.')
    if (response.status === 404 || response.status === 405) throw new Error('Restart the local Worldview service with the latest version, then read this profile again.')
    if (!response.ok) throw new Error(result.error || 'The local workspace could not finish this capture.')
    return result
  }
  function clear() { epoch++; current = null; destination = null }
  function close() { clear(); panel?.close(); browser?.close() }
  let selected = '', selectionContext={}, previousPid=0
  function show(value = '') {
    selected = typeof value === 'string' ? value : value.text || ''
    previousPid=typeof value==='object'?value.pid:0
    selectionContext=typeof value==='object'?{...(value.url?{url:value.url}:{}),...(value.app?{sourceApp:value.app}:{})}:{}
    const prefs=preferences.read?.() || {}, mode=selected ? ((selected.endsWith('?')||selected.length>160)?'application':'word') : prefs.mode
    const pos=prefs.position, display=pos&&Number.isFinite(pos.x)&&Number.isFinite(pos.y)&&electron.screen?.getDisplayNearestPoint(pos)?.workArea
    const position=display?{x:Math.max(display.x,Math.min(pos.x,display.x+display.width-240)),y:Math.max(display.y,Math.min(pos.y,display.y+display.height-90))}:{}
    const enter=(win)=>{ if(!['application','word'].includes(mode))return false;win.setSize(465,560);void win.loadURL(context().origin+'/study-helper.html?mode='+mode);return true }

    if (panel && !panel.isDestroyed()) { if (panel.isMinimized()) panel.restore(); if(selected)enter(panel); panel.show(); panel.focus(); return }
    const win = panel = new BrowserWindow({ title: 'Add to Worldview', ...position, width: 220, height: 54, minWidth: 195, minHeight: 50, frame: false, transparent: true, hasShadow: true, alwaysOnTop: true, maximizable: false, fullscreenable: false, show: false, backgroundColor: '#00000000', webPreferences: { ...secure, preload: join(__dirname, 'capture-preload.cjs') } })
    win.webContents.setWindowOpenHandler(({url}) => {
      if(win.webContents.getURL().startsWith(context().origin+'/study-helper.html?')&&/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/.test(url))void electron.shell.openExternal(url)
      return {action:'deny'}
    })
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.once('ready-to-show', () => win.show())
    win.on('moved', () => { const {x,y} = win.getBounds(); preferences.write?.({position:{x,y}}) })
    win.on('closed', () => { if (panel === win) { panel = null; clear() } })
    if(!enter(win))void win.loadFile(panelFile)
  }
  function openBrowser(url) {
    const target = publicPage(url)
    if (!target) throw new Error('Enter a public HTTPS profile URL.')
    if (!browser || browser.isDestroyed()) {
      const partition = 'persist:worldview-profile-browser'
      const privateSession = session.fromPartition(partition)
      privateSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      privateSession.setPermissionCheckHandler(() => false)
      const win = browser = new BrowserWindow({ title: 'Worldview profile browser', width: 1050, height: 820, webPreferences: { ...secure, partition } })
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const webOnly = (event, destinationUrl) => { if (!publicPage(destinationUrl)) event.preventDefault() }
      win.webContents.on('will-navigate', webOnly)
      win.webContents.on('will-redirect', webOnly)
      win.on('closed', () => { if (browser === win) browser = null })
    }
    browser.show()
    return browser.loadURL(target)
  }
  const guard = (name, handler) => ipcMain.handle('worldview:capture-' + name, async (event, ...args) => {
    if (event.sender !== panel?.webContents || event.senderFrame !== panel?.webContents.mainFrame || !(event.senderFrame.url === panelUrl || ['word','application'].some(mode => event.senderFrame.url === context().origin + '/study-helper.html?mode=' + mode))) throw new Error('Use the local floating capture window.')
    if (['selection','shortcut'].includes(name) && !args.length) return handler()
    if (active) throw new Error('Finish the current capture first.')
    active = true
    try { return await handler(...args) } finally { active = false }
  })
  guard('selection', () => { const value = {text:selected,context:selectionContext}; selected = ''; selectionContext={}; return value })
  guard('shortcut', value => preferences.shortcut?.(value))
  guard('mode', async mode => {
    if (!['word','application','person'].includes(mode)) throw Error('Choose a capture mode.')
    preferences.write?.({mode})
    clear()
    if (mode === 'person') { panel.setSize(220,54); await panel.loadFile(panelFile); return }
    const u = new URL(context().origin)
    if (u.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(u.hostname)) throw Error('Open your local workspace first.')
    panel.setSize(465,560)
    await panel.loadURL(u.origin + '/study-helper.html?mode=' + mode)
  })
  guard('form', async mode => {
    const state = here(), adapter = mode === 'browser' ? owned : dia, ref = await adapter.identify()
    const {readApplicationForm} = await moduleAt('extensions/worldview-reader/application-form.js')
    const result = await adapter.evaluate(ref,'('+readApplicationForm.toString()+')()',false)
    assertSource(await adapter.identify(),ref); verify(state)
    return result
  })
  guard('ocr', async () => {
    const state = here(), win = panel
    win.hide()
    try { const result = await require('./helper-native.cjs').recognizeRegion(); verify(state); return result }
    finally { if(panel === win) win.show() }
  })
  guard('compact', compact => { panel.setSize(compact === true ? 220 : 402, compact === true ? 54 : 270); return true })
  // Report layout from the privileged panel only. Keep its bottom on screen when
  // a photo, a long employer name, or a permission message changes its height.
  ipcMain.handle('worldview:capture-fit', (event, height) => {
    if (event.sender !== panel?.webContents || event.senderFrame !== panel.webContents.mainFrame || event.senderFrame.url !== panelUrl || !Number.isFinite(height)) return
    const bounds = panel.getBounds()
    if (bounds.width < 300) return
    const area = electron.screen.getDisplayMatching(bounds).workArea
    const h = Math.min(area.height, Math.max(150, Math.min(780, Math.ceil(height))))
    panel.setBounds({ ...bounds, y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - h)), height: h })
  })
  guard('close', () => { panel.close(); void require('./helper-native.cjs').restoreFocus(previousPid); return true })
  guard('browser', async url => { clear(); await openBrowser(url); return true })
  guard('read', async mode => {
    clear()
    const state = here(), adapter = mode === 'browser' ? owned : dia
    let ref
    try {
      ref = await adapter.identify()
      const data = await snapshot(adapter, ref, await extract())
      await visibleEducation(adapter, ref, data)
      assertSource(await adapter.identify(), ref)
      const params = new URLSearchParams({ entityType: data.profile.entityType })
      if (data.profile.entityType === 'person') {
        const { previewNameDigest, previewUrlDigest } = await moduleAt('server/crmProfilePreviewIdentity.ts')
        params.set('sourceDigest', previewUrlDigest(ref.url))
        params.set('nameDigest', previewNameDigest(data.profile.name))
      }
      const { groups, workspaceToken, savedAffiliations } = await api(state, 'groups?' + params.toString())
      if (!Array.isArray(groups) || typeof workspaceToken !== 'string' || !workspaceToken) throw new Error('Restart the local Worldview service with the latest version, then read this profile again.')
      const { educationStatus } = await moduleAt('src/crm/affiliationStatus.ts')
      verify(state)
      current = { state, workspaceToken, adapter, ref, savedAffiliations, name: data.profile.name, id: randomUUID(), groups: groups.map(group => group.id), requests: new Map() }
      return { profile: preview(data, educationStatus, savedAffiliations), id: current.id, groups: groups.map(({ id, name, emoji }) => ({ id, name, emoji })), workspace: basename(state.workspace) }
    } catch (error) {
      verify(state)
      return { error: error.message, sourceUrl: ref?.url || '' }
    }
  })
  guard('save', async (id, groupId) => {
    if (!current || id !== current.id || typeof groupId !== 'string' || groupId && !current.groups.includes(groupId)) throw new Error('Read the profile and select an available group.')
    const pending = current
    verify(pending.state); assertSource(await pending.adapter.identify(), pending.ref)
    // Retain the exact original on network uncertainty. Retrying uses the same
    // capture and delivery identity even if the page later renders extra rows.
    if (!pending.collected) pending.collected = await collect(pending.adapter, pending.ref, await extract(), pending.name)
    verify(pending.state)
    if (!pending.requests.has(groupId)) pending.requests.set(groupId, randomUUID())
    const { data, notice } = pending.collected
    const receipt = await api(pending.state, 'quick-add', { requestId: pending.requests.get(groupId), workspaceToken: pending.workspaceToken, groupId: groupId || undefined, url: data.url, title: data.title, text: data.text, html: data.html, profile: data.profile })
    const saved = receipt.status === 'saved' && typeof receipt.recordId === 'string'
    if (!saved && !(receipt.status === 'review' && receipt.draftId)) throw new Error('The local workspace did not confirm the save. Retry to check the same capture.')
    destination = saved ? '#/people?' + (data.profile.entityType === 'company' ? 'tab=companies&company=' : 'person=') + encodeURIComponent(receipt.recordId) : '#/people?capture=' + encodeURIComponent(receipt.draftId)
    return { status: receipt.status, notice, message: receipt.message || '', profile: preview(data, (await moduleAt('src/crm/affiliationStatus.ts')).educationStatus, pending.savedAffiliations) }
  })
  guard('record', () => { if (!destination || !current) throw new Error('Save or review the capture first.'); verify(current.state); return loadRecord(destination) })
  return { show, close }
}
module.exports = { createFloatingCapture, preview }
