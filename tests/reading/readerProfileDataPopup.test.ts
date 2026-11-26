import { popupScript } from './popupRuntime.ts'
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options?: { url?: string }) => { window: { document: Document; close(): void } } }

interface PreviewOverrides { entityType?: 'person' | 'company'; name?: string; headline?: string; role?: string; current?: string[]; schools?: string[]; location?: string; photoUrl?: string }
async function popup(existing = true, queued = false, canAdd = false, prefs: Record<string, string> = {}, overrides: PreviewOverrides = {}, experienceNotice = '', savedRecord?: {recordId: string; groupIds: string[]}) {
  const page = new JSDOM(readFileSync('extensions/worldview-reader/popup.html', 'utf8')), doc = page.window.document
  let pending = queued
  const retry = vi.fn(async () => ({ ok: true, result: { sourceId: 'later-article', versionId: 'article-version' } }))
  const send = vi.fn(async (message: { type: string }) => {
    if (message.type === 'reader-status') return { paired: true, tracked: {}, folkTracked: {}, pending: [], queued: pending ? 1 : 0 }
    if (canAdd && message.type === 'reader-profile-preview') return { ok: true, existing: savedRecord, preview: { name: 'Ada Example', entityType: 'person', url: 'https://www.linkedin.com/in/ada-example/', headline: 'Founder at Acme', role: 'Founder', current: ['Acme'], schools: ['Columbia University'], location: 'Cambridge', ...overrides }, groups: [{ id: 'founders', name: '💼 Founders' }, { id: 'school', name: '🦁 Columbia', emoji: '🦁' }] }
    if (canAdd && message.type === 'reader-profile-add') return queued ? { ok: true, result: { queued: true } } : { ok: true, result: { quickAdd: { status: 'saved', recordId: 'ada' }, experienceNotice } }
    if (message.type === 'reader-retry') { const result = await retry(); pending = false; return result }
    return { ok: true, result: queued ? { queued: true } : { profileDraft: { id: 'capture-ada', profile: { name: 'Ada Example' } }, reviewUrl: 'https://untrusted.example/' } }
  })
  const tabs = { query: vi.fn(async (query: Record<string, unknown>) => query.url ? existing ? [{ id: 8, windowId: 1, url: 'http://127.0.0.1:5173/#/graph' }, { id: 9, windowId: 1, url: 'https://untrusted.example/' }] : [] : [{ id: 7, windowId: 1, url: 'https://www.linkedin.com/in/ada-example/' }]), update: vi.fn(async () => ({})), create: vi.fn(async () => ({})) }
  const storage = { get: vi.fn(async (key: string) => ({ [key]: prefs[key] })), set: vi.fn(async (value: Record<string, string>) => Object.assign(prefs, value)) }
  const chrome = { tabs, runtime: { sendMessage: send }, storage: { local: storage } }
  await new Script(`(async () => { ${popupScript()}\n})()`).runInContext(createContext({ chrome, document: doc, URL, confirm: () => true }))
  return { page, doc, tabs, send, retry, storage }
}
async function settle() { await new Promise(resolve => setTimeout(resolve, 0)) }

it('opens confirmed capture review in the existing Worldview writer tab rather than creating another app tab', async () => {
  const f = await popup(); const note = f.doc.getElementById('note') as HTMLTextAreaElement; note.value = 'Keep this unfinished comment'
  const button = f.doc.getElementById('profile-data') as HTMLButtonElement; expect(button.disabled).toBe(false); button.click(); await settle()
  expect(f.send).toHaveBeenCalledWith({ type: 'reader-profile-data', tabId: 7, token: '', note: note.value })
  expect(f.tabs.query).toHaveBeenCalledWith({ url: ['http://127.0.0.1:5173/*', 'http://localhost:5173/*'] })
  expect(f.tabs.update).toHaveBeenCalledWith(8, { active: true, url: 'http://127.0.0.1:5173/#/people?capture=capture-ada' }); expect(f.tabs.create).not.toHaveBeenCalled()
  expect(f.doc.getElementById('profile-data-status')!.textContent).toContain('Ada Example source saved locally')
  expect(note.value).toBe('Keep this unfinished comment'); f.page.window.close()
})

it('creates a fixed local review tab only when no Worldview tab exists and never follows a response URL', async () => {
  const f = await popup(false); (f.doc.getElementById('profile-data') as HTMLButtonElement).click(); await settle()
  expect(f.tabs.create).toHaveBeenCalledWith({ url: 'http://127.0.0.1:5173/#/people?capture=capture-ada' }); expect(f.tabs.update).not.toHaveBeenCalled(); f.page.window.close()
})

