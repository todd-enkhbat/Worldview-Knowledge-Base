import { expect, it } from 'vitest'
import { groupAtlasEntries, locateEntry, photosDuringVisit, visitDuration } from '../../src/places/atlas.ts'
import { createPlace } from '../../src/places/imports.ts'

it('finds a geotagged photo by its subject, album and nearby city without moving its actual pin', () => {
  const photo=locateEntry({...createPlace({file:'Photo library'}, {identity:'p',kind:'photo',provider:'apple-photos',title:'IMG_88.jpg',point:[42.3601,-71.0942],detail:'Summer walks',startedAt:'2026-06-01'}),visualLabels:['horse']})
  expect(photo.nearby).toBeTruthy()
  expect(photo.latitude).toBe(42.3601)
  const name=photo.nearby!.split(',')[0]
  expect(groupAtlasEntries([photo],'horse '+name+' walks','photo','')).toHaveLength(1)
  expect(groupAtlasEntries([photo],'horse','visit','')).toHaveLength(0)
})
it('keeps unlocated venues searchable and calculates durations only from complete valid intervals', () => {
  const entry=locateEntry(createPlace({file:'invite.ics'}, {identity:'e',kind:'event',provider:'luma',title:'Salon',address:'The night garden'}))
  expect(groupAtlasEntries([entry],'garden','','')[0]).toMatchObject({latitude:null,title:'The night garden'})
  expect(visitDuration('2026-08-01T12:00:00Z','2026-08-01T13:32:00Z')).toBe('1 hr 32 min')
  expect(visitDuration('2026-08-01',null)).toBe('')
})
it('associates photos with a visit across nearby pins while excluding later and distant pictures', () => {
  const common={ identity:'visit',title:'Visit',point:[42.36,-71.09] as [number,number] }
  const visit=createPlace({file:'timeline.json'}, {...common,kind:'visit',provider:'google-maps',startedAt:'2026-08-01T12:00:00Z',endedAt:'2026-08-01T13:00:00Z'})
  const photo=createPlace({file:'Image.jpg'},{...common,identity:'picture',title:'a photo',kind:'photo',provider:'apple-photos',startedAt:'2026-08-01T12:03:00Z',point:[42.3609,-71.09]})
  const photos=[photo,{...photo,latitude:40},{...photo,startedAt:'2026-08-02T10:00:00Z'}]
  expect(photosDuringVisit(visit,photos)).toEqual([photo])
  expect(photosDuringVisit({...visit,endedAt:null},photos)).toEqual([])
})

it('opens a photo into its matching visit or bounds just the neighboring photo times', async()=>{
  const {photoVisit}=await import('../../src/places/atlas.ts')
  const photo=createPlace({file:'Photos'},{identity:'p',kind:'photo',provider:'apple-photos',title:'One',point:[43,-70],startedAt:'2026-11-01T13:00:00Z'})
  const second={...photo,id:'two',startedAt:'2026-11-01T13:45:00Z'}
  const later={...photo,id:'three',startedAt:'2026-11-01T20:00:00Z'}
  const visit={...photo,kind:'visit' as const,id:'v',startedAt:'2026-11-01T12:15:00Z',endedAt:'2026-11-01T14:30:00Z'}
  expect(photoVisit(second,[photo,second,later],[])).toEqual({visit:null,photos:[photo,second]})
  expect(photoVisit(second,[photo,second,later],[visit])).toEqual({visit,photos:[photo,second]})
})
it('leaves undated photographs outside a timed visit',async()=>{
  const {photoVisit}=await import('../../src/places/atlas.ts')
  const photo=createPlace({file:'Photos'},{identity:'p',kind:'photo',provider:'apple-photos',title:'Undated',point:[42,-70]})
  const visit={...photo,kind:'visit' as const,startedAt:'2026-01-01',endedAt:'2026-01-02'}
  expect(photoVisit(photo,[],[visit])).toEqual({visit:null,photos:[photo]})
})
