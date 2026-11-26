import { describe, expect, it } from 'vitest'
import { parseSubstackPosts, parseSubstackProfile } from '../../server/connections/substack.ts'
import { substackLink } from '../../src/writing/substack.ts'
import { PORTABLE_WORLD_KEYS } from '../../src/data/worldSnapshot.ts'

describe('Substack public reader', () => {
  it('reads only the requested identity from public profile data', () => {
    const html = `<script id="preloads-json" type="application/json">${JSON.stringify({ profile: { handle: 'thetallerpoppy', name: 'Todd Enkhbat', bio: 'lover of humanity', photo_url: 'https://substack-post-media.s3.amazonaws.com/public/photo.jpeg' } })}</script>`
    expect(parseSubstackProfile(html)).toMatchObject({ name: 'Todd Enkhbat', handle: 'thetallerpoppy' })
    expect(() => parseSubstackProfile(html.replace('thetallerpoppy', 'another'))).toThrow('expected profile')
    expect(() => parseSubstackProfile('<html>Unavailable</html>')).toThrow('profile format')
  })
  it('supports the current cursor archive and older array responses', () => {
    const post = { id: 1, title: 'Essay', slug: 'essay', canonical_url: 'https://thetallerpoppy.substack.com/p/essay', post_date: '2026-09-02', truncated_body_text: 'Opening words' }
    expect(parseSubstackPosts({ posts: [post], nextCursor: 'next' })).toMatchObject({ hasMore: true, posts: [{ title: 'Essay', excerpt: 'Opening words' }] })
    expect(parseSubstackPosts([post]).posts).toHaveLength(1)
    expect(() => parseSubstackPosts({ errors: [] })).toThrow('published writing')
  })
  it('rejects executable and foreign URLs and excludes malformed posts', () => {
    for (const url of ['javascript:alert(1)', 'https://evil.test', 'https://substack.com.evil.test', 'https://user@substack.com/', 'https://substack.com:8080/']) expect(substackLink(url)).toBe('')
    expect(substackLink('https://substack.com/@thetallerpoppy')).toBeTruthy()
    expect(substackLink('https://evil.test/photo.png', true)).toBe('')
    expect(parseSubstackPosts({ posts: [{ id: 1, title: 'Bad', slug: '../private', canonical_url: 'https://thetallerpoppy.substack.com/p/bad' }] }).posts).toEqual([])
  })
  it('includes the offline public profile and post list in portable backups', () => {
    expect(PORTABLE_WORLD_KEYS).toContain('writing.substack.v1')
  })
})
