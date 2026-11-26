// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProfileCaptureAffiliations } from '../../src/crm/ProfileCaptureAffiliations.tsx'
import { PersonAffiliationBoxes } from '../../src/crm/PersonAffiliationBoxes.tsx'
import { CompanyProfile } from '../../src/crm/CompanyProfile.tsx'
import { createCrmRecord } from '../../src/crm/model.ts'
import type { CrmAffiliation } from '../../src/crm/types.ts'
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

it('groups roles by organization, exposes dated descriptions, and separates school credentials', async () => {
  const company = createCrmRecord('companies', { id: 'acme', name: 'Acme', domain: 'acme.example', urls: ['https://www.linkedin.com/company/acme/'] }, 1)
  const current: CrmAffiliation = { ...work, id: 'now', organization: 'Acme', organizationId: company.id, role: 'Engineering director', startDate: '2024', current: true, description: 'Built the technical team.' }
  const former: CrmAffiliation = { ...work, id: 'before', organization: 'Acme', role: 'Engineer', startDate: '2020', endDate: '2024', excerpt: 'Engineer · Acme · 2020 – 2024 · Developed the first prototype.' }
  const openCompany = vi.fn()
  await act(async () => root.render(<ProfileCaptureAffiliations affiliations={[school, former, current]} organizations={[company]} linkedCompanies={[company]} onOpenCompany={openCompany} revision={3} disabled={false} onSave={save} />))
  const experience = host.querySelector('section[aria-label="Experience"]')!
  expect(experience.querySelectorAll('article')).toHaveLength(1)
  expect([...experience.querySelectorAll('ol strong')].map(node => node.textContent)).toEqual(['Engineering director', 'Engineer'])
  expect(experience.textContent).toContain('2024 — Present')
  expect(experience.textContent).toContain('Former role2020 — 2024')
  expect(experience.querySelector('.crm-career-description')!.textContent).toBe('Built the technical team.')
  expect(experience.querySelectorAll('.crm-career-description')[1].textContent).toBe('Developed the first prototype.')
  const destination = experience.querySelector<HTMLAnchorElement>('h5 a')!
  expect(destination.getAttribute('href')).toBe('#/people?tab=companies&company=acme')
  await act(async () => destination.click())
  expect(openCompany).toHaveBeenCalledWith(company)
  expect(experience.querySelector('a[href="https://acme.example/"]')).not.toBeNull()
  expect(experience.querySelector('a[href="https://www.linkedin.com/company/acme/"]')).not.toBeNull()
  expect(host.querySelector('section[aria-label="Education"]')?.textContent).toContain('BA')
})

it('shows a linked employer on an older record without inventing dates or a current role', async () => {
  const org = createCrmRecord('companies', { id: 'legacy', name: 'Legacy Studio' }, 1)
  await act(async () => root.render(<ProfileCaptureAffiliations linkedCompanies={[org]} jobTitle="Designer" revision={1} disabled={false} onSave={save} />))
  expect(host.textContent).toContain('Designer')
  expect(host.textContent).toContain('Linked company · Dates unconfirmed')
  expect(host.textContent).not.toContain('Current role')
})

it('shows only current employers at the top and opens linked schools or exact school searches', async () => {
  const mit = createCrmRecord('companies', { id: 'mit', name: 'MIT', organizationType: 'university' })
  const legacy = createCrmRecord('companies', { id: 'old', name: 'Past employer' })
  const current = createCrmRecord('companies', { id: 'org', name: 'Current employer' })
  const former = { ...work, id: 'old-role', organizationId: legacy.id, organization: legacy.name, endDate: '2022' }
  const present = { ...work, id: 'now', organizationId: current.id, organization: current.name, current: true }
  const college = { ...school, id: 'mit-role', organization: 'MIT', organizationId: 'mit', endDate: '2022' }
  const columbia = { ...school, id: 'columbia', organization: 'Columbia University', current: true }
  const open = vi.fn(), browse = vi.fn()
  await act(async () => root.render(<PersonAffiliationBoxes affiliations={[former, present, college, columbia]} companies={[legacy, mit, current]} organizations={[mit]} onOpen={open} onBrowse={browse} />))
  const companies = host.querySelector('section[aria-label="Current company"]')!, schools = host.querySelector('section[aria-label="Alma mater & schools"]')!
  expect(companies.textContent).toContain('Current employer')
  expect(companies.textContent).not.toMatch(/Past employer|MIT/)
  expect(schools.textContent).toContain('MITAttended · BA')
  expect(schools.textContent).toContain('Columbia UniversityCurrent student')
  const links = schools.querySelectorAll('a')
  await act(async () => { links[0].click(); links[1].click() })
  expect(open).toHaveBeenCalledWith(mit)
  expect(links[1].getAttribute('href')).toBe('#/people?tab=people&school=Columbia%20University')
  expect(browse).toHaveBeenCalledWith('almaMater', 'Columbia University')
  await act(async () => root.render(<ProfileCaptureAffiliations affiliations={[college]} linkedCompanies={[mit]} organizations={[mit]} revision={1} disabled={false} onSave={save} />))
  expect(host.querySelector('[aria-label="Experience"]')).toBeNull()
})

it('separates current students, confirmed alumni and other attendees from employment in the school roster', async () => {
  const school = createCrmRecord('companies', { id: 'school', name: 'Columbia University' })
  const people = ['Student', 'Alum', 'Attendee', 'Teacher'].map(name => createCrmRecord('people', { id: name, fullName: name }))
  const select = vi.fn()
  await act(async () => root.render(<CompanyProfile company={school} roster={{ education: people.slice(0,3), current: [people[3]], former: [], other: [], educationStatuses: { Student: ['student'], Alum: ['graduate'], Attendee: ['attended'] } }} onSelect={select} />))
  const student = host.querySelector<HTMLAnchorElement>('section[aria-label="Current students"] a')!
  expect(student.textContent).toContain('Student')
  expect(host.querySelector('section[aria-label="Alumni"] a')?.textContent).toContain('Alum')
  expect(host.querySelector('section[aria-label="Attended"] a')?.textContent).toContain('Attendee')
  expect(host.querySelector('section[aria-label="Currently working here"]')?.textContent).not.toMatch(/Student|Alum|Attendee/)
  await act(async () => student.click())
  expect(select).toHaveBeenCalledWith(people[0])
})

it('keeps a large company roster bounded and finds contacts beyond the first page', async () => {
  const company = createCrmRecord('companies',{id:'c',name:'Long Company'})
  const current = Array.from({length:220},(_,i)=>createCrmRecord('people',{id:'p'+i,fullName:'Contact '+i}))
  await act(async()=>root.render(<CompanyProfile company={company} roster={{current,former:[],other:[],education:[]}} onSelect={vi.fn()}/>))
  expect(host.querySelectorAll('.crm-company-contact')).toHaveLength(10)
  await act(async()=>host.querySelector<HTMLButtonElement>('.crm-organization-roster button')!.click())
  expect(host.querySelectorAll('.crm-company-contact')).toHaveLength(20)
  const field=host.querySelector<HTMLInputElement>('.crm-roster-search input')!
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,'Contact 219');field.dispatchEvent(new Event('input',{bubbles:true}))})
  expect(host.querySelectorAll('.crm-company-contact')).toHaveLength(1)
  expect(host.querySelector('.crm-company-contact')?.getAttribute('href')).toBe('#/people?person=p219')
})
