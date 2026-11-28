import { createRequire } from 'node:module'
import { createContext, Script } from 'node:vm'
import { expect, it } from 'vitest'
import { extractProfile } from '../../extensions/worldview-reader/extract.js'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options?: { url?: string }) => { window: { document: Document; close(): void } } }
const source = 'https://www.linkedin.com/in/ada-example/'
function modern(link = source, contact = `${source}overlay/contact-info/`) {
  const roles = [['Teaching Professor', 'Jul 2025–Present'], ['Senior Lecturer', 'Jul 2014–Jun 2025'], ['Lecturer', 'Jul 2008–Jun 2014'], ['Assistant Professor', 'Jul 2000–Jun 2008']]
  return `<div aria-label="Primary content"><div><header><a href="${link}">Ada Example <span>View Ada’s verifications</span></a><a href="${contact}">Contact info</a><button>JHU · Education</button></header></div>
    <div><div role="heading" aria-level="2">Activity</div><p>Recent activity</p></div>
    <div><div role="heading" aria-level="2">Experience</div><div role="list"><div role="listitem"><a href="https://www.linkedin.com/school/2624/">Example University Full-time 26 yrs 5 mos</a><div role="list">${roles.map(([role, date]) => `<div><a href="https://www.linkedin.com/school/2624/"><span>${role}</span> <span>${date}</span></a></div>`).join('')}</div></div></div></div>
    </div><div aria-label="Aside"><div role="heading">More profiles for you</div><a href="${source}">Wrong Person View Wrong’s verifications</a><div role="heading">Education</div><ul><li>Wrong University</li></ul></div><div role="complementary">Unrelated messaging text</div>`
}
function capture(html: string) { const dom = new JSDOM(html, { url: source }); try { return extractProfile(dom.window.document) } finally { dom.window.close() } }

it('reads a modern no-H1 primary profile and grouped semantic roles, preferring the named employer over dated role links', () => {
  const result = capture(modern())
  expect(result.profile).toMatchObject({ entityType: 'person', name: 'Ada Example' })
  expect(result.profile.affiliations).toEqual([
    expect.objectContaining({ kind: 'employment', organization: 'Example University', organizationUrl: 'https://www.linkedin.com/school/2624/', role: 'Teaching Professor', startDate: 'Jul 2025', current: true }),
    expect.objectContaining({ kind: 'employment', organization: 'Example University', role: 'Senior Lecturer', startDate: 'Jul 2014', endDate: 'Jun 2025' }),
    expect.objectContaining({ kind: 'employment', organization: 'Example University', role: 'Lecturer', startDate: 'Jul 2008', endDate: 'Jun 2014' }),
    expect.objectContaining({ kind: 'employment', organization: 'Example University', role: 'Assistant Professor', startDate: 'Jul 2000', endDate: 'Jun 2008' }),
    expect.objectContaining({ kind: 'education', organization: 'JHU', excerpt: 'JHU · Education' }),
  ])
  expect(result.profile.affiliations?.filter(row => row.kind === 'education')).toEqual([expect.objectContaining({ organization: 'JHU' })])
  for (const other of ['Wrong Person', 'Wrong University', 'Unrelated messaging text']) expect(JSON.stringify(result)).not.toContain(other)
})

it('binds a root-href verification name only through the same bounded header’s exact profile Contact info URL', () => {
  expect(capture(modern('https://www.linkedin.com/')).profile.name).toBe('Ada Example')
  expect(() => capture(modern('https://www.linkedin.com/', 'https://www.linkedin.com/in/someone-else/overlay/contact-info/'))).toThrow('No single named')
  const unbounded = modern('https://www.linkedin.com/').replace('<div><header>', '').replace('</header></div>', '')
  expect(() => capture(unbounded)).toThrow('No single named')
})

it('captures the unique labelled LinkedIn portrait beside the verified identity and ignores other sections and hidden photos', () => {
  const photo = '<a href="/" aria-label="Profile photo"><div><img aria-hidden="true" alt="" src="https://media.licdn.com/ada.jpg"></div></a>'
  const otherPhoto = photo.replace('ada.jpg', 'another-person.jpg')
  const html = modern('https://www.linkedin.com/').replace('<header>', '<section>' + photo + '<div>')
    .replace('</header>', '</div></section>').replace('Recent activity', otherPhoto + 'Recent activity')
  expect(capture(html).profile.images).toEqual([{ url: 'https://media.licdn.com/ada.jpg', label: 'Ada Example profile photo', isProfile: true, subjectName: 'Ada Example' }])
  expect(capture(html.replace(photo, '')).profile.images).toEqual([])
  expect(capture(html.replace(photo, photo + otherPhoto)).profile.images).toEqual([])
  expect(capture(html.replace(photo, '<div hidden>' + photo + '</div>')).profile.images).toEqual([])
})

