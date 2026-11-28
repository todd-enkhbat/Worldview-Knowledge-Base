/* global chrome */
import { readApplicationForm, mergeApplicationForms, readEmbeddedApplicationForms } from './application-form.js'
import { groupDisplay } from './group-icon.js'
import { contactActions, renderPeopleRows, renderProfileIdentity } from './contact-ui.js'
import { mountOrganizationEditor } from './organization-ui.js'
// Chromium sizes an action popup from its document's intrinsic width. A vw-only
// root collapses to the tab labels on first layout.
const toolbarPopup = typeof window !== 'undefined' && chrome.extension?.getViews?.({type:'popup'}).includes(window)
if (toolbarPopup) {
  const root = document.documentElement
  const width = Math.min(480, window.screen.availWidth || 480)
  root.classList.add('toolbar-popup')
  root.style.setProperty('--toolbar-width', width + 'px')
  let reachedFullWidth = false
  const fit = () => {
    if (window.innerWidth >= width) reachedFullWidth = true
    if (reachedFullWidth) root.style.setProperty('--toolbar-width', Math.min(width, window.innerWidth) + 'px')
  }
  window.addEventListener('resize', fit)
  requestAnimationFrame(fit)
}
const element = (id) => document.getElementById(id)
const readerWindow = typeof window !== 'undefined' && window.location?.search === '?view=window'
const windowContext = readerWindow ? await chrome.runtime.sendMessage({ type:'reader-window-context' }).catch(() => null) : null
const [tab] = readerWindow ? [windowContext?.sourceTab] : await chrome.tabs.query({ active: true, currentWindow: true })
let sourceAvailable = !readerWindow || windowContext?.available === true
const canCapture = () => paired && sourceAvailable
const folkGroupPage = /^https:\/\/app\.folk\.app\/apps\/contacts\/network\/[0-9a-f-]{36}\/groups\/[0-9a-f-]{36}(?:[/?#]|$)/i.test(tab?.url || '')
const folkAppPage = /^https?:\/\/app\.folk\.app(?:[/:?#]|$)/i.test(tab?.url || '')
const folkSearchPage = /^https:\/\/app\.folk\.app\/apps\/contacts\/network\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/search(?:[?#]|$)/i.test(tab?.url || '')
const folkSearchTypes = folkSearchPage ? [...new URL(tab.url).searchParams].filter(([key]) => key.toLowerCase() === 'type') : []
const folkPersonSearchPage = folkSearchPage && (!folkSearchTypes.length || folkSearchTypes.length === 1 && folkSearchTypes[0][0] === 'type' && folkSearchTypes[0][1] === 'person')
let workspacePort = 5173
const workspaceOrigin = () => 'http://127.0.0.1:' + workspacePort
let paired = false, following = false, followingFolk = false
const submitting = new Set()
let sourceProfileName = '', preview = null, previewStarted = false, toolsInitialized = false
let groups = [], selectedGroupId = '', visibleGroups = [], activeIndex = -1
let people = [], pageUrl = '', selectedPerson = '', rosterStarted = false, rosterBusy = false
let organizationKey = '', closeOrganization
let lastQueuedGroup = null, existing = null, recordFingerprint = ''
const keyText = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const selectedGroup = () => groups.find(group => group.id === selectedGroupId)
const groupTrigger = () => element(existing ? 'add-another-group' : 'profile-group')
const groupPreference = () => `lastProfileGroup:${preview.entityType}`
function groupParts(group) {
  if (group.id) return groupDisplay(group)
  return preview?.entityType === 'company' ? { icon: '🏢', name: 'All companies' } : { icon: '👥', name: 'All contacts' }
}
function saveState(value) {
  element('quick-panel').dataset.saveState = value
  element('quick-status').dataset.state = value
  if (value !== 'saved') element('quick-status').classList.remove('quiet-receipt')
}

function profileIdentity() {
  renderProfileIdentity(element('profile-identity'), existing ? {...preview, current: [], schools: []} : preview, {saved:!!existing, idPrefix:'profile'})
}
function showProfile() {
  element('quick-panel').dataset.entity = preview.entityType
  profileIdentity()
  const facts = element('company-facts')
  const fields = [['Industry', preview.industry], ['Location', preview.location], ['Description', preview.description],
    ['Websites & profiles', Array.isArray(preview.urls) ? preview.urls.join('\n') : '']]
  if (facts) {
    facts.replaceChildren(...fields.filter(([, value]) => value).flatMap(([label, value]) => {
      const term = document.createElement('dt'), detail = document.createElement('dd')
      term.textContent = label
      detail.textContent = value
      return [term, detail]
    }))
    element('company-preview').hidden = preview.entityType !== 'company' || !facts.children.length
    element('company-preview').open = preview.entityType === 'company'
  }
  element('quick-panel').hidden = false
  element('capture-help').hidden = true
  document.body.classList.add('has-profile')
  showOrganizationEditor()
}
function updateSelection() {
  const group = selectedGroup()
  if (!group) return
  const { icon, name } = groupParts(group)
  element('group-selected-icon').textContent = icon
  element('group-selected-name').textContent = name
  element('profile-group').setAttribute('aria-label', `Choose group, currently ${name}`)
  element('quick-add').textContent = existing ? 'Retry adding group' : contactActions(preview.entityType).save
}
function closePicker(restoreFocus = false) {
  element('group-popover').hidden = true
  groupTrigger().setAttribute('aria-expanded', 'false')
  element('group-search').removeAttribute('aria-activedescendant')
  if (restoreFocus) groupTrigger().focus()
}
function chooseGroup(group) {
  selectedGroupId = group.id
  updateSelection()
  element('quick-status').textContent = ''
  saveState('idle'); captureControls()
  closePicker(true)
  if (existing) void saveSelectedGroup()
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
    if (existing && (!group.id || existing.groupIds.includes(group.id))) return false
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
  groupTrigger().setAttribute('aria-expanded', 'true')
  element('group-search').value = ''
  renderOptions()
  element('group-search').focus()
}
for (const id of ['profile-group', 'add-another-group']) {
  element(id).addEventListener('click', () => element('group-popover').hidden ? openPicker() : closePicker(true))
  element(id).addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openPicker() }
  })
}
element('group-search').addEventListener('input', renderOptions)
element('group-picker').addEventListener('keydown', event => {
  if (element('group-popover').hidden) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePicker(true); return }
  if (event.target !== element('group-search')) return
  if (event.key === 'Tab') { closePicker(true); return }
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

async function loadPreview(person) {
  if (previewStarted && !person || !canCapture() || folkAppPage || !/^https?:\/\//.test(tab?.url || '')) return
  previewStarted = true
  try {
    const result = await send('reader-profile-preview', person ? {selectedUrl:person.url,sourceUrl:pageUrl} : {})
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
    if (person && (result.preview.name !== person.name || result.preview.url !== person.url)) throw Error('This profile changed. Reopen the reader.')
    selectedPerson = person?.url || ''
    lastQueuedGroup = null
    existing = null
    closePicker()
    saveState('')
    element('quick-status').textContent = ''
    for (const id of ['open-record','open-desktop-record','log-interaction']) element(id).hidden = true
    preview = result.preview
    sourceProfileName = preview.name
    groups = [{ id: '', name: '' }, ...result.groups.filter(group => typeof group?.id === 'string' && group.id && typeof group.name === 'string')]
    const key = groupPreference()
    const preferences = await chrome.storage?.local?.get(key).catch(() => ({}))
    selectedGroupId = groups.some(group => group.id === preferences?.[key]) ? preferences[key] : ''
    existing = result.existing || null
    recordFingerprint = result.workspaceFingerprint || ''
    element('quick-panel').dataset.existing = String(!!existing)
    element('memberships').hidden = !existing
    element('profile-group').hidden = !!existing
    element('group-picker').hidden = groups.length < 2 && !existing?.groupIds?.length
    if (existing) {
      selectedGroupId = existing.groupIds.find(id => groups.some(g => g.id === id)) || selectedGroupId
      showRecord(existing.recordId, result.workspaceFingerprint)
    }
    updateSelection(); showProfile(); toolsInitialized = false
    captureControls()
  } catch (error) {
    if (person) throw error
    if (!people.length && /(?:linkedin\.com\/(?:in|company|school)\/|instagram\.com\/|facebook\.com\/)/i.test(tab.url)) element('error').textContent = error.message
  }
}
function showOrganizationEditor(refresh = false) {
  const host = element('organization-editor')
  if (!host) return
  const key = preview && existing && recordFingerprint ? preview.entityType + ':' + existing.recordId + ':' + recordFingerprint : ''
  if (key === organizationKey && !refresh) return
  closeOrganization?.()
  organizationKey = key
  host.hidden = !key
  if (!key) return
  element('company-preview').hidden = true
  const identity = { id: existing.recordId, url: preview.url, workspace: recordFingerprint, entityType: preview.entityType }
  closeOrganization = mountOrganizationEditor(host, {
    entityType: identity.entityType,
    actionHost: element('record-actions'),
    async request(fields) {
      if (!canCapture()) throw Error('Reconnect Reader to the current workspace.')
      const config = (await chrome.storage.local.get('pairing')).pairing
      if (!config?.token) throw Error('Reconnect Reader to the current workspace.')
      const response = await fetch(workspaceOrigin() + '/api/reading-capture/organization', {
        method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(fields.action === 'enrich' || fields.online ? 45000 : 8000),
        headers: { 'content-type':'application/json', authorization:'Bearer ' + config.token },
        body: JSON.stringify({ ...fields, ...identity }),
      })
      const value = await response.json()
      if (!response.ok) throw Error(response.status === 405 ? 'Open the latest Worldview app to edit this organization.' : value.error || 'The organization could not be loaded.')
      return value
    },
    personLink(id) {
      void openWorldview(workspaceOrigin() + '/#/people?person=' + encodeURIComponent(id))
        .catch(error => { element('quick-status').textContent = error.message })
    },
    companyLink(id) {
      void openWorldview(workspaceOrigin() + '/#/people?tab=companies&company=' + encodeURIComponent(id))
        .catch(error => { element('quick-status').textContent = error.message })
    },
    onChange(model) {
      if (organizationKey !== key) return
      existing.groupIds = model.memberships.map(member => member.id)
      const name = model.record.name || model.record.fullName || [model.record.firstName, model.record.lastName].filter(Boolean).join(' ') || sourceProfileName
      preview = { ...preview, name, headline: model.record.tagline || model.record.jobTitle || preview.headline || '', location: model.record.location || '' }
      profileIdentity()
      if (identity.entityType === 'company') {
        void (async () => {
          const config = (await chrome.storage.local.get('pairing')).pairing
          if (!config?.token) return
          const response = await fetch(workspaceOrigin() + '/api/reading-capture/organization', {
            method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8000),
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.token },
            body: JSON.stringify({ ...identity, action: 'organization-logo', companyId: identity.id }),
          })
          if (!response.ok || organizationKey !== key) return
          const value = await response.json()
          if (!/^data:image\/(png|jpeg|webp);base64,/.test(value.logo || '') || organizationKey !== key) return
          const image = element('profile-identity').querySelector('img')
          if (image) image.src = value.logo
        })().catch(() => {})
      }
      showRecord(identity.id, identity.workspace)
    },
  })
}

async function confirmSave(receipt, group, updating = false) {
  const { recordId, image } = receipt.quickAdd
  if (typeof recordId !== 'string' || !recordId.trim()) throw new Error('Worldview did not return the saved CRM record.')
  const text = group.id ? 'to ' + groupParts(group).name : 'in Worldview'
  element('quick-status').textContent = [
    updating ? `${preview.name} updated from this profile.` : `${preview.name} saved ${text}.`,
    image === 'unavailable' && 'The profile image could not be downloaded.',
    receipt.experienceNotice,
  ].filter(Boolean).join(' ')
  saveState('saved')
  existing = { recordId, groupIds: [...new Set([...(existing?.groupIds || []), group.id].filter(Boolean))] }
  profileIdentity()
  element('quick-status').classList.toggle('quiet-receipt', !updating && image !== 'unavailable' && !receipt.experienceNotice)
  recordFingerprint = receipt.workspaceFingerprint || recordFingerprint
  showRecord(recordId, recordFingerprint)
  showOrganizationEditor(true)
  if (selectedPerson) people = people.map(row => row.url === selectedPerson ? {...row, existing} : row)
  lastQueuedGroup = null
  await chrome.storage?.local?.set({ [groupPreference()]: group.id }).catch(() => {})
}
function showRecord(recordId, fingerprint) {
  element('quick-panel').dataset.existing = 'true'
  element('profile-group').hidden = true
  element('memberships').hidden = false
  element('group-picker').hidden = groups.length < 2 && !existing.groupIds.length
  element('add-another-group').hidden = !groups.some(group => group.id && !existing.groupIds.includes(group.id))
  const chips = groups.filter(group => existing.groupIds.includes(group.id)).map(group => {
    const chip = document.createElement('span')
    const { name, icon } = groupParts(group)
    chip.className = 'member-chip'
    chip.textContent = [icon, name].filter(Boolean).join(' ')
    return chip
  })
  const caption = document.createElement('span')
  caption.className = 'membership-label'
  caption.textContent = chips.length ? 'Groups' : 'No groups yet'
  element('membership-summary').replaceChildren(caption, ...chips)
  const link = element('open-record'), mac = element('open-desktop-record')
  const company = preview.entityType === 'company', kind = company ? 'company' : 'person'
  const openLabel = contactActions(preview.entityType).open
  const param = company ? 'tab=companies&company' : 'person'
  link.href = `${workspaceOrigin()}/#/people?${param}=${encodeURIComponent(recordId)}`
  link.hidden = false
  // Keep only one primary destination. The alternate browser link lives in More tools.
  if (/^[a-f0-9]{64}$/.test(fingerprint || '')) {
    mac.href = `worldview-local://record/${kind}/${encodeURIComponent(recordId)}?workspace=${fingerprint}`
    mac.textContent = openLabel; mac.title = openLabel + ' in the Mac app'; mac.hidden = false
    link.textContent = 'View in browser'
    element('other-record-destinations').append(link)
  } else {
    mac.hidden = true; mac.removeAttribute('href')
    link.textContent = openLabel; link.title = openLabel + ' in Worldview'
    element('record-actions').insertBefore(link, element('update-profile'))
  }
  const log = element('log-interaction')
  log.hidden = preview.entityType !== 'person'
  log.href = link.href + '&action=log-interaction'
}
element('log-interaction').addEventListener('click', event => {
  event.preventDefault()
  const interactions = element('organization-editor').querySelector('button[aria-label="Interactions"]')
  if (interactions) {
    interactions.click()
    interactions.focus()
    return
  }
  void openWorldview(element('log-interaction').href).catch(error => { element('quick-status').textContent = error.message })
})
element('open-record').addEventListener('click', event => {
  event.preventDefault()
  if (!element('open-record').hidden) void openWorldview(element('open-record').href).catch(error => { element('quick-status').textContent = error.message })
})
element('quick-add').addEventListener('click', () => void saveSelectedGroup())
element('update-profile').addEventListener('click', () => void saveSelectedGroup(true))
async function saveSelectedGroup(updating = false) {
  if (!preview || submitting.has('quick-add') || !updating && !selectedGroup()) return
  if (!updating && existing && (!selectedGroupId || existing.groupIds.includes(selectedGroupId))) return
  submitting.add('quick-add'); closePicker(); captureControls()
  const group = updating ? {id:'',name:''} : selectedGroup(), status = element('quick-status')
  if (!existing) { element('open-record').hidden = true; element('open-desktop-record').hidden = true }
  saveState('working')
  status.textContent = updating ? 'Updating from profile…' : 'Saving…'
  try {
    const { result } = await send('reader-profile-add', { url: preview.url, name: sourceProfileName, entityType: preview.entityType, groupId: group.id, ...(selectedPerson ? {selectedUrl:selectedPerson,sourceUrl:pageUrl} : {}) })
    if (result?.queued) {
      lastQueuedGroup = group
      saveState('pending'); status.textContent = `Queued on this browser. ${result.message || 'It will sync when your local workspace is available.'}`
    } else if (result?.quickAdd?.status === 'review' && result.profileDraft?.id) {
      saveState('review'); status.textContent = result.quickAdd.message || 'Review the matching records in Worldview.'
      await openProfileReview(result.profileDraft.id)
    } else if (result?.quickAdd?.status === 'saved') await confirmSave(result, group, updating)
    else throw new Error('Worldview did not confirm this CRM save.')
    await refresh().catch(() => {})
  } catch (error) { saveState('error'); status.textContent = error.message || 'Could not save this profile.' }
  finally {
    submitting.delete('quick-add'); captureControls()
    if (element('quick-panel').dataset.saveState === 'saved') {
      const next = !element('add-another-group').hidden ? groupTrigger() : !element('open-desktop-record').hidden ? element('open-desktop-record') : element('open-record')
      next.focus()
    }
  }
}

function captureControls() {
  const state = element('quick-panel').dataset.saveState, working = submitting.has('quick-add')
  const saved = state === 'saved', pending = state === 'pending'
  element('update-profile').hidden = !existing
  element('update-profile').disabled = !canCapture() || !preview || working || pending
  element('update-profile').textContent = working ? 'Updating…' : 'Update from profile'
  element('quick-add').hidden = !!existing && state !== 'error'
  element('quick-add').disabled = !canCapture() || !preview || working || saved || pending
  if (working) element('quick-add').textContent = 'Saving…'
  else if (pending) element('quick-add').textContent = 'Queued'
  else if (saved) element('quick-add').textContent = 'Saved'
  else updateSelection()
  element('profile-group').disabled = !sourceAvailable || working || pending
  element('add-another-group').disabled = !sourceAvailable || working || pending
  for (const id of ['follow', 'highlight', 'profile', 'profile-data']) element(id).disabled = !canCapture() || folkAppPage || submitting.has(id)
  element('folk-photos').disabled = !canCapture() || !folkGroupPage || submitting.has('folk-photos')
  element('folk-follow').disabled = !canCapture() || !folkGroupPage || followingFolk || submitting.has('folk-follow')
  element('stop').disabled = !sourceAvailable || !following || submitting.has('stop')
  element('folk-search-diagnostic').disabled = !canCapture() || !folkSearchPage || submitting.has('folk-search-diagnostic')
  element('folk-search-photos').disabled = !canCapture() || !folkPersonSearchPage || submitting.has('folk-search-photos')
  element('folk-search-follow').disabled = !canCapture() || !folkPersonSearchPage || followingFolk || submitting.has('folk-search-follow')
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
  const enki = element('enki-connection'), connectEnki = element('connect-enki')
  if (enki && connectEnki) {
    enki.hidden = !paired
    connectEnki.dataset.enabled = String(result.enkiEnabled === true)
    connectEnki.textContent = result.enkiEnabled ? 'Disconnect Enki from Dia' : 'Connect Enki to Dia'
  }
  workspacePort = Number.isInteger(result.port) && result.port >= 1024 && result.port <= 65535 ? result.port : 5173
  if (paired || result.pendingConnection) element('workspace-port').value = String(workspacePort)
  followingFolk = !!result.folkTracked?.[tab?.id]; following = !!result.tracked[tab?.id] || followingFolk
  element('state').textContent = !paired ? result.pendingConnection ? 'Waiting for your approval in Worldview' : 'Not connected' : followingFolk ? 'Following visible Folk photos · badge PH' : following ? 'Following this article · badge ON' : folkGroupPage ? 'Connected · visible Folk photos' : folkAppPage ? 'Connected · private Folk workspace' : 'Connected'
  element('state').dataset.connected = String(paired)
  if (!paired && (preview || rosterStarted)) {
    people=[]; pageUrl=''; selectedPerson=''; rosterStarted=false; drawRoster()
    preview = null; existing = null; previewStarted = false; toolsInitialized = false; groups = []; lastQueuedGroup = null
    document.body.classList.remove('has-profile')
    element('quick-panel').hidden = true; element('capture-help').hidden = false; element('open-record').hidden = true; element('open-desktop-record').hidden = true; closePicker()
  }
  element('folk-panel').hidden = !folkGroupPage; element('profile-panel').hidden = folkAppPage; element('profile-data-panel').hidden = folkAppPage; element('folk-search-panel').hidden = !folkSearchPage; element('folk-search-capture-panel').hidden = !folkPersonSearchPage
  element('capture-help').textContent = folkGroupPage ? 'Capture only the Folk rows you can see. Contact data stays in People, separate from knowledge and reading.' : folkPersonSearchPage ? 'Keep matched visible portraits privately in People. Shared emails, mismatched names and unknown accounts are skipped.' : folkSearchPage ? 'Choose People to save matched person photos. Company results are excluded.' : folkAppPage ? 'Use a Folk group or person profile to capture photos.' : 'Follow only the article you choose. Highlights and comments stay in your local workspace.'
  element('connection').hidden = paired
  element('connection-help').textContent = result.pendingConnection ? (readerWindow ? 'Approve the browser request in Worldview, then return here.' : 'Approve the browser request in Worldview, then reopen Reader to finish.') : 'Approve this browser in the local app.'
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
  await loadRoster()
  await loadPreview()
  drawRoster()
  element('no-profile').hidden = !paired || !!preview || !!people.length || folkAppPage
  element('capture-tools').hidden = !paired || folkAppPage || (!preview && !/linkedin\.com\/(in|company|school)\//i.test(tab?.url || ''))
  element('reader-tools').hidden = !paired || folkAppPage && !following
  element('stop').hidden = !following
  element('delivery-tools').hidden = !result.queued && !result.connectionError
  if (!element('delivery-tools').hidden) element('delivery-tools').open = true
  if (preview && !following) element('state').textContent = 'Connected'
  if (!toolsInitialized) {
    element('capture-tools').open = false
    element('more-tools').open = !preview && !people.length
    toolsInitialized = true
  }
  if (!element('delivery-tools').hidden) element('more-tools').open = true
  document.body.classList.add('popup-ready')
}
async function loadRoster() {
  if (rosterStarted || !canCapture() || folkAppPage || !/^https?:\/\//.test(tab?.url || '')) return
  rosterStarted = true
  try {
    const result = await send('reader-visible-people')
    if (!Array.isArray(result?.people)) return
    people = result.people
    pageUrl = result.sourceUrl
  } catch (error) { element('error').textContent = error.message }
}
function drawRoster() {
  const primaryKey = preview && !selectedPerson ? preview.url.replace(/\/$/, '') : ''
  const rows = people.filter(row => row.url !== primaryKey)
  element('visible-people').hidden = !sourceAvailable || !rows.length || !!selectedPerson
  element('return-people').hidden = !selectedPerson
  if (!element('visible-people').hidden) renderPeopleRows(element('visible-rows'), rows, onRowAction, rosterBusy)
}
async function onRowAction(row, action) {
  if (rosterBusy || submitting.has('quick-add')) return
  rosterBusy = true
  const restore = event => element('visible-rows').querySelectorAll('button').forEach(button => {
    if (button.dataset.url === row.url && button.dataset.action === event) button.focus({preventScroll:true})
  })
  drawRoster()
  element('error').textContent = ''
  try {
    if (action === 'review') {
      await loadPreview(row)
      drawRoster()
      focusProfileAction()
    } else if (row.reviewId) {
      await openProfileReview(row.reviewId)
    } else if (row.existing) {
      await openWorldview(workspaceOrigin() + '/#/people?person=' + encodeURIComponent(row.existing.recordId))
    } else {
      const { result } = await send('reader-profile-add', { selectedUrl:row.url, sourceUrl:pageUrl, url:row.url, name:row.name, entityType:'person', groupId:'' })
      if (result?.queued) row.pending = true
      else if (result?.quickAdd?.status === 'review' && result.profileDraft?.id) row.reviewId = result.profileDraft.id
      else if (result?.quickAdd?.status === 'saved' && result.quickAdd.recordId) row.existing = {recordId:result.quickAdd.recordId,groupIds:[]}
      else throw Error('Worldview did not confirm the save.')
      element('notice').textContent = row.pending ? row.name + ' is queued.' : row.reviewId ? row.name + ' is ready for review.' : row.name + ' saved.'
    }
  } catch (error) { element('error').textContent = error.message }
  finally { rosterBusy = false; drawRoster(); if (!selectedPerson) restore(action) }
}
element('return-people').onclick = async () => {
  selectedPerson = ''; previewStarted = false; preview = null; existing = null
  element('quick-panel').hidden = true
  element('error').textContent = ''; element('other-record-destinations').querySelector('a')?.setAttribute('hidden','')
  await loadPreview()
  drawRoster()
  element('visible-rows').querySelector('button')?.focus()
}
function showTool(mode) {
  for (const id of ['person','todo','word','application']) {
    const section = element(id === 'person' ? 'crm-panel' : id + '-panel')
    if (section) section.hidden = mode !== id
    const button = element('mode-' + id)
    if (mode === id) button.setAttribute('aria-current','true')
    else button.removeAttribute('aria-current')
  }
}
element('mode-todo').onclick = async () => {
  if (!paired) { showTool('person'); element('connect').focus(); return }
  showTool('todo')
  try { const {mountTodos} = await import('./todo-ui.js'); mountTodos(element('todo-panel')) }
  catch { element('todo-panel').textContent = 'Could not load TO-DO. Reopen the extension to try again.' }
}
function focusProfileAction() {
  const first = existing ? (element('open-desktop-record').hidden ? element('open-record') : element('open-desktop-record')) : element('quick-add')
  first.focus()
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
      const chosen = selectedPerson && ['profile','profile-data'].includes(id) ? { selectedUrl:selectedPerson, sourceUrl:pageUrl, name:preview.name, url:preview.url, entityType:preview.entityType } : {}
      const result = await send(type, { token: submittedToken, note: submittedNote, ...chosen, ...(id === 'pair' ? { port: element('workspace-port').value } : {}) }), receipt = result.result
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
if (toolbarPopup) {
  const button = element('open-reader-window')
  button.hidden = false
  button.onclick = async () => {
    button.disabled = true
    try { await send('reader-open-window') }
    catch (error) { element('state').textContent = error.message || 'Reader could not open a window. Try again.' }
    finally { button.disabled = false }
  }
}

if (readerWindow) {
  const sourceNotice = element('reader-window-source')
  document.documentElement.classList.add('reader-window')
  function renderSource() {
    const hostname = tab ? new URL(tab.url).hostname : ''
    sourceNotice.hidden = false
    sourceNotice.textContent = !windowContext?.ok ? 'Open Reader from the toolbar or its keyboard shortcut.' : sourceAvailable
      ? `Capturing from ${hostname}`
      : hostname ? `Return to the original page on ${hostname}, or open Reader from another page.` : 'Open Reader from a web page to capture it.'
  }
  let checking = false
  async function checkSource() {
    if (!windowContext?.ok || checking) return
    checking = true
    try {
      const context = await send('reader-window-context')
      const wasAvailable = sourceAvailable
      sourceAvailable = context.available
      renderSource()
      captureControls()
      if (!sourceAvailable) closePicker()
      drawRoster()
      if (!wasAvailable && sourceAvailable || !paired) await refresh()
    } catch { /* Refresh can be retried on focus if the browser is still opening. */ }
    finally { checking = false }
  }
  renderSource()
  window.addEventListener('focus', () => void checkSource())
  chrome.tabs.onUpdated?.addListener((id, change) => { if (id === tab?.id && (change.url || change.status)) void checkSource() })
  chrome.tabs.onRemoved?.addListener(id => { if (id === tab?.id) void checkSource() })
  chrome.tabs.onActivated?.addListener(active => { if (active.windowId === tab?.windowId) void checkSource() })
}

try { await refresh() } catch { element('error').textContent = 'The reader could not initialize. Reload this unpacked extension.' }

element('mode-person').onclick = async () => {
  showTool('person')
  if (!preview && people.length) { element('visible-rows').querySelector('button')?.focus(); return }
  if (preview) focusProfileAction()
  else if (!paired) element('connect').focus()
  else {
    previewStarted = false
    element('error').textContent = ''
    await refresh()
    if (preview) focusProfileAction()
  }
}
// Keep the actual Enki tool mounted across tab switches. Only the paired
// extension origin may frame it. Application data stays in the local document.
const studyFrames = new Map()
async function openStudy(mode) {
  showTool(mode)
  const panel = element(mode + '-panel')
  if (!paired) {
    studyFrames.get(mode)?.cleanup()
    studyFrames.delete(mode)
    panel.textContent = 'Connect to Worldview to open this tool.'
    return
  }
  const origin = workspaceOrigin()
  const previous = studyFrames.get(mode)
  if (previous?.origin === origin && previous.frame.isConnected) {
    previous.port?.postMessage({ type:'focus' })
    return
  }
  previous?.cleanup()
  const frame = document.createElement('iframe')
  frame.title = mode === 'word' ? 'Dictionary' : 'Application capture'
  frame.allow = 'clipboard-write'
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  status.textContent = 'Opening ' + frame.title + '…'
  const entry = { origin, frame, port:null, cleanup() {
    clearTimeout(timer)
    entry.port?.close()
    window.removeEventListener('message', handshake)
  } }
  studyFrames.set(mode, entry)
  const timer = setTimeout(() => {
    if (entry.ready) return
    entry.cleanup()
    studyFrames.delete(mode)
    frame.remove()
    status.textContent = 'Couldn’t open this tool. Check that Worldview is running and this browser is paired.'
    const retry = document.createElement('button')
    retry.textContent = 'Retry'
    retry.onclick = () => openStudy(mode)
    panel.append(retry)
  }, 10000)
  async function handshake(event) {
    if (event.origin !== origin || event.source !== frame.contentWindow || event.data?.type !== 'enki:study-ready' || event.data.mode !== mode) return
    window.removeEventListener('message', handshake)
    const channel = new MessageChannel()
    entry.port = channel.port1
    channel.port1.onmessage = async ({ data }) => {
      if (data?.type === 'ready') { clearTimeout(timer); entry.ready = true; status.remove() }
      if(data?.type==='form-saved' && mode==='application') {
        try {await send('reader-watch-application',{applicationId:data.id,source:data.source,workspaceToken:data.workspaceToken,...entry.applicationDocument});entry.port.postMessage({type:'tracking-status',message:'Application saved. Watching this form for a successful submission.'})}
        catch(error){entry.port.postMessage({type:'tracking-status',message:'Application saved. '+(error.message || 'Submission tracking is unavailable.')})}
      }
      if (data?.type === 'height' && Number.isFinite(data.height)) {
        const maxHeight = readerWindow ? Math.max(452, window.innerHeight - 150) : 452
        frame.style.height = Math.min(maxHeight, Math.max(110, data.height)) + 'px'
      }
      if (data?.type === 'read-form' && mode === 'application' && !panel.hidden) {
        try {
          const current = await chrome.tabs.get(tab.id)
          const pageUrl = current.url?.split('#',1)[0]
          if (!current.active || !pageUrl || readerWindow && (current.pendingUrl || current.url) !== tab.url) throw Error('Choose the active application tab.')
          const [{result:outer,documentId}] = await chrome.scripting.executeScript({ target:{tabId:tab.id}, func:readApplicationForm, args:[{expectedUrl:pageUrl}] })
          if(!outer)throw Error('The selected tab did not return an application.')
          entry.applicationDocument = {pageUrl,documentId}
          const results = await readEmbeddedApplicationForms(tab.id,{...outer,documentId})
          const form = mergeApplicationForms(outer,results.map(row=>row.result))
          const unread = outer.embeddedForms.find(frame=>!results.some(row=>row.url===frame.url))
          panel.querySelector('.application-frame-access')?.remove()
          if(unread && chrome.permissions) {
            const controls = document.createElement('div'), access = document.createElement('button'), note = document.createElement('p')
            const provider = new URL(unread.url).origin
            controls.className='application-frame-access'
            access.textContent='Enable answers from '+new URL(unread.url).hostname
            note.setAttribute('role','status')
            note.textContent='Browser permission lets Reader locate this embedded form in the active tab.'
            access.onclick=async()=>{
              access.disabled=true
              try {
                const granted=await chrome.permissions.request({permissions:['webNavigation'],origins:[provider+'/*']})
                if(granted){controls.remove();entry.port.postMessage({type:'reread-form'})}
                else note.textContent='Permission was declined. You can try again here.'
              } catch {note.textContent='Unable to enable embedded answers. Try again.'}
              finally {access.disabled=false}
            }
            controls.append(access,note)
            panel.prepend(controls)
          }
          entry.port.postMessage({ type:'form', form })
        } catch { entry.port.postMessage({ type:'form', error:readerWindow ? 'Return to the original form or open Reader from the new page. You can also paste its questions.' : 'Open a form in the active tab, or paste its questions.' }) }
      }
    }
    let selection = {}
    if (mode === 'word') {
      try {
        if (readerWindow && !(await send('reader-window-context')).available) throw Error('Choose an article to read its selection.')
        const [{ result }] = await chrome.scripting.executeScript({ target:{tabId:tab.id}, func:() => ({ term:window.getSelection()?.toString().trim().slice(0,160) || '', url:location.origin + location.pathname }) })
        selection = result
      } catch { /* A word can also be typed on browser-owned pages. */ }
    }
    if (frame.isConnected) frame.contentWindow.postMessage({ type:'enki:connect', ...selection }, origin, [channel.port2])
  }
  window.addEventListener('message', handshake)
  frame.src = origin + '/study-helper.html?' + new URLSearchParams({ mode, reader:chrome.runtime.id })
  panel.replaceChildren(status, frame)
}
for (const mode of ['word', 'application']) element('mode-' + mode).onclick = () => void openStudy(mode)
element('connect-enki')?.addEventListener('click', async () => {
  const button = element('connect-enki'), status = element('enki-connection-status')
  const enabled = button.dataset.enabled !== 'true'
  button.disabled = true
  try {
    if (enabled) void send('reader-enki-prepare').catch(() => {})
    if (enabled && !await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'], permissions: ['webNavigation'] })) {
      await send('reader-enki-connect', { enabled: false })
      status.textContent = 'Page access was declined. Connect again to enable ]]] in Dia.'
      return
    }
    await send('reader-enki-connect', { enabled })
    status.textContent = enabled ? 'Enki is connected. Press ]]] in Dia to read your current page.' : 'Enki’s browser connection is off.'
    await refresh()
  } catch (error) { status.textContent = error.message || 'Could not connect Enki. Reload Reader and try again.' }
  finally { button.disabled = false }
})
