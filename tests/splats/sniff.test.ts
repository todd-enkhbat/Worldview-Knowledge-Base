import { closeSync, existsSync, openSync, readSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extensionOf, sniffSplat, zipEntryNames } from '../../src/world/splats/ingest/sniff.ts'

const FIXTURES = join(import.meta.dirname, '../../public/fixtures')

function head(name: string, n = 64): Uint8Array | null {
  const path = join(FIXTURES, name)
  if (!existsSync(path)) return null
  const fd = openSync(path, 'r')
  try {
    const buf = new Uint8Array(n)
    const got = readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, got)
  } finally {
    closeSync(fd)
  }
}

const enc = (s: string) => new TextEncoder().encode(s)

/** A one-member zip local header (no data), enough for head-only sniffing. */
function zipHead(member: string): Uint8Array {
  const name = enc(member)
  const out = new Uint8Array(30 + name.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x04034b50, true)
  dv.setUint16(26, name.length, true)
  out.set(name, 30)
  return out
}

describe('sniffSplat on fixture headers', () => {
  const cases: [string, string, boolean][] = [
    ['lion.v3.spz', 'spz', false],
    ['tomatoes.v4.spz', 'spz', true],
    ['apartment.sog', 'sog', false],
    ['knock-community-hall.sog', 'sog', false],
  ]
  for (const [file, format, v4] of cases) {
    const bytes = head(file)
    it.skipIf(!bytes)(`${file} → ${format}${v4 ? ' (v4)' : ''}, from the first 64 bytes alone`, () => {
      // No name: the magic alone must decide.
      const r = sniffSplat(bytes!)
      expect(r.format).toBe(format)
      expect(r.spzV4).toBe(v4)
      expect(r.via).toBe('magic')
    })
  }

  const sogPath = join(FIXTURES, 'apartment.sog')
  it.skipIf(!existsSync(sogPath))('reads the central directory of a whole SOG zip (meta.json is the last member)', () => {
    const names = zipEntryNames(new Uint8Array(readFileSync(sogPath)))
    expect(names).toContain('meta.json')
    expect(names.at(-1)).toBe('meta.json')
  })
})

describe('sniffSplat on synthetic headers', () => {
  it('PLY (LF and CRLF)', () => {
    expect(sniffSplat(enc('ply\nformat binary_little_endian 1.0\n')).format).toBe('ply')
    expect(sniffSplat(enc('ply\r\nformat ascii 1.0\r\n')).format).toBe('ply')
  })

  it('RAD', () => {
    expect(sniffSplat(enc('RAD0{"version":1}')).format).toBe('rad')
  })

  it('gzip is SPZ v1–3, raw NGSP is SPZ with its version', () => {
    expect(sniffSplat(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]))).toEqual({ format: 'spz', spzV4: false, via: 'magic' })
    const ngsp = (v: number) => new Uint8Array([0x4e, 0x47, 0x53, 0x50, v, 0, 0, 0])
    expect(sniffSplat(ngsp(4)).spzV4).toBe(true)
    expect(sniffSplat(ngsp(3))).toEqual({ format: 'spz', spzV4: false, via: 'magic' })
  })

  it('zips: SOG members are SOG, other zips are unknown unless named .sog', () => {
    expect(sniffSplat(zipHead('meta.json')).format).toBe('sog')
    expect(sniffSplat(zipHead('means_l.webp')).format).toBe('sog')
    expect(sniffSplat(zipHead('readme.txt')).format).toBe('unknown')
    expect(sniffSplat(zipHead('readme.txt'), 'scene.sog')).toEqual({ format: 'sog', spzV4: false, via: 'extension' })
  })

  it('.splat and .ksplat are known by extension only', () => {
    const floats = new Uint8Array(new Float32Array([0.25, -1.5, 3, 0.01, 0.01, 0.01, 0, 0]).buffer)
    expect(sniffSplat(floats, 'garden.splat')).toEqual({ format: 'splat', spzV4: false, via: 'extension' })
    expect(sniffSplat(floats, 'https://x.test/a/garden.KSPLAT?v=2')).toEqual({ format: 'ksplat', spzV4: false, via: 'extension' })
    expect(sniffSplat(floats)).toEqual({ format: 'unknown', spzV4: false, via: 'none' })
  })

  it('magic wins over a misleading extension', () => {
    expect(sniffSplat(enc('ply\n'), 'scene.spz').format).toBe('ply')
  })

  it('extensionOf handles paths, queries and dotfiles', () => {
    expect(extensionOf('a/b/c.SPZ?x=1#y')).toBe('spz')
    expect(extensionOf('.hidden')).toBe('')
    expect(extensionOf('noext')).toBe('')
    expect(extensionOf(undefined)).toBe('')
  })
})
