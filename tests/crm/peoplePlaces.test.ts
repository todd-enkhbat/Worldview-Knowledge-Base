import { expect, it } from 'vitest'
import { distanceKm, locateCity } from '../../src/crm/geography/places.ts'

it('locates qualified cities and leaves conflicting and ambiguous names off the map', () => {
  expect(locateCity('London')).toBeUndefined()
  expect(locateCity('London, UK')?.country).toBe('United Kingdom')
  expect(locateCity('San Francisco, CA, United States')?.region).toBe('California')
  expect(locateCity('San Francisco, NY')).toBeUndefined()
  expect(locateCity('Remote')).toBeUndefined()
})
it('computes city-to-city distances, including across the date line', () => {
  const a = locateCity('New York, NY')!, b = locateCity('Boston, Massachusetts')!
  expect(distanceKm(a, b)).toBeGreaterThan(290)
  expect(distanceKm(a, b)).toBeLessThan(320)
  expect(distanceKm({ lat: 0, lon: 179 }, { lat: 0, lon: -179 })).toBeCloseTo(222.39, 1)
})

it('groups nearby cities at the actual map width, with every contact counted and marker hit targets separate', async () => {
  const {clusterPlaces} = await import('../../src/crm/geography/clusters.ts')
  const pins = ['San Francisco, CA','Oakland, CA','Berkeley, CA','Boston, Massachusetts','New York, NY'].map((name,i)=>({city:locateCity(name)!,count:i+1}))
  for (const width of [320,720,1200]) {
    const clusters = clusterPlaces(pins,width)
    expect(clusters.reduce((sum,c)=>sum+c.count,0)).toBe(15)
    expect(clusters.flatMap(c=>c.pins.map(p=>p.city.name)).sort()).toEqual(pins.map(p=>p.city.name).sort())
    expect(clusters.some(c=>c.pins.length>=3)).toBe(true)
    for (let a=0;a<clusters.length;a++) for(let b=a+1;b<clusters.length;b++) {
      expect(Math.hypot((clusters[a].x-clusters[b].x)*width,(clusters[a].y-clusters[b].y)*width/2)).toBeGreaterThanOrEqual(33.99)
    }
  }
})
