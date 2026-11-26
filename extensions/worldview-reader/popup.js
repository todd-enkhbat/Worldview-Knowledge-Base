/* global chrome */
import { readApplicationForm } from './application-form.js'
import { groupDisplay } from './group-icon.js'
const element = (id) => document.getElementById(id)
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
const folkGroupPage = /^https:\/\/app\.folk\.app\/apps\/contacts\/network\/[0-9a-f-]{36}\/groups\/[0-9a-f-]{36}(?:[/?#]|$)/i.test(tab?.url || '')
const folkAppPage = /^https?:\/\/app\.folk\.app(?:[/:?#]|$)/i.test(tab?.url || '')
const folkSearchPage = /^https:\/\/app\.folk\.app\/apps\/contacts\/network\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/search(?:[?#]|$)/i.test(tab?.url || '')
const folkSearchTypes = folkSearchPage ? [...new URL(tab.url).searchParams].filter(([key]) => key.toLowerCase() === 'type') : []
const folkPersonSearchPage = folkSearchPage && (!folkSearchTypes.length || folkSearchTypes.length === 1 && folkSearchTypes[0][0] === 'type' && folkSearchTypes[0][1] === 'person')
let workspacePort = 5173
const workspaceOrigin = () => 'http://127.0.0.1:' + workspacePort
let paired = false, following = false, followingFolk = false
const submitting = new Set()
let preview = null, previewStarted = false, toolsInitialized = false
let groups = [], selectedGroupId = '', visibleGroups = [], activeIndex = -1
let lastQueuedGroup = null, existing = null
const keyText = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const selectedGroup = () => groups.find(group => group.id === selectedGroupId)
const groupPreference = () => `lastProfileGroup:${preview.entityType}`
function groupParts(group) {
  if (group.id) return groupDisplay(group)
  return preview?.entityType === 'company' ? { icon: '🏢', name: 'All companies' } : { icon: '👥', name: 'All contacts' }
}
function saveState(value) {
  element('quick-panel').dataset.saveState = value
  element('quick-status').dataset.state = value
}

function publicPhoto(raw) {
  try {
    const src = new URL(raw)
    const host = src.hostname.toLowerCase().replace(/\.$/, '')
    if (!['http:', 'https:'].includes(src.protocol) || src.username || src.password || src.port || !host.includes('.') ||
        /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(host) || host.endsWith('.home.arpa') || host.includes(':') || /^[\d.]+$/.test(host)) return ''
    return src.href
  } catch { return '' }
}
function setText(id, value) {
  const node = element(id)
  node.textContent = value
  node.hidden = !value
}
function showAvatar() {
  const image = element('profile-avatar'), initials = element('profile-initials')
  const names = preview.name.trim().split(/\s+/)
  initials.textContent = [names[0], ...(names.length > 1 ? names.slice(-1) : [])].map(word => [...word][0] || '').join('').toLocaleUpperCase()
  initials.hidden = false; image.hidden = true
  image.onload = () => { if (image.naturalWidth) { initials.hidden = true; image.hidden = false } }
  image.onerror = () => { image.hidden = true; initials.hidden = false }
  image.referrerPolicy = 'no-referrer'
  image.removeAttribute('src')
  const url = publicPhoto(preview.photoUrl)
  if (url) image.src = url
}
function showProfile() {
  element('quick-panel').dataset.entity = preview.entityType
  element('profile-name').textContent = preview.name
  setText('profile-kind', existing ? 'Already in your CRM' : preview.entityType === 'person' ? 'Save contact' : 'Save company')
  const used = [preview.name, preview.entityType]
  function distinct(values) {
    const output = []
    for (const value of values) {
      if (typeof value !== 'string' || !value.trim()) continue
      const key = keyText(value)
      if (!key || used.some(text => (' ' + keyText(text) + ' ').includes(' ' + key + ' '))) continue
      output.push(value.trim()); used.push(value)
    }
    return output
  }
  setText('profile-summary', distinct([preview.headline, preview.role]).join(' · '))
  setText('profile-affiliations', distinct([...(preview.current || []), ...(preview.schools || [])]).join(' · '))
  setText('profile-location', distinct([preview.location]).join(' · '))
  showAvatar()
  element('quick-panel').hidden = false
  element('capture-help').hidden = true
  document.body.classList.add('has-profile')
}
function updateSelection() {
  const group = selectedGroup()
  if (!group) return
  const { icon, name } = groupParts(group)
  element('group-selected-icon').textContent = icon
  element('group-selected-name').textContent = name
  element('profile-group').setAttribute('aria-label', `Choose group, currently ${name}`)
  element('quick-add').textContent = existing && (!group.id || existing.groupIds.includes(group.id)) ? 'Open saved record' : group.id ? `Add to ${name}` : 'Add to Worldview'
}
function closePicker(restoreFocus = false) {
  element('group-popover').hidden = true
  element('profile-group').setAttribute('aria-expanded', 'false')
  element('group-search').removeAttribute('aria-activedescendant')
  if (restoreFocus) element('profile-group').focus()
}
function chooseGroup(group) {
  selectedGroupId = group.id
  updateSelection()
  element('quick-status').textContent = ''
  saveState('idle'); captureControls()
  closePicker(true)
}
function activateOption(index, scroll = false) {
  activeIndex = index
  const items = element('group-options').children
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle('is-active', i === index)
  }
  const item = items[index]
  if (item) {
    element('group-search').setAttribute('aria-activedescendant', item.id)
    if (scroll) item.scrollIntoView?.({ block: 'nearest' })
  } else element('group-search').removeAttribute('aria-activedescendant')
}
function renderOptions() {
  const query = keyText(element('group-search').value)
  visibleGroups = groups.filter(group => {
    if (!group.id && /(?:no group|ungrouped)/i.test(query)) return true
    const { name, icon } = groupParts(group)
    return query ? keyText(name).includes(query) : (icon + name).includes(element('group-search').value.trim())
  })
  const options = visibleGroups.map((group, index) => {
    const option = document.createElement('button'), icon = document.createElement('span'), name = document.createElement('span')
    const parts = groupParts(group)
    option.type = 'button'; option.tabIndex = -1; option.className = 'group-option'; option.id = `group-option-${index}`
    option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(group.id === selectedGroupId))
    icon.className = 'group-option-icon'; icon.textContent = parts.icon; icon.setAttribute('aria-hidden', 'true')
    name.className = 'group-option-name'; name.textContent = parts.name
    option.append(icon, name)
    option.addEventListener('click', () => chooseGroup(group))
    option.addEventListener('pointermove', () => activateOption(index))
    return option
  })
  element('group-options').replaceChildren(...options)
  element('group-empty').hidden = !!options.length
  const chosen = visibleGroups.findIndex(group => group.id === selectedGroupId)
  activateOption(chosen >= 0 ? chosen : options.length ? 0 : -1)
}
function openPicker() {
  if (!preview || submitting.has('quick-add')) return
  element('group-popover').hidden = false
  element('profile-group').setAttribute('aria-expanded', 'true')
  element('group-search').value = ''
  renderOptions()
  element('group-search').focus()
}
element('profile-group').addEventListener('click', () => element('group-popover').hidden ? openPicker() : closePicker(true))
element('profile-group').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openPicker() }
})
element('group-search').addEventListener('input', renderOptions)
element('group-picker').addEventListener('keydown', event => {
  if (element('group-popover').hidden) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePicker(true); return }
  if (event.target !== element('group-search')) return
  if (event.key === 'Tab') { closePicker(); element('profile-group').focus(); return }
  if (event.key === 'Enter') { event.preventDefault(); if (visibleGroups[activeIndex]) chooseGroup(visibleGroups[activeIndex]); return }
  const size = visibleGroups.length
  if (size && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault(); activateOption((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + size) % size, true)
  }
})
document.addEventListener('click', event => {
  if (!element('group-picker').contains(event.target) && !element('group-popover').hidden) closePicker()
})
element('group-picker').addEventListener('focusout', event => {
  if (event.relatedTarget && !element('group-picker').contains(event.relatedTarget) && !element('group-popover').hidden) closePicker()
})

