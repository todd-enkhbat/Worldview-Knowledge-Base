import { SplatFileType, transcodeSpz } from '@sparkjsdev/spark'
import type { Vec3 } from '../../../domain/types.ts'
import { describeFormat, sniffSplat, type SourceFormat } from './sniff.ts'
import { centreBoxes, padBox, readSpzCentres, readSpzHeader, type Box } from './spzRead.ts'
import { spzV4ToV3 } from './spzV4.ts'

// The worker half of ingest, kept free of worker globals so it also runs in-thread (tests,
// browsers without module workers): sniff → (v4 → v3) → Spark transcodeSpz → full-resolution
// SPZ v3 interior (never raw PLY), plus the analysis the main thread needs to frame it.
//
// Frames: everything is in the capture's native frame. upFix is a render-time rotation of the
// mesh, and the crop is a SplatEdit BOX that is a child of the mesh, so both stay numbers on
// the record and reframing never re-encodes the interior (DECISIONS "Phase 2 ingest").

export type Crop = { min: Vec3; max: Vec3 }

export interface TranscodeRequest {
  bytes: Uint8Array
  name?: string
  /** Hard crop baked into the interior (native units). Omit to keep every splat. */
  crop?: Crop | null
  /** Optional transform baked into the interior. Ingest leaves it unset (upFix is render-time). */
  transform?: { translate?: Vec3; quaternion?: [number, number, number, number]; scale?: number }
}

export type TranscodeStage = 'convert' | 'transcode' | 'analyse' | 'clip'

export interface SceneStats {
  /** Splats in the interior and its SH degree. */
  count: number
  shDegree: number
  /** Exact centre bounds and the 1–99 % quantile box (native units). */
  bounds: Box
  robust: Box
}

export interface TranscodeResult {
  /** Gzipped SPZ v3, full resolution (clipped only by an explicit crop). */
  interior: Uint8Array
  /** The interior clipped to `frame`, for the proxy and thumbnail. Null = use the interior. */
  framed: Uint8Array | null
  framedCount: number
  /** Default crop: the explicit crop, or the padded quantile box. */
  frame: Crop
  format: SourceFormat
  spzV4: boolean
  stats: SceneStats
  timings: { convertMs: number; transcodeMs: number; analyseMs: number; clipMs: number }
}

const FILE_TYPE: Readonly<Partial<Record<SourceFormat, SplatFileType>>> = {
  spz: SplatFileType.SPZ,
  ply: SplatFileType.PLY,
  splat: SplatFileType.SPLAT,
  ksplat: SplatFileType.KSPLAT,
  sog: SplatFileType.PCSOGSZIP,
  rad: SplatFileType.RAD,
}

/** Spark's decoders read `bytes.buffer` from offset 0, so views must become exact copies. */
function exact(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice()
}

function toCrop(b: Box): Crop {
  return { min: [...b.min], max: [...b.max] }
}

/** True when `inner` covers the bounds (clipping to it would remove nothing). */
function covers(inner: Crop, bounds: Box): boolean {
  return inner.min.every((v, i) => v <= bounds.min[i]) && inner.max.every((v, i) => v >= bounds.max[i])
}

export function validCrop(c: Crop | null | undefined): c is Crop {
  return !!c && c.min.length === 3 && c.max.length === 3 && c.min.every((v, i) => Number.isFinite(v) && Number.isFinite(c.max[i]) && v < c.max[i])
}

export async function transcodeToInterior(req: TranscodeRequest, onStage: (stage: TranscodeStage) => void = () => {}): Promise<TranscodeResult> {
  const sniff = sniffSplat(req.bytes, req.name)
  const fileTypeOf = FILE_TYPE[sniff.format]
  if (!fileTypeOf) {
    throw new Error(`Unrecognised splat file${req.name ? ` "${req.name}"` : ''}: expected .spz, .ply, .splat, .ksplat, .sog or .rad`)
  }
  let fileType: SplatFileType = fileTypeOf
  let bytes = req.bytes
  let convertMs = 0
  if (sniff.spzV4) {
    onStage('convert')
    const r = await spzV4ToV3(bytes)
    bytes = r.bytes
    convertMs = r.ms
    fileType = SplatFileType.SPZ
  }

  onStage('transcode')
  const t1 = performance.now()
  const crop = validCrop(req.crop) ? req.crop : null
  let interior: Uint8Array
  try {
    const out = await transcodeSpz({
      inputs: [{ fileBytes: exact(bytes), fileType, transform: req.transform }],
      ...(crop ? { clipXyz: { min: [...crop.min], max: [...crop.max] } } : {}),
      maxSh: 3,
      version: 3,
    })
    interior = out.fileBytes as Uint8Array
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    throw new Error(`Could not decode this ${describeFormat(sniff)} file (${why})`, { cause: e })
  }
  const transcodeMs = Math.round(performance.now() - t1)

  onStage('analyse')
  const t2 = performance.now()
  const { header, centres } = await readSpzCentres(interior)
  if (header.numPoints === 0) throw new Error(crop ? 'The crop box contains no splats' : 'The file contains no splats')
  const { bounds, robust } = centreBoxes(centres)
  const analyseMs = Math.round(performance.now() - t2)
  const stats: SceneStats = { count: header.numPoints, shDegree: header.shDegree, bounds, robust }

  // The default crop trims floaters for display; the interior keeps them (reframe can widen).
  const frame = crop ?? toCrop(padBox(robust, 0.02))
  let framed: Uint8Array | null = null
  let framedCount = header.numPoints
  let clipMs = 0
  if (!crop && !covers(frame, bounds)) {
    onStage('clip')
    const t3 = performance.now()
    const out = await transcodeSpz({
      inputs: [{ fileBytes: interior.slice(), fileType: SplatFileType.SPZ }],
      clipXyz: { min: [...frame.min], max: [...frame.max] },
      maxSh: 3,
      version: 3,
    })
    framed = out.fileBytes as Uint8Array
    framedCount = (await readSpzHeader(framed)).numPoints
    clipMs = Math.round(performance.now() - t3)
  }
  return { interior, framed, framedCount, frame, format: sniff.format, spzV4: sniff.spzV4, stats, timings: { convertMs, transcodeMs, analyseMs, clipMs } }
}
