import { registerDevApi } from '../../../app/devApi.ts'
import { createNode, softDelete } from '../../../data/repo.ts'
import { SPZ_MIME, assertCanWrite, attachScene, requireMemory, updateScene, type SceneBlockDraft } from '../../../data/scenes.ts'

export { reframeScene } from '../../../data/scenes.ts'
import { truncateToPrecision } from '../../../domain/time.ts'
import type { NodeRecord, Pose, Quat, SplatBlock } from '../../../domain/types.ts'
import { loadSplatBytes } from '../assets.ts'
import { buildDerivatives, type ProxyMethod } from '../proxyBuild.ts'
import { Y_DOWN_FIX, defaultEntryPose, isQuat, isVec3 } from './pose.ts'
import { extensionOf, type SourceFormat } from './sniff.ts'
import { transcodeToInterior, validCrop, type Crop, type TranscodeResult, type TranscodeStage } from './transcode.ts'
import type { IngestJob, IngestWorkerMessage } from './worker.ts'

// ingestScene: a splat file → a memory's volumetric scene.
//   worker:  sniff → (SPZ v4 → v3) → transcodeSpz → full-resolution SPZ v3 interior, its
//            bounds, and a copy clipped to the default framing box
//   main:    ≤ 100k proxy (LoD cut on the world SparkRenderer's worker) + 256² thumbnail
//   store:   attachScene (blobs first, record last, old blobs deleted after)
// The crop is a render-time SplatEdit BOX in native units and upFix a render-time mesh
// rotation, so reframeScene only rewrites numbers; rebuildScene also re-derives proxy + thumbnail.

export type { Crop }
export type IngestStage = 'read' | TranscodeStage | 'decimate' | 'thumbnail' | 'store' | 'done'

export interface IngestProgress {
  stage: IngestStage
  /** 0..1 over the whole ingest. */
  fraction: number
  label: string
}

export interface IngestOptions {
  /** Hard crop baked into the interior (native units). Default: keep everything, frame the 1–99 % box. */
  crop?: Crop | null
  /** Native → display rotation. Default: a half turn about X (most captures are y-down). */
  upFix?: Quat
  /** Default: centred on the frame, looking at its centre from 1.5 bounding radii. */
  entryPose?: Pose
  /** File name, for sniffing extension-only formats (.splat, .ksplat) and titles. */
  name?: string
  onProgress?: (p: IngestProgress) => void
  signal?: AbortSignal
  /** Run the transcode in a module Worker (default when Worker exists). */
  worker?: boolean
  /** How long to wait for the world SparkRenderer (proxy cut, thumbnail) before falling back. */
  sparkTimeoutMs?: number
}

export interface IngestResult {
  nodeId: string
  block: SplatBlock
  sourceFormat: SourceFormat
  proxyMethod: ProxyMethod
  /** Wall time of the whole ingest. */
  ms: number
  timings: TranscodeResult['timings'] & { readMs: number; proxyMs: number; thumbMs: number; storeMs: number }
}

const STAGE: Readonly<Record<IngestStage, { at: number; label: string }>> = {
  read: { at: 0, label: 'reading file' },
  convert: { at: 0.1, label: 'converting SPZ v4' },
  transcode: { at: 0.15, label: 'transcoding to SPZ v3' },
  analyse: { at: 0.4, label: 'measuring the scene' },
  clip: { at: 0.45, label: 'framing' },
  decimate: { at: 0.6, label: 'decimating the proxy' },
  thumbnail: { at: 0.8, label: 'rendering the thumbnail' },
  store: { at: 0.9, label: 'storing' },
  done: { at: 1, label: 'done' },
}

function abortError(): Error {
  return new DOMException('Ingest cancelled', 'AbortError')
}

/** Progress callback; also the cancellation point (throws AbortError once aborted). */
function report(opts: IngestOptions, stage: IngestStage, within = 0): void {
  if (opts.signal?.aborted) throw abortError()
  notify(opts, stage, within)
}

