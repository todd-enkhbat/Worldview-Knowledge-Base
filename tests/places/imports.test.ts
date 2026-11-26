import { File as NodeFile } from 'node:buffer'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { parseMapLink, parsePlaceFile, parsePlaceText } from '../../src/places/imports.ts'
import { jpegPhotoMetadata } from '../../src/places/photo.ts'

const csv = 'Title,Note,URL,Tags,Comment\r\n"Corner, Café","Quiet ""desk""",https://www.google.com/maps/place/Corner/@29.9,30,work,late'
const file = (body: Uint8Array | string, name: string) => new NodeFile([typeof body === 'string' ? body : new Uint8Array(body)], name) as unknown as File
describe('import source facts', () => {
  it('reads Takeout lists and ignores unrelated zip contents', async () => {
    const archived = zipSync({ 'Takeout/Saved/Want to go.csv': strToU8(csv.replace('@29.9,30', '@29.9')), 'Takeout/Contacts/private.csv': strToU8(csv) })
    const result = await parsePlaceFile(file(archived, 'takeout.zip'), { account: 'Work' })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({ title: 'Corner, Café', latitude: null, longitude: null, kind: 'saved', provider: 'google-maps', account: 'Work' })
    expect(result.entries[0].detail).toContain('Quiet "desk"')
  })
  it('supports the documented Google Saved schema with a collection description and mixed non-geographic items', () => {
    const mixed = ['Our favorite places', '', 'title,note,item_content_url,tags,comment', 'Ballpark,Afternoon,https://www.google.com/maps/place/Wrigley+Field/data=!4m2!3m1!1s0x880fd3b2e59adf21:0x1cea3ee176ddd646,sports,', 'A book,,https://www.google.com/shopping/product/123,books,'].join('\n')
    const result = parsePlaceText(mixed, {file: 'Chicago.csv'})
    expect(result.skipped).toBe(1)
    const id = BigInt('0x1cea3ee176ddd646').toString()
    expect(result.entries[0].id).toEqual(parseMapLink('https://maps.google.com/?cid='+id).id)
    expect(result.entries[0].lists).toEqual([{name:'Chicago', detail:'Afternoon · sports'}])
  })
  it('uses pin coordinates and never promotes map camera positions into locations', () => {
    expect(parseMapLink('https://www.google.com/maps/place/City+Hall/@60,40,15z').latitude).toBeNull()
    expect(parseMapLink('https://www.google.com/maps/place/City+Hall/@60,40,15z/data=!3d3.2!4d8.5')).toMatchObject({ latitude: 3.2, longitude: 8.5, title: 'City Hall' })
    expect(parseMapLink('https://maps.apple.com/place?coordinate=0,-70&name=Office&address=Main')).toMatchObject({ title: 'Office', address: 'Main', latitude: 0, longitude: -70, provider: 'apple-maps' })
    expect(() => parseMapLink('https://example.com/')).toThrow()
  })
  it('reads both Google Timeline schemas and keeps non-visit segments out', () => {
    const start = '2024-05-03T14:00:00Z', end = '2024-05-03T15:00:00Z'
    const visit = { startTime: start, endTime: end, visit: { topCandidate: { placeId: 'abc', placeLocation: { latLng: '42.30°, -71.22°' } } } }
    const modern = parsePlaceText(JSON.stringify({ semanticSegments: [visit, { activity: {} }] }), { file: 'Timeline.json' })
    expect(modern.entries[0]).toMatchObject({ kind: 'visit', latitude: 42.3, longitude: -71.22, startedAt: start, endedAt: end })
    expect(modern.skipped).toEqual(1)
    const legacy = { placeVisit: { duration: { startTimestamp: start, endTimestamp: end }, location: { latitudeE7: 423000000, longitudeE7: -712200000, name: 'Library', placeId: 'abc' } } }
    const older = parsePlaceText(JSON.stringify({ timelineObjects: [legacy] }), { file: 'legacy.json' })
    expect(older.entries[0].id).toEqual(modern.entries[0].id)
    const mobile = { ...visit, visit: { topCandidate: { placeLocation: 'geo:42.30,-71.22' } } }
    expect(parsePlaceText(JSON.stringify([mobile]), { file: 'location-history.json' }).entries[0].latitude).toEqual(42.3)
  })
  it('preserves unresolved Takeout entries and maps GeoJSON in longitude, latitude order', () => {
    const row = (coords: number[]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: coords }, properties: { Title: 'Institute', Location: { Address: 'Main St' }, 'Google Maps URL': 'https://maps.google.com/?cid=123' } })
    const result = parsePlaceText(JSON.stringify({ type: 'FeatureCollection', features: [row([-71, 42]), row([0, 0])] }), { file: 'Saved Places.json' })
    expect(result.entries[0]).toMatchObject({ longitude: -71, latitude: 42, address: 'Main St' })
    expect(result.entries[1]).toMatchObject({ longitude: null, latitude: null })
  })
  it('recognizes an unfolded Luma invite, resolves TZID and skips cancelled and online events', () => {
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:abc', 'DTSTART;TZID=America/New_York:20240708T120000', 'SUMMARY:Garden walk', 'LOCATION:Main St\\, Camb', ' ridge', 'GEO:42.31;-71.29', 'URL:https://lu.ma/e', 'BEGIN:VALARM', 'DESCRIPTION:Reminder', 'END:VALARM', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:cancelled', 'LOCATION:Park', 'STATUS:CANCELLED', 'END:VEVENT', 'BEGIN:VEVENT', 'LOCATION:https://meet.example/video', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
    const result = parsePlaceText(ics, { file: 'invite.ics' })
    expect(result.skipped).toBe(2)
    expect(result.entries[0]).toMatchObject({ kind: 'event', provider: 'luma', startedAt: '2024-07-08T16:00:00.000Z', latitude: 42.31, longitude: -71.29, address: 'Main St, Cambridge', detail: '' })
    expect(parsePlaceText(ics.replace('lu.ma/e', 'partiful.com/e/123'), { file: 'invite.ics' }).entries[0].provider).toBe('partiful')
  })
  it('reads Apple Maps .loc.vcf files and leaves photos with no GPS out', async () => {
    const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:The library\r\nitem1.URL;type=pref:https://maps.apple.com/?ll=42.3,-71.2&q=The+library\r\nEND:VCARD'
    expect(parsePlaceText(vcf, { file: 'library.loc.vcf' }).entries[0]).toMatchObject({ title: 'The library', latitude: 42.3, longitude: -71.2, provider: 'apple-maps' })
    expect(await parsePlaceFile(file(new Uint8Array([255, 216, 255, 217]), 'plain.jpg'), {})).toMatchObject({ entries: [], skipped: 1 })
  })
  it('reads southeast JPEG coordinates from real TIFF rational and reference tags', () => {
    const tiff = new Uint8Array(156), v = new DataView(tiff.buffer)
    const u16 = (at: number, n: number) => v.setUint16(at, n, true)
    const u32 = (at: number, n: number) => v.setUint32(at, n, true)
    const entry = (at: number, tag: number, type: number, count: number, value: number) => { u16(at, tag); u16(at+2, type); u32(at+4, count); u32(at+8, value) }
    u16(0, 0x4949); u16(2, 42); u32(4, 8); u16(8, 1); entry(10, 0x8825, 4, 1, 28); u16(28, 4)
    entry(30, 1, 2, 2, 83); entry(42, 2, 5, 3, 90); entry(54, 3, 2, 2, 69); entry(66, 4, 5, 3, 114)
    for (const [i, n] of [33, 30, 0, 151, 15, 0].entries()) { u32(90 + i*8, n); u32(94 + i*8, 1) }
    const jpeg = new Uint8Array(12 + tiff.length + 2); jpeg.set([255, 216, 255, 225, 0, tiff.length + 8, 69, 120, 105, 102, 0, 0]); jpeg.set(tiff, 12); jpeg.set([255,217],jpeg.length-2)
    expect(jpegPhotoMetadata(jpeg)).toEqual({ point: [-33.5, 151.25], date: null, detail: '' })
  })
})
it('expands only map-provider short links and does not request destination pages', async () => {
  const { expandShortMapLink } = await import('../../server/mapLink.ts')
  let calls = 0
  const short = 'https://maps.apple/p/ABc-1'
  const canonical = 'https://maps.apple.com/place?coordinate=38,-77&name=Park'
  expect(parseMapLink(short).provider).toBe('apple-maps')
  expect(await expandShortMapLink(short, async () => { calls++; return new Response(null, {status:302, headers:{location:canonical}}) })).toBe(canonical)
  expect(calls).toBe(1)
  expect(await expandShortMapLink(short, async () => new Response(null, {status:302, headers:{location:'https://example.com/'}}))).toBe(short)
  await expect(expandShortMapLink('https://maps.apple:8000/p/example')).rejects.toThrow(/short link/)
})
