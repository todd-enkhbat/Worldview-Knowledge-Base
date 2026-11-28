import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { expect, it, vi } from 'vitest'

const token = `wvread_${'a'.repeat(43)}`, extensionId = 'a'.repeat(32)
const article = { url: 'https://www.linkedin.com/in/ada-example/', title: 'Ada Example | LinkedIn', text: 'Ada Example is a researcher.', profileImages: [{ url: 'https://media.licdn.com/ada.jpg', sourceUrl: 'https://www.linkedin.com/in/ada-example/', isProfile: true, subjectName: 'Ada Example', label: 'Visible profile photo' }], profileLinks: [] }
function area() { const values: Record<string, unknown> = {}; return { values, setAccessLevel: vi.fn(async () => {}), get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in values).map(key => [key, structuredClone(values[key])])), set: async (next: Record<string, unknown>) => { Object.assign(values, structuredClone(next)) }, remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key] } } }
function fixture(extracted: Record<string, unknown> = article, tabUrl = article.url) {
  const local = area(), session = area(), listeners: Record<string, (...args: unknown[]) => unknown> = {}
  const fetcher = vi.fn<typeof fetch>(async (_url, input) => { const payload = JSON.parse(String(input?.body)); return Response.json(payload.saveFolkPhotos ? { sequence: payload.sequence, originalAssetId: 'private-crm-original', folkPhotos: { total: payload.folkPhotoRows.length, saved: payload.folkPhotos.length, kept: 0, unmatched: 0, unavailable: 0, diagnostic: !payload.folkPhotos.length } } : { sourceId: 'source', versionId: 'version', sequence: payload.sequence, contactPhoto: { status: 'saved', personId: 'person_ada', avatarAssetId: 'crm-avatar-original', name: 'Ada Example' } }) })
  const tabState = { active: true, url: tabUrl }
  const chrome = { storage: { local, session }, runtime: { id: extensionId, getURL: (path: string) => `chrome-extension://${extensionId}/${path}`, onMessage: { addListener: (callback: (...args: unknown[]) => unknown) => { listeners.message = callback } } }, action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) }, tabs: { get: async () => tabState, sendMessage: vi.fn(async (tabId: number, message: { type: string }) => { if (message.type === 'folk-photos-status') { const entry = (session.values.folkTracked as Record<number, { nonce: string; url: string }> | undefined)?.[tabId]; return { ok: true, following: !!entry, nonce: entry?.nonce, url: entry?.url } } return { ok: true, progress: { fraction: .2, position: 100, activeMs: 500, following: false } } }), onRemoved: { addListener: (callback: (...args: unknown[]) => unknown) => { listeners.removed = callback } }, onUpdated: { addListener: (callback: (...args: unknown[]) => unknown) => { listeners.updated = callback } } }, scripting: { executeScript: vi.fn(async () => [{ result: extracted }]) } }
  new Script(readFileSync('extensions/worldview-reader/background.js', 'utf8').replace(/^import .*enki-bridge\.js.*$/m, '').replace(/^import .*application-form\.js.*$/m, 'const readApplicationForm = () => {}').replace(/^import .*$/m, 'const extractArticle = () => {}; const extractFolkPhotos = () => {}; const extractProfile = () => {}')).runInContext(createContext({ chrome, fetch: fetcher, AbortSignal, crypto, URL, TextEncoder, structuredClone, console }))
  const send = (message: Record<string, unknown>, sender: Record<string, unknown> = { id: extensionId, url: `chrome-extension://${extensionId}/popup.html` }) => new Promise<Record<string, unknown>>(resolve => listeners.message(message, sender, resolve))
  return { local, session, chrome, fetcher, send, tabState, listeners }
}

it('saves a photo only on its explicit popup action, retaining the source without starting reading or transmitting the comment', async () => {
  const f = fixture(); await f.send({ type: 'reader-pair', token })
  const response = await f.send({ type: 'reader-profile', tabId: 7, note: 'Private unfinished comment', token: 'not sent to the page' })
  expect(response).toMatchObject({ ok: true, result: { contactPhoto: { status: 'saved', personId: 'person_ada' } } })
  const payload = JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))
  expect(payload).toMatchObject({ saveContactPhoto: true, url: article.url, profileImages: article.profileImages, text: article.text })
  for (const field of ['progress', 'remark', 'selection', 'note', 'token']) expect(payload).not.toHaveProperty(field)
  expect(f.local.values.outbox).toEqual([]); expect(f.session.values.tracked).toBeUndefined()
  expect(f.chrome.tabs.sendMessage).not.toHaveBeenCalled(); expect(f.chrome.action.setBadgeText).not.toHaveBeenCalled()
  expect(f.chrome.scripting.executeScript).toHaveBeenCalledOnce()
  expect(JSON.stringify(response)).not.toContain(token)
})

