import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'
import { extractProfile } from '../../extensions/worldview-reader/extract.js'
import { profileFromHtml } from '../../server/crmProfileExtract.ts'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options?: { url?: string }) => { window: { document: Document; close(): void } } }

function capture(body: string, url = 'https://www.linkedin.com/in/ada-example/') {
  const page = new JSDOM(`<!doctype html>${body.includes('<title>') ? '' : '<title>Profile source</title>'}${body}`, { url })
  try { return extractProfile(page.window.document) } finally { page.window.close() }
}

it('keeps two dated jobs at the same employer from a personal website in both capture paths', () => {
  const url = 'https://ada.example.org/about'
  const employer = { '@type': 'Organization', name: 'Example Studio', url: 'https://studio.example.org/', logo: '/studio-logo.png' }
  const schema = { '@type': 'Person', name: 'Ada Example', url, jobTitle: 'Design director', worksFor: [
    { '@type': 'EmployeeRole', roleName: 'Design director', startDate: '2021', description: 'Leads the design team.', worksFor: employer },
    { '@type': 'OrganizationRole', roleName: 'Designer', startDate: '2018', endDate: '2021', description: 'Designed the first release.', worksFor: employer },
  ] }
  const html = '<main><h1>Ada Example</h1><p>Design director at Example Studio</p></main><script type="application/ld+json">' + JSON.stringify(schema) + '</script>'
  for (const result of [capture(html, url), profileFromHtml(html, url)]) {
    expect(result.profile.affiliations).toHaveLength(2)
    expect(result.profile.affiliations?.[0]).toMatchObject({ organization: 'Example Studio', organizationUrl: employer.url, role: 'Design director', startDate: '2021', current: true, description: 'Leads the design team.' })
    expect(result.profile.affiliations?.[1]).toMatchObject({ organization: 'Example Studio', role: 'Designer', startDate: '2018', endDate: '2021', description: 'Designed the first release.' })
    expect(result.profile.affiliations?.[1]?.current).not.toBe(true)
  }
})

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
function worker(extracted: Omit<typeof profile, 'profile'> & { profile: Record<string, unknown>; headerEmployer?: { organization: string; additional: number } } = profile) {
  const local = area(), session = area(), listeners: Record<string, (...args: unknown[]) => unknown> = {}
  const tab = { active: true, url: extracted.url, status: 'complete' }, fetcher = vi.fn<typeof fetch>(async (_url, init) => { const payload = JSON.parse(String(init?.body)); return Response.json({ sequence: payload.sequence, profileDraft: { id: 'capture-ada', status: 'pending', profile: payload.profile, source: { originalAssetId: 'crm-file-original' } } }) })
  const chrome = { storage: { local, session }, runtime: { id: extensionId, getURL: (path: string) => `chrome-extension://${extensionId}/${path}`, onMessage: { addListener: (callback: (...args: unknown[]) => unknown) => { listeners.message = callback } } }, tabs: { get: async () => ({ ...tab }), update: vi.fn(async (_id: number, change: { url: string }) => { tab.url = change.url }), goBack: vi.fn(async () => { tab.url = extracted.url }), onRemoved: { addListener: (callback: (...args: unknown[]) => unknown) => { listeners.removed = callback } }, onUpdated: { addListener: (callback: (...args: unknown[]) => unknown) => { listeners.updated = callback } } }, scripting: { executeScript: vi.fn(async () => [{ result: extracted }]) } }
  const formScript=readFileSync('extensions/worldview-reader/application-form.js','utf8').replace(/^export /gm,'')
  const script = readFileSync('extensions/worldview-reader/background.js', 'utf8').replace(/^import .*enki-bridge\.js.*$/m, '').replace(/^import .*application-form\.js.*$/m, () => formScript).replace(/^import .*$/m, 'const extractArticle = () => {}; const extractFolkPhotos = () => {}; const extractProfile = () => {}; const captureLinkedInExperience = () => {}')
  new Script(script).runInContext(createContext({ chrome, fetch: fetcher, AbortSignal, crypto, URL, TextEncoder, structuredClone }))
  const send = (message: Record<string, unknown>, sender: Record<string, unknown> = { id: extensionId, url: `chrome-extension://${extensionId}/popup.html` }) => new Promise<Record<string, unknown>>(resolve => listeners.message(message, sender, resolve))
  return { local, session, fetcher, tab, chrome, send, listeners }
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

it('identifies a personal website using its named portrait and declared profile links', () => {
  const result = capture('<meta name="description" content="Designer in Cambridge."><main><h1>Ada Example</h1><img alt="Ada Example" src="/ada.jpg"><p>Designer.</p><a rel="me" href="https://www.instagram.com/ada/">Instagram</a></main>', 'https://ada.example/')
  expect(result.profile).toMatchObject({ name: 'Ada Example', description: 'Designer in Cambridge.', images: [expect.objectContaining({ url: 'https://ada.example/ada.jpg', isProfile: true })], urls: ['https://ada.example/', 'https://www.instagram.com/ada/'] })
})

it('opens a read-only preview and refuses to add a different subject if the page changes', async () => {
  const f = worker(); await f.send({ type: 'reader-pair', token })
  f.fetcher.mockResolvedValueOnce(Response.json({ groups: [{ id: 'founders', name: 'Founders' }] }))
  const preview = await f.send({ type: 'reader-profile-preview', tabId: 7 })
  expect(preview).toMatchObject({ preview: { name: 'Ada Example' }, groups: [{ id: 'founders' }] })
  expect(f.local.values.outbox).toBeUndefined()
  expect((await f.send({ type: 'reader-profile-add', tabId: 7, url: profile.url, name: 'Someone Else', entityType: 'person', groupId: 'founders' })).ok).toBe(false)
  expect(f.fetcher).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))).toEqual({ entityType: 'person', url: profile.url })
})

