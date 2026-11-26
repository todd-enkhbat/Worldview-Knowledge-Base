import { createRequire } from 'node:module'
import { createContext, Script } from 'node:vm'
import { expect, it } from 'vitest'
import { extractProfile } from '../../extensions/worldview-reader/extract.js'
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options: { url: string }) => { window: { document: Document; close(): void } } }
function capture(html: string, url: string, serialized = false) { const dom = new JSDOM(html, { url }); try { return serialized ? new Script(`(${extractProfile.toString()})(null, true)`).runInContext(createContext({ document: dom.window.document, URL, TextEncoder })) : extractProfile(dom.window.document) } finally { dom.window.close() } }
it('reads a title-agreed LinkedIn H2 with initials and no portrait without capturing recommended people', () => {
  const url = 'https://www.linkedin.com/in/mohit-example/'
  const html = '<title>Mohit A. | LinkedIn</title><main><section><h2>Mohit A. <span>· 2nd</span></h2><p>Thrive Capital</p><p>San Francisco, California, United States</p><a href="/in/mohit-example/overlay/contact-info/">Contact info</a></section><aside><h1>Wrong Person</h1></aside></main>'
  expect(capture(html, url, true).profile).toMatchObject({ name: 'Mohit A.', entityType: 'person', images: [] })
  expect(() => capture(html.replace('/in/mohit-example/overlay', '/in/other/overlay'), url)).toThrow('No single named')
})
it('reads a visible Instagram identity and bio, with an optional portrait, without post text', () => {
  const html = '<meta property="og:title" content="Ada Example (@ada.example) • Instagram photos and videos"><main><header><h2>ada.example</h2><span>Ada Example</span><div data-testid="user-bio">Designer and researcher</div><img alt="ada.example profile picture" src="https://cdn.example/avatar.jpg"></header><article>Private feed post must stay out</article></main>'
  const result = capture(html, 'https://www.instagram.com/ada.example/', true)
  expect(result.profile).toMatchObject({ name: 'Ada Example', entityType: 'person', description: 'Designer and researcher', images: [{ url: 'https://cdn.example/avatar.jpg', isProfile: true }] })
  expect(result.text).not.toContain('Private feed post')
  expect(capture(html.replace(/<img[^>]*>/, ''), 'https://www.instagram.com/ada.example/').profile.images).toEqual([])
})
it('retains Facebook numeric profile identity and does not require an avatar', () => {
  const html = '<title>Ada Example | Facebook</title><main><section><h1>Ada Example</h1><p data-testid="profile-bio">Independent researcher</p></section><article>Do not capture the timeline</article></main>'
  const result = capture(html, 'https://www.facebook.com/profile.php?id=12345678')
  expect(result.url).toBe('https://www.facebook.com/profile.php?id=12345678')
  expect(result.profile).toMatchObject({ name: 'Ada Example', images: [], description: 'Independent researcher' })
  expect(result.text).not.toContain('timeline')
})
it('rejects feeds, posts, login gates, and unmatched Instagram metadata', () => {
  const html = '<main><h1>Ada Example</h1></main>'
  for (const url of ['https://www.instagram.com/p/123/', 'https://www.instagram.com/accounts/login/', 'https://www.facebook.com/groups/123/', 'https://www.facebook.com/login.php']) expect(() => capture(html, url)).toThrow('main Instagram or Facebook profile')
  expect(() => capture('<title>Ada Example | Instagram</title><main>Sign in to see more</main>', 'https://www.instagram.com/ada/')).toThrow('header is not visible')
})
