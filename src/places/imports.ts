import { unzipSync } from 'fflate'
import { makeThumbnail } from '../data/attachments.ts'
import { calendarVenues } from './calendarFile.ts'
import { coordinates, coordinateText, mapUrlCoordinates, mapIdentity, mapProvider, safePlaceUrl, type Coordinates } from './coordinates.ts'
import { jpegPhotoMetadata } from './photo.ts'
import type { NativePhotoRecord, PlaceEntry, PlaceImportOptions, PlaceProvider } from './types.ts'

export interface ImportContext extends PlaceImportOptions { file: string }
export interface PlaceDraft {
  identity: string; kind: PlaceEntry['kind']; provider: PlaceProvider; title: string; address?: string; point?: Coordinates | null
  startedAt?: string | null; endedAt?: string | null; url?: string; detail?: string; thumbnail?: string
}
interface ParseResult { entries: PlaceEntry[]; skipped: number; issues: string[] }
const emptyResult = (): ParseResult => ({ entries: [], skipped: 0, issues: [] })
const basename = (name: string) => name.split(/[\\/]/).at(-1) || name
const string = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
function dateText(value: unknown) {
  const date = string(value)
  return /^\d{4}-\d\d-\d\d(?:$|T)/i.test(date) && Number.isFinite(Date.parse(date)) ? date : null
}
function eventProvider(text: string): PlaceProvider {
  if (/(?:^|[^a-z\d.-])(?:www\.)?partiful\.com\b|\bpartiful\b.*\.ics$/i.test(text)) return 'partiful'
  if (/(?:^|[^a-z\d.-])(?:www\.)?(?:lu\.ma|luma\.com)\b|\bluma\b.*\.ics$/i.test(text)) return 'luma'
  return 'calendar'
}
export function createPlace(context: ImportContext, draft: PlaceDraft): PlaceEntry {
  const url = safePlaceUrl(draft.url), point = draft.point || mapUrlCoordinates(url)
  const provider = context.provider || (draft.kind === 'event' && draft.provider === 'calendar' ? eventProvider([url, draft.detail, context.file].join(' ')) : draft.provider)
  const account = context.account?.trim().slice(0, 300) || ''
  const identity = draft.kind === 'saved' && mapProvider(url) ? mapIdentity(url) : draft.identity
  const id = JSON.stringify([provider, account.toLowerCase(), draft.kind, identity])
  return { id, provider, account, kind: draft.kind, title: draft.title.trim().slice(0, 500) || 'Saved place', address: (draft.address || '').trim().slice(0, 2000),
    latitude: point?.[0] ?? null, longitude: point?.[1] ?? null, startedAt: dateText(draft.startedAt), endedAt: dateText(draft.endedAt),
    url, detail: (draft.detail || '').trim().slice(0, 4000), sourceFile: context.file, importedAt: Date.now(), ...(draft.thumbnail ? { thumbnail: draft.thumbnail } : {}) }
}
export function nativePhotoPlace(record: NativePhotoRecord, account?: string): PlaceEntry | null {
  const point = coordinates(record.latitude, record.longitude)
  if (!point || !record.id) return null
  const entry = createPlace({ file: 'Apple Photos library', account: account || record.account }, {
    identity: record.id, provider: 'apple-photos', kind: 'photo', title: record.title || record.filename || 'Photo', point, startedAt: record.date, url: record.url,
    detail: [record.filename, record.description, ...(record.keywords || [])].filter(Boolean).join(' · '), thumbnail: record.thumbnail,
  })
  if (record.visualLabels) entry.visualLabels = [...new Set(record.visualLabels.filter(Boolean))].slice(0, 100).map(label => label.slice(0, 200))
  return entry
}
function timelineDraft(value: unknown): PlaceDraft | null {
  const row = obj(value), visit = obj(row.visit || row.placeVisit)
  if (!Object.keys(visit).length) return null
  const best = obj(visit.topCandidate), loc = obj(visit.location || best.placeLocation), duration = obj(visit.duration)
  const point = coordinateText(string(loc.latLng || best.placeLocation)) ||
    (typeof loc.latitudeE7 === 'number' && typeof loc.longitudeE7 === 'number' ? coordinates(loc.latitudeE7 / 1e7, loc.longitudeE7 / 1e7) : null)
  const start = dateText(row.startTime || duration.startTimestamp), end = dateText(row.endTime || duration.endTimestamp)
  const placeId = string(loc.placeId || best.placeId), address = string(loc.address), name = string(loc.name)
  if (!start || !point && !address && !placeId && !name) return null
  const semantic = string(best.semanticType || loc.semanticType).replace(/^TYPE_/, '').replaceAll('_', ' ').toLowerCase()
  return { identity: [placeId || address || point?.join(',') || name, start].join('|'), kind: 'visit', provider: 'google-maps', title: name || address || (semantic && semantic !== 'unknown' ? semantic[0].toUpperCase() + semantic.slice(1) : 'Recorded visit'), point, address, startedAt: start, endedAt: end, detail: semantic === 'unknown' ? '' : semantic,
    url: placeId ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(name || address || point?.join(',') || placeId) + '&query_place_id=' + encodeURIComponent(placeId) : '' }
}
function geoDraft(value: unknown, context: ImportContext): PlaceDraft | null {
  const feature = obj(value), geometry = obj(feature.geometry), props = obj(feature.properties), location = obj(props.Location)
  const url = safePlaceUrl(props['Google Maps URL'] || props.url || props.URL || props.website)
  const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : []
  let point = geometry.type === 'Point' ? coordinates(coords[1], coords[0]) : null
  const google = 'Google Maps URL' in props || 'Location' in props || /takeout|saved places/i.test(context.file)
  // Takeout uses [0,0] for unresolved places. Keep the source link and address.
  if (google && point?.[0] === 0 && point[1] === 0) point = null
  const address = string(location.Address || props.address), title = string(props.Title || props.title || props.name || location.BusinessName) || address
  if (!url && !title && !point) return null
  return { identity: String(feature.id || url || JSON.stringify([title, address, point])), kind: 'saved', provider: google ? 'google-maps' : 'file',
    title: title || 'Saved place', point, address, url, detail: string(props.Note || props.description), startedAt: dateText(props.Published || props.date) }
}
function jsonPlaces(text: string, context: ImportContext): ParseResult {
  const value: unknown = JSON.parse(text), root = obj(value), result = emptyResult()
  const features = root.type === 'Feature' ? [root] : root.features
  const rows = features || root.semanticSegments || root.timelineObjects || value
  if (!Array.isArray(rows)) throw new Error('Choose a Google Timeline export or a GeoJSON feature collection.')
  for (const item of rows) {
    const draft = features ? geoDraft(item, context) : timelineDraft(item)
    if (draft) result.entries.push(createPlace(context, draft)); else result.skipped++
  }
  return result
}
function csvTable(text: string): string[][] {
  const rows: string[][] = []
  let cells: string[] = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++ } else quoted = !quoted }
    else if (c === ',' && !quoted) { cells.push(field.trim()); field = '' }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++
      cells.push(field.trim()); if (cells.some(Boolean)) rows.push(cells); cells = []; field = ''
    } else field += c
  }
  if (quoted) throw new Error('This CSV has an unclosed quoted field.')
  cells.push(field.trim()); if (cells.some(Boolean)) rows.push(cells)
  return rows
}
function csvPlaces(text: string, context: ImportContext): ParseResult {
  const table = csvTable(text), result = emptyResult()
  // A Takeout collection can start with a free-form description and a blank row.
  const normalized = (v: string) => v.toLowerCase().replace(/[\s_-]/g, '')
  const clues = new Set(['lat', 'latitude', 'url', 'googlemapsurl', 'itemcontenturl', 'eventurl', 'address', 'location', 'venue', 'filename'])
  const headerAt = table.slice(0, 2).findIndex(row => row.length > 1 && row.some(field => clues.has(normalized(field))))
  if (headerAt < 0) throw new Error('This CSV has no place, map link, or photo metadata columns.')
  const keys = table[headerAt].map(normalized), rows = table.slice(headerAt + 1)
  for (const values of rows) {
    const row = Object.fromEntries(keys.map((key, index) => [key, values[index] || '']))
    const url = safePlaceUrl(row.url || row.googlemapsurl || row.itemcontenturl || row.eventurl)
    const address = row.address || row.location || row.venue
    const point = coordinates(row.latitude || row.lat, row.longitude || row.lng || row.lon) || mapUrlCoordinates(url)
    const photo = context.provider === 'apple-photos' || !!row.filename && !!point
    const event = context.provider === 'luma' || context.provider === 'partiful' || !!row.eventname || /(?:lu\.ma|luma\.com|partiful\.com)\//i.test(url)
    const title = row.title || row.name || row.eventname || row.filename || address
    if (!title && !point || !address && !point && !url || photo && !point) { result.skipped++; continue }
    const linkedProvider = mapProvider(url)
    // Saved collections may also contain books, shopping links and image searches.
    if (!address && !point && !linkedProvider && !event) { result.skipped++; continue }
    const google = linkedProvider === 'google-maps' || /takeout|google/i.test(context.file)
    const provider = photo ? 'apple-photos' : event ? eventProvider(url) : linkedProvider || (google ? 'google-maps' : 'file')
    const startedAt = dateText(row.date || row.datetime || row.start || row.starttime || row.datecreated)
    const entry = createPlace(context, { identity: row.id || row.placeid || url || JSON.stringify([title, address, point, startedAt]), kind: photo ? 'photo' : event ? 'event' : 'saved', provider,
      title: title || 'Saved place', address, point, url, startedAt, endedAt: row.end || row.endtime, detail: [row.note, row.tags, row.comment, row.keywords, row.description, row.filename].filter(Boolean).join(' · ') })
    if (provider === 'google-maps' && entry.kind === 'saved') entry.lists = [{ name: basename(context.file).replace(/\.csv$/i, ''), detail: entry.detail }]
    result.entries.push(entry)
  }
  return result
}
function appleCards(text: string, context: ImportContext): ParseResult {
  const result = emptyResult()
  for (const card of text.replace(/\r?\n[ \t]/g, '').match(/BEGIN:VCARD[\s\S]*?END:VCARD/gi) || []) {
    const get = (prop: string) => card.match(new RegExp('^(?:[a-zA-Z0-9_-]+\\.)?' + prop + '(?:;[^:\\n\\r]+)?:(.*)$', 'im'))?.[1]?.trim().replace(/\\([,;\\])/g, '$1') || ''
    const url = safePlaceUrl(get('URL')), point = coordinateText(get('GEO')) || mapUrlCoordinates(url)
    const address = get('ADR').split(';').filter(Boolean).join(', '), title = get('FN') || get('ORG') || address
    if (!point && !address && !url) { result.skipped++; continue }
    result.entries.push(createPlace(context, { identity: get('UID') || url || JSON.stringify([title, address, point]), title: title || 'Saved place', address, point, kind: 'saved', provider: 'apple-maps', url, detail: get('NOTE') }))
  }
  return result
}
export function parsePlaceText(text: string, context: ImportContext): ParseResult {
  const name = context.file.toLowerCase()
  text = text.replace(/^\uFEFF/, '')
  if (/\.(json|geojson)$/.test(name)) return jsonPlaces(text, context)
  if (name.endsWith('.csv')) return csvPlaces(text, context)
  if (name.endsWith('.ics')) { const { drafts, skipped } = calendarVenues(text); return { entries: drafts.map(d => createPlace(context, d)), skipped, issues: [] } }
  if (name.endsWith('.vcf')) return appleCards(text, context)
  throw new Error('Choose a Takeout ZIP, CSV, GeoJSON, Timeline JSON, calendar (.ics), Maps card (.vcf), or geotagged JPEG.')
}
const fileLimit = 100 * 1024 * 1024
const acceptedZipMember = /(?:^|\/)(?:Saved\/[^/]+\.csv|Maps \(your places\)\/[^/]+\.json|Saved Places\.json|(?:Location History(?: \(Timeline\))?|Timeline)\/(?:Semantic Location History\/\d{4}\/[^/]+\.json|Timeline\.json))$/i
export async function parsePlaceFile(file: File, options: PlaceImportOptions): Promise<ParseResult> {
  if (file.size > fileLimit) throw new Error('Choose an export smaller than 100 MiB, or unpack it and select individual files.')
  const context = { ...options, file: file.name }, name = file.name.toLowerCase()
  if (/\.jpe?g$/.test(name)) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const photo = jpegPhotoMetadata(bytes)
    if (!photo) return { entries: [], skipped: 1, issues: [file.name + ' has no readable JPEG GPS metadata.'] }
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    const identity = Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('')
    const preview = await makeThumbnail(file, 200)
    const thumbnail = preview && preview.size <= 40_000 ? 'data:image/webp;base64,' + btoa(String.fromCharCode(...new Uint8Array(await preview.arrayBuffer()))) : undefined
    return { entries: [createPlace(context, { identity, kind: 'photo', provider: 'apple-photos', title: basename(file.name), point: photo.point, startedAt: photo.date, detail: photo.detail, thumbnail })], skipped: 0, issues: [] }
  }
  if (!name.endsWith('.zip')) return parsePlaceText(await file.text(), context)
  let remaining = fileLimit, members = 0
  const selected = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter(entry) {
    if (!acceptedZipMember.test(entry.name) || entry.name.includes('__MACOSX')) return false
    remaining -= entry.originalSize
    if (remaining < 0 || ++members > 1000) throw new Error('Choose a smaller Takeout archive or unpack individual lists.')
    return true
  } })
  const result = emptyResult()
  if (!Object.keys(selected).length) throw new Error('This ZIP contains no recognized Google saved lists or Timeline files. Unpack it and choose the place files directly.')
  for (const [path, bytes] of Object.entries(selected)) {
    try { const part = parsePlaceText(new TextDecoder().decode(bytes), { ...context, file: path }); for (const item of part.entries) result.entries.push(item); result.skipped += part.skipped }
    catch (error) { result.issues.push(basename(path) + ': ' + (error instanceof Error ? error.message : String(error))); result.skipped++ }
  }
  return result
}
export function nativePhotoId(entry: PlaceEntry): string | null {
  if (entry.kind !== 'photo' || entry.provider !== 'apple-photos' || entry.sourceFile !== 'Apple Photos library') return null
  try {
    const identity: unknown = JSON.parse(entry.id)
    return Array.isArray(identity) && typeof identity[3] === 'string' ? identity[3] : null
  } catch { return null }
}

