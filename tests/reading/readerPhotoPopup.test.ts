// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => document.body.replaceChildren())
async function fixture(url = 'https://www.linkedin.com/in/ada-example/') {
  document.body.innerHTML = readFileSync('extensions/worldview-reader/popup.html', 'utf8')
  let following = false, followingFolk = false, queued = 0
  const photo = vi.fn(async (): Promise<{ ok: boolean; result: Record<string, unknown> }> => ({ ok: true, result: { contactPhoto: { status: 'saved', personId: 'ada', avatarAssetId: 'portrait', name: 'Ada Example' } } }))
  const folk = vi.fn(async (): Promise<{ ok: boolean; result: Record<string, unknown> }> => ({ ok: true, result: { folkPhotos: { total: 1, saved: 0, kept: 0, unmatched: 0, unavailable: 0, diagnostic: true, message: 'Visible rows retained privately. No photos changed.' } } }))
  const retry = vi.fn(async (): Promise<{ ok: boolean; result: Record<string, unknown> | null }> => ({ ok: true, result: null }))
  const send = vi.fn(async (message: Record<string, unknown>) => {
    if (message.type === 'reader-status') return { paired: true, tracked: following ? { 7: {} } : {}, folkTracked: followingFolk ? { 7: {} } : {}, pending: [], queued }
    if (message.type === 'reader-profile') { const value = await photo(); queued = value.result.queued ? 1 : 0; return value }
    if (['reader-folk-photos', 'reader-folk-search-diagnostic', 'reader-folk-follow', 'reader-folk-search-photos', 'reader-folk-search-follow'].includes(String(message.type))) { if (['reader-folk-follow', 'reader-folk-search-follow'].includes(String(message.type))) followingFolk = true; const value = await folk(); queued = value.result.queued ? 1 : 0; return value }
    if (message.type === 'reader-retry') { const value = await retry(); if (!value.result?.queued) queued = 0; return value }
    if (message.type === 'reader-stop') { following = false; followingFolk = false }
    return { ok: true }
  })
  const chrome = { tabs: { query: async () => [{ id: 7, url }] }, runtime: { sendMessage: send } }
  await new Script(`(async () => { ${readFileSync('extensions/worldview-reader/popup.js', 'utf8')}\n})()`).runInContext(createContext({ chrome, document, URL, confirm: () => true }))
  return { send, photo, folk, retry, note: document.getElementById('note') as HTMLTextAreaElement, button: document.getElementById('profile') as HTMLButtonElement, setFollowing: (value: boolean) => { following = value } }
}
async function settle() { await new Promise(resolve => setTimeout(resolve, 0)) }

it('gives contact photos their own action and confirmation without clearing a comment or following the page', async () => {
  const f = await fixture(); f.note.value = 'Keep this unsent personal comment.'; expect(f.button.disabled).toBe(false); f.button.click(); await settle()
  expect(f.send).toHaveBeenCalledWith({ type: 'reader-profile', tabId: 7, token: '', note: f.note.value })
  expect(document.getElementById('photo-status')!.textContent).toContain('Photo saved locally for Ada Example')
  expect(f.note.value).toBe('Keep this unsent personal comment.')
  expect(document.getElementById('state')!.textContent).toBe('Connected · choose what to keep')
  expect((document.getElementById('stop') as HTMLButtonElement).disabled).toBe(true)
})

it('distinguishes queued or unmatched photo work from a saved photo', async () => {
  const f = await fixture(); f.photo.mockResolvedValueOnce({ ok: true, result: { queued: true } } as never); f.button.click(); await settle()
  expect(document.getElementById('photo-status')!.textContent).toContain('not confirmed yet')
  expect(document.getElementById('photo-status')!.textContent).not.toContain('Photo saved')
  f.photo.mockResolvedValueOnce({ ok: true, result: { contactPhoto: { status: 'unmatched', message: 'No single existing contact matched.' } } } as never); f.button.click(); await settle()
  expect(document.getElementById('photo-status')!.textContent).toBe('No single existing contact matched.')
})

