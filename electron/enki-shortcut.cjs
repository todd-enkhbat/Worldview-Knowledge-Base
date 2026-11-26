// Per-window sequence. Only the predicate for this shortcut and its timing survive each keydown.
function bracketSequence() {
  let taps = 0, first = 0
  return (matches, now) => {
    if (!matches) { taps = 0; return false }
    if (!taps || now - first > 850) { first = now; taps = 0 }
    if (++taps < 3) return false
    taps = 0
    return true
  }
}
function bindEnkiKeys(win, allowed, summon) {
  const next = bracketSequence()
  win.on('blur', () => next(false, 0))
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    const matches = input.key === ']' && !input.isAutoRepeat && !input.isComposing && !input.control && !input.meta
    if (next(matches && allowed(win.webContents.getURL()), performance.now())) setImmediate(summon)
  })
}
module.exports = { bindEnkiKeys, bracketSequence }