it('previews only a subject-bound public HTTPS photo, current role, distinct organizations and schools', async () => {
  const extracted = { ...profile, headerEmployer: { organization: 'Example Labs', additional: 3 }, profile: { ...profile.profile,
    headline: 'Scientist at Example Labs', location: 'Cambridge', affiliations: [
      { kind: 'employment', organization: 'Example Labs', current: true, role: 'Scientist' },
      { kind: 'employment', organization: 'Old Labs', role: 'Fellow' },
      { kind: 'education', organization: 'Example University' }, { kind: 'education', organization: 'Example University' },
    ], images: [
      { url: 'https://images.example/unrelated', isProfile: true, subjectName: 'Another Person' },
      { url: 'https://127.0.0.1/private', isProfile: true, subjectName: 'Ada Example' },
      { url: 'https://media.licdn.com/ada.jpg', isProfile: true, subjectName: 'Ada Example' },
    ],
  } }
  const f = worker(extracted); await f.send({ type: 'reader-pair', token })
  f.fetcher.mockResolvedValueOnce(Response.json({ groups: [] }))
  expect((await f.send({ type: 'reader-profile-preview', tabId: 7 })).preview).toEqual({ url: profile.url, name: 'Ada Example', entityType: 'person', headline: 'Scientist at Example Labs', location: 'Cambridge', role: 'Scientist', current: ['Example Labs + 3 more'], schools: ['Example University'], photoUrl: 'https://media.licdn.com/ada.jpg' })
})

it('remembers a group only upon confirmed quick-add delivery, including retry and saving without a group', async () => {
  const f = worker(); await f.send({ type: 'reader-pair', token })
  const add = { type: 'reader-profile-add', tabId: 7, url: profile.url, name: 'Ada Example', entityType: 'person' }
  const receipt = (status: string) => f.fetcher.mockImplementationOnce(async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    return Response.json({ sequence: body.sequence, profileDraft: { id: 'draft-ada', source: { originalAssetId: 'source' } }, quickAdd: { status, recordId: 'person-ada' } })
  })
  f.fetcher.mockRejectedValueOnce(new Error('offline'))
  await f.send({ ...add, groupId: 'founders' })
  expect(f.local.values['lastProfileGroup:person']).toBeUndefined()
  expect(f.local.values.outbox).toHaveLength(1)
  receipt('saved'); await f.send({ type: 'reader-retry' })
  expect(f.local.values['lastProfileGroup:person']).toBe('founders')
  expect(f.local.values.outbox).toEqual([])
  receipt('review'); await f.send({ ...add, groupId: 'review-needed' })
  expect(f.local.values['lastProfileGroup:person']).toBe('founders')
  receipt('saved'); await f.send(add)
  expect(f.local.values['lastProfileGroup:person']).toBe('')
  expect(f.local.values['lastProfileGroup:company']).toBeUndefined()
})

