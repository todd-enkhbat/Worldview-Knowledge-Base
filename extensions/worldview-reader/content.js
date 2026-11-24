/* global chrome */
// Runs only after an explicit action on this tab; never injected through a broad match rule.
(() => {
  if (globalThis.__worldviewReader) return
  let following = false, nonce = '', url = '', activeMs = 0, last = performance.now(), epoch = 0
  let timer = null, flush = null, observed = { fraction: 0, position: 0 }
  function progress() {
    return { ...observed, activeMs: Math.min(60_000, Math.round(activeMs)), following }
  }
  function stopTimers() { if (timer !== null) clearInterval(timer); if (flush !== null) clearInterval(flush); timer = null; flush = null }
  function startTimers() { stopTimers(); timer = setInterval(tick, 1000); flush = setInterval(() => { if (following) void send() }, 15_000) }
  function observe() {
    const maximum = Math.max(0, document.documentElement.scrollHeight - innerHeight)
    observed = { fraction: maximum ? Math.min(1, Math.max(0, scrollY / maximum)) : 1, position: Math.max(0, scrollY) }
  }
  function tick() {
    const now = performance.now(), elapsed = Math.min(2000, Math.max(0, now - last)); last = now
    if (following && location.href !== url) {
      following = false; stopTimers()
      // A SPA may replace the document before a navigation event arrives. Never credit its new geometry to the old article.
      void chrome.runtime.sendMessage({ type: 'reading-navigation', nonce, url, progress: { ...observed, activeMs: 0, following: false } }).catch(() => {})
      nonce = ''; activeMs = 0; epoch++; return
    }
    if (following && document.visibilityState === 'visible' && document.hasFocus()) { activeMs += elapsed; observe() }
  }
  async function send(force = false) {
    if (!nonce) return
    tick()
    if (!nonce) return
    if (!force && following && (document.visibilityState !== 'visible' || !document.hasFocus())) return
    const measured = progress()
    const sendingEpoch = epoch
    activeMs = Math.max(0, activeMs - measured.activeMs)
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'reading-progress', nonce, url, progress: measured })
      if (!reply?.ok && epoch === sendingEpoch) activeMs += measured.activeMs
    } catch { if (epoch === sendingEpoch) activeMs += measured.activeMs }
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'reading-start') { epoch++; nonce = message.nonce; url = location.href; following = true; activeMs = 0; observed = { fraction: 0, position: 0 }; last = performance.now(); if (document.visibilityState === 'visible' && document.hasFocus()) observe(); startTimers(); respond({ ok: true }) }
    if (message.type === 'reading-stop') { tick(); following = false; stopTimers(); respond({ ok: true, progress: progress() }); nonce = ''; epoch++ }
  })
  addEventListener('pagehide', () => { tick(); following = false; stopTimers(); void send(true); nonce = ''; epoch++ })
  document.addEventListener('visibilitychange', () => { tick(); if (document.visibilityState === 'hidden' && nonce && activeMs) void send(true) })
  globalThis.__worldviewReader = true
})()
