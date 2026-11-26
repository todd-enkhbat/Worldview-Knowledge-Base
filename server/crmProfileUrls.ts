/** Credentials and nonstandard ports are never sent to a supplied profile or image host. */
export function publicProfileUrl(value: unknown, base?: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try { const url = new URL(value, base); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port && url.port !== (url.protocol === 'https:' ? '443' : '80') || url.href.length > 8192 || /(^|\.)(localhost|local|internal|test|invalid)$/i.test(url.hostname)) return null; url.hash = ''; return url.href } catch { return null }
}
export function profilePlatform(raw: string): string {
  try { const host = new URL(raw).hostname.replace(/^www\./, '').toLowerCase(); return /(^|\.)linkedin\.com$/.test(host) ? 'linkedin' : /(^|\.)(twitter\.com|x\.com)$/.test(host) ? 'x' : /(^|\.)github\.com$/.test(host) ? 'github' : /(^|\.)instagram\.com$/.test(host) ? 'instagram' : /(^|\.)facebook\.com$/.test(host) ? 'facebook' : /(^|\.)youtube\.com$/.test(host) || host === 'youtu.be' ? 'youtube' : /(^|\.)bsky\.app$/.test(host) ? 'bluesky' : /(^|\.)substack\.com$/.test(host) ? 'substack' : /(^|\.)threads\.(net|com)$/.test(host) ? 'threads' : /(^|\.)tiktok\.com$/.test(host) ? 'tiktok' : 'website' } catch { return 'website' }
}

export interface CatalogCompanyWebsite { url: string; labels: Record<string, string> }

/** Bare homepages and single language landing pages only. Directory, faculty,
 * campus and hosted profile paths do not establish a parent organization's domain. */
export function organizationHomepageHost(raw: unknown) {
  const value = publicProfileUrl(raw)
  if (!value || profilePlatform(value) !== 'website') return ''
  const url = new URL(value)
  return !url.search && /^\/(?:[a-z]{2}(?:[-_][a-z]{2,4})?\/?)?$/i.test(url.pathname) ? url.hostname.replace(/^www\./, '') : ''
}
