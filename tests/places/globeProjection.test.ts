import { describe, expect, it } from 'vitest'
import { globeProjection, globeTextureIndex, normalizedView, rad, wrapLongitude } from '../../src/places/globeProjection.ts'

describe('offline atlas globe', () => {
  it('centers the selected location and hides its antipode', () => {
    const view = {lat: 42.36, lon: -71.06}, project = globeProjection(view)
    const front = project(view.lat,view.lon), back = project(-view.lat,view.lon+180)
    expect(front.x).toBeCloseTo(0); expect(front.y).toBeCloseTo(0); expect(front.z).toBeCloseTo(1)
    expect(back.z).toBeCloseTo(-1)
    expect(normalizedView(100,185)).toEqual({lat:90,lon:-175})
  })
  it('keeps markers registered with the coastline after crossing the date line or looking down on a pole', () => {
    const width=1440,height=720
    for(const view of [{lat:66,lon:166},{lat:-38,lon:-147},{lat:90,lon:24}]) {
      const project=globeProjection(view)
      for(const lat of [-68.3,10.2,60.3,78.7]) for(const lon of [-178.2,-87.4,30.3,174.7]) {
        const point=project(lat,lon)
        if(point.z<=0)continue
        const texel=globeTextureIndex(point.x,point.y,point.z,Math.cos(view.lat*rad),Math.sin(view.lat*rad),view.lon,width,height)
        expect(texel%width).toBe(Math.floor((wrapLongitude(lon)+180)*width/360))
        expect(Math.floor(texel/width)).toBe(Math.floor((90-lat)*height/180))
      }
    }
  })
})
