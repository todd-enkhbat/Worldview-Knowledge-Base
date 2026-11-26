export type Coordinates = [latitude: number, longitude: number]
export function coordinates(lat: unknown, lon: unknown): Coordinates | null {
  if (![lat, lon].every(value => typeof value === 'number' || typeof value === 'string' && value.trim() && /^[-+]?\d+(?:\.\d+)?$/.test(value.trim()))) return null
  const y = Number(lat), x = Number(lon)
  return Number.isFinite(y) && Math.abs(y) <= 90 && Number.isFinite(x) && Math.abs(x) <= 180 ? [y, x] : null
}
export function coordinateText(value: string): Coordinates | null {
  const parts = value.trim().match(/^(?:geo:)?([-+]?\d+(?:\.\d+)?)°?\s*[,;]\s*([-+]?\d+(?:\.\d+)?)°?(?:;u=[\d.]+)?$/i)
  return parts ? coordinates(parts[1], parts[2]) : null
}
export function safePlaceUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) return ''
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return ''
    return url.href
  } catch { return '' }
}
export function mapUrlCoordinates(value: string): Coordinates | null {
  if (!safePlaceUrl(value)) return null
  const url = new URL(value)
  if (url.hostname === 'maps.apple.com') return coordinateText(url.searchParams.get('coordinate') || url.searchParams.get('ll') || '')
  if (!/^(?:maps\.|www\.)?google\.[a-z.]+$/i.test(url.hostname)) return null
  const pin = url.pathname.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/)
  if (pin) return coordinates(pin[1], pin[2])
  return coordinateText(url.searchParams.get('query') || url.searchParams.get('q') || '')
}

export function mapProvider(value: string): 'google-maps' | 'apple-maps' | null {
  if (!safePlaceUrl(value)) return null
  const { hostname, pathname } = new URL(value)
  if (hostname === 'maps.apple.com' || hostname === 'maps.apple' && pathname.startsWith('/p/')) return 'apple-maps'
  if (hostname === 'maps.app.goo.gl' || hostname === 'goo.gl' && pathname.startsWith('/maps/')) return 'google-maps'
  if (/^(?:maps\.|www\.)?google\.(?:[a-z]{2,3}(?:\.[a-z]{2})?)$/.test(hostname) && (hostname.startsWith('maps.') || /^\/maps(?:\/|$)/.test(pathname))) return 'google-maps'
  return null
}
export function mapIdentity(value: string): string {
  const provider = mapProvider(value)
  if (!provider) return value
  const url = new URL(value), params = url.searchParams
  if (provider === 'apple-maps') return params.get('place-id') || value
  const cid = params.get('cid') || params.get('ludocid'), hex = /!1s0x[0-9a-f]+:(0x[0-9a-f]+)/i.exec(url.pathname)
  if (cid && /^\d+$/.test(cid)) return 'cid:' + cid
  if (hex) return 'cid:' + BigInt(hex[1]).toString(10)
  return params.get('query_place_id') || value
}

export function isShortMapLink(value: string): boolean {
  if (!safePlaceUrl(value)) return false
  const { protocol, hostname, pathname, port } = new URL(value)
  return protocol === 'https:' && !port && (
    hostname === 'maps.apple' && /^\/p\/[A-Za-z0-9_.~-]+\/?$/.test(pathname) ||
    hostname === 'maps.app.goo.gl' && /^\/[A-Za-z0-9_-]+\/?$/.test(pathname) ||
    hostname === 'goo.gl' && /^\/maps\/[A-Za-z0-9_-]+\/?$/.test(pathname))
}
