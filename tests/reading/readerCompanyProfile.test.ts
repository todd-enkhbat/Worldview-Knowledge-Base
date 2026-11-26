import { createRequire } from 'node:module'
import { createContext, Script } from 'node:vm'
import { expect, it } from 'vitest'
import { extractProfile } from '../../extensions/worldview-reader/extract.js'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options: { url: string }) => { window: { document: Document; close(): void } } }
const profileUrl = 'https://www.linkedin.com/company/marsh-studio/'
const other = '<section><h2>Similar companies</h2><img alt="Company logo" src="https://images.example/other.png"><span>Website</span><a href="https://other.example">other.example</a><a href="https://other.example">Visit website</a></section>'
const news = '<article><h2>News</h2><p>Unrelated news.</p><a href="https://news.example">Visit website</a></article>'
function capture(body: string, suffix = '') {
  const page = new JSDOM('<title>Marsh Studio: Overview | LinkedIn</title><main>' + body + '</main>', { url: profileUrl + suffix })
  try {
    return new Script('(' + extractProfile.toString() + ')(document)').runInContext(createContext({ document: page.window.document, URL, TextEncoder }))
  } finally { page.window.close() }
}
it('reads the company’s own hero CTA, modern title and lazy logo on its main page, excluding news and suggestions', () => {
  const redirect = '/redir/redirect?url=' + encodeURIComponent('https://marsh.example/?utm_source=linkedin')
  const body = '<header><a href="/company/marsh-studio/">Marsh Studio</a><img alt="Marsh Studio logo" data-delayed-url="https://images.example/marsh.png" src="data:image/png;base64,xxx"><a aria-label="Visit website for Marsh Studio" href="' + redirect + '">Visit site</a><a href="https://press.example/story">Press</a></header><section><h2>Overview</h2><p>We build equipment for researchers.</p><p>Our studio is based in Boston.</p>' + news + '</section>' + other
  const { profile } = capture(body)
  expect(profile).toMatchObject({ name: 'Marsh Studio', entityType: 'company', urls: [profileUrl, 'https://marsh.example/'], images: [{ subjectName: 'Marsh Studio', url: 'https://images.example/marsh.png' }], description: 'We build equipment for researchers.\n\nOur studio is based in Boston.' })
})
it('prefers the About Website field over a hero CTA and extracts adjacent labeled values outside a definition list', () => {
  const body = '<section class="org-top-card"><h1>Marsh Studio</h1><a href="https://campaign.example/">Visit website</a></section><div role="region"><div role="heading" aria-level="2">Overview</div><p>We build equipment for researchers.</p><div><div><span>Website</span></div><div><a href="/safety/go?url=https%3A%2F%2Fmarsh.example%2F">www.marsh.example</a></div></div><div><strong>Industry</strong><p>Research services</p></div><div><p>Headquarters</p><p>Boston, MA</p></div></div>' + other + news
  expect(capture(body, 'about/').profile).toMatchObject({ urls: [profileUrl, 'https://marsh.example/'], description: 'We build equipment for researchers.', industry: 'Research services', location: 'Boston, MA' })
})
it('uses a visible plain-text official domain and an About description in modern adjacent divs', () => {
  const body = '<header><h1>Marsh Studio</h1></header><div><div role="heading" aria-level="2">About</div><div>We build equipment for researchers.</div></div><div><span>Website</span><div>www.marsh.example</div></div>'
  expect(capture(body, 'about/').profile).toMatchObject({ urls: [profileUrl, 'https://www.marsh.example/'], description: 'We build equipment for researchers.' })
})
it('rejects private, credentialed, obscured or misrepresented destinations and leaves unrelated logos out', () => {
  for (const href of ['/redir/redirect?url=http%3A%2F%2F127.0.0.1%2F', 'https://lnkd.in/short', 'https://name:pass@host.example/', 'https://wrong.example/story', '/company/some-other-company/']) {
    const body = '<header><h1>Marsh Studio</h1></header><section><h2>About</h2><p>We build equipment for researchers.</p><div><span>Website</span><a href="' + href + '">marsh.example</a></div></section>' + other
    expect(capture(body, 'about/').profile).toMatchObject({ urls: [profileUrl], images: [] })
  }
})