async function loadPreview() {
  if (previewStarted || !paired || folkAppPage || !/^https?:\/\//.test(tab?.url || '')) return
  previewStarted = true
  try {
    const result = await send('reader-profile-preview')
    if (!result?.preview || !Array.isArray(result.groups)) return
    // An unpacked popup can update while Dia still has the previous worker loaded.
    if (!('existing' in result)) {
      const config = (await chrome.storage?.local?.get('pairing'))?.pairing
      if (config?.token) {
        const response = await fetch(workspaceOrigin() + '/api/reading-capture/profile-groups', {
          method: 'POST', credentials: 'omit', redirect: 'error',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.token },
          body: JSON.stringify({entityType: result.preview.entityType, url: result.preview.url}),
          signal: AbortSignal.timeout(5000)
        })
        if (!response.ok) throw Error('Could not check this profile in Worldview. Reopen the reader to retry.')
        Object.assign(result, await response.json())
      }
    }
    preview = result.preview
    groups = [{ id: '', name: '' }, ...result.groups.filter(group => typeof group?.id === 'string' && group.id && typeof group.name === 'string')]
    const key = groupPreference()
    const preferences = await chrome.storage?.local?.get(key).catch(() => ({}))
    selectedGroupId = groups.some(group => group.id === preferences?.[key]) ? preferences[key] : ''
    existing = result.existing || null
    if (existing) {
      selectedGroupId = existing.groupIds.find(id => groups.some(g => g.id === id)) || selectedGroupId
      showRecord(existing.recordId, result.workspaceFingerprint)
    }
    updateSelection(); showProfile(); toolsInitialized = false
    captureControls()
  } catch (error) {
    if (/linkedin\.com\/(in|company|school)\//i.test(tab.url)) element('error').textContent = error.message
  }
}
async function confirmSave(receipt, group) {
  const { recordId, image } = receipt.quickAdd
  if (typeof recordId !== 'string' || !recordId.trim()) throw new Error('Worldview did not return the saved CRM record.')
  const text = group.id ? 'to ' + groupParts(group).name : 'in Worldview'
  element('quick-status').textContent = [
    `${preview.name} saved ${text}.`,
    image === 'unavailable' && 'The profile image could not be downloaded.',
    receipt.experienceNotice,
  ].filter(Boolean).join(' ')
  saveState('saved')
  existing = { recordId, groupIds: [...new Set([...(existing?.groupIds || []), group.id].filter(Boolean))] }
  setText('profile-kind', 'Already in your CRM')
  showRecord(recordId, receipt.workspaceFingerprint)
  lastQueuedGroup = null
  await chrome.storage?.local?.set({ [groupPreference()]: group.id }).catch(() => {})
}
function showRecord(recordId, fingerprint) {
  const link = element('open-record')
  const param = preview.entityType === 'company' ? 'tab=companies&company' : 'person'
  link.href = `${workspaceOrigin()}/#/people?${param}=${encodeURIComponent(recordId)}`
  link.textContent = preview.entityType === 'company' ? 'Open company in Worldview' : 'Open contact in Worldview'
  link.hidden = false
  const mac = element('open-desktop-record')
  mac.hidden = !/^[a-f0-9]{64}$/.test(fingerprint || '')
  if (!mac.hidden) {
    const kind = preview.entityType === 'company' ? 'company' : 'person'
    mac.href = `worldview-local://record/${kind}/${encodeURIComponent(recordId)}?workspace=${fingerprint}`
    link.textContent = 'View in browser'
  }
  const log = element('log-interaction')
  log.hidden = preview.entityType !== 'person'
  log.href = link.href + '&action=log-interaction'
}
element('log-interaction').addEventListener('click', event => {
  event.preventDefault()
  void openWorldview(element('log-interaction').href).catch(error => { element('quick-status').textContent = error.message })
})
element('open-record').addEventListener('click', event => {
  event.preventDefault()
  if (!element('open-record').hidden) void openWorldview(element('open-record').href).catch(error => { element('quick-status').textContent = error.message })
})
element('quick-add').addEventListener('click', async () => {
  if (!preview || submitting.has('quick-add') || !selectedGroup()) return
  if (existing && (!selectedGroupId || existing.groupIds.includes(selectedGroupId))) {
    await openWorldview(element('open-record').href).catch(error => { element('quick-status').textContent = error.message })
    return
  }
  submitting.add('quick-add'); closePicker(); captureControls()
  const group = selectedGroup(), status = element('quick-status')
  if (!existing) { element('open-record').hidden = true; element('open-desktop-record').hidden = true }
  saveState('working')
  status.textContent = 'Saving…'
  try {
    const { result } = await send('reader-profile-add', { url: preview.url, name: preview.name, entityType: preview.entityType, groupId: group.id })
    if (result?.queued) {
      lastQueuedGroup = group
      saveState('pending'); status.textContent = `Queued on this browser. ${result.message || 'It will sync when your local workspace is available.'}`
    } else if (result?.quickAdd?.status === 'review' && result.profileDraft?.id) {
      saveState('review'); status.textContent = result.quickAdd.message || 'Review the matching records in Worldview.'
      await openProfileReview(result.profileDraft.id)
    } else if (result?.quickAdd?.status === 'saved') await confirmSave(result, group)
    else throw new Error('Worldview did not confirm this CRM save.')
    await refresh().catch(() => {})
  } catch (error) { saveState('error'); status.textContent = error.message || 'Could not save this profile.' }
  finally { submitting.delete('quick-add'); captureControls() }
})

function captureControls() {
  const saved = element('quick-panel').dataset.saveState === 'saved', working = submitting.has('quick-add')
  element('quick-add').disabled = !paired || !preview || working || saved
  if (working) element('quick-add').textContent = 'Saving…'
  else if (saved) element('quick-add').textContent = 'Saved'
  else updateSelection()
  element('profile-group').disabled = submitting.has('quick-add')
  for (const id of ['follow', 'highlight', 'profile', 'profile-data']) element(id).disabled = !paired || folkAppPage || submitting.has(id)
  element('folk-photos').disabled = !paired || !folkGroupPage || submitting.has('folk-photos')
  element('folk-follow').disabled = !paired || !folkGroupPage || followingFolk || submitting.has('folk-follow')
  element('stop').disabled = !following || submitting.has('stop')
  element('folk-search-diagnostic').disabled = !paired || !folkSearchPage || submitting.has('folk-search-diagnostic')
  element('folk-search-photos').disabled = !paired || !folkPersonSearchPage || submitting.has('folk-search-photos')
  element('folk-search-follow').disabled = !paired || !folkPersonSearchPage || followingFolk || submitting.has('folk-search-follow')
}
function folkNotice(result) {
  if (result?.queued) return 'Folk photo capture queued. No new photo has been confirmed; retry pending captures when Worldview is available.'
  const photos = result?.folkPhotos
  if (!photos) return 'The Folk photo capture was not confirmed. Open Worldview and retry.'
  if (photos.diagnostic) return photos.message || 'Visible photo rows retained for matching. No contact photos were changed.'
  return `${photos.saved || 0} photos saved · ${photos.kept || 0} existing photos kept · ${photos.unmatched || 0} unmatched · ${photos.unavailable || 0} unavailable.${photos.message ? ` ${photos.message}` : ''}`
}
function photoNotice(result) {
  if (result?.queued) return 'Photo capture queued on this browser. The photo is not confirmed yet; retry pending captures when Worldview is available.'
  const photo = result?.contactPhoto
  if (photo?.status === 'saved') return `Photo saved locally${photo.name ? ` for ${photo.name}` : ''}. The original and source are retained.`
  if (photo?.status === 'kept') return `Existing photo kept${photo.name ? ` for ${photo.name}` : ''}. The profile source was retained.`
  if (photo?.status === 'unmatched') return photo.message || 'Profile retained. No single existing contact matched both this profile URL and name. Add or check the contact in Worldview, then save the photo again.'
  if (photo?.status === 'unavailable') return photo.message || 'Profile retained, but its photo could not be saved. Use a local picture upload in Worldview.'
  return 'The photo was not confirmed. Open Worldview and retry this capture.'
}
function profileDataNotice(result) {
  if (result?.queued) return 'Profile source queued on this browser. It has not been confirmed in Worldview; retry when the local app is available.'
  if (result?.quickAdd?.status === 'saved') return `${result.profileDraft?.profile?.name || 'Profile'} saved in your CRM.`
  if (result?.quickAdd?.status === 'review') return result.quickAdd.message
  const draft = result?.profileDraft
  if (!draft?.id) return 'The profile draft was not confirmed. Open Worldview and retry.'
  return `${draft.profile?.name || 'Profile'} source saved locally. Review the collected fields in People before adding or updating a record.`
}
function openProfileReview(id) {
  return openWorldview(`${workspaceOrigin()}/#/people?capture=${encodeURIComponent(id)}`)
}
async function openWorldview(destination) {
  const candidates = await chrome.tabs.query({ url: [workspaceOrigin() + '/*', `http://localhost:${workspacePort}/*`] })
  const existing = candidates.filter(candidate => Number.isSafeInteger(candidate.id) && (() => { try { const url = new URL(candidate.url); return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === String(workspacePort) } catch { return false } })()).sort((a, b) => Number(b.windowId === tab?.windowId) - Number(a.windowId === tab?.windowId))[0]
  if (existing) await chrome.tabs.update(existing.id, { url: destination, active: true })
  else await chrome.tabs.create({ url: destination })
}
async function send(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, tabId: tab?.id, ...extra })
  if (!result?.ok && result?.error) throw new Error(result.error)
  return result
}
async function refresh() {
  const result = await send('reader-status'); paired = result.paired
  workspacePort = Number.isInteger(result.port) && result.port >= 5173 && result.port <= 5185 ? result.port : 5173
  if (paired || result.pendingConnection) element('workspace-port').value = String(workspacePort)
  followingFolk = !!result.folkTracked?.[tab?.id]; following = !!result.tracked[tab?.id] || followingFolk
  element('state').textContent = !paired ? result.pendingConnection ? 'Waiting for your approval in Worldview' : 'Not connected' : followingFolk ? 'Following visible Folk photos · badge PH' : following ? 'Following this article · badge ON' : folkGroupPage ? 'Connected · visible Folk photos' : folkAppPage ? 'Connected · private Folk workspace' : 'Connected'
  element('state').dataset.connected = String(paired)
  if (!paired && preview) {
    preview = null; previewStarted = false; toolsInitialized = false; groups = []; lastQueuedGroup = null
    document.body.classList.remove('has-profile')
    element('quick-panel').hidden = true; element('capture-help').hidden = false; element('open-record').hidden = true; element('open-desktop-record').hidden = true; closePicker()
  }
  element('folk-panel').hidden = !folkGroupPage; element('profile-panel').hidden = folkAppPage; element('profile-data-panel').hidden = folkAppPage; element('folk-search-panel').hidden = !folkSearchPage; element('folk-search-capture-panel').hidden = !folkPersonSearchPage
  element('capture-help').textContent = folkGroupPage ? 'Capture only the Folk rows you can see. Contact data stays in People, separate from knowledge and reading.' : folkPersonSearchPage ? 'Keep matched visible portraits privately in People. Shared emails, mismatched names and unknown accounts are skipped.' : folkSearchPage ? 'Choose People to save matched person photos. Company results are excluded.' : folkAppPage ? 'Use a Folk group or person profile to capture photos.' : 'Follow only the article you choose. Highlights and comments stay in your local workspace.'
  element('connection').hidden = paired
  element('connection-help').textContent = result.pendingConnection ? 'Approve the browser request in Worldview, then reopen this popup to finish.' : 'Approve this browser in the local app. No IDs or tokens to copy.'
  element('connect').textContent = result.pendingConnection ? 'Open Worldview to approve' : 'Connect to Worldview'
  element('extension-id').value = result.extensionId
  element('queue').textContent = result.queued ? `${result.queued} pending captures · originals are safe on this browser` : 'All captures delivered'
  element('retry').hidden = !result.queued
  element('delivery').textContent = result.lastDeliveryAt ? `Last confirmed ${new Date(result.lastDeliveryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : paired ? 'Your next saved article will appear in My files.' : ''
  element('delivery-error').textContent = result.connectionError || (result.queued ? result.lastFailure || 'Open Worldview locally and retry.' : '')
  if (folkGroupPage && !followingFolk && result.folkStopReason) element('folk-status').textContent = result.folkStopReason
  if (folkSearchPage && !followingFolk && result.folkStopReason) element('folk-search-photo-status').textContent = result.folkStopReason
  if (!result.queued) for (const id of ['folk-status', 'photo-status', 'folk-search-status', 'folk-search-photo-status']) if (/queued|not confirmed yet/i.test(element(id).textContent)) element(id).textContent = 'No captures remain queued. Check People for saved photos.'
  if (!result.queued && /queued|not (?:been )?confirmed/i.test(element('profile-data-status').textContent)) element('profile-data-status').textContent = 'No captures remain queued. Open Collect profiles in People to review saved sources.'
  element('pending').replaceChildren(...(result.pending ?? []).slice(0, 20).map((entry) => { const li = document.createElement('li'), title = document.createElement('span'), remove = document.createElement('button'); title.textContent = entry.title; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove pending capture: ${entry.title}`); remove.addEventListener('click', async () => { if (!confirm('Remove this unsent capture? Saved library items are unchanged. You may need to save the article again before later progress can be delivered.')) return; remove.disabled = true; try { await send('reader-discard-one', { sequence: entry.sequence }); await refresh() } catch (error) { element('error').textContent = error instanceof Error ? error.message : 'The pending capture could not be removed.' } }); li.append(title, remove); return li }))
  captureControls()
  await loadPreview()
  element('no-profile').hidden = !paired || !!preview || folkAppPage
  element('capture-tools').hidden = !paired || folkAppPage || (!preview && !/linkedin\.com\/(in|company|school)\//i.test(tab?.url || ''))
  element('reader-tools').hidden = !paired || folkAppPage && !following
  element('stop').hidden = !following
  element('delivery-tools').hidden = !result.queued && !result.connectionError
  if (!element('delivery-tools').hidden) element('delivery-tools').open = true
  if (preview && !following) element('state').textContent = 'Connected'
  if (!toolsInitialized) {
    element('capture-tools').open = false
    toolsInitialized = true
  }
  document.body.classList.add('popup-ready')
}
element('browse-people').addEventListener('click', () => void openWorldview(workspaceOrigin() + '/#/people').catch(error => { element('error').textContent = error.message }))
element('connect').addEventListener('click', async () => { element('connect').disabled = true; element('error').textContent = ''; try { const status = await send('reader-status'); const result = status.pendingConnection ? { openUrl: workspaceOrigin() + '/#/sources?connection=browser' } : await send('reader-connect', { port: element('workspace-port').value }); if (result.openUrl) await chrome.tabs.create({ url: result.openUrl }); await refresh() } catch (error) { element('error').textContent = error instanceof Error ? error.message : 'Open Worldview locally, then try connecting again.' } finally { element('connect').disabled = false } })
for (const [id, type, message] of [['profile-data','reader-profile-data',''],['folk-photos','reader-folk-photos',''],['folk-follow','reader-folk-follow',''],['folk-search-diagnostic','reader-folk-search-diagnostic',''],['folk-search-photos','reader-folk-search-photos',''],['folk-search-follow','reader-folk-search-follow',''],['profile','reader-profile',''],['follow','reader-follow','Article saved. Reading progress is followed only in this chosen tab.'],['highlight','reader-highlight','Selected passage and comment saved.'],['stop','reader-stop','Following stopped for this tab.'],['pair','reader-pair','Pairing saved on this browser.'],['retry','reader-retry','All pending captures delivered.'],['discard','reader-discard','Pending captures discarded.'],['disconnect','reader-disconnect','Browser disconnected. Revoke its token in Worldview too.']]) {
  element(id).addEventListener('click', async () => {
    if (submitting.has(id)) return
    if (['discard','disconnect'].includes(id) && !confirm(id === 'discard' ? 'Discard unsent captures from this browser?' : 'Disconnect and discard unsent captures from this browser?')) return
    element('error').textContent = ''; submitting.add(id); element(id).disabled = true; captureControls()
    const submittedToken = element('token').value.trim(), submittedNote = element('note').value
    try {
      const result = await send(type, { token: submittedToken, note: submittedNote, ...(id === 'pair' ? { port: element('workspace-port').value } : {}) }), receipt = result.result
      if (id === 'retry' && lastQueuedGroup && receipt?.quickAdd?.status === 'saved' && receipt.profileDraft?.source?.url === preview?.url) await confirmSave(receipt, lastQueuedGroup)
      if (['retry', 'discard'].includes(id) && lastQueuedGroup) {
        lastQueuedGroup = null
        element('quick-status').textContent = id === 'discard' ? 'Pending capture discarded.' : 'Pending captures delivered. Check Worldview for their results.'
        saveState('idle')
      }
      const folkAction = ['folk-photos', 'folk-follow', 'folk-search-diagnostic', 'folk-search-photos', 'folk-search-follow'].includes(id)
      element('notice').textContent = receipt?.profileDraft || id === 'profile-data' ? profileDataNotice(receipt) : receipt?.contactPhoto || id === 'profile' ? photoNotice(receipt) : receipt?.folkPhotos || folkAction ? folkNotice(receipt) + (['folk-follow', 'folk-search-follow'].includes(id) ? ' Following this page’s visible rows. Move through the list; use Stop when finished.' : '') : receipt?.queued ? 'Queued on this browser. It will sync when your local workspace is available.' : message
      if (id === 'profile-data' || receipt?.profileDraft) element('profile-data-status').textContent = element('notice').textContent
      if (receipt?.profileDraft?.id && !receipt?.queued && receipt?.quickAdd?.status !== 'saved') await openProfileReview(receipt.profileDraft.id)
      if (id === 'profile' || receipt?.contactPhoto) element('photo-status').textContent = element('notice').textContent
      if (id === 'folk-search-diagnostic') element('folk-search-status').textContent = element('notice').textContent
      else if (['folk-search-photos', 'folk-search-follow'].includes(id) || folkSearchPage && receipt?.folkPhotos) element('folk-search-photo-status').textContent = element('notice').textContent
      else if (['folk-photos', 'folk-follow'].includes(id) || receipt?.folkPhotos) element('folk-status').textContent = element('notice').textContent
      if (id === 'pair' && element('token').value.trim() === submittedToken) element('token').value = ''
      if (['follow','highlight'].includes(id) && !receipt?.queued && element('note').value === submittedNote) element('note').value = ''
      await refresh()
    }
    catch (error) { element('error').textContent = error instanceof Error ? error.message : 'Capture failed. Open your local workspace and retry.'; await refresh().catch(() => {}) }
    finally { submitting.delete(id); element(id).disabled = false; captureControls() }
  })
}
try { await refresh() } catch { element('error').textContent = 'The reader could not initialize. Reload this unpacked extension.' }

