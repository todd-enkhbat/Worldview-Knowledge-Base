import { Color, Matrix4, PerspectiveCamera, Quaternion, Scene, Vector3, type WebGLRenderer } from 'three'
import {
  PackedSplats,
  SparkRenderer,
  SplatEdit,
  SplatEditRgbaBlendMode,
  SplatEditSdf,
  SplatEditSdfType,
  SplatFileType,
  SplatMesh,
  writeSpz,
} from '@sparkjsdev/spark'
import type { Pose, Quat } from '../../domain/types.ts'
import { LAYER } from '../layers.ts'
import { boxCentre, boxRadius, poseInDisplayFrame, type BoxLike } from './ingest/pose.ts'
import { getSpark, whenSpark } from './sparkRegistry.ts'

// Main-thread derivatives of an interior: the ≤ 100k far-field proxy and the 256² thumbnail.
//
// Proxy (DECISIONS "Phase 0 — S1"): the budget-driven complete cut of Spark's LoD tree, run on
// the world SparkRenderer's LoD worker (traverseLodTrees, maxSplats = budget, seen from far away
// with foveation off), then extractSplats → writeSpz v3. getLodTreeLevel is not a complete cut
// and is not used. The fallback, when there is no world renderer or the cut fails, is a seeded
// importance subsample by opacity × volume. Proxies carry no SH (extractSplats drops it).
//
// Thumbnail (PLAN "Splat ingest"): a dedicated SparkRenderer({ target }) on the world's GL
// renderer renders the framed splats from the entry pose; spark.update() is awaited before the
// target is rendered and read, and the renderer is disposed straight after.

export const PROXY_BUDGET = 100_000
export const THUMB_SIZE = 256

// ─── the S1 cut (moved here from src/lab/s1/proxy.ts; the lab imports it back) ─────────

export interface LodWorker {
  call(name: string, args: unknown): Promise<unknown>
}

/** TS-private Spark internals the cut relies on (pinned Spark 2.3.1). */
export interface SparkLodInternals {
  lodInstances: Map<SplatMesh, { lodId: number }>
  ensureLodWorker(): { exclusive<T>(fn: (w: LodWorker) => Promise<T>): Promise<T> }
}

export function sparkInternals(spark: SparkRenderer): SparkLodInternals {
  return spark as unknown as SparkLodInternals
}

/** One call on the LoD worker with exclusive access (the render loop's LoD drive waits). */
export async function lodWorkerCall<T>(spark: SparkRenderer, name: string, args: unknown): Promise<T> {
  return sparkInternals(spark)
    .ensureLodWorker()
    .exclusive(async (w) => (await w.call(name, args)) as T)
}

/**
 * Indices of a budget-driven complete cut of the LoD tree `lodId` (whose splats are `lod`):
 * every node is seen from ~the same far distance, so the pixel limit becomes a uniform
 * world-size cut capped at `budget` splats.
 */
export async function traverseCut(worker: LodWorker, lodId: number, lod: PackedSplats, budget: number): Promise<Uint32Array> {
  // The root node (index 0, BFS order) is one splat spanning the whole set.
  const root = lod.getSplat(0)
  const centre = root.center.clone()
  const diag = Math.max(1e-3, 6 * Math.max(root.scales.x, root.scales.y, root.scales.z))
  const view = new Matrix4().compose(centre.add(new Vector3(0, 0, 1000 * diag)), new Quaternion(), new Vector3(1, 1, 1))
  const result = (await worker.call('traverseLodTrees', {
    maxSplats: budget,
    pixelScaleLimit: 1e-9,
    instances: {
      proxy: {
        instanceId: 'proxy',
        lodId,
        viewToObjectCols: view.elements,
        lodScale: 1,
        behindFoveate: 1,
        coneFov0: 0,
        coneFov: 0,
        coneFoveate: 1,
      },
    },
    traverseMode: 'standard',
  })) as { keyIndices: Record<string, { numSplats: number; indices: Uint32Array }> }
  const { numSplats, indices } = result.keyIndices.proxy
  return indices.slice(0, numSplats)
}

/** The cut for LoD splats the worker does not know yet: init a tree, traverse, dispose it. */
export async function cutLodSplats(spark: SparkRenderer, lod: PackedSplats, budget = PROXY_BUDGET): Promise<PackedSplats> {
  const tree = lod.extra.lodTree as Uint32Array | undefined
  if (!tree) throw new Error('no LoD tree on these splats')
  const indices = await sparkInternals(spark)
    .ensureLodWorker()
    .exclusive(async (w) => {
      const { lodId } = (await w.call('initLodTree', { numSplats: lod.numSplats, lodTree: tree.slice() })) as { lodId: number }
      try {
        return await traverseCut(w, lodId, lod, budget)
      } finally {
        await w.call('disposeLodTree', { lodId })
      }
    })
  return lod.extractSplats(indices, false)
}

