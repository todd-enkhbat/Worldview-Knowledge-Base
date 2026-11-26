// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EnkiPerson, type ProfileBridge } from '../../src/study/EnkiPerson.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
type Preview = Extract<Awaited<ReturnType<ProfileBridge['read']>>, { id: string }>
const person: Preview['profile'] = {
  entityType: 'person', name: 'Ada Example', url: 'https://example.org/ada', headline: 'Researcher',
  companies: [], schools: [], photo: '', website: '', industry: '',
}
let host: HTMLDivElement, root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

async function mount(profile: Preview['profile'] = person) {
  const api = {
    read: vi.fn<ProfileBridge['read']>().mockResolvedValue({ id: 'preview', profile, workspace: 'Test',
      groups: [{ id: 'friends', name: 'Friends', emoji: '🌱' }, { id: 'readers', name: 'Readers' }],
    }),
    save: vi.fn<ProfileBridge['save']>().mockImplementation(async (_id, group) => ({ status: 'saved', existing: {recordId:'ada',groupIds:group === 'readers' ? ['friends','readers'] : [group].filter(Boolean)} })),
    openBrowser: vi.fn<ProfileBridge['openBrowser']>().mockResolvedValue(undefined),
    openRecord: vi.fn<ProfileBridge['openRecord']>().mockResolvedValue(undefined),
  }
  await act(async () => root.render(<EnkiPerson bridge={api} />))
  return api
}
const button = (text: string) => Array.from(host.querySelectorAll('button')).find(el => el.textContent.trim() === text)!
async function click(text: string) { await act(async () => button(text).click()) }
async function select(field: HTMLSelectElement, value: string) {
  await act(async () => { field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })) })
}
const fact = (label: string) => Array.from(host.querySelectorAll('dt')).find(dt => dt.textContent === label)?.nextElementSibling

it('reads explicitly, displays a contact without a portrait, and saves multiple group memberships', async () => {
  const api = await mount()
  expect(api.read).not.toHaveBeenCalled()
  await click('Read profile')
  expect(api.read).toHaveBeenCalledWith('dia')
  expect(host.querySelector('article h1')?.textContent).toBe(person.name)
  expect(host.querySelector('article img')).toBeNull()
  expect(fact('Current company')?.textContent.trim()).toBe('Not shown')
  expect(fact('Alma mater')?.textContent.trim()).toBe('Not shown')
  const group = host.querySelector<HTMLSelectElement>('article select')!
  expect(document.activeElement).toBe(group)
  expect(button('Read profile').closest('details')?.open).toBe(false)
  expect(button('Save contact').closest('details')).toBeNull()
  expect(group.textContent).toContain('🌱 Friends')
  await select(group, 'friends')
  await click('Save contact')
  expect(button('Open contact')).toBeDefined()
  await click('+ Add group')
  const next = host.querySelector<HTMLSelectElement>('article select[name=group]')!
  expect(next.textContent).not.toContain('Friends')
  await select(next, 'readers')
  expect(api.save.mock.calls).toEqual([['preview', 'friends'], ['preview', 'readers']])
  expect(host.querySelector('.enki-membership')?.textContent).toContain('Readers')
  await click('Open contact')
  expect(api.openRecord).toHaveBeenCalledOnce()
})

it('shows organization details and identifies previously saved person facts per field', async () => {
  await mount({ ...person, entityType: 'company', name: 'Research Lab', website: 'https://example.org/', industry: 'Software' })
  await click('Read profile')
  expect(fact('Website')?.textContent.trim()).toBe('https://example.org/')
  expect(fact('Industry')?.textContent.trim()).toBe('Software')
  expect(fact('Alma mater')).toBeUndefined()
  await mount({ ...person, companies: ['Existing Lab'], savedCompanies: true, schools: ['Primary School · Attended'], savedSchools: false })
  await click('Read profile')
  expect(fact('Current company')?.textContent).toContain('Existing Lab')
  expect(fact('Current company')?.querySelector('small')?.textContent).toBe('From Worldview')
  expect(fact('Alma mater')?.textContent.trim()).toBe('Primary School · Attended')
})

it('opens the Worldview browser and reads it explicitly without requesting Dia', async () => {
  const api = await mount()
  await select(host.querySelector('select')!, 'browser')
  const field = host.querySelector<HTMLInputElement>('[name=profileUrl]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, person.url)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('Open page')
  expect(api.openBrowser).toHaveBeenCalledWith(person.url)
  expect(api.read).not.toHaveBeenCalled()
  await click('Read profile')
  expect(api.read.mock.calls).toEqual([['browser']])
})
