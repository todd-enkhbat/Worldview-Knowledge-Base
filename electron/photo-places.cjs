// Only the foreground local workspace's main frame receives PhotoKit results.
// Bind every page to the same window and workspace even across a consent dialog.
const { randomUUID } = require('node:crypto')
function registerPhotoPlaces({ ipcMain, getWorkspace, readNative }) {
  let scan = null, queue = Promise.resolve()
  function current(event) {
    const workspace = getWorkspace()
    if (!workspace || event.sender !== workspace.contents || event.senderFrame !== workspace.contents.mainFrame ||
        !event.senderFrame?.url.startsWith(workspace.origin + '/')) {
      throw new Error('Open Maps in the local Worldview window to use Apple Photos.')
    }
    return { path: workspace.path, origin: workspace.origin, frame: event.senderFrame }
  }
  function same(a, b) { return !!a && a.path === b.path && a.origin === b.origin && a.frame === b.frame }
  function bind(channel, handler) {
    ipcMain.handle(channel, (event, input) => {
      const owner = current(event)
      const verify = () => { if (!same(owner, current(event))) throw new Error('The workspace changed. Open Photos again in Maps.') }
      const work = queue.then(async () => { verify(); const result = await handler(input, owner); verify(); return result })
      queue = work.catch(() => {})
      return work
    })
  }
  bind('worldview:match-contact-names', async candidates => {
    if (!Array.isArray(candidates) || !candidates.every(p=>typeof p?.id==='string' && typeof p.name==='string')) throw new Error('Choose existing CRM people.')
    const names = JSON.parse(await readNative(true))
    return require('./contact-names.cjs').matchNames(candidates,names)
  })
  bind('worldview:photo-places', async (input, owner) => {
    const offset = input?.offset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 0xffffffff) throw new Error('Choose a valid Photos page.')
    if (offset && (!scan || !same(scan.owner, owner) || scan.nextOffset !== offset || scan.token !== input.snapshotToken)) throw new Error('Start this Photos import again in Maps.')
    const token = offset ? scan.token : randomUUID()
    const labels = offset ? scan.labels : input?.includeLabels === true
    scan = null
    const result = JSON.parse(await readNative(offset, !offset && input?.requestAccess !== false, labels))
    if (result.nextOffset !== null) scan = { owner, nextOffset: result.nextOffset, token, labels }
    return { ...result, snapshotToken: token }
  })
  bind('worldview:photo-thumbnail', async id => {
    if (typeof id !== 'string' || !id.trim() || Buffer.byteLength(id) > 1023 || id.includes('\0')) throw new Error('Choose a photo from your library.')
    return JSON.parse(await readNative(id))
  })
}
module.exports = { registerPhotoPlaces }
