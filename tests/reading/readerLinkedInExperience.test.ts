import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
import { captureLinkedInExperience } from '../../extensions/worldview-reader/extract.js'

const { JSDOM } = createRequire(import.meta.url)('jsdom')
const url = 'https://www.linkedin.com/in/sample-person/'
const school = '/school/123/'
const details = url + 'details/experience/?isSelfProfile=false'

// Reduced from the rendered primary card: employer heading, grouped linked roles,
// then flat sibling cards. The date and narrative belong to different containers.
const rows = `<div><div><a href="${school}"><img src="https://media.licdn.com/school.png"></a><a href="${school}"><p>Example Institute</p><p>10 yrs</p></a></div>
  <ul><li><a href="${school}"><p>Department Chair</p><p>Full-time</p><p>Jan 2020 - Present · 6 yrs</p><p>Cambridge, MA</p></a><p><span>Present</span></p><p><span>Leads the teaching program.</span></p><p><a href="/in/sample-person/overlay/skills">Leadership and +2 skills</a></p></li>
  <li><a href="${school}"><p>Lecturer</p><p>2016 – 2019</p></a></li></ul></div>
  <div><a href="/company/456/"><img src="https://media.licdn.com/lab.png"></a><a href="/company/456/"><div><p>Founder</p><p>Example Lab</p></div><p>Feb 2024 - Present · 2 yrs</p></a><p>Cambridge, MA</p><p><span>Develops research tools.</span></p></div>
  <div><div><p>President</p><p>Sample Society</p></div><p>Jan 2015 - Dec 2015</p><p><span>Chaired its annual meeting.</span></p></div>`

it('mounts Experience using the verified employer control and captures grouped, standalone and unlinked roles', async () => {
  const dom = new JSDOM(`<main><section><button>Example Institute + 2 more</button><a href="${url}overlay/contact-info/">Contact info</a></section><section id="activity"><h2>Activity</h2></section></main>`, { url })
  const doc = dom.window.document
  try {
    doc.querySelector('button').addEventListener('click', () => {
      doc.querySelector('main').insertAdjacentHTML('beforeend', `<section><h2>Experience</h2>${rows}<a href="https://www.linkedin.com/in/other/details/experience/">Other person</a><a href="${details}">Show all</a></section>`)
    })
    const captured = await captureLinkedInExperience(url, 'Example Institute', doc)
    expect(captured.continuation).toBe(details)
    expect(captured.roles).toHaveLength(4)
    expect(captured.roles[0]).toMatchObject({ role: 'Department Chair', organization: 'Example Institute', organizationUrl: 'https://www.linkedin.com/school/123/', organizationLogoUrl: 'https://media.licdn.com/school.png', startDate: 'Jan 2020', current: true, description: 'Leads the teaching program.' })
    expect(captured.roles[1]).toMatchObject({ role: 'Lecturer', organization: 'Example Institute', endDate: '2019', organizationLogoUrl: 'https://media.licdn.com/school.png' })
    expect(captured.roles[2]).toMatchObject({ role: 'Founder', organization: 'Example Lab', startDate: 'Feb 2024', current: true, organizationLogoUrl: 'https://media.licdn.com/lab.png', description: 'Develops research tools.' })
    expect(captured.roles[3]).toMatchObject({ role: 'President', organization: 'Sample Society', startDate: 'Jan 2015', endDate: 'Dec 2015', description: 'Chaired its annual meeting.' })
    expect(captured.roles[3]).not.toHaveProperty('organizationUrl')
  } finally { dom.window.close() }
})

it('accepts the same person’s Experience detail view and excludes another profile URL', async () => {
  const dom = new JSDOM(`<main><div>Experience</div>${rows}<aside><p>Other Person</p><p>2000 - Present</p></aside></main>`, { url: details })
  try {
    expect((await captureLinkedInExperience(url, '', dom.window.document)).roles.map(row => row.role)).toEqual(['Department Chair', 'Lecturer', 'Founder', 'President'])
    await expect(captureLinkedInExperience(url.replace('sample-person', 'another-person'), '', dom.window.document)).rejects.toThrow('changed')
  } finally { dom.window.close() }
})
