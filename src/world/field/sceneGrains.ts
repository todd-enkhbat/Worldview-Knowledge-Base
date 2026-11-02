import { Matrix4, Vector3 } from 'three'
import { PackedSplats, SplatFileType } from '@sparkjsdev/spark'
import type { SplatBlock } from '../../domain/types.ts'
import { loadSplatBytes } from '../splats/assets.ts'
import { fitBox, type Box } from '../splats/flyIn.ts'
import { quantileBounds } from '../splats/Diorama.tsx'

// A captured scene as grains of the field. Photoreal splats never sat right among the land's
// grains (grains buried them, post fog took them for sky, a box or rim showed its edge), so the
// field draws a scene the way it draws everything: as particles, here the scene's own splat
// centres in their own colours, solid and depth-writing like the land. The photoreal scene
// stays for walking in (flyIn lifts the diorama).

/** Grains per scene (out of the ≤ 100k-splat proxy). */
export const SCENE_GRAINS = 60_000

/** A scene's grains in its shell frame: centred, upright, its larger half-extent = `half`. */
export interface SceneGrains {
  /** xyz per grain. */
  pos: Float32Array
  /** Linear rgb per grain. */
  col: Float32Array
  /** Grain size per grain (shell units). */
  size: Float32Array
  /** Uniform [0, 1) per grain: the order in which grains condense. */
  rand: Float32Array
  /** How far the floor is below the centre, and the half-width of the narrower side (shell units). */
  floor: number
  footprint: number
}

export interface RawSplats {
  n: number
  center: Float32Array
  /** sRGB 0…1 */
  color: Float32Array
  opacity: Float32Array
  /** Mean of the three scales (native units). */
  scale: Float32Array
}

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const inside = (b: Box, x: number, y: number, z: number) =>
  x >= Math.min(b.min[0], b.max[0]) && x <= Math.max(b.min[0], b.max[0]) && y >= Math.min(b.min[1], b.max[1]) && y <= Math.max(b.min[1], b.max[1]) && z >= Math.min(b.min[2], b.max[2]) && z <= Math.max(b.min[2], b.max[2])

/**
 * Pick up to `max` visible splats inside the box and carry them into the shell frame (the same
 * fit the diorama uses: up-fix, centre, uniform scale to `half`). Pure, for tests.
 */
export function sceneGrainsFrom(raw: RawSplats, box: Box, upFix: SplatBlock['upFix'], half: number, max = SCENE_GRAINS): SceneGrains {
  const fit = fitBox(box, upFix, half)
  const m = new Matrix4().compose(fit.position, fit.quaternion, new Vector3(fit.scale, fit.scale, fit.scale))
  const keep: number[] = []
  for (let i = 0; i < raw.n; i++) {
    if (raw.opacity[i] < 0.25) continue
    if (!inside(box, raw.center[i * 3], raw.center[i * 3 + 1], raw.center[i * 3 + 2])) continue
    keep.push(i)
  }
  const r = rng(keep.length * 2654435761)
  // Partial shuffle: an even, deterministic sample.
  const k = Math.min(max, keep.length)
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(r() * (keep.length - i))
    ;[keep[i], keep[j]] = [keep[j], keep[i]]
  }
  const pos = new Float32Array(k * 3)
  const col = new Float32Array(k * 3)
  const size = new Float32Array(k)
  const rand = new Float32Array(k)
  const v = new Vector3()
  let minY = Infinity
  for (let q = 0; q < k; q++) {
    const i = keep[q]
    v.set(raw.center[i * 3], raw.center[i * 3 + 1], raw.center[i * 3 + 2]).applyMatrix4(m)
    pos.set([v.x, v.y, v.z], q * 3)
    minY = Math.min(minY, v.y)
    for (let c = 0; c < 3; c++) col[q * 3 + c] = Math.pow(Math.min(1, Math.max(0, raw.color[i * 3 + c])), 2.2)
    // A grain covers about its splat, a little more so the surface reads closed.
    size[q] = Math.min(half * 0.06, Math.max(half * 0.006, raw.scale[i] * fit.scale * 1.7))
    rand[q] = r()
  }
  const e = new Matrix4().makeRotationFromQuaternion(fit.quaternion).elements
  const ext = (row: number) => (Math.abs(e[row]) * fit.half.x + Math.abs(e[4 + row]) * fit.half.y + Math.abs(e[8 + row]) * fit.half.z) * fit.scale
  return { pos, col, size, rand, floor: Number.isFinite(minY) ? -minY : ext(1), footprint: Math.min(ext(0), ext(2)) }
}

const cache = new Map<string, Promise<SceneGrains | null>>()

/** A scene's grains from its proxy (decoded once per asset). */
export function loadSceneGrains(block: SplatBlock, half: number): Promise<SceneGrains | null> {
  const id = block.proxyAssetId
  if (!id) return Promise.resolve(null)
  const key = `${id}:${JSON.stringify(block.crop)}:${block.upFix.join(',')}:${half}`
  let p = cache.get(key)
  if (!p) {
    p = (async () => {
      try {
        const packed = new PackedSplats({ fileBytes: await loadSplatBytes(id), fileType: SplatFileType.SPZ })
        await packed.initialized
        const n = packed.numSplats
        const raw: RawSplats = { n, center: new Float32Array(n * 3), color: new Float32Array(n * 3), opacity: new Float32Array(n), scale: new Float32Array(n) }
        packed.forEachSplat((i, center, scales, _q, opacity, color) => {
          raw.center.set([center.x, center.y, center.z], i * 3)
          raw.color.set([color.r, color.g, color.b], i * 3)
          raw.opacity[i] = opacity
          raw.scale[i] = (scales.x + scales.y + scales.z) / 3
        })
        const box = block.crop ?? quantileBounds(packed)
        packed.dispose()
        return box ? sceneGrainsFrom(raw, box, block.upFix, half) : null
      } catch (e) {
        console.error('[field] scene grains', e)
        return null
      }
    })()
    cache.set(key, p)
  }
  return p
}
