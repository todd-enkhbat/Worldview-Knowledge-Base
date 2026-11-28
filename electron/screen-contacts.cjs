const { createHash, randomUUID } = require('node:crypto')
const { recognizeScreenText } = require('./helper-native.cjs')

function linkedinContact(lines) {
  const header = lines.filter(row => row.y < .28).map(row => row.text).join(' ')
  const linkedin = /linkedin/i.test(header) || (/\b(?:My )?Network\b/i.test(header) && /\bMessaging\b/i.test(header) && /\bNotifications\b/i.test(header))
  if (!linkedin || !lines.some(row => /\b(?:Connect|Message|Pending|Follow|More)\b/i.test(row.text))) return null
  const addresses = [...new Set(lines.filter(row => row.y < .20).flatMap(row =>
    [...row.text.matchAll(/(?:^|[\s/])(?:www\.)?linkedin\.com\/in\/([a-z0-9][a-z0-9-]{2,98})(?=\s|[/?#]|$)/gi)].map(match => match[1].toLowerCase())))]
  if (addresses.length > 1) return null
  for (const anchor of lines.filter(row => /\bContact info\b/i.test(row.text) && row.y < .86)) {
    const head = lines.filter(row => row.y < anchor.y && anchor.y - row.y < .20 && row.x <= anchor.x + .05)
    const candidates = head.map(row => ({ ...row, name: row.text.replace(/\s+(?:[O0©◯✓✔]\s*\.?\s*)?(?:[·•|.\-]\s*)?(?:1st|2nd|3rd)\+?(?:\b.*|$)/i, '').trim() }))
      .filter(row => row.height >= anchor.height * 1.22 && /^[\p{L}\p{M}.'’\-]+(?:\s+[\p{L}\p{M}.'’\-]+){1,5}$/u.test(row.name) &&
        !/\b(?:LinkedIn|Profile|Contact|Experience|Highlights|Notifications|Messaging|Network|Premium|Search|People|Jobs)\b/i.test(row.name))
      .sort((a, b) => b.height - a.height || b.y - a.y)
    const name = candidates[0]
    if (!name || (candidates[1] && candidates[1].height >= name.height * .92 && candidates[1].name !== name.name)) continue
    const headline = head.filter(row => row.y > name.y && row.y - name.y < .075 && Math.abs(row.x - name.x) < .06 && row.text.length <= 180 &&
      !/^(?:Follow|Connect|Message|More|Pending|\d+(?:,\d+)*\+? (?:followers|connections))$/i.test(row.text)).sort((a, b) => a.y - b.y)[0]
    return { name: name.name.slice(0, 120), headline: headline?.text ?? '', phone: '', source: 'LinkedIn', url: addresses[0] ? 'https://www.linkedin.com/in/' + addresses[0] : '' }
  }
  return null
}

const reservedInstagram = new Set(['accounts', 'direct', 'explore', 'reels', 'stories', 'about', 'p', 'reel', 'legal', 'developer', 'privacy', 'terms'])
function instagramContact(lines) {
  const header = lines.filter(row => row.y < .55)
  const profile = header.map(row => row.text).join(' ')
  const isProfile = /\bposts\b/i.test(profile) && /\bfollowers\b/i.test(profile) && /\bfollowing\b/i.test(profile)
  if (!isProfile) return null
  const handles = [...new Set(header.filter(row => row.y < .23).flatMap(row => [...row.text.matchAll(/(?:^|[\s/])(?:www\.)?instagram\.com\/([a-z0-9_.]{1,30})(?=\s|[/?#]|$)/gi)]
    .map(match => match[1].toLowerCase()).filter(handle => !reservedInstagram.has(handle))))]
  if (handles.length > 1) return null
  if (!handles.length) {
    const stats = header.find(row => /\bfollowers\b/i.test(row.text))
    if (!stats || !/\b(?:Follow|Message|Edit profile)\b/i.test(profile)) return null
    const nearby = header.filter(row => row.y <= stats.y && stats.y - row.y < .15 && Math.abs(stats.x - row.x) < .22)
    for (const row of nearby) {
      const match = row.text.match(/^@([a-z0-9_.]{1,30})$|^([a-z0-9_.]{2,30})\s+(?:Follow|Following|Message|Edit profile)\b/i)
      const handle = (match?.[1] || match?.[2])?.toLowerCase()
      if (handle && !reservedInstagram.has(handle)) handles.push(handle)
    }
  }
  if (new Set(handles).size !== 1) return null
  const handle = handles[0]
  return { name: '@' + handle, headline: '', url: 'https://www.instagram.com/' + handle + '/', phone: '', source: 'Instagram' }
}

function phoneInLine(text, allowBare = false) {
  if (/\b(?:verification|otp|passcode|security code|order number|tracking number|card number|account number|routing number|invoice)\b/i.test(text)) return ''
  const whatsapp = text.match(/(?:^|[\s/])wa\.me\/([1-9]\d{7,14})(?=\s|[/?#]|$)/i)
  if (whatsapp) return '+' + whatsapp[1]
  const labeled = text.match(/^(?:phone(?: number)?|tel(?:ephone)?|mobile|cell|whatsapp|call)(?:\s*[:·–-]\s*|\s+)(.+)$/i)
  const number = (labeled?.[1] || text).trim()
  if (!/^(?:\+?\d|\()[-.() 0-9]*\d$/.test(number) || /^\d{4}[-.]\d{2}[-.]\d{2}$/.test(number)) return ''
  const digits = number.replace(/\D/g, '')
  if (digits.length < 8 || digits.length > 15 || /^0+$/.test(digits)) return ''
  if (number.startsWith('+')) return '+' + digits
  const formatted = /^\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}$/.test(number)
  return labeled || formatted || allowBare && digits.length >= 10 ? digits : ''
}

function isWhatsApp(lines) {
  const top = lines.filter(row => row.y < .26).map(row => row.text).join(' ')
  return /\bwhatsapp\b/i.test(top) || lines.some(row => /end.to.end encrypted|\bwa\.me\/\d/i.test(row.text))
}

function whatsappContact(lines) {
  const candidates = lines.filter(row => row.y < .23 && row.x > .24 || /^(?:phone(?: number)?|mobile|whatsapp)\s*:/i.test(row.text))
  const links = lines.filter(row => row.y < .23 && /\bwa\.me\/\d/i.test(row.text))
  const numbers = [...new Set([...candidates, ...links].map(row => phoneInLine(row.text, row.y < .23)).filter(Boolean))]
  if (numbers.length > 1) return null
  const fields = lines.filter(row => /^contact info$/i.test(row.text))
  const names = fields.flatMap(anchor => lines.filter(row => row.y > anchor.y && row.y - anchor.y < .25 &&
    Math.abs(row.x - anchor.x) < .13 && row.height >= anchor.height * 1.15 &&
    /^[\p{L}\p{M}.'’\-]+(?:\s+[\p{L}\p{M}.'’\-]+){0,4}$/u.test(row.text) &&
    !/\b(?:WhatsApp|Search|Contact|Messages|Info|Groups|Media|Links|Settings|Notifications|Privacy|About|Add|Block)\b/i.test(row.text)))
  const distinct = [...new Set(names.map(row => row.text))]
  const name = distinct.length === 1 ? distinct[0] : ''
  return name || numbers.length ? { name, headline: '', url: '', phone: numbers[0] ?? '', source: 'WhatsApp' } : null
}

/** Every suggestion contains only fields needed for the confirmation card. */
function contactFromScreen(rows) {
  if (!Array.isArray(rows)) return null
  const lines = rows.filter(row => typeof row?.text === 'string' && [row.x, row.y, row.height].every(Number.isFinite))
    .map(row => ({ ...row, text: row.text.trim() })).filter(row => row.text)
  const social = linkedinContact(lines) || instagramContact(lines)
  if (social) return social
  if (isWhatsApp(lines)) return whatsappContact(lines)
  const numbers = [...new Set(lines.map(row => phoneInLine(row.text)).filter(Boolean))]
  return numbers.length === 1 ? { name: '', headline: '', url: '', phone: numbers[0], source: 'Phone number' } : null
}

function contactFromPaste(value) {
  if (typeof value !== 'string' || value.length > 2000) throw new Error('Paste a name and phone number or a profile link.')
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const numbers = [...new Set(lines.map(line => phoneInLine(line, true)).filter(Boolean))]
  const links = [...new Set(lines.flatMap(line => {
    try {
      const url = new URL(line)
      const host = url.hostname.replace(/^www\./, '')
      const path = url.pathname.replace(/\/$/, '')
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return []
      if (host === 'linkedin.com' && /^\/in\/[a-z0-9][a-z0-9-]{2,98}$/i.test(path)) return ['https://www.linkedin.com' + path.toLowerCase()]
      if (host === 'instagram.com' && /^\/[a-z0-9_.]{1,30}$/i.test(path) && !reservedInstagram.has(path.slice(1).toLowerCase())) return ['https://www.instagram.com' + path.toLowerCase() + '/']
    } catch { /* The line may be a name or a phone number. */ }
    return []
  }))]
  if (numbers.length > 1 || links.length > 1) throw new Error('Paste one contact at a time.')
  const url = links[0] ?? ''
  const handle = url.match(/^https:\/\/www\.instagram\.com\/([^/]+)\/$/)?.[1]
  const name = lines.find(line => /^[\p{L}\p{M}.'’\-]+(?:\s+[\p{L}\p{M}.'’\-]+){0,5}$/u.test(line) && !/^https?:/i.test(line))?.slice(0, 120) ?? (handle ? '@' + handle : '')
  if (!name && !numbers.length && !url) throw new Error('No name, phone number or profile link found.')
  return { name, headline: '', phone: numbers[0] ?? '', url, source: 'Pasted' }
}

function createScreenContacts({ electron, preferences, scope, publish, readText = recognizeScreenText, interval = 5500 }) {
  const { desktopCapturer, systemPreferences, powerMonitor, screen } = electron
  const supported = process.platform === 'darwin' && !!desktopCapturer
  let enabled = supported && preferences.read().screenContacts === true
  let suspended = false, locked = false, inactive = false, generation = 0
  let frame = 'waiting'
  let timer, inFlight, pendingScan, lastImage = '', lastContact = null, previous = '', current = null
  const dismissed = new Set()
  const permission = () => supported && systemPreferences.getMediaAccessStatus('screen') === 'granted'
  const state = () => ({ status: !supported ? 'unavailable' : !enabled ? 'off' : !permission() ? 'permission' : locked || suspended || inactive ? 'paused' : 'watching',
    frame, suggestion: current && (current.pasted || enabled && permission()) ? { id: current.id, ...current.contact } : null })
  const emit = () => publish(state())
  const keyOf = contact => (contact.url || contact.phone || contact.name + '\n' + contact.headline).normalize('NFKC').toLowerCase()
  function clear() {
    generation++
    inFlight?.abort()
    current = null
    previous = ''
    lastImage = ''
    lastContact = null
    frame = 'waiting'
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  function schedule(delay = interval) {
    if (timer || inFlight || !enabled || !permission() || suspended || locked || inactive) return
    timer = setTimeout(() => { timer = undefined; void runScan() }, delay)
    timer.unref?.()
  }
  function runScan(force = false, beforeFrame) {
    pendingScan ??= scan(force, beforeFrame).finally(() => { pendingScan = undefined })
    return pendingScan
  }
  async function readNow(beforeFrame) {
    if (state().status !== 'watching') return { ...state(), result: 'unavailable' }
    if (pendingScan) await pendingScan
    const result = current ? 'found' : await runScan(true, beforeFrame)
    return { ...state(), result }
  }
  function noteFrame(result) {
    if (frame !== result) { frame = result; emit() }
  }
  async function scan(force, beforeFrame) {
    if (!enabled || suspended || locked || inactive || !scope()) return schedule()
    if (!permission()) { clear(); emit(); return }
    if (!force && powerMonitor.getSystemIdleState(120) !== 'active') return schedule()
    const controller = inFlight = new AbortController(), version = generation, workspace = scope()
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      const valid = () => version === generation && workspace === scope() && enabled && !suspended && !locked && !inactive
      const restore = await beforeFrame?.()
      let sources
      try {
        if (!valid() || !permission()) return 'unavailable'
        sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1440 } })
      } finally { restore?.() }
      if (!valid()) return
      const source = sources.find(source => source.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : null)
      const image = source?.thumbnail
      if (!image || image.isEmpty()) { noteFrame('unreadable'); return 'unreadable' }
      const png = image.toPNG()
      const fingerprint = createHash('sha256').update(png).digest('hex')
      const contact = lastImage === fingerprint ? lastContact : contactFromScreen(await readText(png, controller.signal))
      if (!valid()) return
      noteFrame('readable')
      lastImage = fingerprint
      lastContact = contact
      const key = contact ? keyOf(contact) : ''
      if (contact && (force || key === previous && !dismissed.has(key)) && !current) {
        current = { id: randomUUID(), key, workspace, contact }
        emit()
      }
      previous = key
      return current ? 'found' : 'none'
    } catch {
      if (version !== generation || controller.signal.aborted) return 'unavailable'
      // Capture can be transiently unavailable while macOS changes displays.
      lastImage = ''
      previous = ''
      noteFrame('unreadable')
      return 'unreadable'
    } finally { inFlight = undefined; schedule() }
  }
  async function enable() {
    if (!supported) return state()
    preferences.write({ screenContacts: true })
    enabled = true
    if (!permission()) {
      // Only this user-triggered action asks macOS to start the permission flow.
      try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 16, height: 16 } }) } catch { /* Settings remains available. */ }
    }
    refresh()
    return state()
  }
  function refresh() {
    if (enabled && permission()) schedule(0)
    emit()
  }
  function pause() {
    preferences.write({ screenContacts: false })
    enabled = false
    clear()
    dismissed.clear()
    emit()
    return state()
  }
  function discard(id) {
    if (!current || current.id !== id) return
    if (dismissed.size >= 128) dismissed.delete(dismissed.values().next().value)
    dismissed.add(current.key)
    current = null
    emit()
  }
  function proposal(id) {
    if (!current || current.id !== id || current.workspace !== scope() || locked || suspended || inactive ||
        !current.pasted && (!enabled || !permission())) throw new Error('This suggestion is no longer available. Read the contact again.')
    return current.contact
  }
  function paste(text) {
    const workspace = scope()
    if (!workspace || locked || suspended || inactive) throw new Error('Open your workspace to review this contact.')
    const contact = contactFromPaste(text)
    current = { id: randomUUID(), key: keyOf(contact), workspace, contact, pasted: true }
    emit()
    return state()
  }
  if (supported && powerMonitor) {
    powerMonitor.on('lock-screen', () => { locked = true; clear(); emit() })
    powerMonitor.on('unlock-screen', () => { locked = false; emit(); schedule(0) })
    powerMonitor.on('suspend', () => { suspended = true; clear(); emit() })
    powerMonitor.on('resume', () => { suspended = false; emit(); schedule(0) })
    powerMonitor.on('user-did-resign-active', () => { inactive = true; clear(); emit() })
    powerMonitor.on('user-did-become-active', () => { inactive = false; emit(); schedule(0) })
  }
  schedule(0)
  return { state, enable, refresh, pause, readNow, paste, proposal, discard, reset: () => { clear(); dismissed.clear(); emit(); schedule() }, stop: () => { enabled = false; clear() } }
}
module.exports = { contactFromPaste, contactFromScreen, createScreenContacts }
