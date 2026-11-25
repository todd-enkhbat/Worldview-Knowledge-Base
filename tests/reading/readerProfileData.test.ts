import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'
import { extractProfile } from '../../extensions/worldview-reader/extract.js'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options?: { url?: string }) => { window: { document: Document; close(): void } } }

function capture(body: string, url = 'https://www.linkedin.com/in/ada-example/') {
  const page = new JSDOM(`<!doctype html><title>Profile source</title>${body}`, { url })
  try { return extractProfile(page.window.document) } finally { page.window.close() }
}

it('collects visible LinkedIn education and employment with source excerpts, excluding related people and form values', () => {
  const result = capture(`<main><section><h1>Ada Example</h1><div class="text-body-medium">Research engineer</div><span class="text-body-small inline t-black--light">New York, NY</span><img alt="Ada Example" src="https://images.example/ada.jpg"></section>
    <section><div id="education"></div><h2><span aria-hidden="true">Education</span><span class="visually-hidden">Education</span></h2><ul><li><a href="https://www.linkedin.com/school/columbia-university/"><span aria-hidden="true">Columbia University</span><span class="visually-hidden">Columbia University</span></a><div>Bachelor of Science, Computer Science</div><div>2016-2020</div></li></ul></section>
    <section><div id="experience"></div><h2>Experience</h2><ul><li><h3>Research engineer</h3><a href="https://www.linkedin.com/company/example-labs/">Example Labs</a><div>Jan 2021 – Present · 5 years</div></li></ul></section>
    <aside><h1>Grace Other</h1><a href="mailto:grace@example.com">Other email</a><section><h2>Education</h2><li>Other University</li></section></aside>
    <form><input value="private unfinished message"><textarea>private draft text</textarea></form><script>privateScriptSecret()</script><iframe src="https://tracker.example"></iframe></main>`)
  expect(result.profile).toMatchObject({ entityType: 'person', name: 'Ada Example', headline: 'Research engineer', location: 'New York, NY', emails: [] })
  expect(result.profile.affiliations).toEqual([
    expect.objectContaining({ kind: 'education', organization: 'Columbia University', degree: 'Bachelor of Science', field: 'Computer Science', startDate: '2016', endDate: '2020', organizationUrl: 'https://www.linkedin.com/school/columbia-university/' }),
    expect.objectContaining({ kind: 'employment', organization: 'Example Labs', role: 'Research engineer', startDate: 'Jan 2021', current: true, organizationUrl: 'https://www.linkedin.com/company/example-labs/' }),
  ])
  expect(result.profile.affiliations?.[0]).not.toHaveProperty('current')
  expect(result.profile.affiliations?.every(row => !!row.excerpt)).toBe(true)
  expect(result.html).toContain('Columbia University'); expect(result.text).toContain('Example Labs')
  for (const secret of ['Grace Other', 'private unfinished message', 'private draft text', 'privateScriptSecret', 'tracker.example']) expect(JSON.stringify(result)).not.toContain(secret)
  expect(result.html).not.toMatch(/<(?:script|iframe|form|input|textarea)\b/)
})

it('captures company details and canonical company URL from the People tab without assigning employee school aggregates', () => {
  const result = capture(`<main><section class="org-top-card"><h1>Marque Example</h1><p class="org-top-card-summary__tagline">Build useful things</p><img class="org-top-card-primary-content__logo" alt="Marque Example logo" src="https://images.example/logo.png"></section><section><h2>Overview</h2><p>Independent venture company.</p><dl><dt>Website</dt><dd><a href="https://marque.example/">marque.example</a></dd><dt>Industry</dt><dd>Venture capital</dd><dt>Headquarters</dt><dd>San Francisco, CA</dd></dl></section><section><h2>27 associated members</h2><h3>Where they studied</h3><p>4 | The Wharton School</p><p>2 | MIT</p></section></main>`, 'https://www.linkedin.com/company/marque-example/people/')
  expect(result.url).toBe('https://www.linkedin.com/company/marque-example/people/')
  expect(result.profile).toMatchObject({ entityType: 'company', name: 'Marque Example', industry: 'Venture capital', location: 'San Francisco, CA', description: 'Independent venture company.', affiliations: [] })
  expect(result.profile.urls).toEqual(['https://www.linkedin.com/company/marque-example/', 'https://marque.example/'])
  expect(result.text).toContain('The Wharton School'); expect(result.profile.images?.[0]).toMatchObject({ isProfile: true, subjectName: 'Marque Example' })
})

