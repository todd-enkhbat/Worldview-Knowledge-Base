// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://app.folk.app/apps/contacts/network/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/groups/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}
import { afterEach, expect, it, vi } from 'vitest'
import { extractFolkPhotos } from '../../extensions/worldview-reader/extract.js'

const person = 'df786886-4d08-4709-a230-fc0c8bca9ad8', group = 'grp_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const bounds = (top = 20) => ({ width: 40, height: 40, left: 20, right: 60, top, bottom: top + 40, x: 20, y: top, toJSON: () => ({}) })
function render(html: string) { document.body.innerHTML = html; vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => bounds()); for (const image of document.querySelectorAll('img')) Object.defineProperties(image, { complete: { value: true, configurable: true }, naturalWidth: { value: 48, configurable: true }, naturalHeight: { value: 48, configurable: true }, currentSrc: { value: image.src, configurable: true } }) }
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })

it('captures only visible bounded row diagnostics without guessing IDs from names or reading hidden application state', () => {
  render(`<script>window.privateState = "session secret"</script><div role="row" data-person-id="${person}" data-id="not-an-identity" data-sensitive="private"><span hidden>Hidden email</span><input value="secret@example.com"><img src="https://photos.example/ada.jpg" alt="Avatar"><a href="/apps/contacts/person/${person}">Ada Example<span hidden>Hidden personal detail</span></a><a hidden href="https://hidden.example/private">Hidden link</a><a href="javascript:alert(1)">Unsafe link</a></div><div role="row" hidden><img src="https://photos.example/hidden.jpg"></div><div role="row"><img style="opacity:0" src="https://photos.example/transparent.jpg"></div>`)
  document.title = 'My Folk group'
  const batch = extractFolkPhotos(document)
  expect(batch).toMatchObject({ url: document.location.href, title: 'My Folk group', groupId: group, folkPhotos: [] })
  expect(batch.folkPhotoRows).toEqual([{ photoUrl: 'https://photos.example/ada.jpg', name: 'Ada Example', attributes: { 'data-person-id': person }, nearbyLinks: [{ href: `https://app.folk.app/apps/contacts/person/${person}`, text: 'Ada Example' }], sourceUrl: document.location.href, groupId: group, imageState: { alt: 'Avatar', ariaLabel: '', title: '', rowImageCount: 1, complete: true, naturalWidth: 48, naturalHeight: 48, currentSrc: 'https://photos.example/ada.jpg', requestedSources: ['https://photos.example/ada.jpg'], personLinkCount: 0, verifiedReason: 'no-same-group-person-link' } }])
  expect(JSON.stringify(batch)).not.toMatch(/Hidden|private|secret|data-sensitive|not-an-identity/)
  expect(batch).not.toHaveProperty('text'); expect(batch).not.toHaveProperty('progress')
})

it('excludes offscreen images and credential-bearing URLs, deduplicates repeated rows, and bounds a batch to fifty', () => {
  render(`<div role="row"><img id="offscreen" src="https://photos.example/offscreen.jpg" alt="Offscreen"></div><div role="row"><img src="https://user:password@photos.example/credentials.jpg" alt="Credentials"></div>${Array.from({ length: 60 }, (_, i) => `<div role="row"><img src="https://photos.example/${i}.jpg" alt="Person ${i}"></div>`).join('')}<div role="row"><img src="https://photos.example/0.jpg" alt="Person 0"></div>`)
  Object.defineProperty(document.getElementById('offscreen')!, 'getBoundingClientRect', { value: () => bounds(2000) })
  const rows = extractFolkPhotos(document).folkPhotoRows
  expect(rows).toHaveLength(50)
  expect(rows[0].name).toBe('Person 0'); expect(rows.at(-1)?.name).toBe('Person 49')
  expect(JSON.stringify(rows)).not.toMatch(/credentials|password|offscreen/)
})

it('works as a serialized standalone function and refuses a non-group or foreign document', () => {
  render(`<div role="row"><img src="https://photos.example/person.jpg" alt="Ada Example" data-contact-id="per_${person}"></div>`)
  const serialize = new Function(`return (${extractFolkPhotos.toString()})`)() as typeof extractFolkPhotos
  expect(serialize(document).folkPhotoRows[0].attributes).toEqual({ 'data-contact-id': `per_${person}` })
  const foreign = document.implementation.createHTMLDocument('foreign')
  expect(() => serialize(foreign)).toThrow()
})

