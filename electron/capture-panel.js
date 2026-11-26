const byId = id => document.getElementById(id)
const api = window.profileCapture
let previewId = '', busy = false, saved = false, canReadBrowser = false
const status = value => { byId('status').textContent = value || '' }
function reset() { previewId = ''; saved = false; byId('record').hidden = true; byId('preview').hidden = true; byId('photo').removeAttribute('src'); byId('browser-tools').hidden = byId('source').value !== 'browser'; status('') }
function addressLabel() { byId('open-browser').textContent = byId('address').value.trim() ? 'Open page' : 'Open LinkedIn' }
byId('address').oninput = addressLabel
if (typeof ResizeObserver === 'function') new ResizeObserver(() => {
  const main = document.querySelector('main')
  if (!main.hidden) void api.fit(main.offsetHeight + 32).catch(() => {})
}).observe(document.querySelector('main'))
function paintFacts(p) {
  const person = p.entityType === 'person'
  byId('person-facts').hidden = !person; byId('company-facts').hidden = person
  byId('companies').textContent = p.companies.join(', ') || 'Not shown'
  byId('schools').textContent = p.schools.join(', ') || 'Not shown'
  byId('companies-origin').hidden = !p.savedCompanies
  byId('schools-origin').hidden = !p.savedSchools
  byId('website').textContent = p.website || 'Not shown'
  byId('industry').textContent = p.industry || 'Not shown'
}
async function action(callback) {
  if (busy) return
  busy = true
  const controls = [...document.querySelectorAll('button,select,input')]
  for (const control of controls) control.disabled = true
  try { await callback() } catch (error) { status(String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')) }
  finally { busy = false; for (const control of controls) control.disabled = false; byId('save').disabled = saved }
}
async function read() {
  reset(); byId('sources').open = false; status('Reading the selected profile…')
  const result = await api.read(byId('source').value)
  if (result.error) {
    byId('address').value = result.sourceUrl || ''
    byId('sources').open = true; addressLabel(); byId('browser-tools').hidden = false; status(result.error); return
  }
  const p = result.profile
  previewId = result.id
  byId('name').textContent = p.name; byId('headline').textContent = p.headline
  byId('url').textContent = p.url; byId('address').value = p.url
  paintFacts(p)
  byId('photo').hidden = !p.photo; if (p.photo) byId('photo').src = p.photo
  byId('group').replaceChildren(new Option('No group', ''), ...result.groups.map(group => new Option([group.emoji, group.name].filter(Boolean).join(' '), group.id)))
  byId('preview').hidden = false; byId('browser-tools').hidden = true; saveLabel(); status(result.workspace)
}
byId('photo').onerror = () => { byId('photo').hidden = true }
function saveLabel() {
  const group = byId('group')
  byId('save').textContent = group.value ? 'Add to ' + group.selectedOptions[0].textContent : 'Add to Worldview'
}
byId('group').onchange = saveLabel
byId('source').onchange = () => { reset(); if (byId('source').value === 'dia') void action(read) }
byId('read').onclick = () => action(read)
byId('browser-tools').onsubmit = event => {
  event.preventDefault()
  void action(async () => {
    reset(); const target = byId('address').value.trim() || 'https://www.linkedin.com/'
    await api.openBrowser(target); canReadBrowser = true; byId('source').value = 'browser'; byId('browser-tools').hidden = false
    status('Browse to a profile, then click Read profile here.')
  })
}
byId('save').onclick = () => action(async () => {
  status('Reading available profile sections and saving…')
  const result = await api.save(previewId, byId('group').value)
  if (result.profile) paintFacts(result.profile)
  saved = true; byId('save').textContent = result.status === 'saved' ? 'Saved' : 'Captured'
  status([result.status === 'saved' ? 'Saved to Worldview.' : result.message || 'Ready to review in Worldview.', result.notice].filter(Boolean).join(' '))
  byId('record').hidden = false
})
byId('record').onclick = () => action(() => api.openRecord())
byId('collapse').onclick = () => action(async () => { await api.compact(true); document.body.classList.add('compact'); document.querySelector('main').hidden = true; byId('pill').hidden = false })
async function expand() { await api.compact(false); document.body.classList.remove('compact'); byId('pill').hidden = true; document.querySelector('main').hidden = false }
byId('expand').onclick = () => action(async () => {
  await expand()
  if (byId('source').value === 'dia' || canReadBrowser) await read()
  else byId('address').focus()
})
byId('choose-source').onclick = async () => {
  await action(async () => {
    await expand(); byId('sources').open = true; byId('source').value = 'browser'; reset()
  })
  byId('address').focus()
}
for (const button of document.querySelectorAll('.dismiss')) button.onclick = () => api.close()

for (const mode of ['word','application']) byId(mode).onclick = () => action(() => api.mode(mode))

window.addEventListener('keydown',event=>{if(event.key==='Escape')void api.close()})
