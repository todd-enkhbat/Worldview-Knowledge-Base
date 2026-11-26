import { coordinates } from './coordinates.ts'
import type { Coordinates } from './coordinates.ts'
export interface PhotoMetadata { point: Coordinates; date: string | null; detail: string }

/** GPS and capture time from the embedded TIFF directory of a JPEG original. */
export function jpegPhotoMetadata(bytes: Uint8Array): PhotoMetadata | null {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 12 || data.getUint16(0) !== 0xffd8) return null
  for (let pos = 2; pos + 4 <= bytes.length;) {
    if (bytes[pos] !== 255) break
    const marker = bytes[pos + 1]
    if (marker === 0xda || marker === 0xd9) break
    const size = data.getUint16(pos + 2)
    if (size < 2 || pos + 2 + size > bytes.length) break
    if (marker === 0xe1 && size >= 16 && String.fromCharCode(...bytes.slice(pos + 4, pos + 10)) === 'Exif\0\0') {
      const metadata = readTiff(new DataView(bytes.buffer, bytes.byteOffset + pos + 10, size - 8))
      if (metadata) return metadata
    }
    pos += 2 + size
  }
  return null
}
function readTiff(data: DataView): PhotoMetadata | null {
  try {
    const byteOrder = data.getUint16(0), little = byteOrder === 0x4949
    if (!little && byteOrder !== 0x4d4d) return null
    const u16 = (p: number) => data.getUint16(p, little), u32 = (p: number) => data.getUint32(p, little)
    if (u16(2) !== 42) return null
    const directory = (p: number) => {
      const tags = new Map<number, number>()
      if (p < 8 || p + 2 > data.byteLength) return tags
      const count = u16(p)
      if (p + 2 + count * 12 > data.byteLength) return tags
      for (let i = 0; i < count; i++) { const entry = p + 2 + 12 * i; tags.set(u16(entry), entry) }
      return tags
    }
    const ascii = (e?: number) => {
      if (!e || u16(e + 2) !== 2) return ''
      const length = u32(e + 4), offset = length <= 4 ? e + 8 : u32(e + 8)
      if (!length || length > 5000 || offset + length > data.byteLength) return ''
      return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset + offset, length)).replace(/\0.*$/s, '').trim()
    }
    const pointer = (e?: number) => e && u16(e + 2) === 4 && u32(e + 4) === 1 ? u32(e + 8) : 0
    const degrees = (e?: number) => {
      if (!e || u16(e + 2) !== 5 || u32(e + 4) !== 3) return NaN
      const p = u32(e + 8)
      return [0, 8, 16].reduce((sum, k, i) => sum + u32(p + k) / u32(p + k + 4) / 60 ** i, 0)
    }
    const first = directory(u32(4)), gps = directory(pointer(first.get(0x8825))), exif = directory(pointer(first.get(0x8769)))
    const refLat = ascii(gps.get(1)), refLon = ascii(gps.get(3))
    if (!['N', 'S'].includes(refLat) || !['E', 'W'].includes(refLon)) return null
    const point = coordinates(degrees(gps.get(2)) * (refLat === 'S' ? -1 : 1), degrees(gps.get(4)) * (refLon === 'W' ? -1 : 1))
    if (!point) return null
    const raw = ascii(exif.get(0x9003)), offset = ascii(exif.get(0x9011))
    const date = /^(\d{4}):(\d\d):(\d\d) (\d\d:\d\d:\d\d)$/.exec(raw)
    return { point, date: date ? [date[1], date[2], date[3]].join('-') + 'T' + date[4] + (/^[+-]\d\d:\d\d$/.test(offset) ? offset : '') : null, detail: ascii(first.get(0x010e)) }
  } catch (error) { if (error instanceof RangeError) return null; throw error }
}