it('captures a dated top-level role when LinkedIn renders the logo link and description as nested items', () => {
  const result = capture('<main><h1>Ada Example</h1><section><h2>Experience</h2><ul><li><a href="/company/acme/"><img src="https://images.example/acme.png" alt="Acme logo"></a><div>Founder</div><div>Acme · Full-time</div><div>Jan 2020 – Present</div><ul><li><p>Building software with partners.</p></li></ul></li></ul></section></main>')
  expect(result.profile.affiliations).toEqual([expect.objectContaining({ organization: 'Acme', role: 'Founder', current: true, organizationLogoUrl: 'https://images.example/acme.png' })])
})

it('resolves a branded investment firm homepage from its title, domain and own LinkedIn link without capturing portfolio firms', () => {
  const html = '<title>8VC | A different kind of VC firm.</title><meta property="og:description" content="An investment firm"><link rel="apple-touch-icon" href="/webclip.png"><main><h1>Build a better world</h1><a href="https://www.linkedin.com/company/portfolio-example/">A portfolio firm</a></main><footer><a href="https://www.linkedin.com/company/8vc/">LinkedIn</a></footer>'
  expect(capture(html, 'https://www.8vc.com/').profile).toMatchObject({ name: '8VC', entityType: 'company', description: 'An investment firm', urls: ['https://www.8vc.com/', 'https://www.linkedin.com/company/8vc/'], images: [{ url: 'https://www.8vc.com/webclip.png', subjectName: '8VC', isProfile: true }] })
  const loading = capture(html.replace('<main>', '<main style="opacity:0">').replace('Build a better world', 'Unrendered private text'), 'https://www.8vc.com/')
  expect(loading.text).toContain('An investment firm')
  expect(loading.html).not.toContain('Unrendered private text')
  expect(() => capture(html, 'https://8vc.unrelated.example/')).toThrow('No single named')
  expect(() => capture(html.replace('/company/8vc/', '/company/unrelated/'), 'https://8vc.com/')).toThrow('No single named')
})

it('keeps preview stationary and captures the same person’s additional Experience rows, their source and the original profile', async () => {
  const url = 'https://www.linkedin.com/in/ada-example/', expanded = url + 'details/experience/?isSelfProfile=false'
  const extracted = { ...profile, url }
  const f = worker(extracted); await f.send({ type: 'reader-pair', token })
  f.fetcher.mockResolvedValueOnce(Response.json({ groups: [] }))
  await f.send({ type: 'reader-profile-preview', tabId: 7 })
  expect(f.chrome.scripting.executeScript).toHaveBeenCalledTimes(1)
  expect(f.chrome.tabs.update).not.toHaveBeenCalled()
  const job = { kind: 'employment', role: 'Scientist', organization: 'Example Lab', startDate: '2020', current: true }
  const old = { kind: 'employment', role: 'Fellow', organization: 'Example University', startDate: '2015', endDate: '2019' }
  f.chrome.scripting.executeScript.mockResolvedValueOnce([{ result: extracted }])
    .mockResolvedValueOnce([{ result: { roles: [job], continuation: expanded } }] as never)
    .mockResolvedValueOnce([{ result: { roles: [job, old] } }] as never)
  expect((await f.send({ type: 'reader-profile-data', tabId: 7 })).ok).toBe(true)
  expect(f.chrome.tabs.update).toHaveBeenCalledWith(7, { url: expanded })
  expect(f.chrome.tabs.goBack).toHaveBeenCalledWith(7)
  const sent = JSON.parse(String(f.fetcher.mock.calls.at(-1)?.[1]?.body))
  expect(sent).toMatchObject({ url, profile: { affiliations: [job, old] } })
  expect(sent.text).toContain(url + 'details/experience/')
  expect(sent.html).toContain('Fellow · Example University')
})

