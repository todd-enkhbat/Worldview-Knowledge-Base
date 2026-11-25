/* global chrome */
const element = (id) => document.getElementById(id)
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
const folkGroupPage = /^https:\/\/app\.folk\.app\/apps\/contacts\/network\/[0-9a-f-]{36}\/groups\/[0-9a-f-]{36}(?:[/?#]|$)/i.test(tab?.url || '')
const folkAppPage = /^https?:\/\/app\.folk\.app(?:[/:?#]|$)/i.test(tab?.url || '')
const folkSearchPage = /^https:\/\/app\.folk\.app\/apps\/contacts\/network\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/search(?:[?#]|$)/i.test(tab?.url || '')
const folkSearchTypes = folkSearchPage ? [...new URL(tab.url).searchParams].filter(([key]) => key.toLowerCase() === 'type') : []
const folkPersonSearchPage = folkSearchPage && (!folkSearchTypes.length || folkSearchTypes.length === 1 && folkSearchTypes[0][0] === 'type' && folkSearchTypes[0][1] === 'person')
let paired = false, following = false, followingFolk = false
const submitting = new Set()
function captureControls() {
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
  const draft = result?.profileDraft
  if (!draft?.id) return 'The profile draft was not confirmed. Open Worldview and retry.'
  return `${draft.profile?.name || 'Profile'} source saved locally. Review the collected fields in People before adding or updating a record.`
}
async function openProfileReview(id) {
  const destination = `http://127.0.0.1:5173/#/people?capture=${encodeURIComponent(id)}`
  const candidates = await chrome.tabs.query({ url: ['http://127.0.0.1:5173/*', 'http://localhost:5173/*'] })
  const existing = candidates.filter(candidate => Number.isSafeInteger(candidate.id) && (() => { try { const url = new URL(candidate.url); return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '5173' } catch { return false } })()).sort((a, b) => Number(b.windowId === tab?.windowId) - Number(a.windowId === tab?.windowId))[0]
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
  followingFolk = !!result.folkTracked?.[tab?.id]; following = !!result.tracked[tab?.id] || followingFolk
  element('state').textContent = !paired ? result.pendingConnection ? 'Waiting for your approval in Worldview' : 'Not connected' : followingFolk ? 'Following visible Folk photos · badge PH' : following ? 'Following this article · badge ON' : folkGroupPage ? 'Connected · visible Folk photos' : folkAppPage ? 'Connected · private Folk workspace' : 'Connected · choose what to keep'
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
}
element('connect').addEventListener('click', async () => { element('connect').disabled = true; element('error').textContent = ''; try { const status = await send('reader-status'); const result = status.pendingConnection ? { openUrl: 'http://127.0.0.1:5173/#/sources?connection=browser' } : await send('reader-connect'); if (result.openUrl) await chrome.tabs.create({ url: result.openUrl }); await refresh() } catch (error) { element('error').textContent = error instanceof Error ? error.message : 'Open Worldview locally, then try connecting again.' } finally { element('connect').disabled = false } })
for (const [id, type, message] of [['profile-data','reader-profile-data',''],['folk-photos','reader-folk-photos',''],['folk-follow','reader-folk-follow',''],['folk-search-diagnostic','reader-folk-search-diagnostic',''],['folk-search-photos','reader-folk-search-photos',''],['folk-search-follow','reader-folk-search-follow',''],['profile','reader-profile',''],['follow','reader-follow','Article saved. Reading progress is followed only in this chosen tab.'],['highlight','reader-highlight','Selected passage and comment saved.'],['stop','reader-stop','Following stopped for this tab.'],['pair','reader-pair','Pairing saved on this browser.'],['retry','reader-retry','All pending captures delivered.'],['discard','reader-discard','Pending captures discarded.'],['disconnect','reader-disconnect','Browser disconnected. Revoke its token in Worldview too.']]) {
  element(id).addEventListener('click', async () => {
    if (submitting.has(id)) return
    if (['discard','disconnect'].includes(id) && !confirm(id === 'discard' ? 'Discard unsent captures from this browser?' : 'Disconnect and discard unsent captures from this browser?')) return
    element('error').textContent = ''; submitting.add(id); element(id).disabled = true; captureControls()
    const submittedToken = element('token').value.trim(), submittedNote = element('note').value
    try {
      const result = await send(type, { token: submittedToken, note: submittedNote }), receipt = result.result
      const folkAction = ['folk-photos', 'folk-follow', 'folk-search-diagnostic', 'folk-search-photos', 'folk-search-follow'].includes(id)
      element('notice').textContent = receipt?.profileDraft || id === 'profile-data' ? profileDataNotice(receipt) : receipt?.contactPhoto || id === 'profile' ? photoNotice(receipt) : receipt?.folkPhotos || folkAction ? folkNotice(receipt) + (['folk-follow', 'folk-search-follow'].includes(id) ? ' Following this page’s visible rows. Move through the list; use Stop when finished.' : '') : receipt?.queued ? 'Queued on this browser. The local workspace has not confirmed it yet; retry pending captures when available.' : message
      if (id === 'profile-data' || receipt?.profileDraft) element('profile-data-status').textContent = element('notice').textContent
      if (receipt?.profileDraft?.id && !receipt?.queued) await openProfileReview(receipt.profileDraft.id)
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
