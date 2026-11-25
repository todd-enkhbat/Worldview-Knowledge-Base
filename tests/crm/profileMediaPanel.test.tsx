// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCrmRecord } from '../../src/crm/model.ts'
import { ProfileMediaPanel } from '../../src/crm/socialProfiles.tsx'

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('../../src/crm/profileMediaClient.ts', () => ({ profileMediaGet: api.get, profileMediaPost: api.post }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement
const changed = vi.fn(), person = createCrmRecord('people', { id: 'person_1', fullName: 'Ada Example', urls: ['https://ada.example'] }, 1000)
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); changed.mockClear()
  api.get.mockReset().mockResolvedValue({ personId: person.id, recordRevision: person.revision, avatarAssetId: null, photoCandidates: [{ id: 'photo_1', url: 'https://ada.example/photo.jpg', sourceUrl: 'https://ada.example', label: 'Profile photo', kind: 'page' }], links: [{ url: 'https://github.com/ada', platform: 'github', label: 'GitHub', sourceUrl: 'https://ada.example' }], notices: ['Only the attached public page was inspected.'] })
  api.post.mockReset().mockResolvedValue({ record: { ...person, revision: 2 }, downloaded: true, addedLinks: 1, notices: [] })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
async function render(disabled = false) { await act(async () => root.render(<ProfileMediaPanel person={person} disabled={disabled} onChanged={changed} />)) }
function button(label: string) { const value = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label); expect(value, label).toBeDefined(); return value! }
async function click(label: string) { await act(async () => button(label).click()) }
async function input(label: string, value: string) { const element = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) }) }

it('previews attached source profiles without loading remote images or applying a candidate', async () => {
  await render()
  expect(api.get).not.toHaveBeenCalled()
  await click('Find photos & profiles')
  expect(api.get).toHaveBeenCalledWith(person.id, true)
  expect(host.textContent).toContain('Profile photo')
  expect(host.textContent).toContain('GitHub')
  expect(host.textContent).toContain('Only the attached public page was inspected.')
  expect(host.querySelector('img')).toBeNull()
  expect(api.post).not.toHaveBeenCalled()
  await click('Save photo')
  expect(api.post).toHaveBeenCalledWith(person.id, expect.objectContaining({ expectedRecordRevision: person.revision, photoUrl: 'https://ada.example/photo.jpg', sourceUrl: 'https://ada.example', replacePhoto: true, requestId: expect.any(String) }))
  expect(changed).toHaveBeenCalledOnce()
  expect(host.textContent).toContain('Photo saved locally.')
})

it('requires a checked person/source match and retains a failed manual image draft with its retry identity', async () => {
  api.post.mockRejectedValueOnce(new Error('Image server is unavailable'))
  await render(); await click('Add image URL'); await input('Profile image URL', 'https://ada.example/photo.jpg')
  const source = host.querySelector<HTMLSelectElement>('[aria-label="Profile image source page"]')!
  await act(async () => { source.value = person.urls[0]; source.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(button('Save photo locally').disabled).toBe(true)
  await act(async () => host.querySelector<HTMLInputElement>('[type="checkbox"]')!.click())
  await click('Save photo locally')
  expect(host.textContent).toContain('Image server is unavailable')
  expect(host.querySelector<HTMLInputElement>('[aria-label="Profile image URL"]')!.value).toBe('https://ada.example/photo.jpg')
  expect(source.value).toBe(person.urls[0])
  expect(host.querySelector<HTMLInputElement>('[type="checkbox"]')!.checked).toBe(true)
  const first = api.post.mock.calls[0]
  await click('Save photo locally')
  expect(api.post.mock.calls[1]).toEqual(first)
  expect(first[1]).toMatchObject({ sourceUrl: person.urls[0], confirmManualPhoto: true, replacePhoto: true })
  expect(host.querySelector('[aria-label="Profile image URL"]')).toBeNull()
  expect(changed).toHaveBeenCalledOnce()
})

it('keeps source actions unavailable in a read-only window', async () => {
  await render(true)
  expect(button('Find photos & profiles').disabled).toBe(true)
  expect(button('Add image URL').disabled).toBe(true)
  await click('Find photos & profiles')
  expect(api.get).not.toHaveBeenCalled()
  expect(api.post).not.toHaveBeenCalled()
})

it('shows saved source provenance without using the source as a tracking image', async () => {
  await act(async () => root.render(<ProfileMediaPanel person={{ ...person, avatarAssetId: 'crm-avatar-local', portraitSource: { sourceUrl: 'https://ada.example/about', label: 'Personal website' } }} disabled={false} onChanged={changed} />))
  const provenance = host.querySelector<HTMLAnchorElement>('.crm-profile-media-provenance a')!
  expect(provenance.href).toBe('https://ada.example/about')
  expect(provenance.textContent).toBe('Personal website')
  expect(host.textContent).toContain('Local photo')
  expect(host.querySelector('img')).toBeNull()
})
