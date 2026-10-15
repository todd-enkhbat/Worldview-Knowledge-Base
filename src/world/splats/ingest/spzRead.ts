import { gunzip as fflateGunzip } from 'fflate'

// Minimal SPZ v2/v3 reader for what ingest needs without Spark: the header (count, SH degree)
// and the splat centres (for bounds and the default framing box). Positions in v2+ are
// 24-bit signed fixed point with `fractionalBits`, stored first, 9 bytes per splat.

export interface SpzHeader {
  version: number
  numPoints: number
  shDegree: number
  fractionalBits: number
  flags: number
}

const NGSP = 0x5053474e

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

function parseHeader(raw: Uint8Array): SpzHeader {
  if (raw.length < 16) throw new Error('SPZ header is truncated')
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  if (dv.getUint32(0, true) !== NGSP) throw new Error('not an SPZ file (no NGSP header)')
  return {
    version: dv.getUint32(4, true),
    numPoints: dv.getUint32(8, true),
    shDegree: dv.getUint8(12),
    fractionalBits: dv.getUint8(13),
    flags: dv.getUint8(14),
  }
}

/** gunzip with the native DecompressionStream; fflate where it is missing. */
export async function gunzipBytes(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'undefined') {
    const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }
  return new Promise((resolve, reject) => fflateGunzip(data, (err, out) => (err ? reject(err) : resolve(out))))
}

/** Header of a gzipped (v1–3) or raw SPZ file, decompressing only the first block. */
export async function readSpzHeader(bytes: Uint8Array): Promise<SpzHeader> {
  if (!isGzip(bytes)) return parseHeader(bytes)
  if (typeof DecompressionStream === 'undefined') return parseHeader(await gunzipBytes(bytes))
  const reader = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip')).getReader()
  const head = new Uint8Array(16)
  let have = 0
  try {
    while (have < 16) {
      const { done, value } = await reader.read()
      if (done) break
      const take = Math.min(16 - have, value.length)
      head.set(value.subarray(0, take), have)
      have += take
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  return parseHeader(head.subarray(0, have))
}

/** Decompressed SPZ (header + sections) → header and a centre accessor. v2+ only. */
export async function readSpzCentres(bytes: Uint8Array): Promise<{ header: SpzHeader; centres: Float32Array }> {
  const raw = isGzip(bytes) ? await gunzipBytes(bytes) : bytes
  const header = parseHeader(raw)
  if (header.version < 2) throw new Error(`SPZ v${header.version} centres are float16; only v2+ is read here`)
  const n = header.numPoints
  if (raw.length < 16 + 9 * n) throw new Error('SPZ positions section is truncated')
  const scale = 1 / (1 << header.fractionalBits)
  const centres = new Float32Array(3 * n)
  for (let i = 0, p = 16; i < 3 * n; i++, p += 3) {
    const v = ((raw[p] | (raw[p + 1] << 8) | (raw[p + 2] << 16)) << 8) >> 8 // sign-extend 24 → 32
    centres[i] = v * scale
  }
  return { header, centres }
}

export interface Box {
  min: [number, number, number]
  max: [number, number, number]
}

/**
 * Exact bounds plus a per-axis quantile box (lo/hi in [0, 1]) of the centres, from at most
 * `samples` evenly strided splats. The quantile box ignores the floaters most captures carry.
 */
export function centreBoxes(centres: Float32Array, lo = 0.01, hi = 0.99, samples = 200_000): { bounds: Box; robust: Box } {
  const n = centres.length / 3
  if (n === 0) {
    const zero: Box = { min: [0, 0, 0], max: [0, 0, 0] }
    return { bounds: zero, robust: zero }
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = centres[3 * i + c]
      if (v < min[c]) min[c] = v
      if (v > max[c]) max[c] = v
    }
  }
  const stride = Math.max(1, Math.floor(n / samples))
  const m = Math.ceil(n / stride)
  const rmin: [number, number, number] = [0, 0, 0]
  const rmax: [number, number, number] = [0, 0, 0]
  const axis = new Float32Array(m)
  for (let c = 0; c < 3; c++) {
    for (let j = 0, i = 0; j < m; j++, i += stride) axis[j] = centres[3 * Math.min(i, n - 1) + c]
    axis.sort()
    rmin[c] = axis[Math.min(m - 1, Math.max(0, Math.floor(lo * m)))]
    rmax[c] = axis[Math.min(m - 1, Math.max(0, Math.ceil(hi * m) - 1))]
  }
  return { bounds: { min, max }, robust: { min: rmin, max: rmax } }
}

/** Grow a box by `frac` of its extent on every side (at least `minPad` units). */
export function padBox(b: Box, frac: number, minPad = 1e-3): Box {
  const min = b.min.map((v, i) => v - Math.max(minPad, (b.max[i] - v) * frac)) as Box['min']
  const max = b.max.map((v, i) => v + Math.max(minPad, (v - b.min[i]) * frac)) as Box['max']
  return { min, max }
}
