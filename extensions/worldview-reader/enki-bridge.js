/* global chrome */
import { mergeApplicationForms } from './application-form.js'
// Only these fixed operations cross the local bridge. Never accept executable
// JavaScript, selectors, arbitrary fetch destinations, or page-triggered RPC.
export function createEnkiBridge({ pairing, endpoint, extractProfile, extractVisiblePeople, extractArticle, readApplicationForm, readEmbeddedApplicationForms, readExperience, enqueue, serial }) {
  let running = false, controller = null
  const alarm = 'worldview-enki-bridge'
  const shortcutId = 'worldview-enki-shortcut'
  const publicUrl = value => {
    try {
      const url = new URL(value)
      return /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.port &&
        /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) && !/(^|\.)(localhost|local|internal|invalid)$/i.test(url.hostname)
    } catch { return false }
  }
  async function selected(ref) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (!Number.isSafeInteger(tab?.id) || !publicUrl(tab.pendingUrl || tab.url) || tab.pendingUrl && tab.pendingUrl !== tab.url) throw Error('Open a public web page in Dia, then press ]]] again. Browser settings, local pages and downloads cannot be read.')
    if (ref && (String(tab.id) !== ref.id || tab.url !== ref.url)) throw Error('The Dia page changed. Press ]]] again to work with the new page.')
    const url = new URL(tab.url)
    if (!await chrome.permissions.contains({ origins: [url.origin + '/*'] })) throw Error('Allow Worldview Reader on this site, then press ]]] again.')
    if (url.hostname === 'app.folk.app') throw Error('Use Worldview Reader’s separate Folk import on this private CRM page.')
    return tab
  }
  async function execute(command) {
    const { operation, args = {} } = command
    const tab = await selected(args.ref)
    const identity = async expected => {
      await selected(expected)
      const [row] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({ url: location.href }) })
      if (!row?.documentId || row.result?.url !== tab.url || expected?.documentId && expected.documentId !== row.documentId) throw Error('The Dia page reloaded. Press ]]] again to read it.')
      return { id: String(tab.id), url: tab.url, documentId: row.documentId }
    }
    const ref = await identity(args.ref)
    if (operation === 'identify') return ref
    const run = async (func, values = []) => {
      await selected(ref)
      const rows = await chrome.scripting.executeScript({ target: { tabId: tab.id, documentIds: [ref.documentId] }, func, args: values })
      await identity(ref)
      if (!rows[0]?.result || rows[0].documentId !== ref.documentId) throw Error('Dia could not read this page. Try again after it finishes loading.')
      return rows[0].result
    }
    if (operation === 'page') {
      const profile = await run(extractProfile, [null, true]).catch(() => null)
      const form = await run(readApplicationForm).catch(() => null)
      const info = await run(() => ({ title: document.title || location.hostname, url: location.href,
        description: document.querySelector('meta[name="description"]')?.content?.slice(0, 500) || '',
        selection: String(getSelection() || '').slice(0, 2000) }))
      const formProvider = /^(?:tally\.so|(?:[^.]+\.)*typeform\.com|docs\.google\.com|forms\.office\.com)$/.test(new URL(tab.url).hostname)
      const applicationContext = /\b(?:apply|application|fellowship|scholarship|internship|registration|admission|grant|position|opportunity|career|prize)\b/i.test([info.title, form?.opportunity, tab.url].join(' '))
      const questions = form?.answers?.some(answer => !/^(?:search|search .+|find .+|newsletter|email address|subscribe)$/i.test(answer.question))
      const application = form && (form.embeddedForms?.length || form.submitted || questions && (formProvider || applicationContext))
      return { ...info, ref, kind: application ? 'application' : profile?.profile?.name ? 'person' : 'article' }
    }
    if (operation === 'people') return run(extractVisiblePeople, [null, args.selectedUrl || ''])
    if (operation === 'profile' || operation === 'collect') {
      const data = args.selectedUrl ? await run(extractVisiblePeople, [null, args.selectedUrl]) : await run(extractProfile, [null, true])
      if (data.extractorError || !data.profile?.name) throw Error(data.extractorError || 'This page has no named profile. Use Save page in the Page tab.')
      if (operation === 'profile') return data
      if (data.profile.name !== args.name) throw Error('The profile changed. Press ]]] again before saving.')
      const notice = args.selectedUrl ? '' : await readExperience(tab.id, data, data.headerEmployer?.organization)
      const nextRef = await identity()
      await selected(ref)
      return { data, ref: nextRef, notice: notice || '' }
    }
    if (operation === 'form') {
      const outer = await run(readApplicationForm)
      const frames = await readEmbeddedApplicationForms(tab.id, { ...outer, documentId: ref.documentId })
      await identity(ref)
      return mergeApplicationForms(outer, frames.map(row => row.result))
    }
    if (operation === 'save-page') {
      const article = await run(extractArticle)
      if (!article.text) throw Error('No readable page text was found. Select the text you want to keep and try Reader.')
      return enqueue({ url: article.url, title: article.title, text: article.text, html: article.html,
        ...(article.selection ? { selection: article.selection } : {}) })
    }
    throw Error('Choose a supported Enki browser action.')
  }
  const request = async (config, route, body, signal) => {
    const response = await fetch(endpoint(config.port, 'enki/' + route), { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.token }, body: JSON.stringify(body), signal })
    const value = await response.json()
    if (!response.ok) throw Error(value.error || 'Open the latest Worldview app to connect Enki.')
    return value
  }
  async function start() {
    if (running) return
    running = true
    const connection = controller = new AbortController()
    try {
      if (!(await chrome.storage.local.get('enkiEnabled')).enkiEnabled) return
      const config = await pairing()
      if (!config?.token) return
      while (!connection.signal.aborted) {
        if (!(await chrome.storage.local.get('enkiEnabled')).enkiEnabled) break
        const current = await pairing()
        if (current?.token !== config.token || current?.port !== config.port) break
        const { command } = await request(config, 'poll', {}, AbortSignal.any([connection.signal, AbortSignal.timeout(24_000)]))
        if (!command) continue
        let reply
        try { reply = { id: command.id, value: await serial(() => execute(command)) } }
        catch (error) { reply = { id: command.id, error: error.message || 'Dia could not finish this action.' } }
        await request(config, 'reply', reply, AbortSignal.any([connection.signal, AbortSignal.timeout(5000)]))
      }
    } catch { /* A bounded alarm reconnects after sleep or a local service restart. */ }
    finally { running = false; controller = null }
  }
  async function configure(enabled) {
    await chrome.storage.local.remove('enkiPendingAt')
    await chrome.storage.local.set({ enkiEnabled: enabled })
    if (chrome.scripting.getRegisteredContentScripts) {
      const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [shortcutId] })
      if (enabled) {
        if (!registered.length) await chrome.scripting.registerContentScripts([{ id: shortcutId, matches: ['https://*/*', 'http://*/*'], js: ['enki-shortcut.js'], runAt: 'document_start', allFrames: true, persistAcrossSessions: true }])
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
        if (Number.isSafeInteger(tab?.id) && publicUrl(tab.url)) await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['enki-shortcut.js'] }).catch(() => {})
      } else if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [shortcutId] })
    }
    if (enabled) {
      await chrome.alarms.create(alarm, { delayInMinutes: 1, periodInMinutes: 1 })
      void start()
    } else {
      controller?.abort()
      await chrome.alarms.clear(alarm)
      const config = await pairing()
      if (config?.token) await request(config, 'disconnect', {}, AbortSignal.timeout(3000)).catch(() => {})
    }
    return { ok: true, enabled }
  }
  chrome.alarms.onAlarm.addListener(event => { if (event.name === alarm) void start() })
  chrome.runtime.onStartup.addListener(() => void start())
  chrome.permissions.onRemoved.addListener(() => { controller?.abort() })
  chrome.tabs.onActivated?.addListener(async ({ tabId }) => {
    if (!(await chrome.storage.local.get('enkiEnabled')).enkiEnabled) return
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (publicUrl(tab?.url)) await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['enki-shortcut.js'] }).catch(() => {})
  })
  async function finishPending() {
    const { enkiPendingAt } = await chrome.storage.local.get('enkiPendingAt')
    if (!Number.isFinite(enkiPendingAt) || Date.now() - enkiPendingAt > 120_000) return
    if (await chrome.permissions.contains({ origins: ['https://*/*', 'http://*/*'], permissions: ['webNavigation'] })) await configure(true)
  }
  chrome.permissions.onAdded.addListener(() => void finishPending())
  void finishPending()
  void chrome.storage.local.get('enkiEnabled').then(({ enkiEnabled }) => { if (enkiEnabled) return configure(true) })
  async function summon(sender) {
    if (!(await chrome.storage.local.get('enkiEnabled')).enkiEnabled) throw Error('Connect Enki to Dia in Reader first.')
    const tab = await selected()
    if (!Number.isSafeInteger(sender.frameId) || tab.id !== sender.tab?.id || !sender.documentId) throw Error('Use ]]] in the selected page.')
    if (sender.frameId !== 0) {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id })
      if (!frames.some(frame => frame.frameId === sender.frameId && frame.documentId === sender.documentId && frame.documentLifecycle === 'active')) throw Error('The form page changed. Press ]]] again.')
    }
    const ref = await execute({ operation: 'identify', args: { ref: { id: String(tab.id), url: tab.url, ...(sender.frameId === 0 ? { documentId: sender.documentId } : {}) } } })
    const config = await pairing()
    if (!config?.token) throw Error('Connect Reader to Worldview first.')
    void start()
    return request(config, 'summon', { ref }, AbortSignal.timeout(5000))
  }
  return { configure, wake: start, summon }
}