it('accepts a plain visible header name only when it uniquely agrees with the LinkedIn title and same-header exact Contact info', () => {
  const html = `<title>Ada Example | LinkedIn</title>${modern('https://www.linkedin.com/').replace('Ada Example <span>View Ada’s verifications</span>', 'Ada Example')}`
  expect(capture(html).profile).toMatchObject({ name: 'Ada Example', entityType: 'person' })
  expect(() => capture(html.replace('<title>Ada Example | LinkedIn</title>', '<title>Someone Else | LinkedIn</title>'))).toThrow('No single named')
  expect(() => capture(html.replace(`${source}overlay/contact-info/`, 'https://www.linkedin.com/in/someone-else/overlay/contact-info/'))).toThrow('No single named')
  const ambiguous = html.replace('<a href="https://www.linkedin.com/">Ada Example</a>', '<a href="https://www.linkedin.com/">Ada Example</a><a href="https://www.linkedin.com/">Ada Example</a>')
  expect(() => capture(ambiguous)).toThrow('No single named')
})

it('reads headline and location from the verified modern card and confirms a headline employer before Experience has loaded', () => {
  const headline = 'McAfee Professor of Engineering at MIT; Founder; AI-Driven Scientific Discovery'
  const employer = '<button>Massachusetts Institute of Technology <span>+ 3 more</span></button>'
  const outside = '<aside><button>Massachusetts Institute of Technology + 3 more</button><p>Unrelated location</p></aside>'
  const card = `<title>Ada Example | LinkedIn</title><main><section><div><div><a href="/"><h2>Ada Example</h2></a><p>· 2nd</p></div><p>${headline}</p><div><p>Cambridge, Massachusetts, United States</p><p>·</p><p><a href="${source}overlay/contact-info/">Contact info</a></p></div></div>${employer}<button>Caltech</button></section><section><h2>Activity</h2></section>${outside}</main>`
  const result = capture(card)
  expect(result.profile).toMatchObject({ headline, location: 'Cambridge, Massachusetts, United States', affiliations: [{ kind: 'employment', organization: 'Massachusetts Institute of Technology', role: 'McAfee Professor of Engineering', current: true }] })
  expect(result).toMatchObject({ headerEmployer: { organization: 'Massachusetts Institute of Technology', additional: 3 } })
  const wrapped = card.replace(`<p>${headline}</p>`, `<div><span>${headline}</span></div>`)
    .replace(employer, '<button aria-label="Massachusetts Institute of Technology + 3 more"><img alt="">Open experience</button>')
  expect(capture(wrapped)).toMatchObject({ profile: { headline, affiliations: [{ organization: 'Massachusetts Institute of Technology', role: 'McAfee Professor of Engineering' }] }, headerEmployer: { additional: 3 } })
  for (const other of [card.replace(employer, ''), card.replace(headline, 'Former Professor at MIT'), card.replace(employer, '<button hidden>Massachusetts Institute of Technology</button>'), card.replace(employer, employer + '<button>Midwest Institute of Technology</button>')]) {
    expect(capture(other).profile.affiliations).toEqual([])
  }
})

it('withholds a dated organization-linked role when no named group employer is available', () => {
  const html = modern().replace('<a href="https://www.linkedin.com/school/2624/">Example University Full-time 26 yrs 5 mos</a>', '')
  expect(capture(html).profile.affiliations).toEqual([expect.objectContaining({ kind: 'education', organization: 'JHU' })])
})

it('fails closed on unknown LinkedIn body layouts and serializes actionable extraction errors without imported helpers', () => {
  const dom = new JSDOM('<body><h1>Ada Example</h1><div>Unrelated messaging text</div></body>', { url: source })
  try {
    expect(() => extractProfile(dom.window.document)).toThrow('primary profile content')
    const result = new Script(`(${extractProfile.toString()})(null, true)`).runInContext(createContext({ document: dom.window.document, URL, TextEncoder }))
    expect(result).toEqual({ extractorError: expect.stringContaining('primary profile content') })
    expect(JSON.stringify(result)).not.toContain('Unrelated messaging text')
  } finally { dom.window.close() }
})

