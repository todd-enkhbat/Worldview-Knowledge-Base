const { createHash } = require('node:crypto')
function cloudAiIsOff(value) { return !!value && value.configured === false && (value.provider === null || value.provider === 'none') }
function sameWorkspace(path, fingerprint) { return typeof fingerprint === 'string' && createHash('sha256').update(path).digest('hex') === fingerprint }
const workspacePages = new Set([
  'today', 'todos', 'write', 'search', 'library', 'bookshelf', 'quotes', 'people', 'maps',
  'graph', 'topics', 'knowledge', 'review', 'sources', 'vocabulary', 'applications', 'explore',
])
const pageAliases = new Map([['todo', 'todos'], ['writing', 'write'], ['ask', 'search'], ['archive', 'library'], ['world', 'explore']])
function workspacePageFromUrl(value, origin) {
  if (!origin) return null
  try {
    const url = new URL(value)
    if (url.origin !== origin || url.pathname !== '/' || url.username || url.password) return null
    const page = /^#\/([a-z]+)\/?(?:\?|$)/.exec(url.hash)?.[1]
    const canonical = pageAliases.get(page) ?? page
    return workspacePages.has(canonical) ? '#/' + canonical : null
  } catch { return null }
}
function parseRecordLink(value) {
  if (typeof value !== 'string' || value.length > 4096) return null
  const match = /^worldview-local:\/\/record\/(person|company|capture)\/([^/?#]+)\?workspace=([a-f0-9]{64})$/.exec(value)
  if (!match) return null
  try {
    const id = decodeURIComponent(match[2])
    if (!id.trim() || id.length > 1000 || /[\u0000-\u001f\u007f]/.test(id)) return null
    const param = match[1] === 'company' ? 'tab=companies&company' : match[1]
    return { workspace: match[3], hash: '#/people?' + param + '=' + encodeURIComponent(id) }
  } catch { return null }
}
module.exports = { cloudAiIsOff, sameWorkspace, parseRecordLink, workspacePageFromUrl }
