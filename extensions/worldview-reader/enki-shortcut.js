/* global chrome */
// Isolated listener. It retains only the bracket sequence, never text.
(() => {
  if (globalThis.__worldviewEnkiShortcut) return
  globalThis.__worldviewEnkiShortcut = true
  let taps = 0, first = 0
  const reset = () => { taps = 0; first = 0 }
  addEventListener('blur', reset)
  addEventListener('keydown', event => {
    const target = event.composedPath()[0]
    const secure = target instanceof Element && target.closest('input[type="password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"]')
    if (!event.isTrusted || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.key !== ']' || secure || document.visibilityState !== 'visible') { reset(); return }
    const now = performance.now()
    if (!taps || now - first > 1200) { first = now; taps = 0 }
    if (++taps < 3) return
    reset()
    void chrome.runtime.sendMessage({ type: 'reader-enki-summon' }).catch(() => {})
  }, true)
})()
