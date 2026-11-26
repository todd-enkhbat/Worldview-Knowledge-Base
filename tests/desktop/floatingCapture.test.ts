import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'
import * as extract from '../../extensions/worldview-reader/extract.js'
import { educationStatus } from '../../src/crm/affiliationStatus.ts'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const { collect, snapshot, publicPage, experienceLink } = require('../../electron/profile-source.cjs')
const { preview } = require('../../electron/floating-capture.cjs')
const url = 'https://www.linkedin.com/in/ada-example/'
const detail = url + 'details/experience/?shown=true'
const ref = { id: '123', url }
const role = (title: string, dates: string) => `<div><a href="/company/1/"><p>${title}</p><p>Sample Institute</p><p>${dates}</p></a><p><span>Conducted academic research.</span></p></div>`
const education = '<section><h2>Education</h2><ul><li><a href="/school/2/">Sample College</a><p>BS, Mathematics</p><p>2010 – 2014</p></li></ul></section>'
function adapter() {
  let active = { ...ref }
  const pages: Record<string, string> = {
    [url]: `<main><section><h1>Ada Example</h1><p class="text-body-medium">Researcher</p><img alt="Ada Example" src="https://media.licdn.com/ada.jpg"></section><section><h2>Experience</h2>${role('Director','2020 – Present')}<a href="${detail}">Show all experiences</a></section>${education}</main>`,
    [detail]: `<main><p>Experience</p>${role('Director','2020 – Present')}${role('Research Fellow','2015 – 2019')}</main>`,
  }
  const identify = vi.fn(async () => ({ ...active }))
  const evaluate = vi.fn(async (target: typeof ref, script: string) => {
    if (target.url !== active.url) throw new Error('source changed')
    const dom = new JSDOM(pages[active.url], { url: active.url, runScripts: 'outside-only' })
    dom.window.TextEncoder = TextEncoder
    try { return await dom.window.eval(script) } finally { dom.window.close() }
  })
  return { identify, evaluate, visit: vi.fn(async (_from: typeof ref, next: string) => { active = { ...active, url: next } }), change: (next: typeof ref) => { active = next } }
}
it('previews the selected rendered tab, then reads the linked full history on explicit capture and returns to the original profile', async () => {
  const src = adapter()
  const p = await snapshot(src, ref, extract)
  expect(src.visit).not.toHaveBeenCalled()
  expect(preview(p, educationStatus)).toMatchObject({ name: 'Ada Example', url, schools: ['Sample College · Attended'], photo: 'https://media.licdn.com/ada.jpg' })
  const result = await collect(src, ref, extract, 'Ada Example')
  expect(result.notice).toBe('')
  expect(src.visit.mock.calls.map(c => c[1])).toEqual([detail, url])
  expect(result.data.profile.affiliations).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'Director', current: true, description: 'Conducted academic research.' }),
    expect.objectContaining({ role: 'Research Fellow', endDate: '2019' }),
    expect.objectContaining({ kind: 'education', organization: 'Sample College' }),
  ]))
  expect(result.data.text).toContain(url + 'details/experience/')
})
it('refuses a switched tab or changed identity and never follows another person’s continuation', async () => {
  const src = adapter()
  await expect(collect(src, ref, extract, 'Someone Else')).rejects.toThrow('changed')
  src.change({ id: '123', url: 'https://www.linkedin.com/in/other/' })
  await expect(snapshot(src, ref, extract)).rejects.toThrow('changed')
  expect(src.visit).not.toHaveBeenCalled()
  expect(experienceLink('https://www.linkedin.com/in/other/details/experience/', url)).toBeNull()
  for (const bad of ['file:///etc/hosts', 'http://127.0.0.1/', 'https://u:p@example.com/', 'https://work.local/']) expect(publicPage(bad)).toBeNull()
})
it('reads Education only from its named section and accepts the same-person Education continuation', async () => {
  const { captureEducation } = require('../../electron/profile-education.cjs')
  const end = url + 'details/education/'
  const page = new JSDOM(`<main><section><h2>Experience</h2><a href="/school/9/"><p>University Employer</p></a></section><section><h2>Education</h2><a href="/school/2/"><p>Sample College</p><p>BS, Mathematics</p><p>2012 – 2016</p></a><a href="${end}">Show all education</a></section><aside><a href="/school/7/"><p>Other school</p></a></aside></main>`, { url })
  try {
    const result = await captureEducation(url, false, page.window.document)
    expect(result.continuation).toBe(end)
    expect(result.roles).toEqual([expect.objectContaining({ kind: 'education', organization: 'Sample College', degree: 'BS', field: 'Mathematics', startDate: '2012', endDate: '2016' })])
    expect(educationStatus(result.roles[0])).toBe('attended')
    expect(experienceLink(end, url, 'education')).toBe(end)
    expect(experienceLink(end.replace('/ada-example/', '/someone-else/'), url, 'education')).toBeNull()
  } finally { page.window.close() }
})