it('retains an unconfirmed photo in the durable queue and retries the identical sequence', async () => {
  const f = fixture(); await f.send({ type: 'reader-pair', token })
  f.fetcher.mockImplementationOnce(async (_url, input) => { const payload = JSON.parse(String(input?.body)); return Response.json({ sourceId: 'source', versionId: 'version', sequence: payload.sequence }) })
  expect(await f.send({ type: 'reader-profile', tabId: 7 })).toMatchObject({ ok: true, result: { queued: true, message: expect.stringContaining('photo was not confirmed') } })
  expect(f.local.values.outbox).toHaveLength(1)
  const first = f.fetcher.mock.calls[0][1]?.body
  expect(await f.send({ type: 'reader-retry' })).toMatchObject({ ok: true, result: { contactPhoto: { status: 'saved' } } })
  expect(f.fetcher.mock.calls[1][1]?.body).toBe(first); expect(f.local.values.outbox).toEqual([])
})

it('clears terminal unmatched photo attempts only with a valid retained-source receipt and never claims a portrait', async () => {
  const f = fixture(); await f.send({ type: 'reader-pair', token })
  f.fetcher.mockImplementation(async (_url, input) => { const payload = JSON.parse(String(input?.body)); return Response.json({ sourceId: 'source', versionId: 'version', sequence: payload.sequence, contactPhoto: { status: 'unmatched', message: 'No single matching contact.' } }) })
  expect(await f.send({ type: 'reader-profile', tabId: 7 })).toMatchObject({ ok: true, result: { contactPhoto: { status: 'unmatched' } } })
  expect(f.local.values.outbox).toEqual([])
})

it('keeps captures pending when a successful HTTP response does not prove the exact source/version/sequence', async () => {
  const f = fixture(); await f.send({ type: 'reader-pair', token })
  f.fetcher.mockResolvedValue(Response.json({ sourceId: 'source', versionId: 'version', sequence: -1, contactPhoto: { status: 'saved' } }))
  expect(await f.send({ type: 'reader-profile', tabId: 7 })).toMatchObject({ ok: true, result: { queued: true, message: expect.stringContaining('receipt was incomplete') } })
  expect(f.local.values.outbox).toHaveLength(1); expect(f.local.values.lastDeliveryAt).toBeUndefined()
})

it('rejects a generic banner or a content-script request before creating a photo attempt', async () => {
  const f = fixture({ ...article, profileImages: [{ url: 'https://images.example/banner.jpg', isProfile: false }] }); await f.send({ type: 'reader-pair', token })
  expect(await f.send({ type: 'reader-profile', tabId: 7 })).toMatchObject({ ok: false, error: expect.stringContaining('No named profile photo') })
  expect(await f.send({ type: 'reader-profile', tabId: 7 }, { id: extensionId, url: article.url, tab: { id: 7 } })).toMatchObject({ ok: false })
  expect(f.fetcher).not.toHaveBeenCalled(); expect(f.local.values.outbox).toBeUndefined()
})

it('always clears following state and the badge when the final progress capture hits a full queue', async () => {
  const f = fixture(); await f.send({ type: 'reader-pair', token }); await f.send({ type: 'reader-follow', tabId: 7 })
  expect(f.session.values.tracked).toHaveProperty('7')
  await f.local.set({ outbox: Array.from({ length: 20 }, (_, sequence) => ({ sequence: sequence + 1, url: article.url, title: article.title })) })
  expect(await f.send({ type: 'reader-stop', tabId: 7 })).toMatchObject({ ok: false, error: expect.stringContaining('queue is full') })
  expect(f.session.values.tracked).toEqual({}); expect(f.local.values.outbox).toHaveLength(20)
  expect(f.chrome.action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 7, text: '' })
})

