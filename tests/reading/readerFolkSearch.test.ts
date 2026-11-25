// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://app.folk.app/apps/contacts/network/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/search"}
import { afterEach, expect, it, vi } from 'vitest'
import { extractFolkPhotos } from '../../extensions/worldview-reader/extract.js'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })
it('retains visible Search row diagnostics without promoting even observed person IDs to writable photos', () => {
  document.body.innerHTML = '<div role="listitem" data-person-id="per_df786886-4d08-4709-a230-fc0c8bca9ad8"><img alt="Ada Example" src="https://documents.folk.app/avatar"><button>Ada Example</button><span>ADA@example.com</span><span hidden>hidden@example.com</span><input value="private@example.com"><a href="/apps/contacts/network/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/groups/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/people/df786886-4d08-4709-a230-fc0c8bca9ad8">Ada Example</a></div>'
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 40, height: 40, top: 20, left: 20, bottom: 60, right: 60, x: 20, y: 20, toJSON: () => ({}) })
  const result = extractFolkPhotos(document)
  expect(result).toMatchObject({ scope: 'network-search-diagnostic', groupId: '', folkPhotos: [], folkPhotoRows: [{ name: 'Ada Example', groupId: '', attributes: { 'data-person-id': 'per_df786886-4d08-4709-a230-fc0c8bca9ad8' } }] })
  expect(result.folkPhotoRows).toHaveLength(1)
  expect(result.folkPhotoRows[0].imageState?.verifiedReason).toBe('no-same-group-person-link')
  expect(result.folkPhotoRows[0]).toMatchObject({ visibleEmails: ['ada@example.com'], avatarLabel: 'Ada Example', rowRole: 'listitem', isPrimaryAvatar: true })
  expect(JSON.stringify(result)).not.toMatch(/hidden@example|private@example/)
  expect(result).not.toHaveProperty('text'); expect(result).not.toHaveProperty('progress')
})
it('reads a visible avatar wrapper label and distinguishes its company logo without reading hidden/form emails', () => {
  document.body.innerHTML = '<div role="option"><span role="img" aria-label="Ada Example"><img src="https://documents.folk.app/ada"></span><h3>Ada Example</h3><span>ada@example.com</span><span style="display:none">hidden@example.com</span><form><span>form@example.com</span></form><span role="img" aria-label="Example Company"><img src="https://documents.folk.app/company"></span></div>'
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 40, height: 40, top: 20, left: 20, bottom: 60, right: 60, x: 20, y: 20, toJSON: () => ({}) })
  const rows = extractFolkPhotos(document).folkPhotoRows
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({ name: 'Ada Example', visibleEmails: ['ada@example.com'], avatarLabel: 'Ada Example', rowRole: 'option', isPrimaryAvatar: true })
  expect(rows[1]).toMatchObject({ name: 'Ada Example', visibleEmails: ['ada@example.com'], avatarLabel: 'Example Company', isPrimaryAvatar: false })
  expect(extractFolkPhotos(document).folkPhotos).toEqual([])
})
