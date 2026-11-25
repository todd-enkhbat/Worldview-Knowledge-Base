import { expect, it } from 'vitest'
import { profileFromHtml, profileFromSavedText } from '../../server/crmProfileExtract.ts'

const page = (entity: unknown, body = '<h1>Ada Example</h1><p>Scientist and writer.</p>') => `<!doctype html><title>Ada Example · Profile</title><script type="application/ld+json">${JSON.stringify(entity)}</script><main>${body}</main>`

it('reads primary Person schema with education, employment and memberships while retaining a safe readable snapshot', () => {
  const result = profileFromHtml(page({ '@graph': [
    { '@type': 'Person', name: 'Ada Example', jobTitle: 'Research scientist', alumniOf: { name: 'Columbia University', url: 'https://columbia.example/' }, worksFor: { name: 'Example Labs' }, memberOf: { name: 'Local Club' }, affiliation: { name: 'Research Society' }, email: 'ada@example.com', sameAs: ['https://www.linkedin.com/in/ada-example/'] },
    { '@type': 'Person', name: 'Unrelated Person', alumniOf: { name: 'Wrong University' }, email: 'wrong@example.com' },
  ] }, '<h1>Ada Example</h1><p>Scientist and writer.</p><a href="javascript:alert(1)" onclick="dangerous()">A harmless label</a><form><textarea>Private unfinished draft</textarea></form><aside>Other people</aside><iframe src="https://tracker.example"></iframe>'), 'https://ada.example/')
  expect(result.profile).toMatchObject({ entityType: 'person', name: 'Ada Example', headline: 'Research scientist', emails: ['ada@example.com'] })
  expect(result.profile.affiliations?.map(row => [row.kind, row.organization])).toEqual([['education', 'Columbia University'], ['employment', 'Example Labs'], ['membership', 'Local Club'], ['membership', 'Research Society']])
  expect(result.profile.affiliations?.[0]).not.toHaveProperty('current'); expect(result.profile.affiliations?.[0]).not.toHaveProperty('graduated')
  expect(result.profile.urls).toContain('https://www.linkedin.com/in/ada-example/')
  for (const content of ['Wrong University', 'wrong@example.com', 'Private unfinished draft', 'Other people', 'tracker.example', 'javascript:', 'onclick', '<script']) expect(JSON.stringify(result)).not.toContain(content)
  expect(result.html).toContain('A harmless label')
})

it('accepts a company mainEntity only when its declared source URL matches the requested page', () => {
  const company = { '@type': 'Organization', name: 'Example Ventures', url: 'https://ventures.example/about/', industry: 'Venture capital', description: 'Build useful companies.', address: { addressLocality: 'New York', addressRegion: 'NY', addressCountry: { name: 'United States' } }, alumniOf: { name: 'Aggregate School' } }
  const result = profileFromHtml(page({ '@type': 'WebPage', mainEntity: company }, '<h1>About us</h1><p>Example Ventures builds useful companies.</p>'), 'https://ventures.example/about/?source=reader')
  expect(result.profile).toMatchObject({ entityType: 'company', name: 'Example Ventures', location: 'New York, NY, United States', industry: 'Venture capital', affiliations: [] })
  expect(() => profileFromHtml(page({ '@type': 'WebPage', mainEntity: { ...company, url: 'https://unrelated.example/' } }, '<h1>About us</h1>'), 'https://ventures.example/about/')).toThrow('No single verified')
})

it('does not turn Article.author, sidebar people or a hidden heading into the page profile', () => {
  expect(() => profileFromHtml(page({ '@type': 'Article', author: { '@type': 'Person', name: 'Ada Example' } }), 'https://news.example/story')).toThrow('No single verified')
  expect(() => profileFromHtml(page({ '@type': 'Person', name: 'Ada Example' }, '<aside><h1>Ada Example</h1></aside><h1>Research news</h1>'), 'https://news.example/story')).toThrow('No single verified')
  expect(() => profileFromHtml(page({ '@type': 'Person', name: 'Ada Example' }, '<div hidden><h1>Ada Example</h1></div><h1>Research news</h1>'), 'https://news.example/story')).toThrow('No single verified')
})

it('refuses ambiguous primary entity types and malformed source metadata', () => {
  expect(() => profileFromHtml(page([{ '@type': 'Person', name: 'Ada Example' }, { '@type': 'Organization', name: 'Ada Example' }]), 'https://ada.example/')).toThrow('No single verified')
  expect(() => profileFromHtml('<script type="application/ld+json">{invalid}</script><main><h1>Ada Example</h1></main>', 'https://ada.example/')).toThrow('No single verified')
})