it('binds native preview and save to the selected SQLite path and incarnation, and refuses an older server before saving', async () => {
  const { createFloatingCapture } = require('../../electron/floating-capture.cjs')
  const { createHash } = require('node:crypto')
  const { resolve } = require('node:path')
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  const windows: FixtureWindow[] = []
  const source = 'https://person.example/'
  const team = source + 'team'
  let teamHtml = '<main><article><a href="/team/ada">Ada Example</a><p class="person-title">Editor</p></article><article><a href="/team/ira">Ira Example</a><p class="person-title">Producer</p></article></main>'
  class FixtureWindow {
    location = ''
    constructor() { windows.push(this) }
    readonly webContents = {
      id: 71, mainFrame: { url: '' }, setWindowOpenHandler() {}, on() {}, getURL: () => this.location,
      executeJavaScriptInIsolatedWorld: async (_world: number, items: {code: string}[]) => {
        const dom = new JSDOM(this.location === team ? teamHtml : '<script type="application/ld+json">{"@type":"Person","name":"Sample Person","url":"https://person.example/"}</script><main><h1>Sample Person</h1><p>A researcher.</p></main>', { url: this.location, runScripts: 'outside-only' })
        dom.window.TextEncoder = TextEncoder
        try { return await dom.window.eval(items[0].code) } finally { dom.window.close() }
      },
    }
    on() {} once() {} setVisibleOnAllWorkspaces() {} show() {} focus() {} isDestroyed() { return false }
    async loadURL(address: string) { this.location = this.webContents.mainFrame.url = address }
  }
  const requests: { url: string; init: RequestInit }[] = []
  let upgraded = false
  vi.stubGlobal('fetch', async (address: string, init: RequestInit) => {
    requests.push({ url: address, init })
    if (address.endsWith('/visible-matches')) return Response.json({ matches: {}, workspaceToken:'original-incarnation' })
    if (address.includes('/groups?')) return Response.json({ groups: [{ id: 'g', name: 'Group' }], ...(upgraded ? { workspaceToken: 'original-incarnation', savedAffiliations: { companies: ['Existing Lab'], schools: [{organization:'Saved University',status:'attended'}] } } : {}) })
    return Response.json({ status: 'saved', recordId: 'person-one' })
  })
  try {
    const runtime = resolve('.'), ctx = { workspace: '/sample/workspace', origin: 'http://127.0.0.1:5173' }
    const loadRecord = vi.fn()
    const control = createFloatingCapture({ runtime, context: () => ctx, loadRecord, electron: { BrowserWindow: FixtureWindow, ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => { handlers[name] = handler } }, session: { fromPartition: () => ({ setPermissionCheckHandler() {}, setPermissionRequestHandler() {} }) } } })
    await control.show()
    const panel = windows[0].webContents
    const call = (name: string, ...args: unknown[]) => handlers['worldview:capture-' + name]({ sender: panel, senderFrame: panel.mainFrame }, ...args)
    await call('browser', source)
    expect(await call('read', 'browser')).toMatchObject({ error: expect.stringContaining('Restart the local') })
    expect(requests.every(request => request.init.method === 'GET')).toBe(true)
    upgraded = true
    const result = await call('read', 'browser') as {id: string}
    expect(result).toMatchObject({ profile: { companies:['Existing Lab'], savedCompanies:true, schools:['Saved University · Attended'], savedSchools:true } })
    expect(requests.at(-1)?.url).not.toContain('person.example')
    expect(await call('save', result.id,'g')).toMatchObject({ status: 'saved' })
    expect(requests.every(request => (request.init.headers as Record<string,string>)['x-wv-workspace-fingerprint'] === createHash('sha256').update(ctx.workspace).digest('hex'))).toBe(true)
    expect(JSON.parse(String(requests.at(-1)?.init.body))).toMatchObject({ workspaceToken: 'original-incarnation', groupId: 'g', url: source, profile: { affiliations: [] } })
    expect(String(requests.at(-1)?.init.body)).not.toContain('Existing Lab')
    expect(String(requests.at(-1)?.init.body)).not.toContain('Saved University')
    await call('browser', 'https://fellowship.example/apply')
    await call('record')
    expect(loadRecord).toHaveBeenCalledWith('#/people?person=person-one')
    await expect(call('save', result.id, '')).rejects.toThrow('changed')
    ctx.workspace = '/another/workspace'
    await expect(call('save', result.id,'g')).rejects.toThrow('workspace changed')
    expect(requests.filter(request => request.init.method === 'POST')).toHaveLength(1)
    ctx.workspace = '/sample/workspace'
    await call('browser', team)
    expect(await call('people', 'browser')).toMatchObject({ sourceUrl: team, people: [{ name:'Ada Example' }, { name:'Ira Example' }] })
    expect(await call('read', 'browser', source + 'team/absent')).toMatchObject({ error: expect.stringContaining('visible person') })
    const selected = await call('read', 'browser', source + 'team/ira') as { id:string }
    expect(selected).toMatchObject({ profile: { name:'Ira Example', headline:'Producer' } })
    expect(await call('save', selected.id, '')).toMatchObject({ status:'saved', existing:{recordId:'person-one',groupIds:[]} })
    const captured = JSON.parse(String(requests.at(-1)?.init.body))
    expect(captured).toMatchObject({ url:source + 'team/ira', profile:{name:'Ira Example'} })
    expect(captured.text).toContain(team)
    expect(JSON.stringify(captured)).not.toContain('Ada Example')
    await call('record', 'activity')
    expect(loadRecord).toHaveBeenLastCalledWith('#/people?person=person-one&action=log-interaction')
    teamHtml = teamHtml.replace('Ira Example', 'New Name')
    await expect(call('save', selected.id, 'g')).rejects.toThrow('changed')
    await call('browser', source)
    expect(await call('read', 'browser', source + 'team/ira')).toMatchObject({error:expect.stringContaining('changed')})
  } finally { vi.unstubAllGlobals() }
})

it('prefers freshly observed affiliations per field and labels only the fields filled from the saved record', async () => {
  const saved = { companies:['Example Institute'], schools:[{ organization:'Previously Saved School', status:'attended' }] }
  const p = preview({ url, profile:{ entityType:'person',name:'Ada Example',affiliations:[{kind:'education',organization:'Primary School',evidence:[]}] } }, educationStatus, saved)
  expect(p).toMatchObject({companies:['Example Institute'],savedCompanies:true,schools:['Primary School · Attended'],savedSchools:false})
})
