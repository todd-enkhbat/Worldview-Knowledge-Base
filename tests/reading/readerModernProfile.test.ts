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
  ])
  expect(result.profile.affiliations?.some(row => row.kind === 'education')).toBe(false)
  for (const other of ['Wrong Person', 'Wrong University', 'Unrelated messaging text', 'JHU']) expect(JSON.stringify(result)).not.toContain(other)
})

it('binds a root-href verification name only through the same bounded header’s exact profile Contact info URL', () => {
  expect(capture(modern('https://www.linkedin.com/')).profile.name).toBe('Ada Example')
  expect(() => capture(modern('https://www.linkedin.com/', 'https://www.linkedin.com/in/someone-else/overlay/contact-info/'))).toThrow('No single named')
  const unbounded = modern('https://www.linkedin.com/').replace('<div><header>', '').replace('</header></div>', '')
  expect(() => capture(unbounded)).toThrow('No single named')
})

it('accepts a plain visible header name only when it uniquely agrees with the LinkedIn title and same-header exact Contact info', () => {
  const html = `<title>Ada Example | LinkedIn</title>${modern('https://www.linkedin.com/').replace('Ada Example <span>View Ada’s verifications</span>', 'Ada Example')}`
  expect(capture(html).profile).toMatchObject({ name: 'Ada Example', entityType: 'person' })
  expect(() => capture(html.replace('<title>Ada Example | LinkedIn</title>', '<title>Someone Else | LinkedIn</title>'))).toThrow('No single named')
  expect(() => capture(html.replace(`${source}overlay/contact-info/`, 'https://www.linkedin.com/in/someone-else/overlay/contact-info/'))).toThrow('No single named')
  const ambiguous = html.replace('<a href="https://www.linkedin.com/">Ada Example</a>', '<a href="https://www.linkedin.com/">Ada Example</a><a href="https://www.linkedin.com/">Ada Example</a>')
  expect(() => capture(ambiguous)).toThrow('No single named')
})

it('withholds a dated organization-linked role when no named group employer is available', () => {
  const html = modern().replace('<a href="https://www.linkedin.com/school/2624/">Example University Full-time 26 yrs 5 mos</a>', '')
  expect(capture(html).profile.affiliations).toEqual([])
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