const folkUrl = 'https://app.folk.app/apps/contacts/network/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/groups/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const folkBatch = { url: folkUrl, title: 'Folk group', folkPhotos: [], folkPhotoRows: [{ photoUrl: 'https://photos.example/ada.jpg', name: 'Ada Example', attributes: {}, nearbyLinks: [], sourceUrl: folkUrl, groupId: 'grp_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }] }
it('retains visible Folk rows only through the explicit CRM-only payload and accepts a private CRM receipt', async () => {
  const f = fixture(folkBatch, folkUrl); await f.send({ type: 'reader-pair', token })
  f.fetcher.mockImplementation(async (_url, input) => { const payload = JSON.parse(String(input?.body)); return Response.json({ sequence: payload.sequence, originalAssetId: 'private-crm-original', folkPhotos: { total: 1, saved: 0, kept: 0, unmatched: 0, unavailable: 0, diagnostic: true, results: [] } }) })
  expect(await f.send({ type: 'reader-folk-photos', tabId: 7, note: 'Unsent private note' })).toMatchObject({ ok: true, result: { folkPhotos: { diagnostic: true } } })
  const payload = JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))
  expect(payload).toEqual({ ...folkBatch, saveFolkPhotos: true, sequence: expect.any(Number) })
  for (const field of ['text', 'remark', 'progress', 'note', 'selection']) expect(payload).not.toHaveProperty(field)
  expect(f.session.values.tracked).toBeUndefined(); expect(f.chrome.tabs.sendMessage).not.toHaveBeenCalled()
  expect(f.local.values.outbox).toEqual([])
})
it('keeps an unconfirmed Folk capture queued with the exact sequence for retry', async () => {
  const f = fixture(folkBatch, folkUrl); await f.send({ type: 'reader-pair', token })
  f.fetcher.mockImplementationOnce(async (_url, input) => Response.json({ sequence: JSON.parse(String(input?.body)).sequence, folkPhotos: { saved: 1 } }))
  expect(await f.send({ type: 'reader-folk-photos', tabId: 7 })).toMatchObject({ ok: true, result: { queued: true } })
  expect(f.local.values.outbox).toHaveLength(1); expect(f.local.values.lastDeliveryAt).toBeUndefined()
  const original = f.fetcher.mock.calls[0][1]?.body
  f.fetcher.mockImplementationOnce(async (_url, input) => Response.json({ sequence: JSON.parse(String(input?.body)).sequence, originalAssetId: 'private-crm-original', folkPhotos: { total: 1, saved: 0, kept: 0, unmatched: 0, unavailable: 0, diagnostic: true } }))
  expect(await f.send({ type: 'reader-retry' })).toMatchObject({ ok: true, result: { folkPhotos: { diagnostic: true } } })
  expect(f.fetcher.mock.calls[1][1]?.body).toBe(original); expect(f.local.values.outbox).toEqual([])
})
it('blocks Folk article capture and discards old Folk follow progress instead of sending it to knowledge', async () => {
  const f = fixture(folkBatch, folkUrl); await f.send({ type: 'reader-pair', token })
  for (const type of ['reader-follow', 'reader-highlight', 'reader-profile']) expect(await f.send({ type, tabId: 7 })).toMatchObject({ ok: false, error: expect.stringContaining('separate') })
  await f.session.set({ tracked: { 7: { url: folkUrl, title: 'Folk', nonce: 'old-nonce' } } })
  expect(await f.send({ type: 'reading-progress', nonce: 'old-nonce', url: folkUrl, progress: { activeMs: 100 } }, { id: extensionId, url: folkUrl, frameId: 0, tab: { id: 7 } })).toMatchObject({ ok: false, error: expect.stringContaining('tracking stopped') })
  expect(f.session.values.tracked).toEqual({})
  await f.session.set({ tracked: { 7: { url: folkUrl, title: 'Folk', nonce: 'old-nonce' } } })
  expect(await f.send({ type: 'reader-stop', tabId: 7 })).toMatchObject({ ok: true })
  expect(f.session.values.tracked).toEqual({}); expect(f.fetcher).not.toHaveBeenCalled()
})
it('follows only an explicitly chosen Folk group, deduplicates rendered rows and stops on request or navigation', async () => {
  const f = fixture(folkBatch, folkUrl); await f.send({ type: 'reader-pair', token })
  const sender = { id: extensionId, url: folkUrl, frameId: 0, tab: { id: 7 } }
  expect(await f.send({ type: 'reader-folk-follow', tabId: 7 })).toMatchObject({ ok: true })
  const tracked = (f.session.values.folkTracked as Record<number, { nonce: string; seen: string[] }>)[7]
  expect(tracked.seen).toHaveLength(1); expect(tracked.seen[0]).toMatch(/^[0-9a-f]{64}$/)
  expect(f.chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, files: ['folk-content.js'] })
  expect(f.chrome.action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 7, text: 'PH' })
  const changed = { type: 'folk-photos-changed', url: folkUrl, nonce: tracked.nonce }
  expect(await f.send(changed, sender)).toMatchObject({ ok: true, result: { unchanged: true } }); expect(f.fetcher).toHaveBeenCalledOnce()
  expect(await f.send({ ...changed, nonce: 'forged' }, sender)).toMatchObject({ ok: false })
  f.chrome.scripting.executeScript.mockResolvedValue([{ result: { ...folkBatch, folkPhotoRows: [...folkBatch.folkPhotoRows, { ...folkBatch.folkPhotoRows[0], photoUrl: 'https://photos.example/next.jpg', name: 'Next Person' }] } }])
  expect(await f.send(changed, sender)).toMatchObject({ ok: true }); expect(f.fetcher).toHaveBeenCalledTimes(2)
  const payload = JSON.parse(String(f.fetcher.mock.calls[1][1]?.body))
  expect(payload.folkPhotoRows).toHaveLength(1); expect(payload.folkPhotoRows[0].name).toBe('Next Person')
  expect(payload).not.toHaveProperty('text'); expect(payload).not.toHaveProperty('progress')
  await f.send({ type: 'reader-stop', tabId: 7 }); expect(f.session.values.folkTracked).toEqual({}); expect(f.chrome.action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 7, text: '' })
  await f.send({ type: 'reader-folk-follow', tabId: 7 }); f.listeners.updated(7, { url: `${folkUrl}/people/another` }); await f.send({ type: 'reader-status' })
  expect(f.session.values.folkTracked).toEqual({})
})
it('stops Folk following if its bounded durable queue fills, retaining all existing captures', async () => {
  const f = fixture(folkBatch, folkUrl); await f.send({ type: 'reader-pair', token }); await f.send({ type: 'reader-folk-follow', tabId: 7 })
  const entry = (f.session.values.folkTracked as Record<number, { nonce: string }>)[7]
  await f.local.set({ outbox: Array.from({ length: 20 }, (_, sequence) => ({ sequence: sequence + 1, saveFolkPhotos: true, url: folkUrl })) })
  f.chrome.scripting.executeScript.mockResolvedValue([{ result: { ...folkBatch, folkPhotoRows: [{ ...folkBatch.folkPhotoRows[0], photoUrl: 'https://photos.example/new.jpg' }] } }])
  expect(await f.send({ type: 'folk-photos-changed', url: folkUrl, nonce: entry.nonce }, { id: extensionId, url: folkUrl, frameId: 0, tab: { id: 7 } })).toMatchObject({ ok: false, error: expect.stringContaining('queue is full') })
  expect(f.local.values.outbox).toHaveLength(20); expect(f.session.values.folkTracked).toEqual({})
})
it('captures a loading diagnostic again when the exact same row later contains a verified loaded photo', async () => {
  const f = fixture(folkBatch, folkUrl); await f.send({ type: 'reader-pair', token }); await f.send({ type: 'reader-folk-follow', tabId: 7 })
  const entry = (f.session.values.folkTracked as Record<number, { nonce: string }>)[7]
  f.chrome.scripting.executeScript.mockResolvedValue([{ result: { ...folkBatch, folkPhotos: [{ ...folkBatch.folkPhotoRows[0], personId: 'per_df786886-4d08-4709-a230-fc0c8bca9ad8', sourceUrl: `${folkUrl}/people/df786886-4d08-4709-a230-fc0c8bca9ad8` }] } }])
  expect(await f.send({ type: 'folk-photos-changed', url: folkUrl, nonce: entry.nonce }, { id: extensionId, url: folkUrl, frameId: 0, tab: { id: 7 } })).toMatchObject({ ok: true, result: { folkPhotos: { saved: 1 } } })
  expect(f.fetcher).toHaveBeenCalledTimes(2)
  expect(JSON.parse(String(f.fetcher.mock.calls[1][1]?.body)).folkPhotos).toHaveLength(1)
})