it('keeps Stop disabled after following has actually stopped instead of re-enabling it in finally', async () => {
  const f = await fixture(); f.setFollowing(true)
  // Another explicit capture refreshes the current session status before the stop action.
  f.button.click(); await settle(); const stop = document.getElementById('stop') as HTMLButtonElement; expect(stop.disabled).toBe(false)
  stop.click(); await settle(); expect(stop.disabled).toBe(true)
  expect(document.getElementById('notice')!.textContent).toBe('Following stopped for this tab.')
})
it('offers only CRM photo capture on a Folk group and distinguishes diagnostic receipt from saved pictures', async () => {
  const f = await fixture('https://app.folk.app/apps/contacts/network/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/groups/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  expect(document.getElementById('folk-panel')!.hidden).toBe(false); expect(document.getElementById('profile-panel')!.hidden).toBe(true)
  for (const id of ['follow', 'highlight', 'profile']) expect((document.getElementById(id) as HTMLButtonElement).disabled).toBe(true)
  f.note.value = 'Unsent private note'; (document.getElementById('folk-photos') as HTMLButtonElement).click(); await settle()
  expect(f.send).toHaveBeenCalledWith({ type: 'reader-folk-photos', tabId: 7, token: '', note: 'Unsent private note' })
  expect(document.getElementById('folk-status')!.textContent).toBe('Visible rows retained privately. No photos changed.')
  expect(f.note.value).toBe('Unsent private note'); expect(document.getElementById('capture-help')!.textContent).toContain('separate from knowledge and reading')
})
it('shows the explicit Folk follow state and stops it through the shared Stop action', async () => {
  const f = await fixture('https://app.folk.app/apps/contacts/network/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/groups/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  const follow = document.getElementById('folk-follow') as HTMLButtonElement, stop = document.getElementById('stop') as HTMLButtonElement
  expect(follow.disabled).toBe(false); follow.click(); await settle()
  expect(f.send).toHaveBeenCalledWith({ type: 'reader-folk-follow', tabId: 7, token: '', note: '' })
  expect(document.getElementById('state')!.textContent).toBe('Following visible Folk photos · badge PH'); expect(follow.disabled).toBe(true); expect(stop.disabled).toBe(false)
  stop.click(); await settle(); expect(stop.disabled).toBe(true); expect(follow.disabled).toBe(false)
})

it('shows the actual Folk receipt after retry and clears its stale queued status', async () => {
  const f = await fixture('https://app.folk.app/apps/contacts/network/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/groups/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  f.folk.mockResolvedValueOnce({ ok: true, result: { queued: true } }); (document.getElementById('folk-photos') as HTMLButtonElement).click(); await settle()
  expect(document.getElementById('folk-status')!.textContent).toContain('queued')
  f.retry.mockResolvedValueOnce({ ok: true, result: { folkPhotos: { total: 5, saved: 3, kept: 2, unmatched: 0, unavailable: 0 } } }); (document.getElementById('retry') as HTMLButtonElement).click(); await settle()
  expect(document.getElementById('notice')!.textContent).toContain('3 photos saved · 2 existing photos kept'); expect(document.getElementById('folk-status')!.textContent).toContain('3 photos saved'); expect(document.getElementById('folk-status')!.textContent).not.toContain('queued'); expect(document.getElementById('queue')!.textContent).toBe('All captures delivered')
})

it('shows the actual contact-photo receipt after retry', async () => {
  const f = await fixture(); f.photo.mockResolvedValueOnce({ ok: true, result: { queued: true } }); f.button.click(); await settle()
  f.retry.mockResolvedValueOnce({ ok: true, result: { contactPhoto: { status: 'kept', name: 'Ada Example' } } }); (document.getElementById('retry') as HTMLButtonElement).click(); await settle()
  expect(document.getElementById('photo-status')!.textContent).toContain('Existing photo kept for Ada Example'); expect(document.getElementById('photo-status')!.textContent).not.toContain('queued')
})

it('keeps Search diagnostics separate from explicit matched photo actions and disables all article capture', async () => {
  const f = await fixture('https://app.folk.app/apps/contacts/network/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/search')
  expect(document.getElementById('folk-search-panel')!.hidden).toBe(false); expect(document.getElementById('folk-panel')!.hidden).toBe(true)
  for (const id of ['follow', 'highlight', 'profile', 'folk-follow', 'folk-photos']) expect((document.getElementById(id) as HTMLButtonElement).disabled).toBe(true)
  ;(document.getElementById('folk-search-diagnostic') as HTMLButtonElement).click(); await settle()
  expect(f.send).toHaveBeenCalledWith({ type: 'reader-folk-search-diagnostic', tabId: 7, token: '', note: '' }); expect(document.getElementById('folk-search-status')!.textContent).toContain('No photos changed')
  expect(document.getElementById('folk-search-capture-panel')!.hidden).toBe(false)
  f.folk.mockResolvedValueOnce({ ok: true, result: { folkPhotos: { total: 2, saved: 1, kept: 1, unmatched: 0, unavailable: 0 } } })
  ;(document.getElementById('folk-search-follow') as HTMLButtonElement).click(); await settle()
  expect(f.send).toHaveBeenCalledWith({ type: 'reader-folk-search-follow', tabId: 7, token: '', note: '' })
  expect(document.getElementById('folk-search-photo-status')!.textContent).toContain('1 photos saved · 1 existing photos kept')
  expect((document.getElementById('folk-search-follow') as HTMLButtonElement).disabled).toBe(true)
  ;(document.getElementById('stop') as HTMLButtonElement).click(); await settle()
  expect((document.getElementById('folk-search-follow') as HTMLButtonElement).disabled).toBe(false)
})
it('offers matched Search capture only for an unambiguous People result type', async () => {
  const base = 'https://app.folk.app/apps/contacts/network/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/search'
  for (const query of ['?type=company', '?type=unknown', '?type=person&type=company', '?Type=person']) {
    await fixture(base + query)
    expect(document.getElementById('folk-search-capture-panel')!.hidden).toBe(true)
    for (const id of ['folk-search-photos', 'folk-search-follow']) expect((document.getElementById(id) as HTMLButtonElement).disabled).toBe(true)
    expect((document.getElementById('folk-search-diagnostic') as HTMLButtonElement).disabled).toBe(false)
  }
  await fixture(base + '?type=person')
  expect((document.getElementById('folk-search-photos') as HTMLButtonElement).disabled).toBe(false)
})
