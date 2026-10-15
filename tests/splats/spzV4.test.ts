import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSpzHeader } from '../../src/world/splats/ingest/spzRead.ts'
import {
  SpzUnsupportedError,
  assertRepackable,
  isSpzV4,
  readSpzV4Header,
  spzV4ToV3,
  v3SectionSizes,
  type SpzV4Info,
} from '../../src/world/splats/ingest/spzV4.ts'

const TOMATOES = join(import.meta.dirname, '../../public/fixtures/tomatoes.v4.spz')
const have = existsSync(TOMATOES)
const bytes = have ? new Uint8Array(readFileSync(TOMATOES)) : new Uint8Array(0)

/** A v4 header + TOC with the given fields (no stream data). */
function header(fields: { n: number; sh: number; flags?: number; sizes: number[] }): Uint8Array {
  const out = new Uint8Array(32 + 16 * fields.sizes.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x5053474e, true)
  dv.setUint32(4, 4, true)
  dv.setUint32(8, fields.n, true)
  dv.setUint8(12, fields.sh)
  dv.setUint8(13, 12)
  dv.setUint8(14, fields.flags ?? 0)
  dv.setUint8(15, fields.sizes.length)
  dv.setUint32(16, 32, true)
  fields.sizes.forEach((s, i) => {
    dv.setBigUint64(32 + 16 * i, BigInt(s), true)
    dv.setBigUint64(32 + 16 * i + 8, BigInt(s), true)
  })
  return out
}

describe('SPZ v4 header parser', () => {
  it.skipIf(!have)('reads tomatoes.v4.spz: 445 409 splats, SH 3, six v3-ordered streams', () => {
    expect(isSpzV4(bytes)).toBe(true)
    const info = readSpzV4Header(bytes)
    expect(info.numPoints).toBe(445_409)
    expect(info.shDegree).toBe(3)
    expect(info.fractionalBits).toBe(12)
    expect(info.flags).toBe(0)
    expect(info.tocOffset).toBe(32)
    expect(info.streams.map((s) => s.uncompressed)).toEqual(v3SectionSizes(445_409, 3))
    const payload = info.streams.reduce((s, x) => s + x.compressed, 0)
    expect(info.tocOffset + 16 * info.streams.length + payload).toBe(bytes.length)
    expect(() => assertRepackable(info)).not.toThrow()
  })

  it('refuses SH degree 4 and extension records with a CLI hint', () => {
    const sh4 = readSpzV4Header(header({ n: 10, sh: 4, sizes: [90, 10, 30, 30, 40, 24 * 3 * 10] }))
    expect(() => assertRepackable(sh4)).toThrow(SpzUnsupportedError)
    expect(() => assertRepackable(sh4)).toThrow(/convert with the CLI/)
    const ext = readSpzV4Header(header({ n: 10, sh: 1, flags: 0x2, sizes: v3SectionSizes(10, 1) }))
    expect(() => assertRepackable(ext)).toThrow(/extension/)
  })

  it('refuses stream layouts that are not v3 sections; SH 0 may omit the SH stream', () => {
    const extra = readSpzV4Header(header({ n: 10, sh: 1, sizes: [...v3SectionSizes(10, 1), 64] }))
    expect(() => assertRepackable(extra)).toThrow(/stream layout/)
    const five: SpzV4Info = readSpzV4Header(header({ n: 10, sh: 0, sizes: v3SectionSizes(10, 0).slice(0, 5) }))
    expect(() => assertRepackable(five)).not.toThrow()
  })

  it('rejects truncated files and non-v4 input', () => {
    expect(isSpzV4(new Uint8Array([0x1f, 0x8b, 8, 0]))).toBe(false)
    expect(() => readSpzV4Header(new Uint8Array(8))).toThrow(/not an SPZ v4/)
    const h = header({ n: 10, sh: 0, sizes: v3SectionSizes(10, 0) })
    expect(() => readSpzV4Header(h.subarray(0, 40))).toThrow(/out of range/)
  })

  it.skipIf(!have)('repacks tomatoes as gzipped SPZ v3 with the same count and SH degree', async () => {
    const { bytes: v3, info } = await spzV4ToV3(bytes)
    expect(v3[0]).toBe(0x1f)
    expect(v3[1]).toBe(0x8b)
    const h = await readSpzHeader(v3)
    expect(h).toMatchObject({ version: 3, numPoints: info.numPoints, shDegree: 3, fractionalBits: 12, flags: 0 })
  })
})