it('distinguishes a queued source from a saved profile and leaves the browser on the source page', async () => {
  const f = await popup(true, true); (f.doc.getElementById('profile-data') as HTMLButtonElement).click(); await settle()
  expect(f.doc.getElementById('profile-data-status')!.textContent).toContain('not been confirmed'); expect(f.tabs.update).not.toHaveBeenCalled(); expect(f.tabs.create).not.toHaveBeenCalled(); f.page.window.close()
})

it('clears stale profile queued copy when retry delivers a mixed outbox ending in an article receipt', async () => {
  const f = await popup(true, true); (f.doc.getElementById('profile-data') as HTMLButtonElement).click(); await settle()
  expect(f.doc.getElementById('profile-data-status')!.textContent).toContain('not been confirmed')
  ;(f.doc.getElementById('retry') as HTMLButtonElement).click(); await settle()
  expect(f.retry).toHaveBeenCalledOnce(); expect(f.doc.getElementById('queue')!.textContent).toBe('All captures delivered')
  expect(f.doc.getElementById('profile-data-status')!.textContent).toBe('No captures remain queued. Open Collect profiles in People to review saved sources.')
  expect(f.tabs.update).not.toHaveBeenCalled(); expect(f.tabs.create).not.toHaveBeenCalled(); f.page.window.close()
})

