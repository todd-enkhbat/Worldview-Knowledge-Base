import type { IncomingMessage, ServerResponse } from 'node:http'
import { htmlToText } from '../fetchUrl.ts'
import { memoryOriginAllowed, sendMemoryJson } from '../memoryHttp.ts'
import { SUBSTACK_PROFILE, SUBSTACK_PUBLICATION, substackLink, type SubstackSnapshot } from '../../src/writing/substack.ts'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown, max = 1000) => typeof value === 'string' ? value.trim().slice(0, max) : ''
export function parseSubstackProfile(html: string): SubstackSnapshot['profile'] {
  const raw = /<script\b[^>]*id="preloads-json"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1]
  if (!raw) throw new Error('Substack changed its profile format. Open your profile on Substack or try again later.')
  const profile = object(object(JSON.parse(raw)).profile)
  if (profile.handle !== 'thetallerpoppy' || !text(profile.name)) throw new Error('Substack did not return the expected profile.')
  return { name: text(profile.name, 200), handle: 'thetallerpoppy', bio: text(profile.bio), photo: substackLink(profile.photo_url, true) }
}
export function parseSubstackPosts(value: unknown): Pick<SubstackSnapshot, 'posts' | 'hasMore'> {
  const result = object(value), entries = Array.isArray(value) ? value : result.posts
  if (!Array.isArray(entries)) throw new Error('Substack could not return your published writing. Please try again later.')
  return { posts: entries.slice(0, 20).flatMap(entry => {
    const p = object(entry), url = substackLink(p.canonical_url), slug = text(p.slug, 200)
    if (!Number.isSafeInteger(p.id) || !url || !/^[a-z0-9-]+$/.test(slug) || !text(p.title)) return []
    return [{ id: Number(p.id), title: text(p.title, 300), subtitle: text(p.subtitle), url, slug, date: Number.isFinite(Date.parse(String(p.post_date))) ? String(p.post_date) : '', excerpt: text(p.truncated_body_text, 3000) }]
  }), hasMore: !!result.nextCursor }
}
const cache = new Map<string, { at: number; value: unknown }>()
const pending = new Map<string, Promise<unknown>>()
async function read(url: string): Promise<unknown> {
  const saved = cache.get(url)
  if (saved && Date.now() - saved.at < 5 * 60_000) return saved.value
  const running = pending.get(url)
  if (running) return running
  const task = (async () => {
    // Every target is constructed here on the two fixed Substack hosts. Redirects
    // are refused; no credentials, cookies, local drafts or user URLs are forwarded.
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { accept: url === SUBSTACK_PROFILE ? 'text/html' : 'application/json' } })
    if (!response.ok) throw new Error(`Substack is unavailable (${response.status}). Your local writing is safe.`)
    const reader = response.body?.getReader(); if (!reader) throw new Error('Substack returned an empty response.')
    const parts: Uint8Array[] = []; let bytes = 0
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('This Substack response is too large.') } parts.push(next.value) }
    const body = Buffer.concat(parts).toString('utf8'), value: unknown = url === SUBSTACK_PROFILE ? parseSubstackProfile(body) : JSON.parse(body)
    cache.set(url, { at: Date.now(), value }); while (cache.size > 32) cache.delete(cache.keys().next().value!)
    return value
  })()
  pending.set(url, task)
  try { return await task } finally { pending.delete(url) }
}
export async function handleSubstack(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!memoryOriginAllowed(req) || !req.headers['x-wv-client']) return sendMemoryJson(res, 403, { error: 'Open your workspace to read Substack.' })
  if (req.method !== 'GET') return sendMemoryJson(res, 405, { error: 'Substack is read only here.' })
  try {
    const slug = new URL(req.url!, 'http://localhost').searchParams.get('post')
    if (slug !== null) {
      if (!/^[a-z0-9-]{1,200}$/.test(slug)) return sendMemoryJson(res, 400, { error: 'Invalid Substack post.' })
      const post = object(await read(`${SUBSTACK_PUBLICATION}/api/v1/posts/${slug}`))
      return sendMemoryJson(res, 200, { text: htmlToText(text(post.body_html, 500_000)), title: text(post.title, 300) })
    }
    const [profile, archive] = await Promise.all([read(SUBSTACK_PROFILE), read(`${SUBSTACK_PUBLICATION}/api/v1/archive?sort=new&limit=20`)])
    sendMemoryJson(res, 200, { profile, ...parseSubstackPosts(archive), checkedAt: Date.now() })
  } catch (cause) { sendMemoryJson(res, 502, { error: cause instanceof Error ? cause.message : 'Substack could not be reached. Try again later.' }) }
}
