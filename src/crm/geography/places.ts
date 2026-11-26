import data from './cities.json'

export interface City { name: string; region: string; country: string; code: string; lat: number; lon: number }
const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
const index = new Map<string, City[]>()
for (const [name, ascii, region, country, code, lat, lon] of data as [string, string, string, string, string, number, number][]) {
  const city = { name, region, country, code, lat, lon }
  for (const key of new Set([normalize(name), normalize(ascii)].filter(Boolean))) {
    const matches = index.get(key) ?? []
    matches.push(city)
    index.set(key, matches)
  }
}
const states = ('AL Alabama|AK Alaska|AZ Arizona|AR Arkansas|CA California|CO Colorado|CT Connecticut|DE Delaware|DC District of Columbia|FL Florida|GA Georgia|HI Hawaii|ID Idaho|IL Illinois|IN Indiana|IA Iowa|KS Kansas|KY Kentucky|LA Louisiana|ME Maine|MD Maryland|MA Massachusetts|MI Michigan|MN Minnesota|MS Mississippi|MO Missouri|MT Montana|NE Nebraska|NV Nevada|NH New Hampshire|NJ New Jersey|NM New Mexico|NY New York|NC North Carolina|ND North Dakota|OH Ohio|OK Oklahoma|OR Oregon|PA Pennsylvania|RI Rhode Island|SC South Carolina|SD South Dakota|TN Tennessee|TX Texas|UT Utah|VT Vermont|VA Virginia|WA Washington|WV West Virginia|WI Wisconsin|WY Wyoming').toLowerCase().split('|')
const regions = Object.fromEntries(states.map(entry => [entry.slice(0, 2), entry.slice(3)]))
const aliases: Record<string, string> = { nyc: 'new york, ny', 'new york city': 'new york, ny', 'san francisco bay area': 'san francisco, ca', 'sf bay area': 'san francisco, ca', uk: 'gb', usa: 'us', 'united states of america': 'us', england: 'united kingdom' }
export function locateCity(location: string): City | undefined {
  const parts = normalize(location).split(',').flatMap(piece => (Object.hasOwn(aliases, piece.trim()) ? aliases[piece.trim()] : piece).split(',')).map(part => part.trim()).filter(Boolean)
  const [name, ...context] = parts
  const candidates = (index.get(name) ?? []).filter(city => context.every(key =>
    [normalize(city.region), normalize(city.country), normalize(city.code)].includes(key) ||
    (city.code === 'US' && regions[key] === normalize(city.region)) ||
    (key === 'united states' && city.code === 'US')))
  return candidates.length === 1 ? candidates[0] : undefined
}
export function distanceKm(a: Pick<City, 'lat' | 'lon'>, b: Pick<City, 'lat' | 'lon'>) {
  const rad = Math.PI / 180
  const h = Math.sin((a.lat - b.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((a.lon - b.lon) * rad / 2) ** 2
  return 12742 * Math.asin(Math.sqrt(Math.min(1, h)))
}

/** Resolve nearby city names on-device for geotagged records. Keep the recorded coordinates. */
const cityCells = new Map<string, City[]>()
for (const city of new Set(Array.from(index.values()).flat())) {
  const cell=Math.floor(city.lat)+','+Math.floor(city.lon)
  const list=cityCells.get(cell) ?? []
  list.push(city); cityCells.set(cell,list)
}
export function nearestCity(latitude: number, longitude: number, maxKm = 25): City | undefined {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude)>90 || Math.abs(longitude)>180) return
  let best: City | undefined, distance=maxKm
  const latRad=maxKm/110, lonRad=Math.min(180,latRad/Math.max(.001,Math.cos((Math.abs(latitude)+latRad)*Math.PI/180)))
  for (let y=Math.max(-90, Math.floor(latitude-latRad)); y<=Math.min(90, Math.floor(latitude+latRad)); y++) {
    for(let x=Math.floor(longitude-lonRad);x<=Math.floor(longitude+lonRad);x++){
      const cell=y+','+(((x+180)%360+360)%360-180)
      for (const city of cityCells.get(cell) ?? []) {
        const km=distanceKm({lat:latitude,lon:longitude},city)
        if (km <= distance) { best=city; distance=km }
      }
    }
  }
  return best
}
