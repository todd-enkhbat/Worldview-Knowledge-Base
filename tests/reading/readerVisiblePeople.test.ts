import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { createContext, Script } from 'node:vm'
import { extractVisiblePeople } from '../../extensions/worldview-reader/extract.js'
const {JSDOM} = createRequire(import.meta.url)('jsdom')
const url = 'https://example.org/team'
const fixture = '<main><ul><li><a href="/team/alex">Alex West</a><span itemprop="jobTitle">Editor</span></li>' +
  '<li><a href="https://www.linkedin.com/in/sam-e/">Sam East · 2nd</a><span itemprop="jobTitle">Designer</span></li>' +
  '<li hidden><a href="/team/hidden">Hidden Person</a></li><li><a href="/team/clash">One Name</a><a href="/team/clash">Different Name</a></li></ul></main>'
it('returns active named profile links and saves only the selected visible identity', () => {
  const dom = new JSDOM(fixture, {url})
  try {
    const run = (selection = '') => new Script('(' + extractVisiblePeople.toString() + ')(document,' + JSON.stringify(selection) + ')')
      .runInContext(createContext({document:dom.window.document, URL}))
    expect(run().people.map((row: {name:string}) => row.name)).toEqual(['Alex West','Sam East'])
    const chosen = run('https://www.linkedin.com/in/sam-e')
    expect(chosen.sourcePageUrl).toBe(url)
    expect(chosen.profile).toMatchObject({name:'Sam East',headline:'Designer'})
    expect(chosen.text).not.toContain('Editor')
    dom.window.document.querySelector('li:nth-child(2)').remove()
    expect(run(chosen.url).extractorError).toBeTruthy()
  } finally { dom.window.close() }
})