/** Seeded importance sample of `candidates` by opacity × volume (Efraimidis–Spirakis keys). */
export function selectSubsample(source: PackedSplats, candidates: Uint32Array, budget: number, seed = 0x5eed): PackedSplats {
  let state = seed >>> 0
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const n = candidates.length
  if (n <= budget) return source.extractSplats(candidates, false)
  const keys = new Float64Array(n)
  for (let j = 0; j < n; j++) {
    const { scales: s, opacity: o } = source.getSplat(candidates[j])
    const w = Math.max(1e-12, o * s.x * s.y * s.z)
    keys[j] = Math.log(Math.max(1e-300, rand())) / w
  }
  const order = new Uint32Array(n)
  for (let j = 0; j < n; j++) order[j] = j
  order.sort((a, b) => keys[b] - keys[a])
  const picked = new Uint32Array(budget)
  for (let j = 0; j < budget; j++) picked[j] = candidates[order[j]]
  return source.extractSplats(picked.sort(), false)
}

/** Leaf indices of a Spark LoD tree (extra.lodTree: 4 u32 per node, [2] = child count). */
export function lodLeaves(lod: PackedSplats, maxSamples = 400_000): Uint32Array {
  const tree = lod.extra.lodTree as Uint32Array | undefined
  if (!tree) throw new Error('no lodTree')
  const n = tree.length / 4
  let leaves = 0
  for (let i = 0; i < n; i++) if (tree[4 * i + 2] === 0) leaves++
  const stride = Math.max(1, Math.ceil(leaves / maxSamples))
  const out = new Uint32Array(Math.ceil(leaves / stride))
  let k = 0
  let seen = 0
  for (let i = 0; i < n; i++) {
    if (tree[4 * i + 2] !== 0) continue
    if (seen++ % stride === 0) out[k++] = i
  }
  return out.subarray(0, k)
}

export function allIndices(n: number): Uint32Array {
  const out = new Uint32Array(n)
  for (let i = 0; i < n; i++) out[i] = i
  return out
}

// ─── ingest derivatives ────────────────────────────────────────────────────────────────

export type ProxyMethod = 'cut' | 'subsample' | 'copy'

export interface ProxyResult {
  /** Gzipped SPZ v3. */
  bytes: Uint8Array
  count: number
  method: ProxyMethod
  ms: number
}

export interface ThumbResult {
  blob: Blob
  mime: string
  ms: number
}

export interface SceneView {
  entryPose: Pose
  upFix: Quat
  /** Crop box in native units, applied as a SplatEdit BOX (null = none). */
  crop: BoxLike | null
}

export interface DeriveOptions {
  budget?: number
  /** How long to wait for the world SparkRenderer before falling back (ms). */
  sparkTimeoutMs?: number
  thumbnail?: boolean
  onStage?: (stage: 'decimate' | 'thumbnail') => void
}

