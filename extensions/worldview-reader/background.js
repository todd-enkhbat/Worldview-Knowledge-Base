/* global chrome */
import { extractArticle } from './extract.js'

const ENDPOINT = 'http://127.0.0.1:5173/api/reading-capture/capture'
const CONNECT = 'http://127.0.0.1:5173/api/reading-capture/connect'
const storageReady = Promise.all([chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }), chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })])
let operations = Promise.resolve()
// Register listeners synchronously; service-worker restarts must not miss the waking event.
const serial = (operation) => { const run = operations.catch(() => {}).then(() => storageReady).then(operation); operations = run; return run }
const errorText = (error) => error instanceof Error ? error.message : 'The local reader connection failed.'
async function badge(tabId, text) { await chrome.action.setBadgeText({ tabId, text }); await chrome.action.setBadgeBackgroundColor({ tabId, color: '#365e8a' }) }
async function tracked() { return (await chrome.storage.session.get('tracked')).tracked ?? {} }
async function pairing() { return (await chrome.storage.local.get('pairing')).pairing }
async function finishConnection() {
  const pending = (await chrome.storage.local.get('pendingConnection')).pendingConnection
  if (!pending) return
  if (pending.expiresAt <= Date.now()) { await chrome.storage.local.remove('pendingConnection'); return }
  // Chromium may omit Origin on a privileged extension GET. A JSON POST forces
  // an Origin-bearing request without weakening the server's exact-origin gate.
  const response = await fetch(`${CONNECT}/${encodeURIComponent(pending.requestId)}`, { method: 'POST', headers: { authorization: `Bearer ${pending.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'check' }), credentials: 'omit', signal: AbortSignal.timeout(5000) })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) { if (response.status === 401) await chrome.storage.local.remove('pendingConnection'); throw new Error(value.error ?? 'The connection request could not be checked.') }
  if (value.connected && /^wvread_[A-Za-z0-9_-]{43}$/.test(value.token ?? '')) {
    // Persist first, acknowledge second. Reopening the popup safely retries an uncertain ack.
    await chrome.storage.local.set({ pairing: { token: value.token }, sequence: 0 })
    await fetch(`${CONNECT}/${encodeURIComponent(pending.requestId)}`, { method: 'POST', headers: { authorization: `Bearer ${pending.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'acknowledge' }), credentials: 'omit', signal: AbortSignal.timeout(5000) }).catch(() => {})
    await chrome.storage.local.remove('pendingConnection')
  }
}
async function enqueue(body) {
  const config = await pairing()
  if (!config?.token) throw new Error('Pair Worldview Reader with your local workspace first.')
  const state = await chrome.storage.local.get(['sequence', 'outbox'])
  const sequence = Math.max((state.sequence ?? 0) + 1, Date.now()), outbox = state.outbox ?? []
  if (outbox.length >= 20) throw new Error('The local capture queue is full. Open Worldview and retry pending captures.')
  outbox.push({ ...body, sequence })
  await chrome.storage.local.set({ sequence, outbox })
  try { return await drain() } catch (error) { return { queued: true, message: errorText(error) } }
}
async function drain() {
  const config = await pairing(), state = await chrome.storage.local.get('outbox'), outbox = state.outbox ?? []
  if (!config?.token) throw new Error('Pair the reader first.')
  let result = null
  try { while (outbox.length) {
    const response = await fetch(ENDPOINT, { method: 'POST', mode: 'cors', credentials: 'omit', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` }, body: JSON.stringify(outbox[0]), signal: AbortSignal.timeout(10_000) })
    const value = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(value.error ?? `Local capture failed (${response.status}).`)
    result = value; outbox.shift(); await chrome.storage.local.set({ outbox, lastDeliveryAt: Date.now(), lastFailure: '' })
  } } catch (error) { await chrome.storage.local.set({ lastFailure: errorText(error) }); throw error }
  return result
}
async function activeArticle(tabId) {
  const tab = await chrome.tabs.get(tabId)
  if (!tab.active || !/^https?:\/\//.test(tab.url ?? '')) throw new Error('Choose an ordinary web article in the active tab.')
  const results = await chrome.scripting.executeScript({ target: { tabId }, func: extractArticle })
  if (!results[0]?.result?.text) throw new Error('This page could not be read. Paste article text into Worldview instead.')
  return results[0].result
}
async function popupAction(message) {
  if (message.type === 'reader-status') { let connectionError = ''; try { await finishConnection() } catch (error) { connectionError = errorText(error) } const state = await chrome.storage.local.get(['pairing', 'outbox', 'pendingConnection', 'lastDeliveryAt', 'lastFailure']); return { paired: !!state.pairing?.token, pendingConnection: !!state.pendingConnection, connectionError, extensionId: chrome.runtime.id, queued: state.outbox?.length ?? 0, pending: (state.outbox ?? []).map((entry) => ({ sequence: entry.sequence, title: entry.title ?? 'Reading progress', url: entry.url })), lastDeliveryAt: state.lastDeliveryAt ?? null, lastFailure: state.lastFailure ?? '', tracked: await tracked() } }
  if (message.type === 'reader-connect') {
    if (((await chrome.storage.local.get('outbox')).outbox ?? []).length) throw new Error('Retry or explicitly discard pending captures before connecting a different browser pairing.')
    const response = await fetch(CONNECT, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Worldview Reader' }), signal: AbortSignal.timeout(5000) })
    const value = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(value.error ?? 'Open Worldview locally, then click Connect again.')
    if (!/^wvconnect_[A-Za-z0-9_-]{43}$/.test(value.secret ?? '') || !value.requestId) throw new Error('The local service returned an invalid connection request.')
    await chrome.storage.local.set({ pendingConnection: value })
    return { ok: true, openUrl: 'http://127.0.0.1:5173/#/sources?connection=browser' }
  }
  if (message.type === 'reader-pair') {
    if (!/^wvread_[A-Za-z0-9_-]{43}$/.test(message.token ?? '')) throw new Error('Paste the pairing token generated by Worldview.')
    // A new token has its own sequence. Never silently send an older pair's pending data to it.
    if (((await chrome.storage.local.get('outbox')).outbox ?? []).length) throw new Error('Retry or explicitly discard pending captures before changing the pairing.')
    const previous = await pairing()
    await chrome.storage.local.set({ pairing: { token: message.token }, ...(previous?.token === message.token ? {} : { sequence: 0 }) }); return { ok: true }
  }
  if (message.type === 'reader-disconnect') { await chrome.storage.local.remove(['pairing', 'pendingConnection', 'outbox', 'sequence', 'lastFailure', 'lastDeliveryAt']); const all = await tracked(); for (const key of Object.keys(all)) { const tabId = Number(key); await chrome.tabs.sendMessage(tabId, { type: 'reading-stop' }).catch(() => {}); await badge(tabId, '') } await chrome.storage.session.remove('tracked'); return { ok: true } }
  if (message.type === 'reader-discard') { await chrome.storage.local.set({ outbox: [] }); return { ok: true } }
  if (message.type === 'reader-discard-one') { if (!Number.isSafeInteger(message.sequence)) throw new Error('Choose a pending capture.'); const outbox = ((await chrome.storage.local.get('outbox')).outbox ?? []).filter((entry) => entry.sequence !== message.sequence); await chrome.storage.local.set({ outbox, ...(!outbox.length ? { lastFailure: '' } : {}) }); return { ok: true } }
  if (message.type === 'reader-retry') return { ok: true, result: await drain() }
  if (!Number.isSafeInteger(message.tabId)) throw new Error('Choose an active article tab.')
  const tabId = message.tabId
  if (message.type === 'reader-stop') { const all = await tracked(), entry = all[tabId]; const final = await chrome.tabs.sendMessage(tabId, { type: 'reading-stop' }).catch(() => null); if (entry && final?.progress) await enqueue({ url: entry.url, title: entry.title, progress: final.progress }); delete all[tabId]; await chrome.storage.session.set({ tracked: all }); await badge(tabId, ''); return { ok: true } }
  const article = await activeArticle(tabId)
  if (message.type === 'reader-highlight') {
    if (!article.selection) throw new Error('Select text inside the article, then reopen this popup.')
    const result = await enqueue({ ...article, selection: { ...article.selection, note: String(message.note ?? '').slice(0, 20_000) } })
    return { ok: true, result }
  }
  if (message.type === 'reader-follow') {
    const result = await enqueue({ url: article.url, title: article.title, text: article.text, remark: String(message.note ?? '').slice(0, 20_000), progress: { fraction: 0, position: 0, activeMs: 0, following: true } })
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
    if (!['reading-progress', 'reading-navigation'].includes(message.type) || !sender.tab?.id) throw new Error('This reader message is not authorized.')
    const all = await tracked(), entry = all[sender.tab.id]
    if (!entry || entry.nonce !== message.nonce || entry.url !== message.url) throw new Error('Following stopped or this article changed.')
    if (message.type === 'reading-navigation') { delete all[sender.tab.id]; await chrome.storage.session.set({ tracked: all }); await badge(sender.tab.id, ''); return { ok: true } }
    if (sender.url !== entry.url) { delete all[sender.tab.id]; await chrome.storage.session.set({ tracked: all }); await badge(sender.tab.id, ''); throw new Error('This tab navigated away. Choose the article again before following.') }
    // Content scripts report only focused/visible time; sender identity binds it to the chosen tab.
    const result = await enqueue({ url: entry.url, title: entry.title, progress: message.progress })
    return { ok: true, result }
  })
  task.then(respond, (error) => respond({ ok: false, error: errorText(error) }))
  return true
})
chrome.tabs.onRemoved.addListener((tabId) => { void serial(async () => { const all = await tracked(); delete all[tabId]; await chrome.storage.session.set({ tracked: all }) }) })
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'loading' || change.url) void serial(async () => { const all = await tracked(); if (all[tabId] && (change.status === 'loading' || all[tabId].url !== change.url)) { delete all[tabId]; await chrome.storage.session.set({ tracked: all }); await badge(tabId, '') } }) })
