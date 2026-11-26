import { expect, it, vi } from 'vitest'
import { discoverProfileWebsite } from '../../server/crmProfileDiscovery.ts'

const claim = (value: unknown, rank = 'normal') => ({ rank, mainsnak: { datavalue: { value } } })
it('returns current official sites with disambiguating source links and keeps people distinct from companies', async () => {
  const search = { search: [{ label: 'Example', id: 'Q1', description: 'A venture capital firm' }, { label: 'Example', id: 'Q2', description: 'Canadian musician' }, { label: 'Example Holdings', id: 'Q3', description: 'Another company' }] }
  const entities = { Q1: { claims: { P31: [claim({ id: 'Q4830453' })], P856: [claim('https://new.example.org'), claim('https://old.example.org', 'deprecated'), claim('https://127.0.0.1')] } }, Q2: { claims: { P31: [claim({ id: 'Q5' })], P856: [claim('https://musician.example.org')] } } }
  const request = vi.fn<typeof fetch>(async url => Response.json(new URL(String(url)).searchParams.get('action') === 'wbsearchentities' ? search : { entities }))
  const result = await discoverProfileWebsite({ entityType: 'company', name: 'Example' }, request)
  expect(result.suggestions).toEqual([{ name: 'Example', description: 'A venture capital firm', url: 'https://new.example.org/', sourceUrl: 'https://www.wikidata.org/wiki/Q1', source: 'Wikidata' }])
  expect(new URL(String(request.mock.calls[1][0])).searchParams.get('ids')).toBe('Q1|Q2')
  expect((await discoverProfileWebsite({ entityType: 'person', name: 'Example' }, request)).suggestions[0].url).toBe('https://musician.example.org/')
})
it('distinguishes upstream errors from no result and never treats a similar name as exact', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ search: [{ id: 'Q3', label: 'Example Holdings' }] }))
  expect((await discoverProfileWebsite({ entityType: 'company', name: 'Example' }, request)).suggestions).toEqual([])
  expect(request).toHaveBeenCalledTimes(1)
  await expect(discoverProfileWebsite({ entityType: 'person', name: 'Example' }, async () => Response.json({ error: { code: 'ratelimited' } }))).rejects.toThrow('Wikidata')
})

it('re-verifies website ownership and saves company headquarters separately from people and expired claims', async () => {
  const { selectedWikidataProfile } = await import('../../server/crmProfileDiscovery.ts')
  const description = { en: { value: 'A venture capital firm' } }
  const entity = { labels: { en: { value: 'Example Capital' } }, aliases: { en: [{ value: 'Example' }] }, descriptions: description, claims: {
    P856: [claim('https://example.org')], P31: [claim({ id: 'Q4830453' })], P4264: [claim('example-capital')],
    P159: [{ ...claim({ id: 'Q3' }), qualifiers: { P582: [{}] } }, claim({ id: 'Q2' })], P452: [claim({ id: 'Q4' })],
  } }
  const request = vi.fn<typeof fetch>(async url => {
    const params = new URL(String(url)).searchParams
    return Response.json({ entities: params.get('ids') === 'Q1' ? { Q1: entity } : { Q2: { labels: { en: { value: 'Austin' } } }, Q4: { labels: { en: { value: 'Venture capital' } } } } })
  })
  const profile = await selectedWikidataProfile('https://www.wikidata.org/wiki/Q1', 'https://example.org', 'Example', 'company', request)
  expect(profile.profile).toMatchObject({ name: 'Example', urls: ['https://example.org/', 'https://www.linkedin.com/company/example-capital'], location: 'Austin', industry: 'Venture capital' })
  await expect(selectedWikidataProfile(profile.url, 'https://other.example.org', 'Example', 'company', request)).rejects.toThrow('no longer matches')
  await expect(selectedWikidataProfile(profile.url, 'https://example.org', 'Example', 'person', request)).rejects.toThrow('no longer matches')
})

it('coalesces http and www variants on the same item and keeps two same-named organizations distinct', async () => {
  const entity = { claims: { P31: [claim({ id: 'Q4830453' })], P856: [claim('https://www.example.org/en/'), claim('http://example.org/'), claim('https://www.example.org/'), claim('https://example.org/?lang=es'), claim('https://another.example.org/')] } }
  const request = vi.fn<typeof fetch>(async raw => Response.json(new URL(String(raw)).searchParams.get('action') === 'wbsearchentities'
    ? { search: [{ label: 'Example', id: 'Q1' }, { label: 'Example', id: 'Q2' }] }
    : { entities: { Q1: entity, Q2: entity } }))
  const { suggestions } = await discoverProfileWebsite({ name: 'Example', entityType: 'company' }, request)
  expect(suggestions.map(item => [item.sourceUrl.split('/').at(-1), item.url])).toEqual([
    ['Q1', 'https://www.example.org/'], ['Q1', 'https://another.example.org/'],
    ['Q2', 'https://www.example.org/'], ['Q2', 'https://another.example.org/'],
  ])
})
