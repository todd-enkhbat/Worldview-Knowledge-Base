// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProfileCaptureAffiliations } from '../../src/crm/ProfileCaptureAffiliations.tsx'
import type { CrmAffiliation } from '../../src/crm/types.ts'
vi.mock('../../src/crm/socialProfiles.tsx', () => ({ safeProfileUrl: (value: string) => /^https?:\/\//.test(value) ? value : '' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
const school: CrmAffiliation = { id: 'school', kind: 'education', organization: 'Example University', degree: 'BA', evidence: [{ label: 'Captured profile', url: 'https://example.org/ada', excerpt: 'Visible education entry.' }] }
const work: CrmAffiliation = { id: 'work', kind: 'employment', organization: 'Example Company', role: 'Engineer', evidence: [] }
const save = vi.fn(async () => true)
const button = (label: string) => { const found = [...host.querySelectorAll('button')].find(value => value.textContent?.trim() === label || value.getAttribute('aria-label') === label); if (!found) throw new Error('Missing ' + label); return found }
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.clearAllMocks() })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
it('preserves retained source evidence and unrelated rows when removing one affiliation', async () => {
  await act(async () => root.render(<ProfileCaptureAffiliations affiliations={[school, work]} revision={4} disabled={false} onSave={save} />))
  expect(host.textContent).toContain('Education'); expect(host.textContent).toContain('Experience'); expect(host.textContent).toContain('Visible education entry.')
  await act(async () => button('Remove Example Company experience').click()); expect(save).toHaveBeenCalledWith([school], 4); expect(school.evidence[0].excerpt).toBe('Visible education entry.')
})
it('keeps an open affiliation edit bound to its original record revision', async () => {
  await act(async () => root.render(<ProfileCaptureAffiliations affiliations={[school]} revision={4} disabled={false} onSave={save} />))
  await act(async () => button('Edit Example University education').click())
  await act(async () => root.render(<ProfileCaptureAffiliations affiliations={[{ ...school, degree: 'A newer degree' }]} revision={5} disabled={false} onSave={save} />))
  expect(button('Save affiliation').disabled).toBe(true); expect(host.textContent).toContain('This contact changed'); expect(save).not.toHaveBeenCalled()
  await act(async () => button('Cancel').click()); await act(async () => button('Edit Example University education').click()); await act(async () => button('Save affiliation').click())
  expect(save).toHaveBeenCalledWith([{ ...school, degree: 'A newer degree' }], 5)
})