element('mode-person').onclick = async () => {
  if (preview) element('profile-group').focus()
  else if (!paired) element('connect').focus()
  else {
    previewStarted = false
    element('error').textContent = ''
    await refresh()
    if (preview) element('profile-group').focus()
  }
}
for (const mode of ['word', 'application']) {
  element('mode-' + mode).onclick = async event => {
    const control = event.currentTarget
    control.disabled = true
    let handoff
    try {
      if (!paired) throw Error('Connect to Worldview first.')
      const target = { tabId: tab.id }
      const [{ result }] = mode === 'application'
        ? await chrome.scripting.executeScript({ target, func: readApplicationForm })
        : await chrome.scripting.executeScript({ target, func: () => ({
            term: window.getSelection()?.toString().trim().slice(0, 160) || '',
            url: location.origin + location.pathname
          }) })
      const origin = workspaceOrigin()
      handoff = await chrome.tabs.create({ url: origin + '/reader-handoff.html', active: false })
      let ready = false
      for (let attempt = 0; attempt < 80; attempt++) {
        const page = await chrome.tabs.get(handoff.id)
        if (page.status === 'complete' && page.url === origin + '/reader-handoff.html') { ready = true; break }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!ready) throw Error('Open Worldview and try again.')
      await chrome.scripting.executeScript({ target: { tabId: handoff.id }, args: [origin, mode, result],
        func: (expected, kind, value) => {
          if (location.origin !== expected) throw Error('Workspace changed.')
          sessionStorage.setItem('worldview-reader-' + kind, JSON.stringify(value))
        } })
      await chrome.tabs.update(handoff.id, { url: origin + '/#/' + (mode === 'word' ? 'vocabulary' : 'applications'), active: true })
    } catch (error) {
      if (handoff?.id) await chrome.tabs.remove(handoff.id).catch(() => {})
      element('error').textContent = error.message || 'Capture unavailable on this page.'
    } finally { control.disabled = false }
  }
}
