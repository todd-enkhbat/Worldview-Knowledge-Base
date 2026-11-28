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

it('makes refreshing an already-saved contact available without choosing another group', async () => {
  const api=await mount({...person,schools:['Columbia University · Attended']})
  await click('Read profile'); await click('Save contact')
  expect(host.textContent).toContain('Columbia University')
  expect(button('Update from profile').closest('details')).toBeNull()
  await click('Update from profile')
  expect(api.save).toHaveBeenLastCalledWith('preview','')
  expect(host.textContent).toContain('Updated from profile.')
})

it('renders a screen suggestion and collects only after a click, without asking Dia to read', async () => {
  const api = await mount()
  const suggestion = { id: 'screen', name: 'Ada Example', headline: 'Researcher', url: '', phone: '', source: 'LinkedIn' }
  const watching = { status: 'watching' as const, suggestion }
  const screenSave = vi.fn().mockResolvedValue({ status: 'saved' })
  await act(async () => root.render(<EnkiPerson autoRead bridge={{
    ...api, screenState: async () => watching, onScreenContacts: () => () => {},
    screenStart: async () => watching, screenNow: async () => watching, screenPause: async () => ({ status: 'off', suggestion: null }),
    screenSettings: async () => {}, screenDismiss: async () => {}, screenSave,
  }} />))
  expect(api.read).not.toHaveBeenCalled()
  expect(screenSave).not.toHaveBeenCalled()
  expect(host.querySelector<HTMLInputElement>('input[name=contactName]')?.value).toBe('Ada Example')
  await click('Collect contact')
  expect(screenSave).toHaveBeenCalledExactlyOnceWith('screen', { name: 'Ada Example', headline: 'Researcher', phone: '' })
  expect(host.textContent).toContain('Contact saved to People.')
})

it('uses connected Dia instead of screen scanning and renders the shared saved record', async () => {
  const screenState = vi.fn()
  const api = {
    read: vi.fn().mockResolvedValue({id:'dia-preview',profile:person,workspace:'Test',
      existing:{recordId:'ada',groupIds:[]},groups:[]}),
    save: vi.fn(), openBrowser: vi.fn(), openRecord: vi.fn(),
    screenState, onScreenContacts: vi.fn(),
    organization: vi.fn().mockResolvedValue({
      record:{id:'ada',fullName:'Ada Example'}, evidence:{}, groups:[], memberships:[],
      affiliations:[{kind:'education',organization:'University of California, Berkeley'}],
      connections:[{id:'berkeley',name:'University of California, Berkeley',type:'university',logoUrl:'https://images.example/berkeley.png'}],
      people:[],fields:[],notes:[],tasks:[],interactions:[],history:[],
    }),
  } as unknown as ProfileBridge
  await act(async () => root.render(<EnkiPerson bridge={api} autoRead browserConnected />))
  expect(api.read).toHaveBeenCalledWith('dia')
  expect(screenState).not.toHaveBeenCalled()
  expect(host.textContent).toContain('Schools')
  expect(host.textContent).toContain('University of California, Berkeley')
  expect(host.querySelector('img[src="https://images.example/berkeley.png"]')).not.toBeNull()
  const notes = host.querySelector<HTMLButtonElement>('button[aria-label="Notes"]')!
  await act(async () => notes.click())
  expect(host.querySelector('textarea')).not.toBeNull()
})

it('follows a changed Dia profile automatically and pauses while a draft is being edited', async () => {
  vi.useFakeTimers()
  try {
    const next = {...person,name:'Grace Example',url:'https://example.org/grace'}
    let page = {id:'1',url:person.url,documentId:'ada-document'}
    const api = {
      read: vi.fn().mockImplementation(async () => ({
        id:page.documentId,profile:page.url === person.url ? person : next,workspace:'Test',groups:[],
      })),
      followPage:vi.fn(async () => page),save:vi.fn(),openBrowser:vi.fn(),openRecord:vi.fn(),
    } as unknown as ProfileBridge
    await act(async () => root.render(<EnkiPerson bridge={api} autoRead browserConnected />))
    await act(async () => vi.advanceTimersByTimeAsync(1500))
    expect(api.read).toHaveBeenCalledTimes(1)
    const draft = document.createElement('form')
    draft.innerHTML='<textarea aria-label="Draft note">Keep this draft</textarea>'
    host.querySelector('.enki-profile')!.append(draft)
    page={id:'2',url:next.url,documentId:'grace-document'}
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(api.read).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Following paused')
    expect(draft.querySelector('textarea')?.value).toBe('Keep this draft')
    draft.remove()
    await act(async () => vi.advanceTimersByTimeAsync(1500))
    expect(api.read).toHaveBeenCalledTimes(2)
    expect(host.querySelector('#enki-preview-name')?.textContent).toBe('Grace Example')
    expect(api.save).not.toHaveBeenCalled()
    await act(async () => root.render(<EnkiPerson bridge={api} autoRead={false} browserConnected />))
    const calls=vi.mocked(api.followPage!).mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(api.followPage).toHaveBeenCalledTimes(calls)
  } finally { vi.useRealTimers() }
})
