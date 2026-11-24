/* global chrome */
const element = (id) => document.getElementById(id)
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
let paired = false
async function send(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, tabId: tab?.id, ...extra })
  if (!result?.ok && result?.error) throw new Error(result.error)
  return result
}
async function refresh() {
  const result = await send('reader-status'); paired = result.paired
  const following = !!result.tracked[tab?.id]
  element('state').textContent = !paired ? result.pendingConnection ? 'Waiting for your approval in Worldview' : 'Not connected' : following ? 'Following this article · badge ON' : 'Connected · choose an article to keep'
  element('connection').hidden = paired
  element('connection-help').textContent = result.pendingConnection ? 'Approve the browser request in Worldview, then reopen this popup to finish.' : 'Approve this browser in the local app. No IDs or tokens to copy.'
  element('connect').textContent = result.pendingConnection ? 'Open Worldview to approve' : 'Connect to Worldview'
  element('extension-id').value = result.extensionId
  element('queue').textContent = result.queued ? `${result.queued} pending captures · originals are safe on this browser` : 'All captures delivered'
  element('retry').hidden = !result.queued
  element('delivery').textContent = result.lastDeliveryAt ? `Last confirmed ${new Date(result.lastDeliveryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : paired ? 'Your next saved article will appear in My files.' : ''
  element('delivery-error').textContent = result.connectionError || (result.queued ? result.lastFailure || 'Open Worldview locally and retry.' : '')
  element('pending').replaceChildren(...(result.pending ?? []).slice(0, 20).map((entry) => { const li = document.createElement('li'), title = document.createElement('span'), remove = document.createElement('button'); title.textContent = entry.title; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove pending capture: ${entry.title}`); remove.addEventListener('click', async () => { if (!confirm('Remove this unsent capture? Saved library items are unchanged. You may need to save the article again before later progress can be delivered.')) return; remove.disabled = true; try { await send('reader-discard-one', { sequence: entry.sequence }); await refresh() } catch (error) { element('error').textContent = error instanceof Error ? error.message : 'The pending capture could not be removed.' } }); li.append(title, remove); return li }))
  element('follow').disabled = !paired; element('highlight').disabled = !paired; element('stop').disabled = !following
}
element('connect').addEventListener('click', async () => { element('connect').disabled = true; element('error').textContent = ''; try { const status = await send('reader-status'); const result = status.pendingConnection ? { openUrl: 'http://127.0.0.1:5173/#/sources?connection=browser' } : await send('reader-connect'); if (result.openUrl) await chrome.tabs.create({ url: result.openUrl }); await refresh() } catch (error) { element('error').textContent = error instanceof Error ? error.message : 'Open Worldview locally, then try connecting again.' } finally { element('connect').disabled = false } })
for (const [id, type, message] of [['follow','reader-follow','Article saved. Reading progress is followed only in this chosen tab.'],['highlight','reader-highlight','Selected passage and comment saved.'],['stop','reader-stop','Following stopped for this tab.'],['pair','reader-pair','Pairing saved on this browser.'],['retry','reader-retry','Pending captures retried.'],['discard','reader-discard','Pending captures discarded.'],['disconnect','reader-disconnect','Browser disconnected. Revoke its token in Worldview too.']]) {
  element(id).addEventListener('click', async () => {
    if (['discard','disconnect'].includes(id) && !confirm(id === 'discard' ? 'Discard unsent captures from this browser?' : 'Disconnect and discard unsent captures from this browser?')) return
    element('error').textContent = ''; element(id).disabled = true
    const submittedToken = element('token').value.trim(), submittedNote = element('note').value
    try { const result = await send(type, { token: submittedToken, note: submittedNote }); element('notice').textContent = result.result?.queued ? 'Queued on this browser. The local workspace has not confirmed it yet; retry pending captures when available.' : message; if (id === 'pair' && element('token').value.trim() === submittedToken) element('token').value = ''; if (['follow','highlight'].includes(id) && !result.result?.queued && element('note').value === submittedNote) element('note').value = ''; await refresh() }
    catch (error) { element('error').textContent = error instanceof Error ? error.message : 'Capture failed. Open your local workspace and retry.' }
    finally { element(id).disabled = false }
  })
}
try { await refresh() } catch { element('error').textContent = 'The reader could not initialize. Reload this unpacked extension.' }