it('persists verified main-page roles when full Experience cannot load and aborts on a user’s different-profile navigation', async () => {
  const url = 'https://www.linkedin.com/in/ada-example/', continuation = url + 'details/experience/', extracted = { ...profile, url }
  const job = { kind: 'employment', role: 'Scientist', organization: 'Example Lab', startDate: '2020', current: true }
  const setup = async () => {
    const f = worker(extracted); await f.send({ type: 'reader-pair', token })
    f.chrome.scripting.executeScript.mockResolvedValueOnce([{ result: extracted }]).mockResolvedValueOnce([{ result: { roles: [job], continuation } }] as never)
    return f
  }
  const f = await setup()
  f.chrome.tabs.goBack.mockRejectedValueOnce(new Error('Cannot find a next page in history.'))
  f.chrome.scripting.executeScript.mockResolvedValueOnce([{ result: { roles: [] } }] as never)
  expect(await f.send({ type: 'reader-profile-data', tabId: 7 })).toMatchObject({ ok: true, result: { experienceNotice: expect.stringContaining('unavailable') } })
  expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body)).profile.affiliations).toEqual([job])
  expect(f.chrome.tabs.update).toHaveBeenLastCalledWith(7, { url })
  const moved = await setup()
  moved.chrome.scripting.executeScript.mockImplementationOnce(async () => { moved.tab.url = 'https://www.linkedin.com/in/different/'; return [{ result: { roles: [] } }] as never })
  expect((await moved.send({ type: 'reader-profile-data', tabId: 7 })).ok).toBe(false)
  expect(moved.chrome.tabs.goBack).not.toHaveBeenCalled()
  expect(moved.fetcher).not.toHaveBeenCalled()
})