it('reads only the primary matching JSON-LD Person, preserving alumni, work and memberships separately', () => {
  const schema = { '@graph': [
    { '@type': 'Person', name: 'Ada Example', url: 'https://ada.example/', alumniOf: { '@type': 'CollegeOrUniversity', name: 'Columbia University', url: 'https://columbia.example/' }, worksFor: { name: 'Example Labs' }, memberOf: { name: 'Local Club' }, affiliation: { name: 'Research Society' }, jobTitle: 'Scientist', sameAs: ['https://www.linkedin.com/in/ada-example/'] },
    { '@type': 'Person', name: 'Unrelated Person', alumniOf: { name: 'Wrong University' }, email: 'wrong@example.com' },
  ] }
  const result = capture(`<script type="application/ld+json">${JSON.stringify(schema)}</script><main><h1>Ada Example</h1><p>Scientist and researcher.</p><a href="javascript:alert(1)" onclick="bad()">Safe text</a></main>`, 'https://ada.example/')
  expect(result.profile.affiliations?.map(row => [row.kind, row.organization])).toEqual([['education', 'Columbia University'], ['employment', 'Example Labs'], ['membership', 'Local Club'], ['membership', 'Research Society']])
  expect(result.profile.emails).toEqual([]); expect(JSON.stringify(result)).not.toContain('Wrong University'); expect(result.html).not.toMatch(/onclick|javascript:/)
})

it('recognizes a named generic profile with a named portrait and explicit education and experience sections', () => {
  const result = capture('<main><section><h1>Ada Example</h1><img alt="Ada Example" src="https://ada.example/photo.jpg"></section><section><h2>Education</h2><ul><li><p>Example University</p><p>BA, Philosophy</p></li></ul></section><section><h2>Work experience</h2><ul><li><h3>Writer</h3><p>Example Press</p><p>2020 – 2024</p></li></ul></section></main>', 'https://ada.example/about')
  expect(result.profile.entityType).toBe('person'); expect(result.profile.affiliations).toHaveLength(2)
})

it('refuses unbound articles, Folk pages and unnamed LinkedIn details pages', () => {
  expect(() => capture('<main><h1>An article about education</h1><p>Not a profile.</p></main>', 'https://news.example/story')).toThrow('No single named')
  expect(() => capture('<main><h1>Ada Example</h1></main>', 'https://app.folk.app/contacts')).toThrow('separate private')
  expect(() => capture('<main><h1>Education</h1></main>', 'https://www.linkedin.com/in/ada-example/details/education/')).toThrow('main LinkedIn profile')
})

const token = `wvread_${'a'.repeat(43)}`, extensionId = 'a'.repeat(32), profile = { url: 'https://ada.example/', title: 'Ada Example', text: 'Ada Example — Columbia University.', html: '<article><h1>Ada Example</h1></article>', profile: { entityType: 'person', name: 'Ada Example', affiliations: [] } }
function area() { const values: Record<string, unknown> = {}; return { values, setAccessLevel: vi.fn(async () => {}), get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in values).map(key => [key, structuredClone(values[key])])), set: async (next: Record<string, unknown>) => { Object.assign(values, structuredClone(next)) }, remove: async () => {} } }
function worker(extracted = profile) {
  const local = area(), session = area(), listeners: Record<string, (...args: unknown[]) => unknown> = {}
  const tab = { active: true, url: extracted.url }, fetcher = vi.fn<typeof fetch>(async (_url, init) => { const payload = JSON.parse(String(init?.body)); return Response.json({ sequence: payload.sequence, profileDraft: { id: 'capture-ada', status: 'pending', profile: payload.profile, source: { originalAssetId: 'crm-file-original' } } }) })
  const chrome = { storage: { local, session }, runtime: { id: extensionId, getURL: (path: string) => `chrome-extension://${extensionId}/${path}`, onMessage: { addListener: (callback: (...args: unknown[]) => unknown) => { listeners.message = callback } } }, tabs: { get: async () => ({ ...tab }), onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} } }, scripting: { executeScript: vi.fn(async () => [{ result: extracted }]) } }
  const script = readFileSync('extensions/worldview-reader/background.js', 'utf8').replace(/^import .*$/m, 'const extractArticle = () => {}; const extractFolkPhotos = () => {}; const extractProfile = () => {}')
  new Script(script).runInContext(createContext({ chrome, fetch: fetcher, AbortSignal, crypto, URL, TextEncoder, structuredClone }))
  const send = (message: Record<string, unknown>, sender: Record<string, unknown> = { id: extensionId, url: `chrome-extension://${extensionId}/popup.html` }) => new Promise<Record<string, unknown>>(resolve => listeners.message(message, sender, resolve))
  return { local, session, fetcher, tab, chrome, send }
}