it('captures only explicit Search diagnostics, forcing an empty writable list and never enabling its observer', async () => {
  const searchUrl = 'https://app.folk.app/apps/contacts/network/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/search', f = fixture({ ...folkBatch, url: searchUrl, folkPhotos: [{ personId: 'untrusted-writable-row' }] }, searchUrl)
  await f.send({ type: 'reader-pair', token })
  expect(await f.send({ type: 'reader-folk-follow', tabId: 7 })).toMatchObject({ ok: false, error: expect.stringContaining('separate matched Search') })
  expect(await f.send({ type: 'reader-folk-search-diagnostic', tabId: 7 })).toMatchObject({ ok: true, result: { folkPhotos: { diagnostic: true } } })
  expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))).toMatchObject({ url: searchUrl, saveFolkPhotos: true, folkPhotos: [], folkPhotoRows: folkBatch.folkPhotoRows })
  expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))).not.toHaveProperty('saveFolkSearchPhotos')
  expect(f.session.values.folkTracked).toBeUndefined(); expect(f.chrome.tabs.sendMessage).not.toHaveBeenCalled()
})
it('uses a separate explicit matched Search intent and preserves it when following new visible rows', async () => {
  const searchUrl = 'https://app.folk.app/apps/contacts/network/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/search'
  const batch = { ...folkBatch, url: searchUrl, folkPhotos: [{ personId: 'never-trust-client-person-id' }] }, f = fixture(batch, searchUrl)
  await f.send({ type: 'reader-pair', token }); await f.send({ type: 'reader-folk-search-follow', tabId: 7, note: 'Unsent comment' })
  const initial = JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))
  expect(initial).toMatchObject({ saveFolkPhotos: true, saveFolkSearchPhotos: true, folkPhotos: [], url: searchUrl })
  expect(initial).not.toHaveProperty('text'); expect(initial).not.toHaveProperty('remark'); expect(initial).not.toHaveProperty('progress')
  const entry = (f.session.values.folkTracked as Record<number, { nonce: string; searchPhotos: boolean }>)[7]
  expect(entry.searchPhotos).toBe(true)
  f.chrome.scripting.executeScript.mockResolvedValue([{ result: { ...batch, folkPhotoRows: [{ ...folkBatch.folkPhotoRows[0], photoUrl: 'https://photos.example/new-search-avatar.jpg' }] } }])
  expect(await f.send({ type: 'folk-photos-changed', nonce: entry.nonce, url: searchUrl }, { id: extensionId, frameId: 0, url: searchUrl, tab: { id: 7 } })).toMatchObject({ ok: true })
  expect(JSON.parse(String(f.fetcher.mock.calls[1][1]?.body))).toMatchObject({ saveFolkSearchPhotos: true, folkPhotos: [] })
  await f.send({ type: 'reader-stop', tabId: 7 }); expect(f.session.values.folkTracked).toEqual({})
  f.tabState.url = folkUrl; expect(await f.send({ type: 'reader-folk-search-photos', tabId: 7 })).toMatchObject({ ok: false })
})
it('rejects company, unknown and ambiguous Search result types before retaining a writable request', async () => {
  const base = folkUrl.replace(/\/groups\/[^/]+$/, '/search')
  for (const query of ['?type=company', '?type=unknown', '?type=', '?type=person&type=person', '?Type=person', '?type=person&TYPE=company']) {
    const url = base + query, f = fixture({ ...folkBatch, url }, url); await f.send({ type: 'reader-pair', token })
    expect(await f.send({ type: 'reader-folk-search-photos', tabId: 7 })).toMatchObject({ ok: false, error: expect.stringContaining('Choose People') })
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.local.values.outbox).toBeUndefined()
  }
  const url = base + '?type=person', f = fixture({ ...folkBatch, url }, url); await f.send({ type: 'reader-pair', token })
  expect(await f.send({ type: 'reader-folk-search-photos', tabId: 7 })).toMatchObject({ ok: true })
  expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))).toMatchObject({ saveFolkSearchPhotos: true })
})