const topCard = (controls: string, headline = 'Investing @General Catalyst | ex-a16z') => `<title>Ada Example | LinkedIn</title><main><section><h1>Ada Example</h1><p class="text-body-medium">${headline}</p><a href="${source}overlay/contact-info/">Contact info</a>${controls}</section><aside><button>Wrong University</button><a href="/school/wrong/">Wrong School</a></aside><section><h2>People you may know</h2><a href="/school/other/">Other University</a></section></main>`
it('reads the top-card school beside a confirmed employer before Education is mounted, including the screenshot headline syntax', () => {
  const result = capture(topCard('<button>General Catalyst</button><button><img alt="Columbia University logo" src="https://media.licdn.com/school.jpg">Columbia University in the City of New York</button>'))
  expect(result.profile.affiliations).toEqual([
    expect.objectContaining({kind:'employment',organization:'General Catalyst',current:true}),
    expect.objectContaining({kind:'education',organization:'Columbia University in the City of New York'}),
  ])
  expect(result.profile.affiliations![1]).not.toHaveProperty('current')
  expect(result.profile.affiliations![1]).not.toHaveProperty('degree')
  expect(result.text).toContain('Columbia University in the City of New York')
  expect(result.html).toContain('Columbia University in the City of New York')
  expect(JSON.stringify(result)).not.toContain('Wrong University')
})
it('falls back to the exact LinkedIn shared school highlight on the selected profile',()=>{
  const html=topCard('').replace('</main>','<section><h2>Highlights</h2><p><strong>You both studied at Columbia University</strong></p></section></main>')
  const result=capture(html)
  expect(result.profile.affiliations).toEqual([expect.objectContaining({kind:'education',organization:'Columbia University',excerpt:'You both studied at Columbia University'})])
  expect(result.text).toContain('You both studied at Columbia University')
  for (const unrelated of [html.replace('<section><h2>Highlights</h2>','<aside><section><h2>Highlights</h2>').replace('</main>','</aside></main>'),html.replace('You both studied at','Other people studied at')]) {
    expect(capture(unrelated).profile.affiliations).toEqual([])
  }
})
it.each([
  ['<a href="/school/1/">University of Example</a>','University of Example'],
  ['<button aria-label="Education: MIT. Click to see education">MIT</button>','MIT'],
  ['<a href="#education">Caltech</a>','Caltech'],
  ['<button data-field="school">Sciences Po</button>','Sciences Po'],
])('recognizes a school only from a profile-bound school link or education control: %s', (control,school) => {
  expect(capture(topCard(control)).profile.affiliations).toEqual([expect.objectContaining({kind:'education',organization:school})])
})
it('does not turn a university employer, a generic university mention, or a hidden school control into education', () => {
  for (const control of ['<button>Example University</button>','<a href="/school/1/">Example University</a>','<button hidden data-field="school">MIT</button>']) {
    expect(capture(topCard(control,'Professor at Example University')).profile.affiliations!.filter(row=>row.kind==='education')).toEqual([])
  }
})
it('prefers the detailed education entry over the same top-card school and keeps the extractor serializable', () => {
  const html=topCard('<a href="/school/1/">University of Example</a>').replace('</main>','<section><h2>Education</h2><ul><li><a href="/school/1/">University of Example</a><p>BS, Physics</p><p>2016–2020</p></li></ul></section></main>')
  const dom=new JSDOM(html,{url:source})
  try {
    const result=new Script(`(${extractProfile.toString()})(null,true)`).runInContext(createContext({document:dom.window.document,URL,TextEncoder}))
    expect(result.profile.affiliations.filter((row:{kind:string})=>row.kind==='education')).toEqual([expect.objectContaining({organization:'University of Example',degree:'BS',field:'Physics'})])
  } finally {dom.window.close()}
})

it('reads the adjacent Berkeley school when the headline is just the employer name', () => {
  const html = topCard('<button>Core Automation</button><button><img alt="University of California, Berkeley logo" src="https://media.licdn.com/berkeley.png">University of California, Berkeley</button>', 'Core Automation')
  const result = capture(html)
  expect(result.profile.affiliations).toContainEqual(expect.objectContaining({
    kind: 'education', organization: 'University of California, Berkeley',
    organizationLogoUrl: 'https://media.licdn.com/berkeley.png',
  }))
  expect(result.text).toContain('University of California, Berkeley')
  expect(capture(html.replace('<button>Core Automation</button>', '')).profile.affiliations?.filter(row => row.kind === 'education')).toEqual([])
})
