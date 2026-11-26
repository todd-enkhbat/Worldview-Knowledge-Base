import { isShortMapLink, mapProvider, safePlaceUrl } from '../src/places/coordinates.ts'

/** Read redirect headers from the provider's shortener; a destination URL never receives a request. */
export async function expandShortMapLink(raw: string, request: typeof fetch = fetch): Promise<string> {
  if (!isShortMapLink(raw)) throw new Error('Choose a shared Google Maps or Apple Maps short link.')
  let url = new URL(raw).href
  const provider = mapProvider(url), timeout = AbortSignal.timeout(5000)
  for (let hop = 0; hop < 3; hop++) {
    const response = await request(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: timeout })
    const target = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
    await response.body?.cancel()
    if (!target) break
    const next = safePlaceUrl(new URL(target, url).href)
    if (!next || !next.startsWith('https://') || mapProvider(next) !== provider) break
    if (!isShortMapLink(next)) return next
    url = next
  }
  return raw
}