it('queues only the explicit CRM profile intent, without reading progress or the unfinished popup comment', async () => {
  const f = worker(); await f.send({ type: 'reader-pair', token }); const response = await f.send({ type: 'reader-profile-data', tabId: 7, note: 'Unsent personal draft' })
  expect(response).toMatchObject({ ok: true, result: { profileDraft: { id: 'capture-ada' } }, openUrl: 'http://127.0.0.1:5173/#/people?capture=capture-ada' })
  const sent = JSON.parse(String(f.fetcher.mock.calls[0][1]?.body)); expect(sent).toMatchObject({ ...profile, saveProfileData: true })
  for (const field of ['progress', 'remark', 'selection', 'note', 'token']) expect(sent).not.toHaveProperty(field)
  expect(f.local.values.outbox).toEqual([]); expect(f.session.values.tracked).toBeUndefined()
  expect(await f.send({ type: 'reader-profile-data', tabId: 7 }, { id: extensionId, frameId: 0, url: profile.url, tab: { id: 7 } })).toMatchObject({ ok: false })
})

it('keeps an incomplete profile receipt queued and retries the exact original sequence', async () => {
  const f = worker(); await f.send({ type: 'reader-pair', token }); f.fetcher.mockImplementationOnce(async () => Response.json({ profileDraft: { id: 'capture-ada' } }))
  expect(await f.send({ type: 'reader-profile-data', tabId: 7 })).toMatchObject({ result: { queued: true, message: expect.stringContaining('not confirmed') } })
  expect(f.local.values.outbox).toHaveLength(1); const body = f.fetcher.mock.calls[0][1]?.body
  expect(await f.send({ type: 'reader-retry' })).toMatchObject({ result: { profileDraft: { id: 'capture-ada' } } }); expect(f.fetcher.mock.calls[1][1]?.body).toBe(body); expect(f.local.values.outbox).toEqual([])
})

it('rejects a combined snapshot over1MiB before storing an undeliverable outbox entry', async () => {
  const f = worker({ ...profile, text: 'x'.repeat(530_000), html: 'y'.repeat(530_000) }); await f.send({ type: 'reader-pair', token })
  expect(await f.send({ type: 'reader-profile-data', tabId: 7 })).toMatchObject({ ok: false, error: expect.stringContaining('1 MiB') }); expect(f.local.values.outbox).toBeUndefined(); expect(f.fetcher).not.toHaveBeenCalled()
})

it('accepts only benign LinkedIn trailing-slash normalization while rejecting a different-person navigation', async () => {
  const url = 'https://www.linkedin.com/in/ada-example/', extracted = { ...profile, url }, f = worker(extracted)
  f.tab.url = url.slice(0, -1); await f.send({ type: 'reader-pair', token })
  f.chrome.scripting.executeScript.mockImplementationOnce(async () => { f.tab.url = url; return [{ result: extracted }] })
  expect(await f.send({ type: 'reader-profile-data', tabId: 7 })).toMatchObject({ ok: true, result: { profileDraft: { id: 'capture-ada' } } })
  const other = worker(extracted); await other.send({ type: 'reader-pair', token })
  other.chrome.scripting.executeScript.mockImplementationOnce(async () => { other.tab.url = 'https://www.linkedin.com/in/someone-else/'; return [{ result: extracted }] })
  expect(await other.send({ type: 'reader-profile-data', tabId: 7 })).toMatchObject({ ok: false, error: expect.stringContaining('different profile') })
  expect(other.local.values.outbox).toBeUndefined(); expect(other.fetcher).not.toHaveBeenCalled()
})

it('forwards serialized extraction errors and treats a missing injection result as unreadable rather than a navigation', async () => {
  const f = worker(); await f.send({ type: 'reader-pair', token })
  f.chrome.scripting.executeScript.mockResolvedValueOnce([{ result: { extractorError: 'The profile name is not visible. Open the main profile.' } }] as never)
  expect(await f.send({ type: 'reader-profile-data', tabId: 7 })).toEqual({ ok: false, error: 'The profile name is not visible. Open the main profile.' })
  f.chrome.scripting.executeScript.mockResolvedValueOnce([{ result: undefined }] as never)
  expect(await f.send({ type: 'reader-profile-data', tabId: 7 })).toMatchObject({ ok: false, error: expect.stringContaining('could not identify') })
  expect(f.local.values.outbox).toBeUndefined(); expect(f.fetcher).not.toHaveBeenCalled()
})