it('previews a contact and saves to the selected group without leaving the profile', async () => {
  const f = await popup(true, false, true)
  expect(f.doc.getElementById('quick-panel')!.hidden).toBe(false)
  expect(f.doc.getElementById('profile-summary')!.textContent).toBe('Founder at Acme')
  expect(f.doc.getElementById('profile-affiliations')!.textContent).toBe('Columbia University')
  expect(f.doc.body.classList.contains('has-profile')).toBe(true)
  expect((f.doc.getElementById('capture-tools') as HTMLDetailsElement).open).toBe(false)
  ;(f.doc.getElementById('profile-group') as HTMLButtonElement).click()
  const choice = [...f.doc.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(node => node.textContent.includes('Founders'))!
  choice.click()
  ;(f.doc.getElementById('quick-add') as HTMLButtonElement).click()
  await settle()
  expect(f.send).toHaveBeenCalledWith({ type: 'reader-profile-add', tabId: 7, name: 'Ada Example', url: 'https://www.linkedin.com/in/ada-example/', entityType: 'person', groupId: 'founders' })
  expect(f.doc.getElementById('quick-status')!.textContent).toBe('Ada Example saved to Founders.')
  expect(f.storage.set).toHaveBeenCalledWith({ 'lastProfileGroup:person': 'founders' })
  expect((f.doc.getElementById('open-record') as HTMLAnchorElement).href).toBe('http://127.0.0.1:5173/#/people?person=ada')
  expect(f.tabs.update).not.toHaveBeenCalled()
  expect(f.tabs.create).not.toHaveBeenCalled()
  f.page.window.close()
})

it('restores a compatible group for this entity and filters emoji groups using the keyboard', async () => {
  const f = await popup(true, false, true, { 'lastProfileGroup:person': 'founders' })
  const button = f.doc.getElementById('profile-group')!, search = f.doc.getElementById('group-search') as HTMLInputElement
  expect(f.doc.getElementById('group-selected-name')!.textContent).toBe('Founders')
  button.click()
  expect(f.doc.activeElement).toBe(search)
  const keyboard = (node: Element, key: string) => node.dispatchEvent(new f.doc.defaultView!.KeyboardEvent('keydown', { key, bubbles: true }))
  keyboard(search, 'ArrowDown')
  keyboard(search, 'Escape')
  expect(button.getAttribute('aria-expanded')).toBe('false')
  expect(f.doc.activeElement).toBe(button)
  button.click(); search.value = 'col'; search.dispatchEvent(new f.doc.defaultView!.Event('input'))
  const items = f.doc.querySelectorAll('[role="option"]')
  expect(items).toHaveLength(1)
  expect(items[0].textContent).toBe('🦁Columbia')
  keyboard(search, 'Enter')
  expect(f.doc.getElementById('group-selected-name')!.textContent).toBe('Columbia')
  expect(f.storage.set).not.toHaveBeenCalled()
  button.click()
  search.value = 'no-such-group'; search.dispatchEvent(new f.doc.defaultView!.Event('input'))
  expect(f.doc.getElementById('group-empty')!.hidden).toBe(false)
  f.doc.getElementById('profile-name')!.click()
  expect(button.getAttribute('aria-expanded')).toBe('false')
  expect(f.doc.getElementById('group-selected-name')!.textContent).toBe('Columbia')
  f.page.window.close()
})

it('falls back from a deleted group and a blocked photo URL, and preserves the last saved group on queue', async () => {
  const f = await popup(true, true, true, { 'lastProfileGroup:person': 'deleted' }, { photoUrl: 'http://127.0.0.1:8000/private' })
  expect(f.doc.getElementById('group-selected-name')!.textContent).toBe('All contacts')
  const photo = f.doc.getElementById('profile-avatar') as HTMLImageElement
  expect(photo.hasAttribute('src')).toBe(false)
  expect(f.doc.getElementById('profile-initials')!.textContent).toBe('AE')
  ;(f.doc.getElementById('quick-add') as HTMLButtonElement).click()
  await settle()
  expect(f.doc.getElementById('quick-panel')!.dataset.saveState).toBe('pending')
  expect(f.doc.getElementById('open-record')!.hidden).toBe(true)
  expect(f.storage.set).not.toHaveBeenCalled()
  f.page.window.close()
})

it('keeps sparse companies readable, handles image errors and opens the confirmed company record', async () => {
  const f = await popup(true, false, true, { 'lastProfileGroup:person': 'founders' }, { entityType: 'company', name: 'Acme', headline: '', role: '', current: [], schools: [], location: '', photoUrl: 'https://images.example.com/acme.png' })
  expect(f.doc.getElementById('profile-summary')!.hidden).toBe(true)
  expect(f.doc.getElementById('quick-add')!.textContent).toBe('Save company')
  const avatar = f.doc.getElementById('profile-avatar') as HTMLImageElement
  expect(avatar.src).toBe('https://images.example.com/acme.png')
  expect(avatar.referrerPolicy).toBe('no-referrer')
  avatar.dispatchEvent(new f.doc.defaultView!.Event('error'))
  expect(f.doc.getElementById('profile-initials')!.hidden).toBe(false)
  ;(f.doc.getElementById('quick-add') as HTMLButtonElement).click(); await settle()
  expect(f.storage.set).toHaveBeenCalledWith({ 'lastProfileGroup:company': '' })
  ;(f.doc.getElementById('open-record') as HTMLAnchorElement).click(); await settle()
  expect(f.tabs.update).toHaveBeenCalledWith(8, { active: true, url: 'http://127.0.0.1:5173/#/people?tab=companies&company=ada' })
  f.page.window.close()
})

it('keeps a confirmed save visible with an incomplete Experience notice', async () => {
  const note = 'Saved the visible roles. Open Experience to capture the rest.'
  const f = await popup(true, false, true, {}, {}, note)
  ;(f.doc.getElementById('quick-add') as HTMLButtonElement).click()
  await settle()
  expect(f.doc.getElementById('quick-status')!.textContent).toBe('Ada Example saved in Worldview. ' + note)
  expect(f.doc.getElementById('open-record')!.hidden).toBe(false)
  f.page.window.close()
})

it('reopens a known contact in its real group without submitting a capture', async () => {
  const f = await popup(true, false, true, {}, {}, '', {recordId: 'ada', groupIds: ['founders']})
  expect(f.doc.getElementById('profile-kind')?.textContent).toBe('Saved')
  expect(f.doc.getElementById('membership-summary')?.textContent).toContain('Founders')
  expect(f.doc.getElementById('profile-group')?.hidden).toBe(true)
  expect(f.doc.getElementById('quick-add')?.hidden).toBe(true)
  const button = f.doc.getElementById('open-record') as HTMLAnchorElement
  expect(button.textContent).toBe('Open contact')
  button.click(); await settle()
  expect(f.tabs.update).toHaveBeenCalledWith(8, {url:'http://127.0.0.1:5173/#/people?person=ada',active:true})
  expect(f.send.mock.calls.some(([m]) => m.type === 'reader-profile-add')).toBe(false)
  expect(f.doc.getElementById('log-interaction')?.getAttribute('href')).toContain('person=ada&action=log-interaction')
  f.page.window.close()
})
it('adds another group after a confirmed save without discarding the first membership', async () => {
  const f = await popup(true, false, true, { 'lastProfileGroup:person': 'founders' })
  try {
    ;(f.doc.getElementById('quick-add') as HTMLButtonElement).click(); await settle()
    expect((f.doc.getElementById('quick-add') as HTMLButtonElement).disabled).toBe(true)
    const another = f.doc.getElementById('add-another-group') as HTMLButtonElement
    expect(another.hidden).toBe(false); another.click()
    const school = [...f.doc.querySelectorAll<HTMLButtonElement>('.group-option')].find(button => button.textContent?.includes('Columbia'))!
    school.click(); await settle()
    expect(f.doc.getElementById('quick-add')!.hidden).toBe(true)
    expect(f.doc.getElementById('add-another-group')!.hidden).toBe(true)
    expect(f.send.mock.calls.filter(([m]) => m.type === 'reader-profile-add')).toHaveLength(2)
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'reader-profile-add', groupId: 'school' }))
    expect(f.doc.getElementById('membership-summary')!.textContent).toContain('Founders')
    expect(f.doc.getElementById('membership-summary')!.textContent).toContain('Columbia')
  } finally { f.page.window.close() }
})