it('binds university directory education to the named faculty member in Reader and URL collection', () => {
  const url = 'https://engineering.example.edu/people_individual/ren-park/'
  const publisher = { '@type': 'Organization', name: 'Department of Engineering', url }
  const body = '<title>Ren Park – Engineering</title><script type="application/ld+json">' + JSON.stringify(publisher) + '</script><nav>Directory links</nav><main><h1>People</h1><h2>Ren Park</h2><p>Assistant: <a href="mailto:assistant@example.edu">assistant@example.edu</a></p><h3>Education</h3><ul>' +
    '<li>Postdoctoral Scholar, 2004–2005; Unrelated Research Institute</li>' +
    '<li>Ph.D. (Dr. rer. nat.) 2004 in Materials Science (Chemistry), Example Institute for Metals Research at the University of Example</li>' +
    '<li>M.S. 2001 in Engineering Mechanics, Example Tech</li>' +
    '<li>B.S. equiv./pre-diploma 2000 in Chemical Engineering, University of Example</li>' +
    '<li>Ph.D. candidate 2028 in Chemistry, Other University</li></ul><h3>Related News</h3><p>Other faculty and publications</p></main><footer>Department contact</footer>'
  const expected = [
    { kind: 'education', degree: 'Ph.D. (Dr. rer. nat.)', field: 'Materials Science (Chemistry)', endDate: '2004', organization: 'University of Example', description: 'Example Institute for Metals Research' },
    { kind: 'education', degree: 'M.S.', field: 'Engineering Mechanics', endDate: '2001', organization: 'Example Tech' },
    { kind: 'education', degree: 'B.S. equiv./pre-diploma', field: 'Chemical Engineering', endDate: '2000', organization: 'University of Example' },
  ]
  for (const draft of [capture(body, url), profileFromHtml(body, url)]) {
    expect(draft.profile).toMatchObject({ name: 'Ren Park', entityType: 'person', urls: [url], affiliations: expected })
    expect(draft.profile.affiliations?.every(row => row.excerpt)).toBe(true)
    expect(draft.text).toContain('Example Institute for Metals Research')
    expect(JSON.stringify(draft)).not.toMatch(/assistant@|Department contact|faculty and publications|Unrelated Research Institute|Other University/)
  }
  const unbound = body.replace('<h2>Ren Park</h2>', '<h2>Someone Else</h2>')
  expect(() => capture(unbound, url)).toThrow('No single named')
  expect(() => profileFromHtml(unbound, url)).toThrow('No single verified')
})
function applicationWorker(){
  const f=worker(), documentId='top-doc'
  f.local.values.pairing={token,port:5173}
  const source=profile.url, applicationId='application-one'
  f.chrome.scripting.executeScript.mockResolvedValue([{documentId,frameId:0,result:{embeddedForms:[],answers:[{question:'Why apply?',answer:''}],armed:true}}] as never)
  const watch=()=>f.send({type:'reader-watch-application',tabId:7,applicationId,source,pageUrl:source,documentId,workspaceToken:'workspace'})
  const tracking=()=>(f.session.values.applicationTracking as Record<number,{nonce:string}>)[7]
  const sender={id:extensionId,tab:{id:7},frameId:0,documentId,url:source}
  const submit=()=>({type:'application-submitted',nonce:tracking().nonce,applicationId,source,form:{submitted:true,appliedAt:Date.now(),submissionEvidence:'Thank you for your application',answers:[]}})
  return {...f,watch,tracking,sender,submit}
}
it('binds submissions to the watched document and retries the queued confirmation after a failed delivery',async()=>{
  const f=applicationWorker(), tracked=await f.watch()
  expect(tracked).toMatchObject({ok:true})
  const confirmation=f.submit()
  expect(await f.send({...confirmation,nonce:'not-the-observer'},f.sender)).toMatchObject({ok:false,stopped:true})
  expect(await f.send(confirmation,{...f.sender,frameId:1,url:'https://tally.so/embed/form'})).toMatchObject({ok:false,stopped:true})
  expect(await f.send(confirmation,{...f.sender,documentId:'other-doc'})).toMatchObject({ok:false,stopped:true})
  expect(f.fetcher).not.toHaveBeenCalled()
  f.fetcher.mockRejectedValueOnce(new Error('The local server is offline'))
  expect(await f.send(confirmation,f.sender)).toMatchObject({ok:true,queued:true})
  expect(f.tracking()).toBeUndefined()
  const [endpoint,pending]=f.fetcher.mock.calls[0]
  expect(String(endpoint)).toContain('/application-submitted')
  const envelope=JSON.parse(String(pending?.body))
  expect(envelope.submissionId).toBe(confirmation.nonce)
  f.fetcher.mockResolvedValueOnce(Response.json({ok:true,id:envelope.applicationId,submissionId:envelope.submissionId,sequence:envelope.sequence,appliedAt:confirmation.form.appliedAt}))
  expect(await f.send({type:'reader-retry'})).toMatchObject({ok:true,result:{id:envelope.applicationId}})
  expect(f.fetcher.mock.calls[1][1]?.body).toBe(pending?.body)
  expect(f.local.values.outbox).toEqual([])
})

it('stops the selected application observer on a same-path query change or tab close',async()=>{
  const f=applicationWorker()
  expect(await f.watch()).toMatchObject({ok:true})
  const confirmation=f.submit()
  f.tab.url+='?step=unrelated'
  f.listeners.updated(7,{url:f.tab.url})
  expect(await f.send(confirmation,f.sender)).toMatchObject({ok:false,stopped:true})
  expect(f.chrome.scripting.executeScript).toHaveBeenLastCalledWith(expect.objectContaining({target:{tabId:7,documentIds:['top-doc']},args:[{stop:confirmation.nonce}]}))
  f.tab.url=profile.url
  expect(await f.watch()).toMatchObject({ok:true})
  const another=f.submit()
  f.listeners.removed(7)
  expect(await f.send(another,f.sender)).toMatchObject({ok:false,stopped:true})
  expect(f.tracking()).toBeUndefined()
  expect(f.fetcher).not.toHaveBeenCalled()
})
