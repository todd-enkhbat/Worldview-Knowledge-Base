import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowCounterClockwise, Minus, Plus } from '@phosphor-icons/react'
import { GlobeSurface } from './GlobeSurface.tsx'
import { globeProjection, normalizedView, wrapLongitude, type GlobeView } from './globeProjection.ts'
import type { AtlasGroup } from './atlas.ts'
import './globe.css'

const home: GlobeView = { lat: 24, lon: -36 }
const location = (g: AtlasGroup | null | undefined) => g && g.latitude !== null && g.longitude !== null ? { lat: g.latitude, lon: g.longitude } : null
export function AtlasGlobe({groups, active, select, focus, switcher, openMap}: {
  groups: AtlasGroup[]; active: string; select: (group: AtlasGroup[]) => void; focus: AtlasGroup | null; switcher: React.ReactNode; openMap: (point: GlobeView) => void
}) {
  const scene = useRef<HTMLDivElement>(null), moved = useRef(false)
  const initial = location(groups.find(group => location(group))) ?? home
  const initialSet = useRef(groups.some(group => location(group)))
  const [view,setView] = useState<GlobeView>(initial), [zoom,setZoom] = useState(1)
  const [size,setSize] = useState({w:720,h:360}), [theme,setTheme] = useState('light')
  const frame = useRef<number | null>(null), current = useRef(view)
  const drag = useRef<{id:number; x:number; y:number; start:GlobeView; groups?:AtlasGroup[]} | null>(null)
  const title = useId()
  const cancel = useCallback(() => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null }, [])
  const apply = useCallback((next: GlobeView) => { current.current = next; setView(next) }, [])
  const orient = useCallback((goal: GlobeView) => {
    cancel()
    if (typeof matchMedia !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches) { apply(goal); return }
    const from = current.current, delta = wrapLongitude(goal.lon - from.lon), started = performance.now()
    function step(now: number) {
      const progress = Math.min(1,(now-started)/440), mix = 1 - (1-progress)**3
      apply(normalizedView(from.lat+(goal.lat-from.lat)*mix,from.lon+delta*mix))
      frame.current = progress < 1 ? requestAnimationFrame(step) : null
    }
    frame.current = requestAnimationFrame(step)
  }, [apply,cancel])
  useEffect(() => () => cancel(),[cancel])
  useEffect(() => {
    const point = location(groups.find(group => location(group)))
    if (!initialSet.current && !moved.current && point) { initialSet.current = true; apply(point) }
  }, [groups,apply])
  useEffect(() => { const point = location(focus); if (point) { orient(point);goalZoom.current=Math.max(goalZoom.current,2);setZoom(goalZoom.current) } }, [focus, orient])
  useEffect(() => {
    const element = scene.current
    if (!element) return
    const measure = () => { if (element.clientWidth && element.clientHeight) setSize({w:element.clientWidth,h:element.clientHeight}) }
    measure()
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    resize?.observe(element)
    const owner = element.closest('[data-theme]'), readTheme = () => setTheme(owner?.getAttribute('data-theme') ?? 'light')
    readTheme()
    const observer = owner ? new MutationObserver(readTheme) : null
    if (owner) observer?.observe(owner,{attributes:true,attributeFilter:['data-theme']})
    return () => { resize?.disconnect();observer?.disconnect() }
  },[])
  const radius = Math.min(size.w*.43,size.h*.46)*zoom, cx=size.w/2, cy=size.h/2
  const project=useMemo(()=>globeProjection(view),[view])
  const ordered = useMemo(() => [...groups].sort((a,b)=>Number(b.id===active)-Number(a.id===active)), [groups,active])
  const points=useMemo(()=>{
    const list:{x:number;y:number;groups:AtlasGroup[];total:number}[]=[]
    const buckets = new Map<string, typeof list>(), spacing = 24
    for (const group of ordered) {
      const pos=location(group); if(!pos)continue
      const mark=project(pos.lat,pos.lon), x=cx+radius*mark.x, y=cy+radius*mark.y
      if(mark.z<=.016 || x<8 || y<8 || x>size.w-8 || y>size.h-8)continue
      const col=Math.floor(x/spacing),row=Math.floor(y/spacing)
      let near: typeof list[number] | undefined
      for(let dx=-1;dx<=1&&!near;dx++) for(let dy=-1;dy<=1&&!near;dy++) near=buckets.get((col+dx)+','+(row+dy))?.find(p=>Math.hypot(p.x-x,p.y-y)<spacing)
      if(near){near.groups.push(group);near.total+=group.entries.length;continue}
      const entry={x,y,groups:[group],total:group.entries.length},key=col+','+row
      list.push(entry);const bucket=buckets.get(key)??[];bucket.push(entry);buckets.set(key,bucket)
    }
    return list
  },[ordered,project,cx,cy,radius,size])
  const touches = useRef(new Map<number, {x:number; y:number}>())
  const pinch = useRef(0), dragged = useRef(false), zoomFrame = useRef(0), goalZoom = useRef(1)
  const adjust = useCallback((factor:number, animate = true) => {
    const target = Math.min(5,Math.max(.75,goalZoom.current*factor))
    goalZoom.current = target
    cancelAnimationFrame(zoomFrame.current)
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) { setZoom(target); return }
    const started = performance.now()
    const step = (now:number) => {
      const done = now-started >= 180
      setZoom(old=>done ? target : old+(target-old)*.28)
      if (!done) zoomFrame.current=requestAnimationFrame(step)
    }
    zoomFrame.current=requestAnimationFrame(step)
  },[])
  useEffect(() => {
    const element=scene.current
    if (!element) return
    const wheel=(event:WheelEvent) => {
      event.preventDefault()
      const dy = event.deltaY*(event.deltaMode===1?16:1)
      adjust(Math.exp(-Math.max(-220,Math.min(220,dy))*.0025),false)
    }
    element.addEventListener('wheel',wheel,{passive:false})
    return () => { element.removeEventListener('wheel',wheel);cancelAnimationFrame(zoomFrame.current) }
  },[adjust])
  const reset = () => { adjust(1/goalZoom.current);orient(location(groups.find(group=>location(group)))??home) }
  function release(id:number) {
    touches.current.delete(id); pinch.current=0; drag.current=null
  }
  function enterAt(clientX:number,clientY:number) {
    const bounds=scene.current?.getBoundingClientRect()
    if (!bounds) return
    const x=(clientX-bounds.left-cx)/radius, y=(clientY-bounds.top-cy)/radius, square=1-x*x-y*y
    if (square<0) return
    const radians=Math.PI/180, lat=current.current.lat*radians, z=Math.sqrt(square)
    openMap(normalizedView(Math.asin(Math.max(-1,Math.min(1,z*Math.sin(lat)-y*Math.cos(lat))))/radians,
      current.current.lon+Math.atan2(x,z*Math.cos(lat)+y*Math.sin(lat))/radians))
  }
  function openRecords(picked:AtlasGroup[]) {
    const point=location(picked[0])
    if(point)orient(point)
    select(picked)
  }
  function keys(e:KeyboardEvent<HTMLDivElement>) {
    if(e.target!==e.currentTarget)return
    if(e.key==='Enter'){e.preventDefault();openMap(current.current);return}
    const directions:Record<string,[number,number]>={ArrowLeft:[0,-1],ArrowRight:[0,1],ArrowUp:[1,0],ArrowDown:[-1,0]}
    const step=directions[e.key]
    if(step){e.preventDefault();moved.current=true;cancel();apply(normalizedView(view.lat+step[0]*12/zoom,view.lon+step[1]*15/zoom))}
    else if(['+','=','-','Home'].includes(e.key)){e.preventDefault();if(e.key==='Home')reset();else adjust(e.key==='-'?.8:1.25)}
  }
  return <section className="atlas-chart atlas-globe-chart" aria-label="Globe of matching places">
    <header>{switcher}<div className="atlas-map-tools">
      <button type="button" aria-label="Zoom out globe" disabled={zoom<=.75} onClick={()=>adjust(1/1.5)}><Minus/></button>
      <button type="button" aria-label="Zoom in globe" disabled={zoom>=5} onClick={()=>adjust(1.5)}><Plus/></button>
      <button type="button" aria-label="Reset globe view" onClick={reset}><ArrowCounterClockwise/></button></div></header>
    <div ref={scene} className="atlas-globe-scene" role="group" aria-label="Interactive globe" aria-describedby={title} tabIndex={0} onKeyDown={keys}
      onPointerDown={e=>{
        if(e.button!==0)return
        const marker = (e.target as Element).closest<HTMLButtonElement>('[data-globe-marker]')
        const picked = marker && points.find(p=>p.groups[0].id===marker.dataset.globeMarker)
        cancel();moved.current=true;touches.current.set(e.pointerId,{x:e.clientX,y:e.clientY})
        dragged.current=touches.current.size>1
        drag.current={id:e.pointerId,x:e.clientX,y:e.clientY,start:current.current,groups:picked?.groups}
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={e=>{
        if(!touches.current.has(e.pointerId))return
        touches.current.set(e.pointerId,{x:e.clientX,y:e.clientY})
        if(touches.current.size===2){
          const [a,b]=[...touches.current.values()],distance=Math.hypot(a.x-b.x,a.y-b.y)
          if(pinch.current>0 && distance>0)adjust(distance/pinch.current,false)
          pinch.current=distance;dragged.current=true;return
        }
        const d=drag.current;if(!d||d.id!==e.pointerId)return
        const dx=e.clientX-d.x,dy=e.clientY-d.y
        if(Math.hypot(dx,dy)<4 && !dragged.current)return
        dragged.current=true
        if(!e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.setPointerCapture(e.pointerId)
        const next=normalizedView(d.start.lat+dy*55/radius,d.start.lon-dx*55/radius)
        cancel();frame.current=requestAnimationFrame(()=>{frame.current=null;apply(next)})
      }}
      onPointerUp={e=>{
        if(touches.current.has(e.pointerId) && !dragged.current){
          const picked=drag.current?.groups
          if(picked)openRecords(picked)
          else enterAt(e.clientX,e.clientY)
        }
        release(e.pointerId)
      }} onPointerCancel={e=>release(e.pointerId)} onLostPointerCapture={e=>{if(e.target===e.currentTarget)release(e.pointerId)}}>
      <GlobeSurface view={view} radius={radius} width={size.w} height={size.h} theme={theme} markers={points}/>
      {points.map((point,index)=>{const g=point.groups[0],cluster=point.groups.length>1,label=cluster?point.groups.length+' locations near '+g.title.replace(/^near\s+/i,''):g.title
        const showLabel=g.id===active || (!active && index===0 && point.x>54 && point.x<size.w-54)
        return <button type="button" key={g.id} data-globe-marker={g.id} className="atlas-pin atlas-sphere-pin" style={{left:point.x,top:point.y}} data-selected={g.id===active} data-label-side={point.x>size.w*.65?'left':'right'} title={label} aria-label={label+', '+point.total+' records'} onClick={e=>{ if(e.detail===0)openRecords(point.groups) }}><i>{point.total>1?(point.total>=1000?Math.round(point.total/100)/10+'k':point.total):<span/>}</i>{showLabel && <small>{cluster && !/^near\s/i.test(g.title) ? 'Near '+g.title : g.title}</small>}</button>})}
    </div>
    <footer><span id={title}>Drag to rotate · Click the globe to open the map</span><span>Natural Earth</span></footer>
  </section>
}
