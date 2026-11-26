import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { ArrowsOut, ArrowCounterClockwise, GlobeHemisphereWest, MapTrifold } from '@phosphor-icons/react'
import type { GlobeView } from './globeProjection.ts'
import { AtlasGlobe } from './AtlasGlobe.tsx'
import type { AtlasGroup } from './atlas.ts'
import { nearestCity } from '../crm/geography/places.ts'

type Props = { groups: AtlasGroup[]; active: string; select: (groups: AtlasGroup[]) => void; focus: AtlasGroup | null }
function StreetMap({ groups, active, select, target, switcher }: Omit<Props, 'focus'> & { target: GlobeView | null; switcher: React.ReactNode }) {
  const host = useRef<HTMLDivElement>(null)
  const [map, setMap] = useState<L.Map | null>(null)
  const [tileError, setTileError] = useState(false)
  useEffect(() => {
    const el = host.current
    if (!el) return
    const instance = L.map(el, { minZoom: 1, maxZoom: 19, maxBounds: [[-85,-180],[85,180]], maxBoundsViscosity: 1 }).setView([24, 5], el.clientWidth<920 ? 1 : 2)
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, noWrap: true, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    })
    let failed = false
    tiles.on('loading', () => { failed = false })
    tiles.on('tileerror', () => { failed = true; setTileError(true) })
    tiles.on('load', () => setTileError(failed)).addTo(instance)
    L.control.scale({ imperial: false }).addTo(instance)
    const observer = new ResizeObserver(() => instance.invalidateSize())
    observer.observe(el)
    instance.on('click', (event: L.LeafletMouseEvent) => {
      const {lat,lng} = event.latlng.wrap(), city = nearestCity(lat,lng)
      const content = document.createElement('div'), title = document.createElement('strong'), coords = document.createElement('p'), link = document.createElement('a')
      title.textContent = city ? 'Near '+city.name+', '+city.country : 'Map location'
      coords.textContent = lat.toFixed(4)+'°, '+lng.toFixed(4)+'°'
      link.href = 'https://www.openstreetmap.org/?mlat='+lat+'&mlon='+lng+'#map='+instance.getZoom()+'/'+lat+'/'+lng
      link.textContent = 'Open in OpenStreetMap'; link.target = '_blank'; link.rel = 'noopener noreferrer'
      content.append(title,coords,link); L.popup().setLatLng(event.latlng).setContent(content).openOn(instance)
    })
    setMap(instance)
    return () => { observer.disconnect(); instance.stop(); instance.remove() }
  }, [])
  useEffect(() => {
    if (!map || !target) return
    const center: L.LatLngTuple = [target.lat, target.lon]
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) map.setView(center, Math.max(12,map.getZoom()), {animate:false})
    else map.flyTo(center, Math.max(12,map.getZoom()), {duration:.65})
  }, [map,target])
  useEffect(() => {
    if (!map) return
    const markers = L.layerGroup().addTo(map)
    function draw() {
      if (!map) return
      markers.clearLayers()
      const cells = new Map<string,AtlasGroup[]>(), bounds = map.getBounds().pad(.05)
      for (const g of groups) {
        if (g.latitude === null || g.longitude === null || !bounds.contains([g.latitude,g.longitude])) continue
        const point = map.project([g.latitude,g.longitude]), key = Math.floor(point.x/42)+','+Math.floor(point.y/42)
        const cell = cells.get(key)
        if (cell) cell.push(g); else cells.set(key,[g])
      }
      for (const cell of cells.values()) {
        const first = cell[0], count = cell.reduce((n,g)=>n+g.entries.length,0)
        const title = (cell.length === 1 ? first.title : cell.length+' locations near '+first.title)+' · '+count+' records'
        const icon = L.divIcon({className:'atlas-street-pin'+(cell.some(g=>g.id===active)?' is-selected':''), html:String(count>99?'99+':count), iconSize:[32,32],iconAnchor:[16,16]})
        const marker = L.marker([first.latitude!,first.longitude!],{title,icon}).addTo(markers)
        marker.getElement()?.setAttribute('aria-label',title)
        marker.on('click', () => select(cell))
      }
    }
    draw(); map.on('moveend resize',draw)
    return () => { map.off('moveend resize',draw); markers.remove() }
  }, [map,groups,active,select])
  return <section className="atlas-chart"><header>{switcher}<div className="atlas-map-tools"><button aria-label="Reset map view" title="World view" onClick={()=>map?.setView([24,5],map.getSize().x<920?1:2)}><ArrowCounterClockwise/></button></div></header>
    <div ref={host} className="atlas-street-map" aria-label="Street map with saved locations"/>
    <footer aria-live="polite">{tileError ? 'Some map tiles are unavailable. Your locations and the offline globe are still available.' : 'Select a marker to explore its records.'}</footer></section>
}
export function AtlasMap({expanded,onExpand,...props}: Props & {expanded:boolean;onExpand:(value:boolean)=>void}) {
  const [globe,setGlobe] = useState(false)
  const [target,setTarget] = useState<GlobeView | null>(null)
  useEffect(() => {
    const g=props.focus
    if (g && g.latitude!==null && g.longitude!==null) {
      setTarget({lat:g.latitude,lon:g.longitude});setGlobe(false)
    }
  },[props.focus])
  const openMap = (point:GlobeView) => {setTarget(point);setGlobe(false)}
  const expandButton=useRef<HTMLButtonElement>(null)
  useEffect(()=>{
    if (!expanded) return
    const exit = (event:KeyboardEvent) => { if(event.key==='Escape' && !event.defaultPrevented && !document.querySelector('dialog[open]')) {onExpand(false);expandButton.current?.focus()} }
    document.addEventListener('keydown',exit); return ()=>document.removeEventListener('keydown',exit)
  },[expanded,onExpand])
  const switcher=<div className="atlas-projections" role="group" aria-label="Map controls">
    <button aria-pressed={!globe} onClick={()=>setGlobe(false)}><MapTrifold size={16}/>Map</button>
    <button aria-pressed={globe} onClick={()=>setGlobe(true)}><GlobeHemisphereWest size={16}/>Globe</button>
    <button ref={expandButton} aria-pressed={expanded} onClick={()=>onExpand(!expanded)}><ArrowsOut size={16}/>{expanded?'Collapse':'Expand'}</button></div>
  return <div className="atlas-map-frame">
    {globe ? <AtlasGlobe {...props} switcher={switcher} openMap={openMap}/> : <StreetMap {...props} target={target} switcher={switcher}/>}</div>
}
