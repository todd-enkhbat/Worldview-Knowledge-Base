import { readFileSync } from 'node:fs'

/** Keep the VM popup fixtures on the same module code the unpacked extension runs. */
export function popupScript() {
  const icons = readFileSync('extensions/worldview-reader/group-icon.js', 'utf8').replace('export function groupDisplay', 'function groupDisplay')
  const form = readFileSync('extensions/worldview-reader/application-form.js', 'utf8').replace('export function readApplicationForm', 'function readApplicationForm')
  return readFileSync('extensions/worldview-reader/popup.js', 'utf8').replace("import { readApplicationForm } from './application-form.js'", () => form).replace("import { groupDisplay } from './group-icon.js'", () => icons)
}
