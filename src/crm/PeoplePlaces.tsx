import { useEffect, useMemo, useRef, useState } from 'react'
import { crmAll, crmMessage, personName } from './client.ts'
import { OrganizationMark } from './CompanyProfile.tsx'
import { CrmAvatar } from './CrmControls.tsx'
import { crmRecordLocation } from './recordLocation.ts'
import { distanceKm, locateCity, type City } from './geography/places.ts'
import { clusterPlaces } from './geography/clusters.ts'
import land from './geography/land.svg?url'
import type { CrmCompany, CrmFilter, CrmPerson } from './types.ts'
import './peoplePlaces.css'

const cityLabel = (city: City) => [...new Set([city.name, city.region, city.country].filter(Boolean))].join(', ')

type Record = CrmPerson | CrmCompany
const displayName = (record: Record) => typeof record.fullName === 'string' ? personName(record as CrmPerson) : String(record.name)
export default function PeoplePlaces({ initialCity, groupId, filter, search, revision, collection, onSelect }: { initialCity: string; groupId: string; filter: CrmFilter | null; search: string; revision?: number; collection: 'people' | 'companies'; onSelect: (record: Record) => void }) {
  const noun = collection === 'companies' ? 'companies' : 'contacts'
  const [people, setPeople] = useState<Record[]>([])
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [limit, setLimit] = useState(30), [unmatchedLimit, setUnmatchedLimit] = useState(50)
  const map = useRef<HTMLDivElement>(null), [width, setWidth] = useState(720), [openPin, setOpenPin] = useState('')
  const [near, setNear] = useState(initialCity), [radius, setRadius] = useState(80)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void crmAll(collection, controller.signal, { ...(groupId ? { groupId } : {}), q: search, ...(filter ? { filter: JSON.stringify(filter) } : {}) }).then(rows => {
      if (!controller.signal.aborted) { setPeople(rows.filter(p => !p.mergedIntoId)); setLoading(false) }
    }).catch(cause => { if (!controller.signal.aborted) { setError(crmMessage(cause)); setLoading(false) } })
    return () => controller.abort()
  }, [collection, groupId, filter, search, revision])
  useEffect(() => {
    const element = map.current
    if (!element) return
    const measure = () => { if (element.clientWidth) setWidth(element.clientWidth) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure); observer.observe(element)
    return () => observer.disconnect()
  }, [loading])
  useEffect(() => { setOpenPin(''); setLimit(30) }, [near, radius, search, groupId, collection, width])
  const placed = useMemo(() => people.map(person => ({ person, city: locateCity(crmRecordLocation(person)) })), [people])
  const cities = useMemo(() => [...new Set(placed.flatMap(row => row.city ? [row.city] : []))].sort((a, b) => cityLabel(a).localeCompare(cityLabel(b))), [placed])
  const center = cities.find(city => cityLabel(city) === near) ?? locateCity(near)
  const visible = placed.flatMap(({ person, city }) => {
    if (!city || (near.trim() && !center)) return []
    const km = center ? distanceKm(city, center) : 0
    return km <= radius ? [{ person, city, km }] : []
  }).sort((a, b) => a.km - b.km || displayName(a.person).localeCompare(displayName(b.person)))
  const pins = new Map<City, number>()
  for (const { city } of visible) pins.set(city, (pins.get(city) ?? 0) + 1)
  const markers = clusterPlaces(Array.from(pins, ([city,count]) => ({city,count})),width)
  const chosen = markers.find(marker => cityLabel(marker.pins[0].city) === openPin)
  if (error) return <p role="alert">{error}</p>
  if (loading) return <p role="status">Loading locations…</p>
  return <section className="crm-places" aria-label={noun + ' by location'}>
    <div className="crm-places-controls"><label>Near city<input list="crm-known-cities" value={near} placeholder="All locations" onChange={e => setNear(e.target.value)} /></label>
      <datalist id="crm-known-cities">{cities.map(city => <option key={cityLabel(city)} value={cityLabel(city)} />)}</datalist>
      <label>Within<select value={radius} onChange={e => setRadius(Number(e.target.value))}>{[25, 80, 160, 500].map(value => <option key={value} value={value}>{value} km</option>)}</select></label>
      {near && <button className="crm-link-button" onClick={() => setNear('')}>Show all locations</button>}</div>
    <div ref={map} className="crm-places-map" role="group" aria-label={'Map of reported locations for ' + noun}><img src={land} alt="" />{markers.map(marker => {
      const name = cityLabel(marker.pins[0].city), grouped = marker.pins.length > 1
      const label = grouped ? marker.pins.length + ' cities · ' + marker.count + ' ' + noun : name + ' · ' + marker.count + ' ' + noun
      return <button key={name} type="button" style={{ left:marker.x*100+'%',top:marker.y*100+'%' }} aria-label={label} aria-expanded={grouped ? chosen === marker : undefined} title={label} onClick={() => grouped ? setOpenPin(openPin === name ? '' : name) : setNear(name)}>{marker.count < 100 ? marker.count : '99+'}</button>
    })}</div>
    {chosen && <section className="crm-location-cluster" aria-label="Cities in selected cluster"><header><strong>Choose a city</strong><button className="crm-link-button" onClick={() => setOpenPin('')}>Close</button></header><div>{chosen.pins.map(pin => <button key={cityLabel(pin.city)} type="button" onClick={() => setNear(cityLabel(pin.city))}>{cityLabel(pin.city)} <small>{pin.count}</small></button>)}</div></section>}
    <p aria-live="polite">{near && !center ? 'City not identified. Include the state or country, or choose a listed city.' : visible.length + ' ' + noun + ' on the map'} · City-level estimates</p>
    {visible.slice(0, limit).map(({ person, km }) => <button className="crm-place-contact" key={person.id} onClick={() => onSelect(person)}>{collection === 'companies' ? <OrganizationMark allowRemote={false} company={person as CrmCompany} name={displayName(person)} /> : <CrmAvatar name={displayName(person)} assetId={(person as CrmPerson).avatarAssetId} />}<span><strong>{displayName(person)}</strong><small>{[collection === 'companies' ? person.industry : person.jobTitle, crmRecordLocation(person)].filter(Boolean).join(' · ')}</small></span>{center && <small>{Math.round(km)} km</small>}</button>)}
    {visible.length > limit && <button className="crm-link-button" onClick={() => setLimit(limit + 30)}>Show more locations</button>}
    {placed.some(row => !row.city) && <details><summary>Missing or unmatched city ({placed.filter(row => !row.city).length})</summary>{placed.filter(row => !row.city).slice(0, unmatchedLimit).map(({ person }) => <button className="crm-place-contact" key={person.id} onClick={() => onSelect(person)}>{displayName(person)} · {crmRecordLocation(person) || 'No location recorded'}</button>)}{placed.filter(row => !row.city).length > unmatchedLimit && <button className="crm-link-button" onClick={() => setUnmatchedLimit(unmatchedLimit + 50)}>Show more unmatched locations</button>}</details>}
    <small>Map data from Natural Earth</small>
  </section>
}