it('accepts a stale Dia SPA sender URL only when the current chosen tab, top frame and nonce still match', async () => {
  const f = fixture(folkBatch, folkUrl); await f.send({ type: 'reader-pair', token }); await f.send({ type: 'reader-folk-follow', tabId: 7 })
  const entry = (f.session.values.folkTracked as Record<number, { nonce: string }>)[7], changed = { type: 'folk-photos-changed', url: folkUrl, nonce: entry.nonce }
  const sender = { id: extensionId, url: 'https://app.folk.app/earlier-spa-document', frameId: 0, tab: { id: 7 } }
  expect(await f.send(changed, sender)).toMatchObject({ ok: true, result: { unchanged: true } }); expect(f.session.values.folkTracked).toHaveProperty('7')
  expect(await f.send(changed, { ...sender, frameId: 1 })).toMatchObject({ ok: false }); expect(f.fetcher).toHaveBeenCalledOnce()
  f.tabState.url = folkUrl + '/people/another-person'
  expect(await f.send(changed, sender)).toMatchObject({ ok: false, error: expect.stringContaining('navigation') }); expect(f.session.values.folkTracked).toEqual({})
})

it('pauses an inactive followed tab and resumes it while explicit popup captures retain the active-tab requirement', async () => {
  const f = fixture(folkBatch, folkUrl); await f.send({ type: 'reader-pair', token }); await f.send({ type: 'reader-folk-follow', tabId: 7 })
  const entry = (f.session.values.folkTracked as Record<number, { nonce: string }>)[7], changed = { type: 'folk-photos-changed', url: folkUrl, nonce: entry.nonce }, sender = { id: extensionId, url: folkUrl, frameId: 0, tab: { id: 7 } }
  f.tabState.active = false; expect(await f.send(changed, sender)).toMatchObject({ ok: true, result: { paused: true } }); expect(f.session.values.folkTracked).toHaveProperty('7')
  expect(await f.send({ type: 'reader-folk-photos', tabId: 7 })).toMatchObject({ ok: false, error: expect.stringContaining('no longer active') }); expect(f.fetcher).toHaveBeenCalledOnce()
  f.tabState.active = true; expect(await f.send(changed, sender)).toMatchObject({ ok: true, result: { unchanged: true } })
})

