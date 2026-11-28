const { join, basename } = require('node:path')
const { pathToFileURL } = require('node:url')
const { createHash, randomUUID } = require('node:crypto')
const { publicPage, assertSource, ownedSource, snapshot, visibleProfiles, visibleEducation, collect } = require('./profile-source.cjs')

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
    name: p.name, headline: p.headline || '', location: p.location || '', entityType: p.entityType, url: data.url,
    companies: savedCompanies ? saved.companies : companies, savedCompanies,
    schools: savedSchools ? [...new Set(saved.schools.map(row => row.organization + ' · ' + schoolLabel[row.status]))] : schools, savedSchools,
    website: website || '', industry: p.industry || '', photo: image?.url || '',
  }
}

// Tool changes never resize this shell. Only the first opening and a moved pet
// need a screen position; a user-positioned panel takes precedence on later opens.
function captureBounds(screen, prefs, anchor) {
  const saved = prefs.panelBounds
  const validPoint = point => Number.isFinite(point?.x) && Number.isFinite(point?.y)
  const position = validPoint(saved) ? saved : anchor ? null : validPoint(prefs.position) ? prefs.position : null
  const display = position ? screen?.getDisplayNearestPoint(position) : anchor ? screen?.getDisplayMatching(anchor) : screen?.getPrimaryDisplay()
  const area = display?.workArea
  const width = Math.min(area?.width ?? Infinity, Number.isFinite(saved?.width) ? Math.max(320, saved.width) : 436)
  const height = Math.min(area?.height ?? Infinity, Number.isFinite(saved?.height) ? Math.max(240, saved.height) : 360)
  if (!area) return { width, height }
  let x = position?.x ?? area.x + area.width - width - 20
  let y = position?.y ?? area.y + area.height - height - 20
  if (!position && anchor) {
    x = anchor.x - width - 8
    if (x < area.x) x = anchor.x + anchor.width + 8
    y = anchor.y + anchor.height - height
  }
  return { width, height, x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))) }
}

