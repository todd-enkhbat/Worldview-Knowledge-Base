/* global chrome */
// Observes only the explicitly chosen Folk group. Extraction and credentials stay in the worker.
(() => {
  if (globalThis.__worldviewFolkPhotos) return
  let nonce = '', url = '', timer = null, debounce = null, busy = false, dirty = false, epoch = 0
  const observer = new MutationObserver(schedule)
  function stop() {
    nonce = ''; epoch++; observer.disconnect()
    if (timer !== null) clearInterval(timer)
    if (debounce !== null) clearTimeout(debounce)
    timer = null; debounce = null; dirty = false
    document.removeEventListener('scroll', schedule, true)
    document.removeEventListener('visibilitychange', schedule)
    document.removeEventListener('load', schedule, true)
  }
  function reportStopped(reason) {
    const message = { type: 'folk-photos-stopped', nonce, url, reason: String(reason).slice(0, 200) }
    stop(); try { void chrome.runtime.sendMessage(message).catch(() => {}) } catch { /* Popup heartbeat reconciles an invalidated extension context. */ }
  }
  async function send() {
    debounce = null
    if (!nonce) return
    if (location.href !== url) {
      const message = { type: 'folk-photos-navigation', nonce, url }; stop()
      void chrome.runtime.sendMessage(message).catch(() => {}); return
    }
    if (document.visibilityState !== 'visible' || !document.hasFocus()) { dirty = true; return }
    if (busy) { dirty = true; return }
    const sendingEpoch = epoch
    busy = true; dirty = false
    try { const result = await chrome.runtime.sendMessage({ type: 'folk-photos-changed', nonce, url }); if (epoch === sendingEpoch) { if (!result?.ok) reportStopped(result?.error || 'The worker did not confirm this observer.'); else if (result.result?.paused) dirty = true } }
    catch { if (epoch === sendingEpoch) reportStopped('The observer lost its extension connection.') }
    finally { busy = false; if (nonce && dirty) schedule() }
  }
  function schedule() { if (!nonce) return; dirty = true; if (debounce === null) debounce = setTimeout(() => { void send() }, 1200) }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'folk-photos-status') { respond({ ok: true, following: !!nonce && message.nonce === nonce && location.href === url, nonce, url }); return }
    if (message.type === 'folk-photos-start') {
      stop(); nonce = message.nonce; url = location.href
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset', 'href', 'alt'] })
      document.addEventListener('scroll', schedule, true); document.addEventListener('visibilitychange', schedule); document.addEventListener('load', schedule, true)
      timer = setInterval(() => { if (location.href !== url || dirty) void send() }, 2000)
      respond({ ok: true })
    }
    if (message.type === 'folk-photos-stop') { stop(); respond({ ok: true }) }
  })
  addEventListener('pagehide', () => { if (nonce) { const message = { type: 'folk-photos-navigation', nonce, url }; stop(); void chrome.runtime.sendMessage(message).catch(() => {}) } })
  globalThis.__worldviewFolkPhotos = true
})()
