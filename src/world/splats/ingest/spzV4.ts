import { ZSTDDecoder } from 'three/examples/jsm/libs/zstddec.module.js'
import { gzip as fflateGzip } from 'fflate'

// SPZ v4 → v3 repack, in the browser (PLAN "Splat ingest"; DECISIONS "Phase 0 — S1").
// Spark 2.3.1 cannot read v4: getSplatFileType() only recognises a gzip-wrapped NGSP header,
// and forcing fileType SPZ fails with "Invalid gzip header".
//
// Layout of v4 as found in tomatoes.v4.spz (little-endian):
//   0  u32 magic "NGSP"   4 u32 version = 4   8 u32 numPoints
//   12 u8 shDegree        13 u8 fractionalBits 14 u8 flags   15 u8 numStreams
//   16 u32 tocOffset (32), then reserved zeros up to tocOffset
//   toc: numStreams × { u64 compressedSize, u64 uncompressedSize }
//   then each stream as a zstd frame, back to back.
// The streams are v3's sections in v3 order (positions 9·N, alpha N, color 3·N, scale 3·N,
// rotation 4·N, SH dim·3·N), so a v3 file is the 16-byte v3 header plus the concatenated
// decoded streams, gzipped. Anything else (SH degree 4, extension records, extra streams)
// has no v3 equivalent Spark can read, so it is refused with a CLI hint instead of guessed.

const MAGIC = 0x5053474e // "NGSP"
/** v3 header flag bits Spark understands. 0x2 marks trailing extension records. */
const FLAG_ANTIALIASED = 0x1
const FLAG_EXTENSIONS = 0x2

export const SPZ_CLI_HINT =
  'convert with the CLI: build github.com/nianticlabs/spz and re-save the file as SPZ v3 (or PLY) with SH degree ≤ 3 and no extensions, then import the converted file'

/** A v4 file this converter will not repack (SH degree 4, extensions, unknown streams). */
export class SpzUnsupportedError extends Error {
  readonly hint = SPZ_CLI_HINT
  constructor(reason: string) {
    super(`${reason}: ${SPZ_CLI_HINT}`)
    this.name = 'SpzUnsupportedError'
  }
}

export function isSpzV4(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return dv.getUint32(0, true) === MAGIC && dv.getUint32(4, true) === 4
}

export interface SpzV4Info {
  numPoints: number
  shDegree: number
  fractionalBits: number
  flags: number
  tocOffset: number
  streams: { compressed: number; uncompressed: number }[]
}

/** Parse the v4 header and table of contents (no decoding). Throws on a truncated file. */
export function readSpzV4Header(bytes: Uint8Array): SpzV4Info {
  if (!isSpzV4(bytes)) throw new Error('not an SPZ v4 file')
  if (bytes.length < 32) throw new Error('SPZ v4 header is truncated')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const numPoints = dv.getUint32(8, true)
  const shDegree = dv.getUint8(12)
  const fractionalBits = dv.getUint8(13)
  const flags = dv.getUint8(14)
  const numStreams = dv.getUint8(15)
  const tocOffset = dv.getUint32(16, true)
  if (tocOffset < 20 || tocOffset + numStreams * 16 > bytes.length) throw new Error('SPZ v4 table of contents is out of range')
  const streams: SpzV4Info['streams'] = []
  for (let i = 0; i < numStreams; i++) {
    const o = tocOffset + i * 16
    streams.push({ compressed: Number(dv.getBigUint64(o, true)), uncompressed: Number(dv.getBigUint64(o + 8, true)) })
  }
  return { numPoints, shDegree, fractionalBits, flags, tocOffset, streams }
}

/** SH coefficients per colour channel for a degree (0, 3, 8, 15). */
export function shDim(degree: number): number {
  return (degree + 1) * (degree + 1) - 1
}

/** Uncompressed v3 section sizes, in order, for N points at an SH degree ≤ 3. */
export function v3SectionSizes(n: number, shDegree: number): number[] {
  return [9 * n, n, 3 * n, 3 * n, 4 * n, shDim(shDegree) * 3 * n]
}

/**
 * Throws SpzUnsupportedError unless the v4 streams map 1:1 onto v3 sections (the only case
 * the repack handles). SH degree 0 may omit the empty SH stream.
 */
export function assertRepackable(info: SpzV4Info): void {
  if (info.shDegree > 3) throw new SpzUnsupportedError(`SPZ v4 with SH degree ${info.shDegree} is not supported in the browser`)
  if (info.flags & FLAG_EXTENSIONS) throw new SpzUnsupportedError('SPZ v4 with extension records is not supported in the browser')
  const expected = v3SectionSizes(info.numPoints, info.shDegree)
  const got = info.streams.map((s) => s.uncompressed)
  const matches = (want: number[]) => want.length === got.length && want.every((w, i) => w === got[i])
  if (!matches(expected) && !(info.shDegree === 0 && matches(expected.slice(0, 5)))) {
    throw new SpzUnsupportedError(`SPZ v4 stream layout (${got.length} streams: ${got.join(', ')} B) does not match SPZ v3`)
  }
}

let decoder: Promise<ZSTDDecoder> | null = null
function zstd(): Promise<ZSTDDecoder> {
  decoder ??= (async () => {
    const d = new ZSTDDecoder()
    await d.init()
    return d
  })().catch((e: unknown) => {
    decoder = null
    throw e
  })
  return decoder
}

/** gzip with the native CompressionStream (off the JS heap); fflate where it is missing. */
export async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream !== 'undefined') {
    const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('gzip'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }
  return new Promise((resolve, reject) => fflateGzip(data, (err, out) => (err ? reject(err) : resolve(out))))
}

/** Repack an SPZ v4 file as a gzipped SPZ v3 file Spark can load (SH intact). */
export async function spzV4ToV3(bytes: Uint8Array): Promise<{ bytes: Uint8Array; info: SpzV4Info; ms: number }> {
  const t0 = performance.now()
  const info = readSpzV4Header(bytes)
  assertRepackable(info)
  const total = info.streams.reduce((s, x) => s + x.uncompressed, 0)
  const out = new Uint8Array(16 + total)
  const ov = new DataView(out.buffer)
  ov.setUint32(0, MAGIC, true)
  ov.setUint32(4, 3, true)
  ov.setUint32(8, info.numPoints, true)
  ov.setUint8(12, info.shDegree)
  ov.setUint8(13, info.fractionalBits)
  ov.setUint8(14, info.flags & FLAG_ANTIALIASED)
  ov.setUint8(15, 0)
  const d = await zstd()
  let src = info.tocOffset + info.streams.length * 16
  let dst = 16
  for (const s of info.streams) {
    if (src + s.compressed > bytes.length) throw new Error('SPZ v4 stream runs past the end of the file')
    const decoded = d.decode(bytes.subarray(src, src + s.compressed), s.uncompressed)
    if (decoded.length !== s.uncompressed) throw new Error(`zstd stream size ${decoded.length} ≠ ${s.uncompressed}`)
    out.set(decoded, dst)
    src += s.compressed
    dst += s.uncompressed
  }
  const gz = await gzipBytes(out)
  return { bytes: gz, info, ms: Math.round(performance.now() - t0) }
}