function createFloatingCapture({ electron, runtime, context, loadRecord, celebrate, preferences = {}, screenContacts, restart }) {
  const { BrowserWindow, ipcMain, session } = electron
  let panel = null, browser = null, current = null, destination = null, active = false, epoch = 0
  let idle = Promise.resolve()
  const helperModes = ['page', 'word', 'person', 'application', 'todo']
  const isHelperPage = url => helperModes.some(mode => url === context().origin + '/study-helper.html?mode=' + mode)
  let scan = null
  let opening = null, pendingMode = null, lastBounds = null, wantVisible = false
  const owned = ownedSource(() => browser)
  const moduleAt = path => import(pathToFileURL(join(runtime, path)).href)
  const extract = () => moduleAt('extensions/worldview-reader/extract.js')
  const secure = { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false }
  const sameWorkspace = (a,b) => a.origin === b.origin && a.workspace === b.workspace && a.epoch === b.epoch
  const here = () => ({ ...context(), epoch })
  const reader = require('./reader-source.cjs').readerSource(here)
  const source = mode => mode === 'browser' ? owned : reader
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
  function clear() { epoch++; current = null; destination = null; scan = null; reader.reset() }
  function close() { wantVisible = false; clear(); panel?.close(); browser?.close() }
  function dismissIfVisible() {
    const visible = wantVisible && panel && !panel.isDestroyed() && (opening || panel.isVisible())
    wantVisible = false
    if (!visible) return false
    panel.hide()
    return true
  }
  let selected = '', selectionContext = {}, previousPid = 0
  function show(value = '', requestedMode, anchor, summon) {
    const prefs = preferences.read?.() || {}
    selected = typeof value === 'string' ? value : value?.text || ''
    previousPid = value?.pid || 0
    selectionContext = { ...(value?.url && { url: value.url }), ...(value?.app && { sourceApp: value.app }) }
    const selectionMode = selected.endsWith('?') || selected.length > 160 ? 'application' : 'word'
    const mode = requestedMode || (selected ? selectionMode : helperModes.includes(prefs.mode) ? prefs.mode : 'person')
    if (mode === 'person') clear()
    if (mode === 'page') { clear(); if (summon) reader.bind(summon.client, summon.ref) }
    const local = new URL(context().origin)
    if (!helperModes.includes(mode) || local.protocol !== 'http:' || !['localhost','127.0.0.1'].includes(local.hostname) || local.username || local.password) throw Error('Open your local workspace first.')
    wantVisible = true

    if (panel && !panel.isDestroyed()) {
      if (panel.isMinimized()) panel.restore()
      if (!panel.isVisible() && anchor && !prefs.panelBounds) {
        const next = captureBounds(electron.screen, prefs, anchor)
        lastBounds = next
        panel.setBounds(next)
      }
      if (opening) {
        pendingMode = { mode, hasSelection: !!selected, refreshPage: mode === 'page' || mode === 'person' }
        return opening
      }
      panel.show()
      panel.focus()
      panel.webContents.send('worldview:show-mode', { mode, hasSelection: !!selected, refreshPage: mode === 'page' || mode === 'person' })
      return
    }

    const initial = captureBounds(electron.screen, prefs, anchor)
    lastBounds = initial
    const win = panel = new BrowserWindow({
      title: 'Enki', ...initial, minWidth: 320, minHeight: 240,
      frame: false, show: false, resizable: true, hasShadow: true, alwaysOnTop: true,
      maximizable: false, fullscreenable: false, backgroundColor: '#faf9f6',
      webPreferences: { ...secure, preload: join(__dirname, 'capture-preload.cjs') },
    })
    win.webContents.setWindowOpenHandler(({url}) => {
      if (isHelperPage(win.webContents.getURL()) && /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/.test(url)) void electron.shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    function rememberBounds() {
      const bounds = win.getBounds()
      if (Object.keys(bounds).every(key => bounds[key] === lastBounds?.[key])) return
      lastBounds = bounds
      preferences.write?.({ panelBounds: bounds })
    }
    win.on('moved', rememberBounds)
    win.on('resized', rememberBounds)
    if (screenContacts) win.on('focus', () => screenContacts.refresh())
    // macOS can hide a panel before the last native resize notification arrives.
    win.on('hide', rememberBounds)
    win.on('close', rememberBounds)
    win.on('closed', () => { if (panel === win) { panel = null; opening = null; pendingMode = null; clear() } })
    opening = win.loadURL(local.origin + '/study-helper.html?mode=' + mode).then(() => {
      if (panel !== win || win.isDestroyed()) return
      if (pendingMode) win.webContents.send('worldview:show-mode', pendingMode)
      if (wantVisible) { win.show(); win.focus() }
    }).catch(error => {
      if (panel !== win || win.isDestroyed()) return
      win.close()
      throw error
    }).finally(() => { if (panel === win) { opening = null; pendingMode = null } })
    return opening
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
    if (event.sender !== panel?.webContents || event.senderFrame !== panel?.webContents.mainFrame || !isHelperPage(event.senderFrame.url)) throw new Error('Use the local floating capture window.')
    if (name === 'follow-page') return active ? null : handler(...args)
    if (['mode', 'close', 'celebrate', 'selection', 'shortcut', 'screen-state', 'screen-pause'].includes(name)) return handler(...args)
    if (name === 'page') await idle
    if (active) throw new Error('Finish the current capture first.')
    active = true
    let finished
    idle = new Promise(resolve => { finished = resolve })
    try { return await handler(...args) } finally { active = false; finished() }
  })
  guard('selection', () => { const value = {text:selected,context:selectionContext}; selected = ''; selectionContext={}; return value })
  guard('shortcut', value => preferences.shortcut?.(value))
  guard('mode', mode => {
    if (!helperModes.includes(mode)) throw Error('Choose a capture mode.')
    preferences.write?.({ mode })
  })
  guard('celebrate', () => celebrate?.())
  guard('page', () => { current = null; destination = null; scan = null; return reader.page() })
  guard('save-page', () => reader.savePage())
  guard('form', async mode => {
    const state = here(), adapter = source(mode), ref = await adapter.identify()
    if (adapter.form) { const result = await adapter.form(ref); verify(state); return result }
    const {readApplicationForm} = await moduleAt('extensions/worldview-reader/application-form.js')
    const result = await adapter.evaluate(ref,'('+readApplicationForm.toString()+')()',false)
    assertSource(await adapter.identify(),ref); verify(state)
    return result
  })
  guard('ocr', async () => {
    const state = here(), win = panel
    win.hide()
    try { const result = await require('./helper-native.cjs').recognizeRegion(); verify(state); return result }
    finally { if(panel === win && wantVisible) win.show() }
  })
  guard('close', () => {
    dismissIfVisible()
    void require('./helper-native.cjs').restoreFocus(previousPid)
    return true
  })
  guard('browser', async url => { await openBrowser(url); return true })
  if (screenContacts) {
    guard('screen-state', () => screenContacts.state())
    guard('screen-start', () => screenContacts.enable())
    guard('screen-now', () => screenContacts.readNow(async () => {
      const win = panel
      if (!win?.isVisible() || typeof win.setOpacity !== 'function') return
      win.setOpacity(0)
      await new Promise(resolve => setTimeout(resolve, 85))
      return () => { if (!win.isDestroyed()) win.setOpacity(1) }
    }))
    guard('screen-pause', () => screenContacts.pause())
    guard('screen-dismiss', id => screenContacts.discard(id))
    guard('screen-paste', value => screenContacts.paste(value))
    guard('screen-settings', () => electron.shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'))
    guard('screen-restart', () => restart?.())
    guard('screen-save', async (id, fields) => {
      const state = here(), contact = screenContacts.proposal(id)
      const { workspaceToken } = await api(state, 'groups?entityType=person')
      screenContacts.proposal(id)
      const result = await api(state, 'screen-contact', { requestId: id, workspaceToken, name: fields?.name, headline: fields?.headline, phone: fields?.phone, url: contact.url })
      if (result.status === 'saved' || result.status === 'existing') screenContacts.discard(id)
      return result
    })
  }
  const recordRoute = (type, recordId) => '#/people?' + (type === 'company' ? 'tab=companies&company=' : 'person=') + encodeURIComponent(recordId)
  guard('people', async mode => {
    scan = null
    const state = here(), adapter = source(mode)
    let ref
    try {
      ref = await adapter.identify()
      const { people } = await visibleProfiles(adapter, ref, await extract())
      const rows = Array.isArray(people) ? people.filter(person => person.name && publicPage(person.url)).slice(0,64) : []
      const { previewUrlDigest } = await moduleAt('server/crmProfilePreviewIdentity.ts')
      const matched = rows.length ? await api(state, 'visible-matches', { digests: rows.map(person => previewUrlDigest(person.url)) }) : null
      verify(state)
      assertSource(await adapter.identify(), ref)
      scan = { state, adapter, ref, workspaceToken: matched?.workspaceToken, rows }
      return { sourceUrl: ref.url, people: rows.map(person => ({ ...person, existing: matched?.matches?.[previewUrlDigest(person.url)] ?? null })) }
    } catch (error) {
      verify(state)
      return { error: error.message, sourceUrl: ref?.url || '' }
    }
  })
  guard('follow-page', async () => {
    if (!panel?.isVisible()) return null
    return reader.peek()
  })
  guard('read', async (mode, selectedUrl) => {
    if (mode !== 'browser' && selectedUrl === undefined) reader.acceptPage()
    current = null
    destination = null
    const state = here(), adapter = source(mode)
    let ref
    try {
      ref = await adapter.identify()
      const extractor = await extract()
      let data
      if (selectedUrl !== undefined) {
        const person = scan?.rows.find(row => row.url === selectedUrl)
        if (!person || scan.adapter !== adapter) throw new Error('Scan this page and choose a visible person.')
        verify(scan.state)
        assertSource(ref, scan.ref)
        data = await visibleProfiles(adapter, ref, extractor, selectedUrl)
        if (data.profile.name !== person.name) throw new Error('This person changed. Scan the page again.')
      } else {
        data = await snapshot(adapter, ref, extractor)
        await visibleEducation(adapter, ref, data)
      }
      const { previewNameDigest, previewUrlDigest } = await moduleAt('server/crmProfilePreviewIdentity.ts')
      const params = new URLSearchParams({ entityType: data.profile.entityType, sourceDigest: previewUrlDigest(data.url), nameDigest: previewNameDigest(data.profile.name) })
      const { groups, workspaceToken, savedAffiliations, existing = null } = await api(state, 'groups?' + params.toString())
      if (!Array.isArray(groups) || typeof workspaceToken !== 'string' || !workspaceToken) throw new Error('Restart the local Worldview service with the latest version, then read this profile again.')
      if (selectedUrl && workspaceToken !== scan.workspaceToken) throw new Error('The workspace changed. Scan the page again.')
      const { educationStatus } = await moduleAt('src/crm/affiliationStatus.ts')
      verify(state)
      assertSource(await adapter.identify(), ref)
      current = { state, workspaceToken, adapter, ref, selectedUrl, savedAffiliations, existing, entityType: data.profile.entityType, name: data.profile.name, id: randomUUID(), groups: groups.map(group => group.id), requests: new Map() }
      if (existing) destination = recordRoute(data.profile.entityType, existing.recordId)
      return { profile: preview(data, educationStatus, savedAffiliations), id: current.id, existing, groups, workspace: basename(state.workspace) }
    } catch (error) {
      verify(state)
      return { error: error.message, sourceUrl: ref?.url || '' }
    }
  })
  async function requirePreview(id) {
    if (!current || id !== current.id) throw new Error('Read this profile again before continuing.')
    const pending = current
    verify(pending.state); assertSource(await pending.adapter.identify(), pending.ref)
    return pending
  }
  async function collectedPreview(id) {
    const pending = await requirePreview(id)
    // Retries reuse the original capture. A directory row must still identify the same person.
    if (pending.selectedUrl) {
      const data = await visibleProfiles(pending.adapter, pending.ref, await extract(), pending.selectedUrl)
      if (data.profile.name !== pending.name) throw new Error('This person changed. Scan the page again.')
      pending.collected ??= { data, notice: '' }
    } else if (!pending.collected) pending.collected = await collect(pending.adapter, pending.ref, await extract(), pending.name)
    verify(pending.state)
    if (pending !== current) throw new Error('The selected profile changed. Read it again.')
    return pending
  }
  guard('profile-action', async (id, action) => {
    if (action !== 'review-fields' && action !== 'photo-only') throw new Error('Choose a profile action.')
    const pending = action === 'photo-only' ? await requirePreview(id) : await collectedPreview(id)
    const data = action === 'photo-only'
      ? pending.selectedUrl ? await visibleProfiles(pending.adapter, pending.ref, await extract(), pending.selectedUrl) : await snapshot(pending.adapter, pending.ref, await extract())
      : pending.collected.data
    verify(pending.state)
    if (pending !== current || data.profile.name !== pending.name) throw new Error('This person changed. Read the profile again.')
    pending.actionIds ??= new Map()
    if (!pending.actionIds.has(action)) pending.actionIds.set(action, randomUUID())
    const requestId = pending.actionIds.get(action)
    const base = { requestId, workspaceToken: pending.workspaceToken, url: data.url }
    if (action === 'photo-only') {
      const image = data.profile.images?.find(row => row.isProfile === true && row.subjectName === pending.name && publicPage(row.url))
      if (data.profile.entityType !== 'person' || !image) throw new Error('No named contact portrait is visible on this profile.')
      return api(pending.state, action, { ...base, name: pending.name, photoUrl: image.url })
    }
    const receipt = await api(pending.state, action, { ...base, title:data.title, text:data.text, html:data.html, profile:data.profile })
    if (typeof receipt.draftId !== 'string' || !receipt.draftId) throw new Error('Worldview could not open the captured fields.')
    verify(pending.state)
    await loadRecord('#/people?capture=' + encodeURIComponent(receipt.draftId))
    return { status:'review', message:'The captured fields are ready to review in People.' }
  })
  guard('save', async (id, groupId) => {
    if (!current || id !== current.id || typeof groupId !== 'string' || groupId && !current.groups.includes(groupId)) throw new Error('Read the profile and select an available group.')
    const pending = await collectedPreview(id)
    if (!pending.requests.has(groupId)) pending.requests.set(groupId, randomUUID())
    const { data, notice } = pending.collected
    const receipt = await api(pending.state, 'quick-add', { requestId: pending.requests.get(groupId), workspaceToken: pending.workspaceToken, groupId: groupId || undefined, url: data.url, title: data.title, text: data.text, html: data.html, profile: data.profile })
    const saved = receipt.status === 'saved' && typeof receipt.recordId === 'string'
    if (!saved && !(receipt.status === 'review' && receipt.draftId)) throw new Error('The local workspace did not confirm the save. Retry to check the same capture.')
    destination = saved ? recordRoute(data.profile.entityType, receipt.recordId) : '#/people?capture=' + encodeURIComponent(receipt.draftId)
    if (saved) pending.existing = { recordId: receipt.recordId, groupIds: [...new Set([...(pending.existing?.groupIds || []), groupId].filter(Boolean))] }
    return { status: receipt.status, existing: pending.existing, notice, message: receipt.message || '', profile: preview(data, (await moduleAt('src/crm/affiliationStatus.ts')).educationStatus, pending.savedAffiliations) }
  })
  guard('organization', async (id, fields = {}) => {
    const pending = current
    if (!pending || pending.id !== id) throw Error('Choose the current saved contact.')
    verify(pending.state)
    if (!pending.existing) throw Error('Save this contact before editing its record.')
    return api(pending.state, 'organization', {
      ...fields, id: pending.existing.recordId, entityType: pending.entityType,
      workspaceToken: pending.workspaceToken,
    })
  })
  guard('linked-record', async (previewId, type, id) => {
    const pending = await requirePreview(previewId)
    if (!['person', 'company'].includes(type) || typeof id !== 'string' || !id || id.length > 200) throw Error('Choose a saved record.')
    verify(pending.state)
    return loadRecord(recordRoute(type, id))
  })
  guard('record', (action, previewId) => {
    if (!destination || !current) throw new Error('Select a saved contact or review a capture first.')
    if (previewId !== undefined && previewId !== current.id) throw new Error('Read this contact again before opening it.')
    verify(current.state)
    return loadRecord(destination + (action === 'activity' && destination.startsWith('#/people?person=') ? '&action=log-interaction' : ''))
  })
  return { show, close, dismissIfVisible, screenChanged: value => { if (panel && !panel.isDestroyed()) panel.webContents.send('worldview:screen-contacts', value) } }
}
module.exports = { createFloatingCapture, captureBounds, preview }
