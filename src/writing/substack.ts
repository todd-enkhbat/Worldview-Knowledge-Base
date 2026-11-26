export const SUBSTACK_PROFILE = 'https://substack.com/@thetallerpoppy'
export const SUBSTACK_PUBLICATION = 'https://thetallerpoppy.substack.com'
export const SUBSTACK_KV = 'writing.substack.v1'
export interface SubstackPost { id: number; title: string; subtitle: string; url: string; slug: string; date: string; excerpt: string }
export interface SubstackSnapshot { profile: { name: string; handle: string; bio: string; photo: string }; posts: SubstackPost[]; hasMore: boolean; checkedAt: number }
export function substackLink(value: unknown, image = false): string {
  try {
    const url = new URL(String(value))
    const hosts = image ? ['substackcdn.com', 'substack-post-media.s3.amazonaws.com'] : ['substack.com', 'thetallerpoppy.substack.com']
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.includes(url.hostname) ? url.href : ''
  } catch { return '' }
}