/** The world renderer, waiting up to `ms` for the canvas to register one. */
export async function sparkWithin(ms: number): Promise<SparkRenderer | null> {
  const now = getSpark()
  if (now || ms <= 0) return now
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  try {
    return await Promise.race([whenSpark(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Proxy (+ thumbnail) from `source` (gzipped SPZ v3 of `count` splats, already framed).
 * A source within budget is its own proxy. Never throws for the thumbnail: it is optional.
 */
export async function buildDerivatives(
  source: Uint8Array,
  count: number,
  view: SceneView,
  opts: DeriveOptions = {},
): Promise<{ proxy: ProxyResult; thumb: ThumbResult | null }> {
  const budget = opts.budget ?? PROXY_BUDGET
  const spark = await sparkWithin(opts.sparkTimeoutMs ?? 2000)
  const needsCut = count > budget
  const wantThumb = opts.thumbnail !== false && spark !== null
  if (!needsCut && !wantThumb) return { proxy: { bytes: source, count, method: 'copy', ms: 0 }, thumb: null }

  opts.onStage?.('decimate')
  const t0 = performance.now()
  const splats = new PackedSplats({ fileBytes: source.slice(), fileType: SplatFileType.SPZ, lod: needsCut && spark !== null, nonLod: true })
  try {
    await splats.initialized
    let proxy: ProxyResult = { bytes: source, count, method: 'copy', ms: 0 }
    if (needsCut) {
      let picked: PackedSplats | null = null
      let method: ProxyMethod = 'subsample'
      if (spark && splats.lodSplats) {
        try {
          picked = await cutLodSplats(spark, splats.lodSplats, budget)
          method = 'cut'
        } catch (e) {
          console.warn('[ingest] LoD cut failed; using the importance subsample', e)
        }
      }
      picked ??= selectSubsample(splats, allIndices(splats.numSplats), budget)
      try {
        const { fileBytes } = await writeSpz(picked, { version: 3, maxSh: 0 })
        proxy = { bytes: fileBytes, count: picked.numSplats, method, ms: Math.round(performance.now() - t0) }
      } finally {
        picked.dispose()
      }
    }
    let thumb: ThumbResult | null = null
    if (wantThumb && spark) {
      opts.onStage?.('thumbnail')
      try {
        thumb = await renderThumbnail(spark.renderer, splats, view)
      } catch (e) {
        console.warn('[ingest] thumbnail failed', e)
      }
    }
    return { proxy, thumb }
  } finally {
    splats.disposeLodSplats()
    splats.dispose()
  }
}

/** Clip a mesh to a native-units box: alpha × 0 outside (the SDF is inverted). */
export function addCropEdit(mesh: SplatMesh, crop: BoxLike): SplatEdit {
  const edit = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, sdfSmooth: 0, softEdge: 0 })
  const box = new SplatEditSdf({ type: SplatEditSdfType.BOX, invert: true, opacity: 0 })
  box.position.copy(boxCentre(crop))
  box.scale.set((crop.max[0] - crop.min[0]) / 2, (crop.max[1] - crop.min[1]) / 2, (crop.max[2] - crop.min[2]) / 2)
  edit.add(box)
  mesh.add(edit)
  return edit
}

/**
 * Render `splats` (non-LoD) from the entry pose into a size² image with a dedicated Spark
 * render target on the world's GL renderer. The field of view is widened to fit the crop.
 */
export async function renderThumbnail(renderer: WebGLRenderer, splats: PackedSplats, view: SceneView, size = THUMB_SIZE): Promise<ThumbResult> {
  const t0 = performance.now()
  const spark = new SparkRenderer({ renderer, target: { width: size, height: size, superXY: 2 }, autoUpdate: false, enableLod: false })
  spark.material.forceSinglePass = true
  const scene = new Scene()
  const mesh = new SplatMesh({ packedSplats: splats })
  const camera = new PerspectiveCamera(50, 1, 0.01, 1000)
  for (const o of [spark, mesh]) o.layers.set(LAYER.SPLATS)
  camera.layers.set(LAYER.SPLATS)
  scene.add(spark, mesh)
  try {
    mesh.quaternion.set(...view.upFix).normalize()
    if (view.crop) addCropEdit(mesh, view.crop)
    const { position, quaternion } = poseInDisplayFrame(view.entryPose, view.upFix)
    camera.position.copy(position)
    camera.quaternion.copy(quaternion)
    if (view.crop) {
      const centre = boxCentre(view.crop).applyQuaternion(mesh.quaternion)
      const d = Math.max(1e-3, centre.distanceTo(position))
      const r = boxRadius(view.crop)
      camera.near = Math.max(1e-3, d * 0.01)
      camera.far = d + 4 * r
      camera.fov = view.entryPose.fov ?? Math.min(90, Math.max(30, ((2 * Math.asin(Math.min(1, r / d)) * 180) / Math.PI) * 0.9))
    } else if (view.entryPose.fov) camera.fov = view.entryPose.fov
    camera.updateProjectionMatrix()
    scene.updateMatrixWorld(true)
    await mesh.initialized
    // Two passes: the first generates and sorts, the second picks up anything that finished
    // initialising during the first (edits, textures).
    await spark.update({ scene, camera })
    await spark.update({ scene, camera })

    const prevColor = renderer.getClearColor(new Color())
    const prevAlpha = renderer.getClearAlpha()
    const prevAutoClear = renderer.autoClear
    try {
      renderer.setClearColor(0x000000, 0)
      renderer.autoClear = true
      spark.renderTarget({ scene, camera })
    } finally {
      renderer.setClearColor(prevColor, prevAlpha)
      renderer.autoClear = prevAutoClear
    }
    const pixels = await spark.readTarget()
    const blob = await encodeRgba(straightAlphaTopDown(pixels, size, size), size, size)
    return { blob, mime: blob.type || 'image/png', ms: Math.round(performance.now() - t0) }
  } finally {
    scene.remove(spark, mesh)
    mesh.dispose()
    spark.dispose()
  }
}

/** GL rows run bottom-up and Spark blends premultiplied: flip and un-premultiply for an image. */
export function straightAlphaTopDown(pixels: Uint8Array, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * height * 4)
  const row = width * 4
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * row
    const dst = y * row
    for (let x = 0; x < row; x += 4) {
      const a = pixels[src + x + 3]
      const k = a > 0 ? 255 / a : 0
      out[dst + x] = pixels[src + x] * k
      out[dst + x + 1] = pixels[src + x + 1] * k
      out[dst + x + 2] = pixels[src + x + 2] * k
      out[dst + x + 3] = a
    }
  }
  return out
}

/** RGBA → webp where the browser can encode it (Safari falls back to png on its own). */
export async function encodeRgba(rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): Promise<Blob> {
  const image = new ImageData(rgba, width, height)
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.putImageData(image, 0, 0)
      return canvas.convertToBlob({ type: 'image/webp', quality: 0.85 })
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2D canvas to encode the thumbnail')
  ctx.putImageData(image, 0, 0)
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('thumbnail encode failed'))), 'image/webp', 0.85),
  )
}
