import { distanceKm, locateCity, nearestCity } from '../crm/geography/places.ts'
import { personName } from '../crm/client.ts'
import { crmRecordLocation } from '../crm/recordLocation.ts'
import { organizationClusters } from '../crm/organizationClusters.ts'
import type { CrmCompany, CrmPerson } from '../crm/types.ts'
import type { PlaceEntry } from './types.ts'

export type AtlasEntry = Omit<PlaceEntry, 'kind' | 'provider'> & {
  kind: PlaceEntry['kind'] | 'person'
  provider: PlaceEntry['provider'] | 'people'
  avatarAssetId?: string | null
  organizations?: {id:string;name:string;logo?:string|null;linked:boolean}[]
  nearby?: string
  approximate?: boolean
  city?: string
}
export const sourceNames = { 'google-maps': 'Google Maps', 'apple-maps': 'Apple Maps', luma: 'Luma', partiful: 'Partiful', calendar: 'Calendar', 'apple-photos': 'Apple Photos', file: 'File', people: 'People' }
export const layerNames = { saved: 'Saved', visit: 'Visits', event: 'Events', photo: 'Photos', person: 'People' }
export function contactPlaces(people: CrmPerson[], companies: CrmCompany[] = []): AtlasEntry[] {
  const orgs=organizationClusters(people,companies)
  const records=new Map(companies.map(company=>[company.id,company]))
  return people.flatMap(person => {
    const address = crmRecordLocation(person)
    if (!address || person.mergedIntoId || person.archivedAt) return []
    const city = locateCity(address)
    const organizations=Array.from(orgs.byPerson.get(person.id) ?? [],id=>({id,name:orgs.names.get(id)!,logo:records.get(id)?.logoAssetId,linked:records.has(id)}))
    return [{ id: 'contact:' + person.id, kind: 'person', provider: 'people', title: personName(person), address, latitude: city?.lat ?? null, longitude: city?.lon ?? null, city: city?.name, approximate: !!city, account: '', startedAt: null, endedAt: null, url: '#/people?person=' + encodeURIComponent(person.id), detail: person.jobTitle, organizations, sourceFile: 'Contact location', importedAt: 0, avatarAssetId: person.avatarAssetId }]
  })
}
export function locateEntry(entry: PlaceEntry): AtlasEntry {
  if (entry.latitude !== null && entry.longitude !== null) {
    const nearby=nearestCity(entry.latitude,entry.longitude)
    return nearby ? { ...entry, nearby: [nearby.name,nearby.region,nearby.country].filter(Boolean).join(', ') } : entry
  }
  if (!entry.address) return entry
  const parts = entry.address.split(',').map(p => p.trim().replace(/^([A-Za-z]{2})\s+\d{5}(?:-\d{4})?$/, '$1'))
  for (let i = 0; i < parts.length; i++) {
    const city = locateCity(parts.slice(i).join(', '))
    if (city) return { ...entry, city: city.name, approximate:true, latitude: city.lat, longitude: city.lon }
  }
  return entry
}
export const searchKey = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()
export interface AtlasGroup { id: string; title: string; entries: AtlasEntry[]; latitude: number | null; longitude: number | null }
export function groupAtlasEntries(rows: AtlasEntry[], query: string, layer: string, account: string): AtlasGroup[] {
  const groups = new Map<string, AtlasGroup>(), words = searchKey(query).trim().split(/\s+/).filter(Boolean)
  for (const entry of rows) {
    if ((layer && entry.kind !== layer) || (account && entry.account !== account)) continue
    const haystack = searchKey([entry.title, entry.address, entry.city, entry.nearby, entry.detail, ...(entry.organizations ?? []).map(o=>o.name), ...(entry.visualLabels ?? []), ...(entry.lists ?? []).map(list=>list.name + ' ' + list.detail), entry.account, entry.startedAt, sourceNames[entry.provider], entry.sourceFile].filter(Boolean).join(' '))
    if (!words.every(word => haystack.includes(word))) continue
    const { latitude, longitude } = entry
    const title = entry.city || (entry.kind === 'person' || entry.kind === 'event' ? entry.address : entry.kind === 'photo' ? entry.address || (entry.nearby ? 'Near '+entry.nearby.split(',')[0] : 'Photo location') : entry.title) || entry.title
    const id = latitude !== null && longitude !== null ? latitude.toFixed(3) + ',' + longitude.toFixed(3) : 'address:' + searchKey(entry.address || title)
    const group = groups.get(id)
    if (group) { group.entries.push(entry); if (group.title === 'Photo location') group.title = title }
    else groups.set(id, { id, title, entries: [entry], latitude, longitude })
  }
  for (const group of groups.values()) group.entries.sort((a,b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '') || a.title.localeCompare(b.title))
  return [...groups.values()].sort((a,b) => b.entries.length - a.entries.length || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
}
export function visitDuration(start: string | null, end: string | null) {
  if (!start || !end) return ''
  const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60000)
  if (!Number.isFinite(minutes) || minutes < 0) return ''
  if (minutes < 1) return '<1 min'
  return [minutes >= 60 && Math.floor(minutes / 60) + ' hr', minutes % 60 > 0 && minutes % 60 + ' min'].filter(Boolean).join(' ')
}