it('maps only a matching named image and an unambiguous observed person link in the exact workspace and group', () => {
  const prefix = '/apps/contacts/network/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/groups/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const row = (id: string, name: string, href: string, extra = '') => `<div role="row"><img src="https://documents.folk.app/${id}" alt="${name}"><a href="${href}">${name}</a>${extra}</div>`
  render(row('person', 'Ada Example', `${prefix}/people/${person}`) + row('company', 'Example Corp', `${prefix}/companies/${person}`) + row('other-group', 'Other Group', `${prefix.replace('bbbbbbbb', 'eeeeeeee')}/people/${person}`) + row('ambiguous', 'Two People', `${prefix}/people/af786886-4d08-4709-a230-fc0c8bca9ad8`, `<a href="${prefix}/people/bf786886-4d08-4709-a230-fc0c8bca9ad8">Another Person</a>`))
  expect(extractFolkPhotos(document).folkPhotos).toEqual([{ personId: `per_${person}`, name: 'Ada Example', photoUrl: 'https://documents.folk.app/person', sourceUrl: `${document.location.origin}${prefix}/people/${person}`, groupId: group }])
})

it('does not assign a company logo to a person or choose between conflicting portraits for the same person', () => {
  const href = `${document.location.href}/people/${person}`
  render(`<div role="row"><img src="https://documents.folk.app/company" alt="Example Company"><a href="${href}">Ada Example</a></div>`)
  expect(extractFolkPhotos(document).folkPhotos).toEqual([])
  render(`<div role="row"><img src="https://documents.folk.app/first" alt="Ada Example"><a href="${href}">Ada Example</a></div><div role="row"><img src="https://documents.folk.app/conflicting" alt="Ada Example"><a href="${href}">Ada Example</a></div>`)
  expect(extractFolkPhotos(document).folkPhotos).toEqual([])
})

it('does not apply an unloaded, placeholder or stale currentSrc from a recycled virtual row', () => {
  const href = `${document.location.href}/people/${person}`
  render(`<div role="row"><img src="https://documents.folk.app/new-face" alt="Ada Example"><a href="${href}">Ada Example</a></div>`)
  const image = document.querySelector('img')!
  expect(extractFolkPhotos(document).folkPhotos).toHaveLength(1)
  Object.defineProperty(image, 'complete', { value: false }); expect(extractFolkPhotos(document).folkPhotos).toEqual([])
  Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 0 } }); expect(extractFolkPhotos(document).folkPhotos).toEqual([])
  Object.defineProperties(image, { naturalWidth: { value: 48 }, currentSrc: { value: 'https://documents.folk.app/old-person-face' } }); expect(extractFolkPhotos(document).folkPhotos).toEqual([])
  Object.defineProperty(image, 'currentSrc', { value: image.src }); expect(extractFolkPhotos(document).folkPhotos).toHaveLength(1)
})

it('binds Folk’s observed blank-alt avatar only in a semantic row with exactly one image and one verified person link', () => {
  const href = `${document.location.href}/people/${person}`
  const row = (inside: string, semantic = true) => `<div${semantic ? ' role="row"' : ''}>${inside}</div>`
  const img = '<img src="https://documents.folk.app/face" alt="">', link = `<a href="${href}">Ada Example</a>`
  render(row(img + link)); expect(extractFolkPhotos(document).folkPhotos).toHaveLength(1)
  render(row(img + link, false)); expect(extractFolkPhotos(document).folkPhotos).toEqual([])
  render(row(img + '<img src="https://documents.folk.app/logo" alt="">' + link)); expect(extractFolkPhotos(document).folkPhotos).toEqual([])
  render(row(img + link + `<a href="${document.location.href}/companies/${person}">Company</a>`)); expect(extractFolkPhotos(document).folkPhotos).toEqual([])
  render(row(img.replace('alt=""', 'alt="Wrong Person"') + link)); expect(extractFolkPhotos(document).folkPhotos).toEqual([])
  render(row(img + link)); Object.defineProperty(document.querySelector('img')!, 'currentSrc', { value: 'https://documents.folk.app/old-person' }); expect(extractFolkPhotos(document).folkPhotos).toEqual([])
})
