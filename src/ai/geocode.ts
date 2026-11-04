// Address → coordinates through OpenStreetMap's Nominatim search, only when the user asks
// ("Find on map" on a place). Nominatim's policy: at most one request a second, and a
// referer identifying the app (browsers send it). Results are cached for the session.

const ENDPOINT = 'https://nominatim.openstreetmap.org/search'
const cache = new Map<string, { lat: number; lng: number } | null>()
let last = 0

export function parseNominatim(body: unknown): { lat: number; lng: number } | null {
  if (!Array.isArray(body) || !body.length) return null
  const hit = body[0] as { lat?: unknown; lon?: unknown }
  const lat = Number(hit.lat)
  const lng = Number(hit.lon)
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null
}

export async function geocode(query: string, f: typeof fetch = fetch): Promise<{ lat: number; lng: number } | null> {
  const q = query.trim()
  if (!q) return null
  if (cache.has(q)) return cache.get(q)!
  const wait = last + 1100 - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  last = Date.now()
  const res = await f(`${ENDPOINT}?${new URLSearchParams({ q, format: 'jsonv2', limit: '1' })}`, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`map search failed (${res.status})`)
  const hit = parseNominatim(await res.json())
  cache.set(q, hit)
  return hit
}
