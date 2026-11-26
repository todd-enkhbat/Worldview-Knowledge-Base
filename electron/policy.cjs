const { createHash } = require('node:crypto')
function cloudAiIsOff(value) { return !!value && value.configured === false && (value.provider === null || value.provider === 'none') }
function sameWorkspace(path, fingerprint) { return typeof fingerprint === 'string' && createHash('sha256').update(path).digest('hex') === fingerprint }
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
module.exports = { cloudAiIsOff, sameWorkspace, parseRecordLink }
