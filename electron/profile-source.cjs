const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { randomUUID } = require('node:crypto')
const { captureEducation } = require('./profile-education.cjs')
const run = promisify(execFile)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// All Apple Events address the front window's selected tab. The web renderer never
// receives this adapter or supplies scripts. Arguments travel as argv, never shell text.
const appleScript = `on run argv
  if application id "company.thebrowser.dia" is not running then error "Open Dia and select a profile first."
  tell application id "company.thebrowser.dia"
    if (count of windows) is 0 then error "Open a profile in Dia first."
    set t to active tab of front window
    set tabKey to id of t as text
    set tabURL to URL of t as text
    if item 1 of argv is "identify" then return tabKey & linefeed & tabURL
    if tabKey is not item 2 of argv or tabURL is not item 3 of argv then error "Dia's active tab changed. Read the selected profile again."
    if item 1 of argv is "visit" then
      set URL of t to item 4 of argv
      return "ok"
    end if
    return execute t javascript (item 4 of argv)
  end tell
end run`
function publicPage(value) {
  try {
    const u = new URL(value)
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) || /(?:^|\.)(?:localhost|local|internal|invalid)$/.test(u.hostname)) return null
    return u.href
  } catch { return null }
}
function pageKey(value) {
  const u = new URL(value)
  if (/(^|\.)linkedin\.com$/i.test(u.hostname) && /^\/(in|school|company)\//.test(u.pathname)) return u.origin + u.pathname.replace(/\/$/, '')
  u.hash = ''
  return u.href
}
function samePage(a, b) { try { return pageKey(a) === pageKey(b) } catch { return false } }
function experienceLink(value, sourceUrl, section = 'experience') {
  if (!['experience', 'education'].includes(section)) return null
  const href = publicPage(value), source = new URL(sourceUrl)
  if (!href || !/(^|\.)linkedin\.com$/i.test(source.hostname) || !/^\/in\/[^/]+\/?$/.test(source.pathname)) return null
  const u = new URL(href)
  return u.origin === source.origin && u.pathname.replace(/\/$/, '') === source.pathname.replace(/\/$/, '') + '/details/' + section ? href : null
}
async function apple(...args) {
  try { const { stdout } = await run('/usr/bin/osascript', ['-e', appleScript, ...args], { timeout: 18000, maxBuffer: 2 * 1024 * 1024 }); return stdout.trimEnd() }
  catch (error) {
    const message = String(error.stderr || '')
    if (/active tab changed/.test(message)) throw new Error('Dia’s active tab changed. Read the selected profile again.')
    if (/Open Dia|Open a profile/.test(message)) throw new Error('Open Dia and select a profile first.')
    if (/-1743|not authorized to send apple events/i.test(message)) throw new Error('macOS blocked access to Dia. Use the Worldview browser below, or allow Worldview to control Dia in System Settings → Privacy & Security → Automation.')
    if (/enable-applescript-javascript|javascript.*apple events|executing javascript.*disabled/i.test(message)) throw new Error('To save this profile inside Dia, click Worldview Reader in the Dia toolbar. Dia blocked desktop access to the page.')
    throw new Error('Worldview could not read the active Dia tab. Open the profile in the Worldview browser below.')
  }
}
async function diaIdentity() {
  const [id, url] = (await apple('identify')).split('\n')
  if (!id || !publicPage(url)) throw new Error('Select a public HTTPS profile in Dia.')
  return { id, url }
}
function assertSource(current, expected) {
  if (current.id !== expected.id || !samePage(current.url, expected.url)) throw new Error('The selected tab changed. Read the profile again.')
}
function diaSource() {
  const fixed = async (ref, command) => {
    const current = await diaIdentity(); assertSource(current, ref)
    return apple('read', current.id, current.url, command)
  }
  return {
    identify: diaIdentity,
    async evaluate(ref, code, asynchronous) {
      if (!asynchronous) return JSON.parse(await fixed(ref, 'JSON.stringify(' + code + ')'))
      // Dia's supported Apple Event returns text synchronously. Only this
      // explicit capture's short-lived result is polled, on the same selected tab.
      const marker = JSON.stringify('__worldview_' + randomUUID())
      await fixed(ref, `(() => {const k=${marker}, s={}; Object.defineProperty(globalThis,k,{value:s,configurable:true}); setTimeout(()=>{delete globalThis[k]},30000); Promise.resolve(${code}).then(v=>{s.value=v;s.done=true},()=>{s.failed=true;s.done=true});return 'started'})()`)
      try {
        for (let i = 0; i < 40; i++) {
          await delay(180)
          const state = JSON.parse(await fixed(ref, `JSON.stringify(globalThis[${marker}] || {failed:true,done:true})`))
          if (state.failed) throw new Error('Dia could not finish reading this profile section.')
          if (state.done) return state.value
        }
        throw new Error('The profile section took too long to load.')
      } finally { await fixed(ref, `delete globalThis[${marker}]`).catch(() => {}) }
    },
    async visit(ref, url) {
      const current = await diaIdentity(); assertSource(current, ref)
      await apple('visit', current.id, current.url, url)
    },
  }
}
function ownedSource(getWindow) {
  const contents = () => {
    const win = getWindow()
    if (!win || win.isDestroyed()) throw new Error('Open a profile in the Worldview browser first.')
    return win.webContents
  }
  const identify = async () => {
    const web = contents(), url = publicPage(web.getURL())
    if (!url) throw new Error('Open a public HTTPS profile in the Worldview browser.')
    return { id: String(web.id), url }
  }
  return {
    identify,
    async evaluate(ref, code) { assertSource(await identify(), ref); return contents().executeJavaScriptInIsolatedWorld(1001, [{ code }]) },
    async visit(ref, url) { assertSource(await identify(), ref); await contents().loadURL(url) },
  }
}
function script(fn, ...args) { return '(' + fn.toString() + ')(' + args.map(value => JSON.stringify(value)).join(',') + ')' }

async function snapshot(adapter, ref, extract) {
  assertSource(await adapter.identify(), ref)
  const data = adapter.readProfile ? await adapter.readProfile(ref) : await adapter.evaluate(ref, script(extract.extractProfile, null, true), false)
  assertSource(await adapter.identify(), ref)
  if (!data?.profile?.name || !samePage(data.url, ref.url)) throw new Error(data?.extractorError || 'Open one person’s profile or an organization page, then read it again.')
  return data
}
// Read only people actually presented in this tab. Detail captures use the
// selected card's own evidence, never a directory's full text or another card.
async function visibleProfiles(adapter, ref, extract, selectedUrl = '') {
  assertSource(await adapter.identify(), ref)
  const data = adapter.readPeople ? await adapter.readPeople(ref, selectedUrl) : await adapter.evaluate(ref, script(extract.extractVisiblePeople, null, selectedUrl), false)
  assertSource(await adapter.identify(), ref)
  if (data?.extractorError) throw new Error(data.extractorError)
  if (!samePage(selectedUrl ? data?.sourcePageUrl : data?.pageUrl, ref.url)) throw new Error('The visible page changed. Scan it again.')
  if (selectedUrl && (!data?.profile?.name || data.url !== selectedUrl || data.profile.entityType !== 'person')) throw new Error('This person is no longer visible. Scan the page again.')
  return data
}
async function waitFor(adapter, ref) {
  for (let i = 0; i < 45; i++) {
    const current = await adapter.identify()
    if (current.id !== ref.id) throw new Error('The selected tab changed. Read the profile again.')
    if (samePage(current.url, ref.url)) return
    await delay(150)
  }
  throw new Error('The browser did not finish opening the selected profile section.')
}
async function follow(adapter, ref, url, code) {
  const detail = { id: ref.id, url }
  try {
    await adapter.visit(ref, url); await waitFor(adapter, detail)
    const result = await adapter.evaluate(detail, code, true)
    if (!result?.roles?.length) throw new Error('The profile section was unavailable.')
    return result.roles
  } finally {
    const current = await adapter.identify()
    if (current.id === ref.id && samePage(current.url, url)) { await adapter.visit(detail, ref.url); await waitFor(adapter, ref) }
  }
}
function mergeEducation(data, source, rows = []) {
  const all = data.profile.affiliations ||= []
  for (const row of rows) {
    const same = all.filter(old => old.kind === 'education' && old.organization.toLowerCase() === row.organization.toLowerCase() && (!old.startDate || !row.startDate || old.startDate === row.startDate) && (!old.degree || !row.degree || old.degree === row.degree))
    if (same.length === 1) { const excerpt = [same[0].excerpt || '', row.excerpt || ''].sort((a,b) => b.length - a.length)[0]; Object.assign(same[0], row, { excerpt }) }
    else if (same.length === 0 && all.length < 60) all.push(row)
  }
  if (rows.length && source) {
    const evidence = ['Education · ' + pageKey(source) + '/', ...rows.map(r => r.excerpt || r.organization)].join('\n')
    data.text += '\n\n' + evidence
    data.html += '<section><h2>Captured education</h2><p>' + evidence.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</p></section>'
  }
}
async function visibleEducation(adapter, ref, data) {
  if (adapter.readProfile) return
  const url = new URL(ref.url)
  if (data.profile.entityType === 'person' && /(^|\.)linkedin\.com$/i.test(url.hostname) && /^\/in\/[^/]+\/?$/.test(url.pathname)) {
    const result = await adapter.evaluate(ref, script(captureEducation, ref.url, false), true)
    mergeEducation(data, '', result?.roles)
  }
}
function mergeExperience(data, sources) {
  const rows = [], evidence = [], norm = value => String(value || '').trim().toLowerCase()
  const sameRole = (a,b) => norm(a.role) === norm(b.role) && norm(a.organization) === norm(b.organization)
  for (const source of sources) {
    if (!source.roles?.length) continue
    evidence.push('Experience · ' + pageKey(source.url) + '/')
    for (const row of source.roles) {
      const old = rows.find(other => sameRole(row, other) && norm(row.startDate) === norm(other.startDate) && norm(row.endDate) === norm(other.endDate))
      if (old) Object.assign(old,row); else rows.push(row)
      evidence.push([row.role, row.organization, row.startDate + ' – ' + (row.endDate || 'Present')].join(' · '))
    }
  }
  if (!rows.length) return
  const others = (data.profile.affiliations || []).filter(old => old.kind !== 'employment' || !rows.some(row => sameRole(row, old) && (!old.startDate || norm(old.startDate) === norm(row.startDate)) && (!old.endDate || norm(old.endDate) === norm(row.endDate))))
  data.profile.affiliations = [...rows, ...others].slice(0,60)
  data.text += '\n\n' + evidence.join('\n')
  const escape = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  data.html += '<section><h2>Captured experience</h2>' + evidence.map(line=>'<p>'+escape(line)+'</p>').join('') + '</section>'
}
async function collect(adapter, ref, extract, expectedName) {
  if (adapter.collect) {
    assertSource(await adapter.identify(), ref)
    const result = await adapter.collect(ref, expectedName)
    assertSource(await adapter.identify(), ref)
    if (result?.data?.profile?.name !== expectedName || !samePage(result.data.url, ref.url)) throw Error('The profile changed. Press ]]] again.')
    return result
  }
  let data = await snapshot(adapter, ref, extract)
  if (data.profile.name !== expectedName) throw new Error('The person shown on this page changed. Read the profile again.')
  const page = new URL(ref.url), sources = []
  let notice = ''
  if (data.profile.entityType === 'person' && /(^|\.)linkedin\.com$/i.test(page.hostname) && /^\/in\/[^/]+\/?$/.test(page.pathname)) {
    const employer = data.headerEmployer?.organization || data.profile.affiliations?.find(row => row.kind === 'employment' && row.current)?.organization || ''
    const code = script(extract.captureLinkedInExperience, ref.url, employer)
    try {
      const main = await adapter.evaluate(ref, code, true)
      sources.push({ url: ref.url, roles: main?.roles })
      // Re-read the main page after lazy sections have been mounted. This keeps
      // available Education as well as Experience in the original source.
      data = await snapshot(adapter, ref, extract)
      if (data.profile.name !== expectedName) throw new Error('The selected profile changed.')
      const url = experienceLink(main?.continuation, ref.url)
      if (url) {
        sources.push({ url, roles: await follow(adapter, ref, url, code) })
      } else if (!main?.roles?.length) notice = 'Only the profile summary was available. Open Experience on the profile to capture additional roles.'
    } catch {
      assertSource(await adapter.identify(), ref)
      notice = 'Only the sections available on the main profile were captured.'
    }
    mergeExperience(data, sources)
    try {
      const schoolCode = script(captureEducation, ref.url, true)
      const main = await adapter.evaluate(ref, schoolCode, true)
      mergeEducation(data, ref.url, main?.roles)
      const url = experienceLink(main?.continuation, ref.url, 'education')
      if (url) mergeEducation(data, url, await follow(adapter, ref, url, schoolCode))
    } catch {
      assertSource(await adapter.identify(), ref)
      notice = [notice, 'The full Education section was unavailable.'].filter(Boolean).join(' ')
    }
    if (notice) data.text += '\n\n' + notice
  }
  assertSource(await adapter.identify(), ref)
  if (data.profile.name !== expectedName) throw new Error('The selected profile changed. Read the profile again.')
  return { data, notice }
}
module.exports = { publicPage, samePage, assertSource, diaSource, ownedSource, snapshot, visibleProfiles, visibleEducation, collect, mergeExperience, experienceLink }
