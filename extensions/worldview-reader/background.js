/* global chrome */
import { extractArticle, extractFolkPhotos, extractProfile, captureLinkedInExperience } from './extract.js'

const DEFAULT_PORT = 5173
const RETRY_ALARM = 'worldview-pending-captures'
function localPort(value = DEFAULT_PORT) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 5173 || port > 5185) throw new Error('Use the local port shown in Worldview for Mac under Sources → Desktop.')
  return port
}
const localOrigin = port => 'http://127.0.0.1:' + localPort(port)
const endpoint = (port, route) => localOrigin(port) + '/api/reading-capture/' + route
async function scheduleDelivery() {
  if (!chrome.alarms) return
  const state = await chrome.storage.local.get(['outbox', 'retryStopped'])
  if (!state.outbox?.length || state.retryStopped) { await chrome.alarms.clear(RETRY_ALARM); return }
  if (!await chrome.alarms.get(RETRY_ALARM)) await chrome.alarms.create(RETRY_ALARM, { delayInMinutes: 1, periodInMinutes: 1 })
}
const storageReady = Promise.all([chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }), chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })])
let operations = Promise.resolve()
// Register listeners synchronously; service-worker restarts must not miss the waking event.
const serial = (operation) => { const run = operations.catch(() => {}).then(() => storageReady).then(operation); operations = run; return run }
const errorText = (error) => error instanceof Error ? error.message : 'The local reader connection failed.'
const folkPage = url => { try { return new URL(url).hostname === 'app.folk.app' } catch { return false } }
const folkSearch = url => /^https:\/\/app\.folk\.app\/apps\/contacts\/network\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/search(?:[?#]|$)/i.test(url || '')
const folkPersonSearch = url => { if (!folkSearch(url)) return false; const types = [...new URL(url).searchParams].filter(([key]) => key.toLowerCase() === 'type'); return !types.length || types.length === 1 && types[0][0] === 'type' && types[0][1] === 'person' }
async function badge(tabId, text) { await chrome.action.setBadgeText({ tabId, text }); await chrome.action.setBadgeBackgroundColor({ tabId, color: '#365e8a' }) }
async function tracked() { return (await chrome.storage.session.get('tracked')).tracked ?? {} }
async function folkTracked() { return (await chrome.storage.session.get('folkTracked')).folkTracked ?? {} }
async function stopFolk(tabId, reason = '') {
  const all = await folkTracked(); delete all[tabId]; await chrome.storage.session.set({ folkTracked: all, ...(reason ? { folkStopReason: String(reason).slice(0, 500) } : {}) })
  await chrome.tabs.sendMessage(tabId, { type: 'folk-photos-stop' }, { frameId: 0 }).catch(() => {})
  await badge(tabId, '')
}
async function reconcileFolk(tabId) {
  const entry = (await folkTracked())[tabId]
  if (!entry) return
  try {
    const tab = await chrome.tabs.get(tabId), state = await chrome.tabs.sendMessage(tabId, { type: 'folk-photos-status', nonce: entry.nonce }, { frameId: 0 })
    if (tab.url === entry.url && state?.ok && state.following && state.nonce === entry.nonce && state.url === entry.url) return
  } catch { /* A reloaded or stopped observer must not leave a live PH badge. */ }
  await stopFolk(tabId, 'Photo following stopped because its observer is no longer active. Choose Follow again.')
}
async function pairing() { return (await chrome.storage.local.get('pairing')).pairing }
async function finishConnection() {
  const pending = (await chrome.storage.local.get('pendingConnection')).pendingConnection
  if (!pending) return
  if (pending.expiresAt <= Date.now()) { await chrome.storage.local.remove('pendingConnection'); return }
  // Chromium may omit Origin on a privileged extension GET. A JSON POST forces
  // an Origin-bearing request without weakening the server's exact-origin gate.
  const CONNECT = endpoint(pending.port, 'connect')
  const response = await fetch(`${CONNECT}/${encodeURIComponent(pending.requestId)}`, { method: 'POST', headers: { authorization: `Bearer ${pending.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'check' }), credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000) })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) { if (response.status === 401) await chrome.storage.local.remove('pendingConnection'); throw new Error(value.error ?? 'The connection request could not be checked.') }
  if (value.connected && /^wvread_[A-Za-z0-9_-]{43}$/.test(value.token ?? '')) {
    const stored = await chrome.storage.local.get(['pairing', 'outbox'])
    if (stored.outbox?.length && stored.pairing?.token !== value.token) throw new Error('Deliver or discard the previous pairing’s pending captures before finishing this connection.')
    // Persist first, acknowledge second. Reopening the popup safely retries an uncertain ack.
    await chrome.storage.local.set({ pairing: { token: value.token, port: localPort(pending.port) }, sequence: 0 })
    await fetch(`${CONNECT}/${encodeURIComponent(pending.requestId)}`, { method: 'POST', headers: { authorization: `Bearer ${pending.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'acknowledge' }), credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000) }).catch(() => {})
    await chrome.storage.local.remove('pendingConnection')
  }
}
async function enqueue(body) {
  const config = await pairing()
  if (!config?.token) throw new Error('Pair Worldview Reader with your local workspace first.')
  const state = await chrome.storage.local.get(['sequence', 'outbox'])
  const sequence = Math.max((state.sequence ?? 0) + 1, Date.now()), outbox = state.outbox ?? []
  if (new TextEncoder().encode(JSON.stringify({ ...body, sequence })).byteLength > 1024 * 1024) throw new Error('This source snapshot exceeds the 1 MiB request limit. Open a smaller profile section before capturing.')
  if (outbox.length >= 20) throw new Error('The local capture queue is full. Open Worldview and retry pending captures.')
  outbox.push({ ...body, sequence })
  await chrome.storage.local.set({ sequence, outbox })
  await scheduleDelivery()
  try { return await drain() } catch (error) { return { queued: true, message: errorText(error) } }
}
async function drain() {
  const config = await pairing(), state = await chrome.storage.local.get('outbox'), outbox = state.outbox ?? []
  if (!config?.token) throw new Error('Pair the reader first.')
  let result = null
  try { while (outbox.length) {
    const response = await fetch(endpoint(config.port, 'capture'), { method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` }, body: JSON.stringify(outbox[0]), signal: AbortSignal.timeout(outbox[0].quickAdd ? 35_000 : 10_000) })
    const value = await response.json().catch(() => ({}))
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status)) await chrome.storage.local.set({ retryStopped: true })
      throw new Error(value?.error ?? `Local capture failed (${response.status}).`)
    }
    if (outbox[0].saveProfileData === true) {
      const draft = value?.profileDraft
      if (value?.sequence !== outbox[0].sequence || typeof draft?.id !== 'string' || !draft.id || typeof draft?.source?.originalAssetId !== 'string' || !draft.source.originalAssetId) throw new Error('The profile draft was not confirmed. Your source stays queued; update Worldview and retry.')
      if (outbox[0].quickAdd && !(value.quickAdd?.status === 'saved' && typeof value.quickAdd?.recordId === 'string' || value.quickAdd?.status === 'review')) throw new Error('CRM save was not confirmed. Update Worldview and retry the pending capture.')
    } else if (outbox[0].saveFolkPhotos === true) {
      const photos = value?.folkPhotos, count = value => Number.isSafeInteger(value) && value >= 0
      if (!value || value.sequence !== outbox[0].sequence || typeof value.originalAssetId !== 'string' || !value.originalAssetId || !photos || !['total', 'saved', 'kept', 'unmatched', 'unavailable'].every(key => count(photos[key]))) throw new Error('The Folk photo capture was not confirmed. Your capture stays queued; update Worldview and retry.')
    } else if (!value || typeof value.sourceId !== 'string' || !value.sourceId || typeof value.versionId !== 'string' || !value.versionId || value.sequence !== outbox[0].sequence || outbox[0].selection && (typeof value.highlightId !== 'string' || !value.highlightId)) throw new Error('The local capture receipt was incomplete. Your capture stays queued; update Worldview if this keeps happening.')
    if (outbox[0].saveContactPhoto === true) {
      const photo = value.contactPhoto
      if (!photo || !['saved', 'kept', 'unmatched', 'unavailable'].includes(photo.status) || ['saved', 'kept'].includes(photo.status) && (typeof photo.personId !== 'string' || !photo.personId || typeof photo.avatarAssetId !== 'string' || !photo.avatarAssetId)) throw new Error('The contact photo was not confirmed. Your capture stays queued; update Worldview and retry.')
    }
    const delivered = outbox.shift(), entityType = delivered.profile?.entityType
    const rememberGroup = delivered.quickAdd && value.quickAdd?.status === 'saved' && ['person', 'company'].includes(entityType)
    result = value
    await chrome.storage.local.set({ outbox, retryStopped: false, lastDeliveryAt: Date.now(), lastFailure: '', ...(rememberGroup ? { [`lastProfileGroup:${entityType}`]: delivered.groupId || '' } : {}) })
  } } catch (error) { await chrome.storage.local.set({ lastFailure: errorText(error) }); throw error }
  await scheduleDelivery()
  return result
}
async function activeArticle(tabId) {
  const tab = await chrome.tabs.get(tabId)
  if (!tab.active || !/^https?:\/\//.test(tab.url ?? '')) throw new Error('Choose an ordinary web article in the active tab.')
  if (folkPage(tab.url)) throw new Error('Use Capture visible Folk photos for this CRM page. It keeps contact data separate from your knowledge and reading archive.')
  const results = await chrome.scripting.executeScript({ target: { tabId }, func: extractArticle })
  if (!results[0]?.result?.text) throw new Error('This page could not be read. Paste article text into Worldview instead.')
  return results[0].result
}

async function readExperience(tabId, snapshot, employer) {
  const profileUrl = new URL(snapshot.url), path = profileUrl.pathname.replace(/\/$/, '')
  if (snapshot.profile.entityType !== 'person' || !/(^|\.)linkedin\.com$/.test(profileUrl.hostname) || !/^\/in\/[^/]+$/.test(path)) return
  const detailPath = path + '/details/experience'
  const onPath = (value, expected) => {
    try { const u = new URL(value); return u.origin === profileUrl.origin && u.pathname.replace(/\/$/, '') === expected } catch { return false }
  }
  const read = async () => (await chrome.scripting.executeScript({ target: { tabId }, func: captureLinkedInExperience, args: [snapshot.url, employer || ''] }))[0]?.result
  const main = await read(), sources = [{ result: main, url: profileUrl.origin + path + '/' }]
  let notice = ''
  if (main?.continuation && onPath(main.continuation, detailPath)) {
    const start = await chrome.tabs.get(tabId)
    if (!start.active || !onPath(start.url, path)) throw new Error('Return to the selected profile and save again.')
    // activeTab covers this same-origin tab. Follow only the visible Experience link
    // of this person. Restore the original page without touching another navigation.
    let entered = false
    const gate = value => {
      try { const u = new URL(value); return u.origin === profileUrl.origin && /^\/(?:authwall|login|checkpoint)(?:\/|$)/.test(u.pathname) } catch { return false }
    }
    try {
      await chrome.tabs.update(tabId, { url: main.continuation })
      let ready = false
      for (let attempt = 0; attempt < 50; attempt++) {
        const tab = await chrome.tabs.get(tabId)
        entered ||= onPath(tab.url, detailPath)
        if (!tab.active || (!onPath(tab.pendingUrl || tab.url, detailPath) && (entered || !onPath(tab.url, path)))) throw new Error('The tab changed while loading the selected person’s experience.')
        if (onPath(tab.url, detailPath) && tab.status === 'complete') { ready = true; break }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      if (!ready) throw new Error('LinkedIn did not finish loading this person’s full Experience. Retry the save after it loads.')
      const details = await read()
      if (!details?.roles?.length) throw new Error('LinkedIn did not show the roles on its full Experience page. Retry when the page has loaded.')
      sources.push({ result: details, url: profileUrl.origin + detailPath + '/' })
    } catch (error) {
      const current = await chrome.tabs.get(tabId), target = current.pendingUrl || current.url
      if (!current.active || !onPath(target, detailPath) && !gate(target) && (entered || !onPath(target, path))) throw error
      notice = 'LinkedIn’s full Experience page was unavailable. This capture includes the details shown on the main profile.'
    } finally {
      const current = await chrome.tabs.get(tabId)
      if (onPath(current.pendingUrl || current.url, detailPath) || gate(current.pendingUrl || current.url)) {
        // Dia can replace the entry when a privileged tab update follows a
        // link, leaving no browser history entry for tabs.goBack().
        try { await chrome.tabs.goBack(tabId) } catch {
          const stranded = await chrome.tabs.get(tabId)
          if (onPath(stranded.pendingUrl || stranded.url, detailPath) || gate(stranded.pendingUrl || stranded.url)) await chrome.tabs.update(tabId, { url: snapshot.url })
        }
        for (let attempt = 0; attempt < 25; attempt++) {
          const restoring = await chrome.tabs.get(tabId)
          if (onPath(restoring.pendingUrl || restoring.url, path)) break
          if (!onPath(restoring.url, detailPath) && !gate(restoring.url)) break
          await new Promise(resolve => setTimeout(resolve, 120))
        }
      }
    }
  }
  const last = await chrome.tabs.get(tabId)
  if (!last.active || !onPath(last.pendingUrl || last.url, path)) throw new Error('The tab navigated to a different profile during capture.')
  if (notice) snapshot.text += '\n\n' + notice
  const rows = [], evidence = [], norm = value => String(value || '').trim().toLowerCase()
  const sameRole = (a,b) => norm(a.role) === norm(b.role) && norm(a.organization) === norm(b.organization)
  for (const source of sources) {
    if (!source.result?.roles?.length) continue
    evidence.push('Experience · ' + source.url)
    for (const row of source.result.roles) {
      const prior = rows.find(other => sameRole(row, other) && norm(row.startDate) === norm(other.startDate) && norm(row.endDate) === norm(other.endDate))
      if (prior) Object.assign(prior, row)
      else rows.push(row)
      evidence.push([row.role, row.organization, row.startDate + ' – ' + (row.endDate || 'Present')].join(' · '))
    }
  }
  if (!rows.length) return notice
  const previous = snapshot.profile.affiliations || []
  const others = previous.filter(old => old.kind !== 'employment' || !rows.some(row => sameRole(row, old) && (!old.startDate || norm(row.startDate) === norm(old.startDate)) && (!old.endDate || norm(row.endDate) === norm(old.endDate))))
  snapshot.profile = { ...snapshot.profile, affiliations: [...rows, ...others].slice(0, 60) }
  snapshot.text += '\n\n' + evidence.join('\n')
  const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  snapshot.html += '<section><h2>Captured experience</h2>' + evidence.map(line => '<p>' + escape(line) + '</p>').join('') + '</section>'
  return notice
}
async function captureFolk(tabId, entry = null, diagnosticSearch = false, saveSearchPhotos = false) {
  const tab = await chrome.tabs.get(tabId)
  if (!tab.active) { if (entry) return { result: { paused: true }, seen: entry.seen }; throw new Error('The chosen Folk tab is no longer active.') }
  if (!/^https:\/\/app\.folk\.app\//.test(tab.url || '') || entry && entry.url !== tab.url) throw new Error('The chosen Folk group URL changed. Choose the active group and follow again.')
  if ((diagnosticSearch || saveSearchPhotos) !== folkSearch(tab.url)) throw new Error(diagnosticSearch || saveSearchPhotos ? 'Open the exact Folk Search page for this action.' : 'Use the separate matched Search photo action on this page.')
  if (saveSearchPhotos && !folkPersonSearch(tab.url)) throw new Error('Choose People in Folk Search. Company, unknown or ambiguous result types cannot save person photos.')
  const extracted = await chrome.scripting.executeScript({ target: { tabId }, func: extractFolkPhotos }), batch = extracted[0]?.result
  if (!batch?.folkPhotoRows?.length || batch.url !== tab.url) { if (entry && batch?.url === tab.url) return { result: { unchanged: true }, seen: entry.seen }; throw new Error('No visible photo rows were found, or the Folk group navigated during capture. Keep the group open and try again.') }
  const previous = new Set(entry?.seen ?? []), keys = await Promise.all(batch.folkPhotoRows.map(async row => {
    const verifiedPeople = batch.folkPhotos.filter(photo => photo.photoUrl === row.photoUrl && photo.name === row.name).map(photo => photo.personId)
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ row, verifiedPeople })))
    return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('')
  }))
  const rows = batch.folkPhotoRows.filter((_row, index) => !previous.has(keys[index]))
  if (!rows.length) return { result: { unchanged: true }, seen: [...previous], url: batch.url, title: batch.title }
  const photos = diagnosticSearch || saveSearchPhotos ? [] : batch.folkPhotos.filter(photo => rows.some(row => row.photoUrl === photo.photoUrl && row.name === photo.name))
  const latest = await chrome.tabs.get(tabId)
  if (latest.url !== tab.url) throw new Error('The chosen Folk page navigated during capture. Choose it again.')
  if (!latest.active) { if (entry) return { result: { paused: true }, seen: entry.seen }; throw new Error('The chosen Folk tab is no longer active.') }
  const result = await enqueue({ url: batch.url, title: batch.title, saveFolkPhotos: true, ...(saveSearchPhotos ? { saveFolkSearchPhotos: true } : {}), folkPhotos: photos, folkPhotoRows: rows })
  return { result, seen: [...new Set([...previous, ...keys])].slice(-5000), url: batch.url, title: batch.title }
}
async function popupAction(message) {
  if (message.type === 'reader-status') { let connectionError = ''; try { await finishConnection() } catch (error) { connectionError = errorText(error) } if (Number.isSafeInteger(message.tabId)) await reconcileFolk(message.tabId); const state = await chrome.storage.local.get(['pairing', 'outbox', 'pendingConnection', 'lastDeliveryAt', 'lastFailure']), session = await chrome.storage.session.get('folkStopReason'); return { port: localPort(state.pendingConnection?.port ?? state.pairing?.port), paired: !!state.pairing?.token, pendingConnection: !!state.pendingConnection, connectionError, extensionId: chrome.runtime.id, queued: state.outbox?.length ?? 0, pending: (state.outbox ?? []).map((entry) => ({ sequence: entry.sequence, title: entry.title ?? 'Reading progress', url: entry.url })), lastDeliveryAt: state.lastDeliveryAt ?? null, lastFailure: state.lastFailure ?? '', tracked: await tracked(), folkTracked: await folkTracked(), folkStopReason: session.folkStopReason || '' } }
  if (message.type === 'reader-connect') {
    if (((await chrome.storage.local.get('outbox')).outbox ?? []).length) throw new Error('Retry or explicitly discard pending captures before connecting a different browser pairing.')
    const port = localPort(message.port)
    const response = await fetch(endpoint(port, 'connect'), { method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Worldview Reader' }), signal: AbortSignal.timeout(5000) })
    const value = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(value.error ?? 'Open Worldview locally, then click Connect again.')
    if (!/^wvconnect_[A-Za-z0-9_-]{43}$/.test(value.secret ?? '') || !value.requestId) throw new Error('The local service returned an invalid connection request.')
    await chrome.storage.local.set({ pendingConnection: { ...value, port } })
    return { ok: true, openUrl: localOrigin(port) + '/#/sources?connection=browser' }
  }
  if (message.type === 'reader-pair') {
    if (!/^wvread_[A-Za-z0-9_-]{43}$/.test(message.token ?? '')) throw new Error('Paste the pairing token generated by Worldview.')
    // A new token has its own sequence. Never silently send an older pair's pending data to it.
    if (((await chrome.storage.local.get('outbox')).outbox ?? []).length) throw new Error('Retry or explicitly discard pending captures before changing the pairing.')
    const previous = await pairing()
    await chrome.storage.local.set({ pairing: { token: message.token, port: localPort(message.port) }, ...(previous?.token === message.token ? {} : { sequence: 0 }) })
    await chrome.storage.local.remove('pendingConnection')
    return { ok: true }
  }
  if (message.type === 'reader-disconnect') { await chrome.storage.local.remove(['pairing', 'pendingConnection', 'outbox', 'sequence', 'lastFailure', 'lastDeliveryAt', 'retryStopped']); const all = await tracked(); for (const key of Object.keys(all)) { const tabId = Number(key); await chrome.tabs.sendMessage(tabId, { type: 'reading-stop' }).catch(() => {}); await badge(tabId, '') } for (const key of Object.keys(await folkTracked())) await stopFolk(Number(key)); await chrome.storage.session.remove(['tracked', 'folkTracked']); return { ok: true } }
  if (message.type === 'reader-discard') { await chrome.storage.local.set({ outbox: [] }); return { ok: true } }
  if (message.type === 'reader-discard-one') { if (!Number.isSafeInteger(message.sequence)) throw new Error('Choose a pending capture.'); const outbox = ((await chrome.storage.local.get('outbox')).outbox ?? []).filter((entry) => entry.sequence !== message.sequence); await chrome.storage.local.set({ outbox, ...(!outbox.length ? { lastFailure: '' } : {}) }); return { ok: true } }
  if (message.type === 'reader-retry') {
    await chrome.storage.local.remove('retryStopped')
    await scheduleDelivery()
    return { ok: true, result: await drain() }
  }
  if (!Number.isSafeInteger(message.tabId)) throw new Error('Choose an active article tab.')
  const tabId = message.tabId
  if (message.type === 'reader-stop') { if ((await folkTracked())[tabId]) { await stopFolk(tabId); return { ok: true } } const all = await tracked(), entry = all[tabId]; const final = await chrome.tabs.sendMessage(tabId, { type: 'reading-stop' }).catch(() => null); try { if (entry && !folkPage(entry.url) && final?.progress) await enqueue({ url: entry.url, title: entry.title, progress: final.progress }) } finally { delete all[tabId]; await chrome.storage.session.set({ tracked: all }); await badge(tabId, '') } return { ok: true } }
  if (['reader-folk-photos', 'reader-folk-follow', 'reader-folk-search-diagnostic', 'reader-folk-search-photos', 'reader-folk-search-follow'].includes(message.type)) {
    const searchPhotos = ['reader-folk-search-photos', 'reader-folk-search-follow'].includes(message.type)
    const captured = await captureFolk(tabId, null, message.type === 'reader-folk-search-diagnostic', searchPhotos)
    if (['reader-folk-follow', 'reader-folk-search-follow'].includes(message.type)) {
      const all = await folkTracked(), nonce = crypto.randomUUID()
      all[tabId] = { url: captured.url, title: captured.title, nonce, seen: captured.seen, startedAt: Date.now(), ...(searchPhotos ? { searchPhotos: true } : {}) }
      await chrome.storage.session.set({ folkTracked: all, folkStopReason: '' })
      try { await chrome.scripting.executeScript({ target: { tabId }, files: ['folk-content.js'] }); await chrome.tabs.sendMessage(tabId, { type: 'folk-photos-start', nonce }, { frameId: 0 }); await badge(tabId, 'PH') }
      catch (error) { await stopFolk(tabId); throw error }
    }
    return { ok: true, result: captured.result }
  }
  if (['reader-profile-data', 'reader-profile-preview', 'reader-profile-add'].includes(message.type)) {
    const tab = await chrome.tabs.get(tabId)
    if (!tab.active || !/^https?:\/\//.test(tab.url || '') || folkPage(tab.url)) throw new Error('Choose a person’s profile or company website in the active tab. Folk keeps its separate private import.')
    const extracted = await chrome.scripting.executeScript({ target: { tabId }, func: extractProfile, args: [null, true] }), profile = extracted[0]?.result
    if (typeof profile?.extractorError === 'string') throw new Error(profile.extractorError)
    if (!profile?.profile?.name) throw new Error(extracted[0]?.error?.message || 'Reader could not identify this page’s named profile. Open the main profile, keep its name visible and load the sections you want to save.')
    const latest = await chrome.tabs.get(tabId)
    const pageKey = value => { try { const parsed = new URL(value); return /(^|\.)linkedin\.com$/i.test(parsed.hostname) && /^\/(?:in|company|school)\/[^/]+(?:\/(?:about|people|posts|jobs|life))?\/?$/.test(parsed.pathname) ? `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}${parsed.search}${parsed.hash}` : value } catch { return value } }
    if (pageKey(profile.url) !== pageKey(tab.url) || pageKey(latest.url) !== pageKey(tab.url)) throw new Error('The tab navigated to a different profile during capture. Choose that person or company again before saving.')
    if (!latest.active) throw new Error('The chosen profile tab is no longer active. Return to it and save again.')
    const { headerEmployer, ...snapshot } = profile
    const { name, entityType, headline = '', location = '', affiliations = [], images = [] } = profile.profile
    if (message.type === 'reader-profile-preview') {
      const config = await pairing()
      if (!config?.token) throw new Error('Connect the reader to Worldview first.')
      const response = await fetch(endpoint(config.port, 'profile-groups'), { method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` }, body: JSON.stringify({ entityType, url: profile.url }), signal: AbortSignal.timeout(5000) })
      const value = await response.json()
      if (!response.ok || !Array.isArray(value.groups)) throw new Error(value.error || 'Open the latest local Worldview app to load your groups.')
      const jobs = affiliations.filter(row => row.kind === 'employment' && row.current)
      const current = [...new Set(jobs.map(row => row.organization))]
      if (current.length === 1 && headerEmployer?.organization === current[0] && headerEmployer.additional > 0) current[0] += ` + ${headerEmployer.additional} more`
      const schools = [...new Set(affiliations.filter(row => row.kind === 'education').map(row => row.organization))]
      const portrait = images.find(image => {
        if (image?.isProfile !== true || image.subjectName !== name) return false
        try {
          const target = new URL(image.url)
          return target.protocol === 'https:' && !target.username && !target.password && !target.port && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(target.hostname) && !/(^|\.)(?:localhost|local|internal|invalid)$/i.test(target.hostname)
        } catch { return false }
      })
      return { ok: true, preview: { url: profile.url, name, entityType, headline, location, current, schools, photoUrl: portrait?.url || '', role: jobs.find(row => row.role)?.role || '' }, groups: value.groups, existing: value.existing, workspaceFingerprint: value.workspaceFingerprint }
    }
    const quickAdd = message.type === 'reader-profile-add'
    if (quickAdd && (message.url !== profile.url || name !== message.name || entityType !== message.entityType)) throw new Error('The profile changed. Reopen the extension to see the current contact.')
    const experienceNotice = await readExperience(tabId, snapshot, headerEmployer?.organization || affiliations.find(row => row.kind === 'employment' && row.current)?.organization)
    const result = await enqueue({ ...snapshot, saveProfileData: true, ...(quickAdd ? { quickAdd: true, ...(message.groupId ? { groupId: message.groupId } : {}) } : {}) })
    if (experienceNotice && result) result.experienceNotice = experienceNotice
    return { ok: true, result, ...(result?.profileDraft?.id ? { openUrl: localOrigin((await pairing())?.port) + '/#/people?capture=' + encodeURIComponent(result.profileDraft.id) } : {}) }
  }
  const article = await activeArticle(tabId)
  if (message.type === 'reader-profile') {
    if (!article.profileImages?.some(image => image.isProfile === true && image.subjectName?.trim())) throw new Error('No named profile photo was found on this page. Open the person’s visible profile, or upload their picture in Worldview.')
    const result = await enqueue({ url: article.url, title: article.title, text: article.text, profileImages: article.profileImages, profileLinks: article.profileLinks, saveContactPhoto: true })
    return { ok: true, result }
  }
  if (message.type === 'reader-highlight') {
    if (!article.selection) throw new Error('Select text inside the article, then reopen this popup.')
    const result = await enqueue({ ...article, selection: { ...article.selection, note: String(message.note ?? '').slice(0, 20_000) } })
    return { ok: true, result }
  }
  if (message.type === 'reader-follow') {
    const result = await enqueue({ url: article.url, title: article.title, text: article.text, profileImages: article.profileImages, profileLinks: article.profileLinks, remark: String(message.note ?? '').slice(0, 20_000), progress: { fraction: 0, position: 0, activeMs: 0, following: true } })
    const all = await tracked(), nonce = crypto.randomUUID(); all[tabId] = { url: article.url, title: article.title, nonce }
    await chrome.storage.session.set({ tracked: all })
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
    await chrome.tabs.sendMessage(tabId, { type: 'reading-start', nonce }); await badge(tabId, 'ON')
    return { ok: true, result }
  }
  throw new Error('Unknown reader action.')
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return
  const popup = !sender.tab && sender.url === chrome.runtime.getURL('popup.html')
  const task = serial(async () => {
    if (popup) return popupAction(message)
    if (['folk-photos-changed', 'folk-photos-navigation', 'folk-photos-stopped'].includes(message.type) && Number.isSafeInteger(sender.tab?.id) && sender.frameId === 0) {
      const all = await folkTracked(), entry = all[sender.tab.id]
      if (!entry || entry.nonce !== message.nonce || entry.url !== message.url) throw new Error('Folk photo following stopped or this group changed.')
      if (message.type === 'folk-photos-navigation' || message.type === 'folk-photos-stopped') { await stopFolk(sender.tab.id, message.type === 'folk-photos-navigation' ? 'Photo following stopped after page navigation.' : `Photo following stopped: ${String(message.reason || 'the observer could not reach its worker').slice(0, 200)}`); return { ok: true, stopped: true } }
      // MessageSender.url can retain an earlier SPA document URL in Dia. The
      // chosen current tab, fresh extraction, top frame and nonce bind this action.
      const tab = await chrome.tabs.get(sender.tab.id)
      if (tab.url !== entry.url) { await stopFolk(sender.tab.id, 'Photo following stopped because the group URL changed.'); return { ok: false, error: 'Folk photo following stopped after navigation.' } }
      try { const captured = await captureFolk(sender.tab.id, entry, false, entry.searchPhotos === true); all[sender.tab.id] = { ...entry, seen: captured.seen }; await chrome.storage.session.set({ folkTracked: all }); return { ok: true, result: captured.result } }
      catch (error) { await stopFolk(sender.tab.id, errorText(error)); throw error }
    }
    if (!['reading-progress', 'reading-navigation'].includes(message.type) || !sender.tab?.id) throw new Error('This reader message is not authorized.')
    const all = await tracked(), entry = all[sender.tab.id]
    if (!entry || entry.nonce !== message.nonce || entry.url !== message.url) throw new Error('Following stopped or this article changed.')
    if (folkPage(entry.url)) { delete all[sender.tab.id]; await chrome.storage.session.set({ tracked: all }); await badge(sender.tab.id, ''); throw new Error('Folk reading tracking stopped. Use its separate visible-photo action.') }
    if (message.type === 'reading-navigation') { delete all[sender.tab.id]; await chrome.storage.session.set({ tracked: all }); await badge(sender.tab.id, ''); return { ok: true } }
    if (sender.url !== entry.url) { delete all[sender.tab.id]; await chrome.storage.session.set({ tracked: all }); await badge(sender.tab.id, ''); throw new Error('This tab navigated away. Choose the article again before following.') }
    // Content scripts report only focused/visible time; sender identity binds it to the chosen tab.
    const result = await enqueue({ url: entry.url, title: entry.title, progress: message.progress })
    return { ok: true, result }
  })
  task.then(respond, (error) => respond({ ok: false, error: errorText(error) }))
  return true
})
chrome.tabs.onRemoved.addListener((tabId) => { void serial(async () => { const all = await tracked(), photos = await folkTracked(), wasFollowing = !!photos[tabId]; delete all[tabId]; delete photos[tabId]; await chrome.storage.session.set({ tracked: all, folkTracked: photos, ...(wasFollowing ? { folkStopReason: 'Photo following stopped because the chosen tab was closed or replaced.' } : {}) }) }) })
chrome.tabs.onUpdated.addListener((tabId, change) => { const observedAt = Date.now(); if (change.status === 'loading' || change.url) void serial(async () => { const all = await tracked(), photos = await folkTracked(); if (all[tabId] && (change.status === 'loading' || all[tabId].url !== change.url)) { delete all[tabId]; await chrome.storage.session.set({ tracked: all }); await badge(tabId, '') } if (photos[tabId] && observedAt >= (photos[tabId].startedAt ?? 0)) { if (change.url && change.url !== photos[tabId].url) await stopFolk(tabId, 'Photo following stopped because the group URL changed.'); else if (change.status === 'loading') await reconcileFolk(tabId) } }) })

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name !== RETRY_ALARM) return
    void serial(async () => {
      const state = await chrome.storage.local.get(['outbox', 'retryStopped'])
      if (state.outbox?.length && !state.retryStopped) await drain().catch(() => {})
      await scheduleDelivery()
    }).catch(() => {})
  })
  void serial(scheduleDelivery).catch(() => {})
}
