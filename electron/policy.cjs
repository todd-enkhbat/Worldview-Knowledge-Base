const { createHash } = require('node:crypto')
function cloudAiIsOff(value) { return !!value && value.configured === false && (value.provider === null || value.provider === 'none') }
function sameWorkspace(path, fingerprint) { return typeof fingerprint === 'string' && createHash('sha256').update(path).digest('hex') === fingerprint }
module.exports = { cloudAiIsOff, sameWorkspace }