it('clears stored following and PH when the observer reports a local stop or popup heartbeat finds a dead observer', async () => {
  const f = fixture(folkBatch, folkUrl); await f.send({ type: 'reader-pair', token }); await f.send({ type: 'reader-folk-follow', tabId: 7 })
  let entry = (f.session.values.folkTracked as Record<number, { nonce: string }>)[7]
  expect(await f.send({ type: 'folk-photos-stopped', url: folkUrl, nonce: entry.nonce, reason: 'Extension connection failed' }, { id: extensionId, url: 'https://app.folk.app/old-spa-url', frameId: 0, tab: { id: 7 } })).toMatchObject({ ok: true, stopped: true })
  expect(f.session.values.folkTracked).toEqual({}); expect(f.session.values.folkStopReason).toContain('Extension connection failed'); expect(f.chrome.action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 7, text: '' })
  await f.send({ type: 'reader-folk-follow', tabId: 7 }); entry = (f.session.values.folkTracked as Record<number, { nonce: string }>)[7]
  f.chrome.tabs.sendMessage.mockResolvedValueOnce({ ok: true, following: false, nonce: entry.nonce, url: folkUrl } as never)
  expect(await f.send({ type: 'reader-status', tabId: 7 })).toMatchObject({ folkTracked: {}, folkStopReason: expect.stringContaining('observer is no longer active') })
  expect(f.chrome.tabs.sendMessage).toHaveBeenCalledWith(7, { type: 'folk-photos-status', nonce: entry.nonce }, { frameId: 0 }); expect(f.chrome.action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 7, text: '' })
})

it('keeps a healthy same-URL observer through a loading notification and stops actual cross-group navigation', async () => {
  const f = fixture(folkBatch, folkUrl); await f.send({ type: 'reader-pair', token }); await f.send({ type: 'reader-folk-follow', tabId: 7 })
  f.listeners.updated(7, { status: 'loading' }); await f.send({ type: 'reader-status' }); expect(f.session.values.folkTracked).toHaveProperty('7')
  f.listeners.updated(7, { url: folkUrl + '/other-group' }); await f.send({ type: 'reader-status' }); expect(f.session.values.folkTracked).toEqual({}); expect(f.session.values.folkStopReason).toContain('group URL changed')
})
