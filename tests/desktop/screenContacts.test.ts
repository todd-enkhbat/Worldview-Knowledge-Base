import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'

type Line = { text: string; x: number; y: number; height: number }
type Contact = { name: string; headline: string; url: string; phone: string; source: string }
const { contactFromScreen, contactFromPaste, createScreenContacts } = createRequire(import.meta.url)('../../electron/screen-contacts.cjs') as {
  contactFromScreen: (rows: Line[]) => Contact | null
  contactFromPaste: (text: string) => Contact
  createScreenContacts: (options: Record<string, unknown>) => {
    enable: () => Promise<unknown>; state: () => { status: string; suggestion: (Contact & { id: string }) | null }
    proposal: (id: string) => Contact; discard: (id: string) => void; reset: () => void; stop: () => void
    paste: (text: string) => unknown; refresh: () => void; readNow: (beforeFrame?: () => Promise<() => void>) => Promise<unknown>
  }
}

const line = (text: string, y: number, height = .02, x = .08): Line => ({ text, x, y, height })
const profile = [line('My Network', .05), line('Messaging', .05, .02, .4), line('Notifications', .05, .02, .6), line('Ada Example · 2nd', .42, .037),
  line('Researcher at Example Lab', .46), line('Somewhere · Contact info', .50), line('Message', .58),
  line('Suggested People', .4, .034, .75)]

it('requires a person profile layout, reads the primary header and never invents a URL', () => {
  const expected = { name: 'Ada Example', headline: 'Researcher at Example Lab', url: '', phone: '', source: 'LinkedIn' }
  expect(contactFromScreen(profile)).toEqual(expected)
  expect(contactFromScreen([line('www.linkedin.com/in/ada-example', .025), ...profile])).toEqual({ ...expected, url: 'https://www.linkedin.com/in/ada-example' })
  expect(contactFromScreen(profile.filter(row => !row.text.includes('Contact info')))).toBeNull()
  expect(contactFromScreen([...profile, line('Avery Example', .43, .037)])).toBeNull()
  const visualBadge = profile.filter(row => !row.text.includes('My Network') && !row.text.includes('2nd'))
  expect(contactFromScreen([line('Network', .05), line('Daisy Z. O.2nd', .42, .037), ...visualBadge])).toMatchObject({ name: 'Daisy Z.', source: 'LinkedIn' })
})

it('suggests an Instagram handle only with profile context', () => {
  const url = line('instagram.com/ada.example/', .06)
  const stats = line('123 posts   250 followers   180 following', .35, .019, .3)
  expect(contactFromScreen([url, stats])).toMatchObject({ name: '@ada.example', url: 'https://www.instagram.com/ada.example/', source: 'Instagram' })
  expect(contactFromScreen([line('@ada.example', .29, .026, .28), line('Follow', .3, .02, .42), stats])).toMatchObject({ name: '@ada.example', source: 'Instagram' })
  expect(contactFromScreen([url, line('Explore', .3)])).toBeNull()
})

it('captures a WhatsApp header number or a distinct visible phone and ignores message-body numbers and dates', () => {
  const app = line('WhatsApp', .06)
  expect(contactFromScreen([app, line('+1 (415) 555-0126', .12, .024, .4)])).toMatchObject({ phone: '+14155550126', source: 'WhatsApp' })
  expect(contactFromScreen([app, line('Contact info', .13, .02, .65), line('Ada Example', .24, .03, .66)])).toMatchObject({ name: 'Ada Example', source: 'WhatsApp' })
  expect(contactFromScreen([app, line('415-555-0126', .57, .024, .4)])).toBeNull()
  expect(contactFromScreen([line('Phone: (415) 555-0126', .50)])).toMatchObject({ name: '', phone: '4155550126', source: 'Phone number' })
  expect(contactFromScreen([line('2026-11-26', .44), line('Verification code: 12345678', .48)])).toBeNull()
  expect(contactFromScreen([line('+1 415 555 0126', .44), line('+1 415 555 0127', .48)])).toBeNull()
})

it('parses only the supplied contact and drops tracking information from pasted profile links', () => {
  expect(contactFromPaste('Ada Example\n+1 (415) 555-0126')).toMatchObject({ name: 'Ada Example', phone: '+14155550126' })
  expect(contactFromPaste('https://www.instagram.com/Ada.Example/?igsh=tracking')).toMatchObject({ name: '@ada.example', url: 'https://www.instagram.com/ada.example/' })
  expect(() => contactFromPaste('+14155550126\n+14155550127')).toThrow('one contact')
})

it.skipIf(process.platform !== 'darwin')('starts by consent, waits for a stable profile, and clears it on lock or workspace change', async () => {
  vi.useFakeTimers()
  const power = Object.assign(new EventEmitter(), { getSystemIdleState: () => 'active' })
  let scope = 'first', allowed = false
  const source = { display_id: '2', thumbnail: { isEmpty: () => false, toPNG: () => Buffer.from('fixture') } }
  const capture = vi.fn(async () => [source])
  const readText = vi.fn(async () => profile)
  const publish = vi.fn()
  const scanner = createScreenContacts({
    electron: { desktopCapturer: { getSources: capture }, powerMonitor: power,
      systemPreferences: { getMediaAccessStatus: () => allowed ? 'granted' : 'denied' },
      screen: { getDisplayNearestPoint: () => ({ id: 2 }), getCursorScreenPoint: () => ({ x: 1, y: 1 }) } },
    preferences: { read: () => ({}), write: vi.fn() }, scope: () => scope, publish, readText, interval: 50,
  })
  try {
    await vi.advanceTimersByTimeAsync(100)
    expect(capture).not.toHaveBeenCalled()
    expect(await scanner.enable()).toMatchObject({ status: 'permission' })
    expect(capture).toHaveBeenCalledExactlyOnceWith({ types: ['screen'], thumbnailSize: { width: 16, height: 16 } })
    expect(readText).not.toHaveBeenCalled()
    scanner.paste('Ada Example\n+14155550126')
    const pasted = scanner.state().suggestion!
    expect(scanner.proposal(pasted.id)).toMatchObject({ phone: '+14155550126', source: 'Pasted' })
    scanner.discard(pasted.id)
    allowed = true
    scanner.refresh()
    await vi.advanceTimersByTimeAsync(1)
    expect(scanner.state().suggestion).toBeNull()
    await vi.advanceTimersByTimeAsync(50)
    const suggestion = scanner.state().suggestion!
    expect(suggestion.name).toBe('Ada Example')
    expect(scanner.proposal(suggestion.id).name).toBe('Ada Example')
    power.emit('lock-screen')
    expect(scanner.state()).toMatchObject({ status: 'paused', suggestion: null })
    const scans = capture.mock.calls.length
    await vi.advanceTimersByTimeAsync(200)
    expect(capture).toHaveBeenCalledTimes(scans)
    power.emit('unlock-screen')
    await vi.advanceTimersByTimeAsync(60)
    scope = 'second'
    scanner.reset()
    expect(scanner.state().suggestion).toBeNull()
    expect(() => scanner.proposal(suggestion.id)).toThrow()
    const restore = vi.fn()
    capture.mockResolvedValueOnce([])
    expect(await scanner.readNow(async () => restore)).toMatchObject({ result: 'unreadable', frame: 'unreadable' })
    expect(restore).toHaveBeenCalledOnce()
  } finally { scanner.stop(); vi.useRealTimers() }
})