/** A visit links personal photos only when their capture times and recorded coordinates agree. */
export function photosDuringVisit(visit: AtlasEntry, photosByTime: AtlasEntry[]) {
  if (visit.kind!=='visit' || visit.latitude===null || visit.longitude===null || !visit.startedAt || !visit.endedAt) return []
  const start=Date.parse(visit.startedAt), end=Date.parse(visit.endedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start>end) return []
  let low=0, high=photosByTime.length
  while (low<high) {
    const mid=Math.floor((low+high)/2)
    if (Date.parse(photosByTime[mid].startedAt!)<start) low=mid+1
    else high=mid
  }
  const matches:AtlasEntry[]=[]
  for(let i=low;i<photosByTime.length;i++) {
    const photo=photosByTime[i], at=Date.parse(photo.startedAt!)
    if(at>end) break
    if(photo.latitude!==null && photo.longitude!==null && distanceKm({lat:visit.latitude,lon:visit.longitude},{lat:photo.latitude,lon:photo.longitude})<=.5) matches.push(photo)
  }
  return matches
}

export function photoVisit(photo: AtlasEntry, photos: AtlasEntry[], visits: AtlasEntry[]) {
  if (!photo.startedAt || !Number.isFinite(Date.parse(photo.startedAt))) return {visit:null,photos:[photo]}
  const matches = visits.filter(visit => photosDuringVisit(visit,[photo]).length)
  matches.sort((a,b) => (Date.parse(a.endedAt!)-Date.parse(a.startedAt!))-(Date.parse(b.endedAt!)-Date.parse(b.startedAt!)))
  const visit = matches[0]
  if (visit) return {visit,photos:photosDuringVisit(visit,photos)}
  const index = photos.findIndex(row=>row.id===photo.id)
  if(index<0 || photo.latitude===null || photo.longitude===null || !photo.startedAt) return {visit:null,photos:[photo]}
  const close = (candidate: AtlasEntry, previous: AtlasEntry) => candidate.latitude!==null && candidate.longitude!==null &&
    Math.abs(Date.parse(candidate.startedAt!)-Date.parse(previous.startedAt!))<=90*60000 &&
    distanceKm({lat:photo.latitude!,lon:photo.longitude!},{lat:candidate.latitude,lon:candidate.longitude})<=.5
  let first=index,last=index
  while(first>0 && close(photos[first-1],photos[first])) first--
  while(last+1<photos.length && close(photos[last+1],photos[last])) last++
  return {visit:null,photos:photos.slice(first,last+1)}
}
