function nameKey(name) {
  const key = name.normalize('NFC').toLowerCase().trim().replace(/\s+/gu,' ')
  return key.includes(' ') ? key : ''
}
function matchNames(candidates, names) {
  const contacts = new Map(), crm = new Map()
  for (const name of names) {
    const key = nameKey(name)
    if (key) contacts.set(key,(contacts.get(key) ?? 0)+1)
  }
  for (const {id,name} of candidates) {
    const key = nameKey(name)
    if (key) crm.set(key,crm.has(key) ? null : id)
  }
  const ids = []
  let ambiguous = 0
  for (const [key,id] of crm) {
    if (!contacts.has(key)) continue
    if (id && contacts.get(key)===1) ids.push(id)
    else ambiguous++
  }
  return {ids,ambiguous}
}
module.exports = {matchNames}
