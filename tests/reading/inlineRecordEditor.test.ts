// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { mountOrganizationEditor } from '../../extensions/worldview-reader/organization-ui.js'

let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); document.body.replaceChildren() })
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }
async function setup() {
  const host = document.createElement('div'); document.body.append(host)
  let record = { id: 'ada', revision: 3, fullName: 'Ada', emails: ['ada@example.org', 'other@example.org'], phones: [] }
  const model = () => ({ record, affiliations: [{ id: 'school', kind: 'education', organization: 'Berkeley', evidence: [] }], connections: [], groups: [], memberships: [], fields: [], interactions: [], notes: [], tasks: [], history: [] })
  const request = vi.fn(async (payload: Record<string, unknown>) => {
    if (payload.action === 'edit') record = { ...record, ...payload.patch as object, revision: record.revision + 1 }
    return model()
  })
  dispose = mountOrganizationEditor(host, { request, personLink() {}, companyLink() {}, onChange() {}, entityType: 'person' })
  await settle()
  const click = (label: string) => (host.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click()
  return { host, request, click }
}

it('edits a single email, preserves other values, and returns focus to the saved value', async () => {
  const f = await setup(); f.click('Edit email addresses')
  const input = f.host.querySelector('.reader-inline-form input') as HTMLInputElement
  expect(document.activeElement).toBe(input)
  input.value = 'new@example.org'; input.form!.requestSubmit(); await settle()
  expect(f.request).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'edit', revision: 3, patch: { emails: ['new@example.org', 'other@example.org'] } }))
  expect(f.host.querySelector('.reader-inline-form')).toBeNull()
  expect(document.activeElement?.textContent).toBe('new@example.org')
})

it('cancels without saving and keeps a failed draft open while preventing navigation', async () => {
  const f = await setup(); f.click('Add phone numbers')
  let input = f.host.querySelector('.reader-inline-form input') as HTMLInputElement
  input.value = '+1 555 0123'
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(f.request).toHaveBeenCalledTimes(1)
  f.click('Edit school'); input = f.host.querySelector('.reader-inline-form input') as HTMLInputElement
  input.value = 'Columbia University'; f.request.mockRejectedValueOnce(Error('Connection lost. Try saving again.'))
  input.form!.requestSubmit(); await settle()
  expect(input.value).toBe('Columbia University'); expect(input.disabled).toBe(false)
  expect(f.host.textContent).toContain('Connection lost')
  ;(f.host.querySelector('nav button:nth-child(4)') as HTMLButtonElement).click()
  expect(f.host.querySelector('section[aria-label="Details"]')?.hasAttribute('hidden')).toBe(false)
  expect(document.activeElement).toBe(input)
})