/** Coordinates in the URL identify a pin. The viewport's @lat,lon is deliberately ignored. */
export function parseMapLink(value: string, options: PlaceImportOptions = {}): PlaceEntry {
  const link = safePlaceUrl(value.trim())
  if (!link) throw new Error('Paste a Google Maps or Apple Maps place link.')
  const url = new URL(link), provider = mapProvider(link)
  if (!provider) throw new Error('Paste a link from Apple Maps or Google Maps.')
  const apple = provider === 'apple-maps'
  const query = url.searchParams
  const pathTitle = url.pathname.match(/\/maps\/place\/([^/]+)/)?.[1]
  let title = query.get('name') || query.get('q') || query.get('query') || ''
  if (!title && pathTitle) {
    try { title = decodeURIComponent(pathTitle.replace(/\+/g, ' ')) } catch { /* A malformed title does not invalidate a source link. */ }
  }
  const point = mapUrlCoordinates(link), address = query.get('address') || ''
  const identity = query.get('place-id') || query.get('query_place_id') || query.get('cid') || link
  return createPlace({ ...options, file: apple ? 'Apple Maps link' : 'Google Maps link' }, {
    identity, kind: 'saved', provider: apple ? 'apple-maps' : 'google-maps', title: title || address || (apple ? 'Apple Maps place' : 'Google Maps place'), point, address, url: link,
  })
}
