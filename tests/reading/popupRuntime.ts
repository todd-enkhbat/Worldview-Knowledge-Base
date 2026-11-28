import { readFileSync } from 'node:fs'

/** Keep the VM popup fixtures on the same module code the unpacked extension runs. */
export function popupScript() {
  const icons = readFileSync('extensions/worldview-reader/group-icon.js', 'utf8').replace('export function groupDisplay', 'function groupDisplay')
  const form = readFileSync('extensions/worldview-reader/application-form.js', 'utf8').replace(/^export /gm, '')
  const ui = readFileSync('extensions/worldview-reader/contact-ui.js', 'utf8').replaceAll('export function ', 'function ')
  const events = readFileSync('extensions/worldview-reader/reader-events-ui.js', 'utf8').replace(/^export /gm, '')
  const organization = readFileSync('extensions/worldview-reader/organization-ui.js', 'utf8').replace(/^import .*reader-events-ui\.js.*$/m, () => events).replace(/^export /gm, '')
  return readFileSync('extensions/worldview-reader/popup.js', 'utf8').replace("import { contactActions, renderPeopleRows, renderProfileIdentity } from './contact-ui.js'", () => ui).replace(/^import .*application-form\.js.*$/m, () => form).replace("import { groupDisplay } from './group-icon.js'", () => icons).replace(/^import .*organization-ui\.js.*$/m, () => organization)
}
