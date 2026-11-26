import { createHash } from 'node:crypto'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export function previewNameDigest(value: string): string {
  const name = value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
  return name ? hash(name) : ''
}

/** Query values can identify distinct people on the same path. Hash the full
 * identity locally; only a digest goes into the native preview request. */
export function previewUrlDigest(value: string | undefined): string {
  if (!value) return ''
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) if (/^(?:utm_|trk$|trackingId$|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key)
    if (/(^|\.)linkedin\.com$/i.test(url.hostname) && /^\/in\/[^/]+\/?$/i.test(url.pathname)) {
      url.hostname = 'www.linkedin.com'; url.protocol = 'https:'; url.pathname = url.pathname.toLowerCase()
    }
    return hash(url.origin + url.pathname.replace(/\/$/, '') + url.search)
  } catch { return '' }
}