it('re-reads source-bound retained education and experience while preserving exact original text', () => {
  const text = 'Ada Example\n\nScientist\n\nEducation\n\nColumbia University\n\nBachelor of Arts, Philosophy\n\n2016–2020\n\nExperience\n\nResearch engineer\n\nExample Labs\n\nJan 2021 – Present\n\nSkills\n\nPhysics'
  const result = profileFromSavedText(text, { title: 'Ada Example', profileImages: [{ isProfile: true, subjectName: 'Ada Example', sourceUrl: 'https://profiles.example/ada', url: 'https://images.example/ada.jpg' }] }, 'https://profiles.example/ada')
  expect(result.text).toBe(text)
  expect(result.profile.affiliations).toEqual([
    expect.objectContaining({ kind: 'education', organization: 'Columbia University', degree: 'Bachelor of Arts', field: 'Philosophy', startDate: '2016', endDate: '2020' }),
    expect.objectContaining({ kind: 'employment', organization: 'Example Labs', role: 'Research engineer', startDate: 'Jan 2021', current: true }),
  ])
  expect(result.profile.affiliations?.[0]).not.toHaveProperty('current')
})

it('keeps retained company employee-school aggregates as source text, never company education', () => {
  const text = 'Example Ventures\n27 associated members\nWhere they studied\n4 | The Wharton School\n2 | MIT\nEducation\nAggregate University\nBA\n2015 – 2019'
  const result = profileFromSavedText(text, { profile: { entityType: 'company', name: 'Example Ventures', industry: 'Venture capital', urls: ['https://www.linkedin.com/company/example-ventures/'] } }, 'https://www.linkedin.com/company/example-ventures/people/')
  expect(result.profile).toMatchObject({ entityType: 'company', name: 'Example Ventures', industry: 'Venture capital', affiliations: [] }); expect(result.text).toBe(text)
  const legacy = profileFromSavedText(text, { profileImages: [{ isProfile: true, subjectName: 'Example Ventures' }] }, 'https://www.linkedin.com/company/example-ventures/people/')
  expect(legacy.profile).toMatchObject({ entityType: 'company', affiliations: [] })
  expect(() => profileFromSavedText(text, { profile: { entityType: 'person', name: 'Example Ventures' } }, 'https://www.linkedin.com/company/example-ventures/people/')).toThrow('conflicts')
})

it('preserves an existing explicit captured affiliation without reinterpreting adjacent prose', () => {
  const affiliation = { kind: 'advisory', organization: 'Example Foundation', role: 'Adviser', excerpt: 'Adviser at Example Foundation' }
  const result = profileFromSavedText('Ada Example\nAdviser at Example Foundation\nArticle about Other University', { profile: { entityType: 'person', name: 'Ada Example', affiliations: [affiliation] } }, 'https://ada.example/')
  expect(result.profile.affiliations).toEqual([affiliation])
})
it('withholds legacy LinkedIn text whose experience block can include grouped roles and other people', () => {
  const text = 'Ada Example\nExperience\nExample University\nFull-time · 26 yrs\nTeaching Professor\nJul 2025 - Present\nMore profiles for you\nOther Person\nHead of Mining at Other Company'
  expect(() => profileFromSavedText(text, { profileImages: [{ isProfile: true, subjectName: 'Ada Example' }] }, 'https://www.linkedin.com/in/ada-example/')).toThrow('does not retain section boundaries')
  expect(() => profileFromSavedText(text, { profile: {}, profileImages: [{ isProfile: true, subjectName: 'Ada Example' }] }, 'https://www.linkedin.com/in/ada-example/')).toThrow('does not retain section boundaries')
  const explicit = profileFromSavedText(text, { profile: { entityType: 'person', name: 'Ada Example', affiliations: [] } }, 'https://www.linkedin.com/in/ada-example/')
  expect(explicit.profile.affiliations).toEqual([])
})

it('requires one bound named subject and refuses unrelated metadata or oversized input', () => {
  const text = 'Ada Example\nEducation\nColumbia University'
  expect(() => profileFromSavedText(text, {}, 'https://ada.example/')).toThrow('no single named')
  expect(() => profileFromSavedText(text, { profileImages: [{ isProfile: true, subjectName: 'Ada Example', sourceUrl: 'https://unrelated.example/' }] }, 'https://ada.example/')).toThrow('no single named')
  expect(() => profileFromSavedText('An article\nAda Example', { profile: { entityType: 'person', name: 'Someone Else' } }, 'https://ada.example/')).toThrow('does not begin')
  expect(() => profileFromHtml('x'.repeat(512 * 1024 + 1), 'https://ada.example/')).toThrow('within512KiB')
  expect(() => profileFromHtml(page({ '@type': 'Person', name: 'Ada Example' }), 'http://user:password@example.com/')).toThrow('public person')
})
