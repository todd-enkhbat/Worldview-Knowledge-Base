import { useLayoutEffect, useRef } from 'react'
import { geoCentroid, geoOrthographic, geoPath } from 'd3-geo'
import { feature, mesh } from 'topojson-client'
import type { Topology, GeometryCollection } from 'topojson-specification'
import world from 'world-atlas/countries-110m.json'
import { globeProjection, type GlobeView } from './globeProjection.ts'

// Decode the bundled Natural Earth geometry once. Only visible paths are projected while rotating.
const topology = world as unknown as Topology<{ countries: GeometryCollection<{name:string}>; land: GeometryCollection }>
const land = feature(topology, topology.objects.land)
const borders = mesh(topology, topology.objects.countries, (a, b) => a !== b)
const countries = feature(topology, topology.objects.countries).features.map(country => ({
  name: String(country.properties?.name ?? ''), center: geoCentroid(country),
}))

export function GlobeSurface({ view, radius, width, height, theme, markers }: {
  view: GlobeView; radius: number; width: number; height: number; theme: string; markers: {x:number; y:number}[]
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const element = canvas.current, ctx = element?.getContext('2d')
    if (!element || !ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (element.width !== Math.round(width*dpr)) element.width = Math.round(width*dpr)
    if (element.height !== Math.round(height*dpr)) element.height = Math.round(height*dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const dark = theme === 'dark'
    const projection = geoOrthographic().rotate([-view.lon, -view.lat]).translate([width/2,height/2]).scale(radius).precision(.65)
    const trace = geoPath(projection, ctx)
    ctx.beginPath(); trace({type:'Sphere'}); ctx.fillStyle = dark ? '#23383c' : '#cfdfdf'; ctx.fill()
    ctx.beginPath(); trace(land); ctx.fillStyle = dark ? '#65786c' : '#f5f1df'; ctx.fill()
    ctx.strokeStyle = dark ? '#91a196' : '#97aaa1'; ctx.lineWidth = .8; ctx.stroke()
    ctx.beginPath(); trace(borders); ctx.strokeStyle = dark ? '#475b55' : '#bac0ac'; ctx.lineWidth = .7; ctx.stroke()
    const project = globeProjection(view)
    const occupied = markers.map(p => ({left:p.x-16, right:p.x+16, top:p.y-13, bottom:p.y+13}))
    ctx.font = '12px "Alte Haas", system-ui, sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    for (const {name,center:[lon,lat]} of countries) {
      const p = project(lat,lon), x = width/2 + radius*p.x, y = height/2 + radius*p.y
      if (p.z < .45 || y < 12 || y > height-12) continue
      const half = ctx.measureText(name).width/2+4, left=x-half, right=x+half
      if (left < 4 || right > width-4 || occupied.some(b => left<b.right && right>b.left && y-9<b.bottom && y+9>b.top)) continue
      ctx.lineWidth=3; ctx.strokeStyle=dark?'#52665a':'#f5f1df'; ctx.strokeText(name,x,y)
      ctx.fillStyle=dark?'#f7f4e7':'#47594f'; ctx.fillText(name,x,y)
      occupied.push({left,right,top:y-9,bottom:y+9})
    }
  }, [view,radius,width,height,theme,markers])
  return <canvas ref={canvas} className="atlas-country-surface" aria-hidden="true" />
}
