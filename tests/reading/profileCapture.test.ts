// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.linkedin.com/in/leah-example/"}
import { afterEach, describe, expect, it } from 'vitest'
import { extractArticle } from '../../extensions/worldview-reader/extract.js'
import { capturedProfileMetadata } from '../../server/articleProfile.ts'

afterEach(() => { document.head.replaceChildren(); document.body.replaceChildren() })
describe('explicit profile references captured by Reader', () => {
  it('captures a visible LinkedIn photo with current accessible labels even when decorative image semantics hide its alt text', () => {
    document.title = 'Leah Example | LinkedIn'
    document.body.innerHTML = '<main><h2>Leah Example</h2><p>Researcher at Example University.</p><a aria-label="Profile photo"><img aria-hidden="true" src="https://media.licdn.com/portrait.jpg" alt="Leah Example"></a><aside><img src="https://media.licdn.com/somebody-else.jpg" alt="Basil Example"></aside></main>'
    expect(document.location.hostname).toBe('www.linkedin.com')
    expect(extractArticle(document).profileImages).toEqual([expect.objectContaining({ url: 'https://media.licdn.com/portrait.jpg', subjectName: 'Leah Example', isProfile: true })])
  })
  it('uses the profile name for a named photo fallback and rejects visually hidden photos', () => {
    document.title = '(1) Leah Example | LinkedIn'
    document.body.innerHTML = '<main><p>Researcher at Example University.</p><img alt="Basil Example" src="https://media.licdn.com/basil.jpg"><img alt="Leah Example" src="https://media.licdn.com/leah.jpg"></main>'
    expect(extractArticle(document).profileImages[0]).toMatchObject({ url: 'https://media.licdn.com/leah.jpg', subjectName: 'Leah Example' })
    document.querySelector('img[alt="Leah Example"]')!.setAttribute('style', 'display:none')
    expect(extractArticle(document).profileImages).toEqual([])
  })
  it('keeps real person schema images and rel-me links without fetching remote media or confusing share links', () => {
    document.body.innerHTML = '<main><h1>Leah Example</h1><p>A researcher who writes about cities.</p><a rel="me" href="https://github.com/leah-example">My code</a><a href="https://x.com/share?url=example">Share this page</a></main>'
    const schema = document.createElement('script'); schema.type = 'application/ld+json'; schema.textContent = JSON.stringify({ '@type': 'Person', name: 'Leah Example', image: 'https://images.example/leah.jpg', sameAs: ['https://www.linkedin.com/in/leah-example/'] }); document.head.append(schema)
    const result = extractArticle(document)
    expect(result.profileImages).toEqual([{ url: 'https://images.example/leah.jpg', sourceUrl: document.location.href, label: 'Leah Example', isProfile: true, subjectName: 'Leah Example' }])
    expect(result.profileLinks.map(value => value.url)).toEqual(['https://github.com/leah-example', 'https://www.linkedin.com/in/leah-example/'])
  })
  it('never promotes arbitrary people on a team page to the primary profile or imports their social accounts', () => {
    document.body.innerHTML = '<main><h1>Our research team</h1><p>Two researchers work here.</p></main>'
    const schema = document.createElement('script'); schema.type = 'application/ld+json'; schema.textContent = JSON.stringify({ '@graph': ['Leah Example', 'Basil Example'].map(name => ({ '@type': 'Person', name, image: `https://images.example/${name.split(' ')[0]}.jpg`, sameAs: [`https://x.com/${name.split(' ')[0]}`] })) }); document.head.append(schema)
    const result = extractArticle(document)
    expect(result.profileImages).toHaveLength(2)
    expect(result.profileImages.every(image => !image.isProfile && !!image.subjectName)).toBe(true)
    expect(result.profileLinks).toEqual([])
  })
  it('does not label generic article preview art as a person portrait or synthesize an undefined image URL', () => {
    document.body.innerHTML = '<article><p>A page with no photograph.</p></article>'
    expect(extractArticle(document).profileImages).toEqual([])
    document.head.innerHTML = '<meta property="og:image" content="https://images.example/article-art.jpg">'
    expect(extractArticle(document).profileImages[0].isProfile).toBe(false)
  })
  it('normalizes bounded references, rejects credentials and executable URLs, and binds provenance to the captured page', () => {
    const profile = capturedProfileMetadata({ profileImages: [{ url: 'javascript:alert(1)' }, { url: 'https://user:secret@example.com/avatar.jpg' }, { url: '/face.jpg', sourceUrl: 'https://forged.example/', label: 'Portrait', isProfile: true }], profileLinks: [{ url: 'data:text/html,no' }, { url: 'https://x.com/example#bio' }] }, 'https://profile.example/person')
    expect(profile.profileImages).toEqual([{ url: 'https://profile.example/face.jpg', sourceUrl: 'https://profile.example/person', label: 'Portrait', isProfile: true }])
    expect(profile.profileLinks).toEqual([{ url: 'https://x.com/example', rel: 'me' }])
    expect(capturedProfileMetadata({ profileImages: Array.from({ length: 40 }, (_, i) => ({ url: `https://images.example/${i}.jpg` })) }, 'https://profile.example/').profileImages).toHaveLength(8)
  })
})
