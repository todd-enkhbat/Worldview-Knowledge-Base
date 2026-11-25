// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SocialProfileEditor, SocialProfileLinks, replaceSocialProfile, safeProfileUrl, socialEditorValues, socialProfile } from '../../src/crm/socialProfiles.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

it('recognizes actual platform hosts and does not trust a lookalike domain or unsafe URL', () => {
  expect(socialProfile('https://www.linkedin.com/in/ada/')?.platform.id).toBe('linkedin')
  expect(socialProfile('https://twitter.com/ada')?.platform.id).toBe('x')
  expect(socialProfile('https://linkedin.com.other.example/in/ada')?.platform.id).toBe('website')
  expect(socialProfile('https://linkedin.com@other.example/in/ada')).toBeNull()
  expect(safeProfileUrl('javascript:alert(1)')).toBe('')
  expect(safeProfileUrl('data:image/png;base64,eA==')).toBe('')
  expect(socialProfile('https://example.test/%ZZ')?.platform.id).toBe('website')
})

it('renders labeled platform links with no remote photos or unsafe links', async () => {
  await act(async () => root.render(<SocialProfileLinks urls={['https://linkedin.com/in/ada', 'https://x.com/ada', 'https://ada.example', 'javascript:alert(1)', 'https://x.com/ada']} />))
  expect(host.querySelectorAll('a')).toHaveLength(3)
  expect(host.textContent).toContain('LinkedIn')
  expect(host.textContent).toContain('X / Twitter')
  expect(host.querySelector('a[data-platform="linkedin"]')?.getAttribute('rel')).toBe('noreferrer noopener')
  expect(host.querySelector('img')).toBeNull()
  expect(host.querySelector('script')).toBeNull()
})

it('keeps duplicate and unrecognized source links when editing a named social profile', () => {
  const originals = ['https://x.com/old', 'https://x.com/secondary', 'https://notes.example/old', 'https://mastodon.example/@ada', 'original:retained']
  const updated = replaceSocialProfile(originals, 'x', 'https://x.com/new')
  expect(updated).toEqual(['https://x.com/new', ...originals.slice(1)])
  expect(socialEditorValues(updated).other).toEqual(['https://x.com/secondary', 'https://mastodon.example/@ada', 'original:retained'])
  expect(replaceSocialProfile(updated, 'x', '')).toEqual(originals.slice(1))
})

it('keeps an incomplete URL draft in its labeled field while preserving all other profiles', async () => {
  const changed = vi.fn(), originals = ['https://linkedin.com/in/ada', 'https://x.com/secondary', 'original:retained']
  await act(async () => root.render(<SocialProfileEditor value={originals} onChange={changed} />))
  const input = host.querySelector<HTMLInputElement>('[aria-label="LinkedIn URL"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  expect(input.value).toBe('https://')
  expect(changed).toHaveBeenLastCalledWith(['https://', 'https://x.com/secondary', 'original:retained'])
  const additional = host.querySelector<HTMLTextAreaElement>('[aria-label="Additional profile URLs"]')!
  expect(additional.value).toBe('original:retained')
})