/** Progress without the cancellation check, for after the record has committed. */
function notify(opts: IngestOptions, stage: IngestStage, within = 0): void {
  const s = STAGE[stage]
  const order: IngestStage[] = ['read', 'convert', 'transcode', 'analyse', 'clip', 'decimate', 'thumbnail', 'store', 'done']
  const next = order[order.indexOf(stage) + 1]
  const span = next ? STAGE[next].at - s.at : 0
  opts.onProgress?.({ stage, fraction: Math.min(1, s.at + span * within), label: s.label })
}

/** Bytes of a Blob or URL, with read progress when the size is known. */
async function readSource(source: Blob | { url: string }, opts: IngestOptions): Promise<Uint8Array> {
  if (source instanceof Blob) {
    report(opts, 'read')
    return new Uint8Array(await source.arrayBuffer())
  }
  const res = await fetch(source.url, { signal: opts.signal })
  if (!res.ok) throw new Error(`${source.url}: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  if (!res.body || total <= 0) {
    report(opts, 'read')
    return new Uint8Array(await res.arrayBuffer())
  }
  const out = new Uint8Array(total)
  const reader = res.body.getReader()
  let have = 0
  let chunks: Uint8Array[] | null = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (chunks) chunks.push(value)
    else if (have + value.length > total) {
      // content-length lied (compressed transfer): collect the rest and concatenate.
      chunks = [out.slice(0, have), value]
    } else out.set(value, have)
    have += value.length
    report(opts, 'read', Math.min(1, have / total))
  }
  if (!chunks) return have === total ? out : out.slice(0, have)
  const all = new Uint8Array(have)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.length
  }
  return all
}

function workersAvailable(opts: IngestOptions): boolean {
  return opts.worker !== false && typeof Worker !== 'undefined'
}

/**
 * The transcode in a module Worker (one per job), or in-thread where workers are missing.
 * A Blob goes to the worker as is (structured clone shares it), so a large capture is read
 * there and never held on the main thread.
 */
async function runTranscode(input: Uint8Array | Blob, job: { name?: string; crop?: Crop | null }, opts: IngestOptions): Promise<TranscodeResult> {
  const onStage = (stage: TranscodeStage) => report(opts, stage)
  if (!workersAvailable(opts)) {
    const bytes = input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : input
    return transcodeToInterior({ bytes, ...job }, onStage)
  }
  return new Promise<TranscodeResult>((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'splat-ingest' })
    const finish = () => {
      worker.terminate()
      opts.signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      finish()
      reject(abortError())
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = (e: MessageEvent<IngestWorkerMessage>) => {
      const m = e.data
      if (m.type === 'stage') {
        try {
          onStage(m.stage)
        } catch (err) {
          finish()
          reject(err)
        }
        return
      }
      finish()
      if (m.type === 'done') resolve(m.result)
      else reject(new Error(m.message))
    }
    worker.onerror = (e) => {
      finish()
      reject(new Error(e.message || 'The splat ingest worker failed to start'))
    }
    if (input instanceof Blob) {
      const msg: IngestJob = { id: 1, source: input, ...job }
      worker.postMessage(msg)
      return
    }
    const own = input.byteOffset === 0 && input.byteLength === input.buffer.byteLength && input.buffer instanceof ArrayBuffer ? input : input.slice()
    const msg: IngestJob = { id: 1, source: own.buffer as ArrayBuffer, ...job }
    worker.postMessage(msg, [own.buffer as ArrayBuffer])
  })
}

function sourceName(source: Blob | { url: string }, opts: IngestOptions): string | undefined {
  if (opts.name) return opts.name
  if (source instanceof Blob) return (source as Partial<File>).name
  return decodeURIComponent(source.url.split(/[?#]/, 1)[0].split('/').pop() ?? '') || undefined
}

/** Ingest a splat file into a memory node, replacing any scene it had. */
export async function ingestScene(nodeId: string, source: Blob | { url: string }, opts: IngestOptions = {}): Promise<IngestResult> {
  const t0 = performance.now()
  assertCanWrite()
  requireMemory(nodeId)
  if (opts.crop !== undefined && opts.crop !== null && !validCrop(opts.crop)) throw new Error('crop must be { min, max } with min < max on every axis')
  if (opts.upFix !== undefined && !isQuat(opts.upFix)) throw new Error('upFix must be a non-zero quaternion [x, y, z, w]')
  const name = sourceName(source, opts)

  let input: Uint8Array | Blob
  if (source instanceof Blob && workersAvailable(opts)) {
    report(opts, 'read')
    input = source
  } else input = await readSource(source, opts)
  const readMs = Math.round(performance.now() - t0)
  const tx = await runTranscode(input, { name, crop: opts.crop ?? null }, opts)

  const upFix = opts.upFix ?? Y_DOWN_FIX
  const frame = tx.frame
  const entryPose = opts.entryPose ?? defaultEntryPose(frame, upFix)
  const t1 = performance.now()
  const { proxy, thumb } = await buildDerivatives(
    tx.framed ?? tx.interior,
    tx.framed ? tx.framedCount : tx.stats.count,
    { entryPose, upFix, crop: frame },
    { onStage: (s) => report(opts, s), sparkTimeoutMs: opts.sparkTimeoutMs },
  )
  const derivedMs = Math.round(performance.now() - t1)

  report(opts, 'store')
  const t2 = performance.now()
  const draft: SceneBlockDraft = {
    entryPose,
    crop: { min: [...frame.min], max: [...frame.max] },
    upFix,
    counts: { interior: tx.stats.count, proxy: proxy.count },
    sourceFormat: tx.format,
  }
  const record = await attachScene(nodeId, draft, {
    interior: { data: tx.interior, mime: SPZ_MIME },
    proxy: { data: proxy.bytes, mime: SPZ_MIME },
    thumb: thumb ? { data: thumb.blob, mime: thumb.mime } : null,
  })
  const storeMs = Math.round(performance.now() - t2)
  notify(opts, 'done')
  return {
    nodeId,
    block: record.splat!,
    sourceFormat: tx.format,
    proxyMethod: proxy.method,
    ms: Math.round(performance.now() - t0),
    timings: { ...tx.timings, readMs, proxyMs: proxy.ms, thumbMs: thumb?.ms ?? Math.max(0, derivedMs - proxy.ms), storeMs },
  }
}

export interface ReframePatch {
  crop?: Crop | null
  upFix?: Quat
  entryPose?: Pose
}

/**
 * Change a scene's framing and, with `rebuild` (the default), re-derive the proxy and the
 * thumbnail from the stored interior clipped to the (new) crop: a few seconds of work, run
 * after framing is saved. Without `rebuild` it equals reframeScene (numbers only). A new
 * upFix without an entry pose recomputes the default pose so the camera stays level.
 */
export async function rebuildScene(
  nodeId: string,
  patch: ReframePatch = {},
  opts: { rebuild?: boolean } & Pick<IngestOptions, 'onProgress' | 'signal' | 'worker' | 'sparkTimeoutMs'> = {},
): Promise<SplatBlock> {
  assertCanWrite()
  const node = requireMemory(nodeId)
  const prev = node.splat
  if (!prev) throw new Error('This memory has no volumetric scene')
  if (patch.crop !== undefined && patch.crop !== null && !validCrop(patch.crop)) throw new Error('crop must be { min, max } with min < max on every axis')
  if (patch.upFix !== undefined && !isQuat(patch.upFix)) throw new Error('upFix must be a non-zero quaternion [x, y, z, w]')
  if (patch.entryPose !== undefined && (!isVec3(patch.entryPose.position) || !isQuat(patch.entryPose.quaternion))) {
    throw new Error('entryPose needs position [x, y, z] and quaternion [x, y, z, w]')
  }
  const crop = patch.crop !== undefined ? patch.crop : prev.crop
  const upFix = patch.upFix ?? prev.upFix
  let entryPose = patch.entryPose ?? prev.entryPose
  if (!patch.entryPose && patch.upFix && crop) entryPose = defaultEntryPose(crop, upFix)
  const next: Partial<SceneBlockDraft> = { crop: crop ? { min: [...crop.min], max: [...crop.max] } : null, upFix, entryPose }

  if (opts.rebuild === false || !prev.interiorAssetId) return (await updateScene(nodeId, next)).splat!

  const o: IngestOptions = { onProgress: opts.onProgress, signal: opts.signal, worker: opts.worker, sparkTimeoutMs: opts.sparkTimeoutMs }
  report(o, 'read')
  const interior = await loadSplatBytes(prev.interiorAssetId)
  const framed = crop ? await runTranscode(interior, { name: 'interior.spz', crop }, o) : null
  const source = framed ? framed.interior : interior
  const count = framed ? framed.stats.count : prev.counts.interior
  const { proxy, thumb } = await buildDerivatives(source, count, { entryPose, upFix, crop }, { onStage: (s) => report(o, s), sparkTimeoutMs: o.sparkTimeoutMs })
  report(o, 'store')
  const record = await updateScene(
    nodeId,
    { ...next, counts: { interior: prev.counts.interior, proxy: proxy.count } },
    { proxy: { data: proxy.bytes, mime: SPZ_MIME }, thumb: thumb ? { data: thumb.blob, mime: thumb.mime } : undefined },
  )
  notify(o, 'done')
  return record.splat!
}

/** "lion.v3.spz" → "Lion". */
export function titleFromFileName(name: string): string {
  const ext = extensionOf(name)
  let base = name.split(/[?#]/, 1)[0].split(/[\\/]/).pop() ?? name
  if (ext) base = base.slice(0, -(ext.length + 1))
  base = base.replace(/\.v\d+$/i, '').replace(/[._-]+/g, ' ').trim()
  return base ? base[0].toUpperCase() + base.slice(1) : 'Scene'
}

export interface IngestFromUrlResult {
  nodeId: string
  counts: SplatBlock['counts']
  ms: number
  sourceFormat: SourceFormat
}

/**
 * Dev / Playwright entry (`__wv.ingestFromUrl`). Without a nodeId it creates a memory titled
 * after the file, dated today; that node goes to the trash again if the ingest fails.
 */
export async function ingestFromUrl(url: string, nodeId?: string, opts: Omit<IngestOptions, 'name'> = {}): Promise<IngestFromUrlResult> {
  const t0 = performance.now()
  let created: NodeRecord | null = null
  let id = nodeId
  if (!id) {
    const fileName = decodeURIComponent(url.split(/[?#]/, 1)[0].split('/').pop() ?? '')
    created = await createNode({
      archetype: 'memory',
      title: titleFromFileName(fileName),
      temporalOrigin: truncateToPrecision(Date.now(), 'day'),
      temporalPrecision: 'day',
    })
    id = created.id
  }
  try {
    const r = await ingestScene(id, { url }, opts)
    return { nodeId: id, counts: r.block.counts, ms: Math.round(performance.now() - t0), sourceFormat: r.sourceFormat }
  } catch (e) {
    if (created) await softDelete(created.id).catch(() => {})
    throw e
  }
}

registerDevApi('ingestFromUrl', (url: string, nodeId?: string, opts?: Omit<IngestOptions, 'name'>) => ingestFromUrl(url, nodeId, opts))
registerDevApi('rebuildScene', (nodeId: string, patch?: ReframePatch, opts?: { rebuild?: boolean }) => rebuildScene(nodeId, patch, opts))
