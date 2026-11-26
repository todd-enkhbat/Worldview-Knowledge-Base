import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
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
it('shows both affiliation labels even for a profile with empty fields and drives explicit controls through the limited bridge', async () => {
  const dom = new JSDOM(readFileSync('electron/capture-panel.html', 'utf8'), { runScripts: 'outside-only' })
  const p = preview({ url, profile: { entityType: 'person', name: 'Ada Example', affiliations: [] } }, educationStatus)
  expect(p).toMatchObject({ companies: [], schools: [] })
  const api = { read: vi.fn(async () => ({ id: 'chosen', profile: p, workspace: 'Example', groups: [{ id: 'founders', name: 'Founders', emoji: '🌱' }] })), save: vi.fn(async () => ({ status: 'saved' })) }
  dom.window.profileCapture = api
  try {
    dom.window.eval(readFileSync('electron/capture-panel.js', 'utf8'))
    expect(api.read).not.toHaveBeenCalled()
    const el = (id: string) => dom.window.document.getElementById(id)
    await el('read').onclick()
    expect(el('companies').textContent).toBe('Not shown'); expect(el('schools').textContent).toBe('Not shown')
    expect(el('group').textContent).toContain('🌱 Founders')
    el('group').value = 'founders'; await el('save').onclick()
    expect(api.save).toHaveBeenCalledWith('chosen', 'founders')
    expect(el('record').hidden).toBe(false)
  } finally { dom.window.close() }
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

it('starts as a compact explicit button and shows the business fields for an organization preview', async () => {
  const dom = new JSDOM(readFileSync('electron/capture-panel.html', 'utf8'), { runScripts: 'outside-only' })
  const p = preview({ url: 'https://www.linkedin.com/company/example/', profile: { entityType: 'company', name: 'Example', urls: ['https://www.linkedin.com/company/example/', 'https://example.com/'], industry: 'Software' } }, educationStatus)
  const api = { compact: vi.fn(async () => {}), read: vi.fn(async () => ({ id: 'company-preview', profile: p, groups: [], workspace: 'Sample' })) }
  dom.window.profileCapture = api
  try {
    dom.window.eval(readFileSync('electron/capture-panel.js', 'utf8'))
    expect(dom.window.document.querySelector('main').hidden).toBe(true)
    expect(api.read).not.toHaveBeenCalled()
    await dom.window.document.getElementById('expand').onclick()
    expect(api.compact).toHaveBeenCalledWith(false)
    expect(api.read).toHaveBeenCalledTimes(1)
    expect(api.read).toHaveBeenCalledWith('dia')
    expect(dom.window.document.getElementById('sources').open).toBe(false)
    expect(dom.window.document.getElementById('person-facts').hidden).toBe(true)
    expect(dom.window.document.getElementById('company-facts').hidden).toBe(false)
    expect(dom.window.document.getElementById('website').textContent).toBe('https://example.com/')
    expect(dom.window.document.getElementById('industry').textContent).toBe('Software')
  } finally { dom.window.close() }
})

it('binds native preview and save to the selected SQLite path and incarnation, and refuses an older server before saving', async () => {
  const { createFloatingCapture } = require('../../electron/floating-capture.cjs')
  const { createHash } = require('node:crypto')
  const { pathToFileURL } = require('node:url')
  const { resolve } = require('node:path')
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  const windows: FixtureWindow[] = []
  const source = 'https://person.example/'
  class FixtureWindow {
    location = ''
    constructor() { windows.push(this) }
    readonly webContents = {
      id: 71, mainFrame: { url: '' }, setWindowOpenHandler() {}, on() {}, getURL: () => this.location,
      executeJavaScriptInIsolatedWorld: async (_world: number, items: {code: string}[]) => {
        const dom = new JSDOM('<script type="application/ld+json">{"@type":"Person","name":"Sample Person","url":"https://person.example/"}</script><main><h1>Sample Person</h1><p>A researcher.</p></main>', { url: source, runScripts: 'outside-only' })
        dom.window.TextEncoder = TextEncoder
        try { return await dom.window.eval(items[0].code) } finally { dom.window.close() }
      },
    }
    on() {} once() {} setVisibleOnAllWorkspaces() {} show() {} isDestroyed() { return false }
    async loadFile(path: string) { this.webContents.mainFrame.url = pathToFileURL(path).href }
    async loadURL(address: string) { this.location = address }
  }
  const requests: { url: string; init: RequestInit }[] = []
  let upgraded = false
  vi.stubGlobal('fetch', async (address: string, init: RequestInit) => {
    requests.push({ url: address, init })
    if (address.includes('/groups?')) return Response.json({ groups: [{ id: 'g', name: 'Group' }], ...(upgraded ? { workspaceToken: 'original-incarnation', savedAffiliations: { companies: ['Existing Lab'], schools: [{organization:'Saved University',status:'attended'}] } } : {}) })
    return Response.json({ status: 'saved', recordId: 'person-one' })
  })
  try {
    const runtime = resolve('.'), ctx = { workspace: '/sample/workspace', origin: 'http://127.0.0.1:5173' }
    const control = createFloatingCapture({ runtime, context: () => ctx, loadRecord: vi.fn(), electron: { BrowserWindow: FixtureWindow, ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => { handlers[name] = handler } }, session: { fromPartition: () => ({ setPermissionCheckHandler() {}, setPermissionRequestHandler() {} }) } } })
    control.show()
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
    ctx.workspace = '/another/workspace'
    await expect(call('save', result.id,'g')).rejects.toThrow('workspace changed')
    expect(requests.filter(request => request.init.method === 'POST')).toHaveLength(1)
  } finally { vi.unstubAllGlobals() }
})

it('opens the local browser source directly from the pill without requesting Dia automation', async () => {
  const dom = new JSDOM(readFileSync('electron/capture-panel.html', 'utf8'), { runScripts: 'outside-only' })
  const api = { compact: vi.fn(async () => {}), read: vi.fn() }
  dom.window.profileCapture = api
  try {
    dom.window.eval(readFileSync('electron/capture-panel.js', 'utf8'))
    await dom.window.document.getElementById('choose-source').onclick()
    expect(api.read).not.toHaveBeenCalled()
    expect(dom.window.document.getElementById('source').value).toBe('browser')
    expect(dom.window.document.getElementById('browser-tools').hidden).toBe(false)
    expect(dom.window.document.activeElement.id).toBe('address')
  } finally { dom.window.close() }
})

it('prefers freshly observed affiliations per field and labels only the fields filled from the saved record', async () => {
  const saved = { companies:['Example Institute'], schools:[{ organization:'Previously Saved School', status:'attended' }] }
  const p = preview({ url, profile:{ entityType:'person',name:'Ada Example',affiliations:[{kind:'education',organization:'Primary School',evidence:[]}] } }, educationStatus, saved)
  expect(p).toMatchObject({companies:['Example Institute'],savedCompanies:true,schools:['Primary School · Attended'],savedSchools:false})
  const dom = new JSDOM(readFileSync('electron/capture-panel.html', 'utf8'), { runScripts:'outside-only' })
  dom.window.profileCapture = { read: async () => ({id:'a',profile:p,groups:[],workspace:'Example'}), compact: async () => {} }
  try {
    dom.window.eval(readFileSync('electron/capture-panel.js','utf8')); await dom.window.document.getElementById('expand').onclick(); await dom.window.document.getElementById('read').onclick()
    const company = dom.window.document.getElementById('companies-origin')
    expect(company.hidden).toBe(false); expect(company.textContent).toBe('From Worldview')
    expect(dom.window.document.getElementById('schools-origin').hidden).toBe(true)
  } finally { dom.window.close() }
})
