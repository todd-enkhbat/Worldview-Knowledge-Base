import { Box3, Euler, Quaternion, Vector3 } from 'three'
import { SplatFileType, type PackedSplats } from '@sparkjsdev/spark'
import { isSpzV4, spzV4ToV3 } from './spzV4.ts'

// The four CC-BY-4.0 fixtures (public/fixtures, credits in CREDITS.md), and how each is
// posed inside a diorama. `crop` is a per-axis quantile range of splat centres, in the
// fixture's native frame; it becomes the SplatEditSdf BOX (native units) and the fit.

export interface FixtureSpec {
  name: string
  url: string
  /** Native → diorama rotation (most captures are y-down). */
  euler: [number, number, number]
  cropLo: [number, number, number]
  cropHi: [number, number, number]
}

export const FIXTURES: FixtureSpec[] = [
  { name: 'lion', url: '/fixtures/lion.v3.spz', euler: [Math.PI, 0, 0], cropLo: [0.002, 0.002, 0.002], cropHi: [0.998, 0.998, 0.998] },
  { name: 'tomatoes', url: '/fixtures/tomatoes.v4.spz', euler: [0, 0, 0], cropLo: [0.02, 0.02, 0.02], cropHi: [0.98, 0.98, 0.98] },
  { name: 'apartment', url: '/fixtures/apartment.sog', euler: [Math.PI, 0, 0], cropLo: [0.05, 0.02, 0.05], cropHi: [0.95, 0.9, 0.95] },
  { name: 'hall', url: '/fixtures/knock-community-hall.sog', euler: [Math.PI, 0, 0], cropLo: [0.05, 0.02, 0.05], cropHi: [0.95, 0.9, 0.95] },
]

export interface LoadedBytes {
  bytes: Uint8Array
  fileType: SplatFileType
  fetchMs: number
  /** SPZ v4 → v3 repack time, when the file was v4. */
  convertMs?: number
}

export async function fetchSplatBytes(url: string): Promise<LoadedBytes> {
  const t0 = performance.now()
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  let bytes: Uint8Array = new Uint8Array(await res.arrayBuffer())
  const fetchMs = Math.round(performance.now() - t0)
  const fileType = url.endsWith('.sog') ? SplatFileType.PCSOGSZIP : SplatFileType.SPZ
  let convertMs: number | undefined
  if (isSpzV4(bytes)) {
    const r = await spzV4ToV3(bytes)
    bytes = r.bytes
    convertMs = r.ms
  }
  return { bytes, fileType, fetchMs, convertMs }
}

/** Per-axis quantile box of splat centres, from ≤ `samples` evenly strided splats. */
export function quantileBox(splats: PackedSplats, lo: [number, number, number], hi: [number, number, number], samples = 60_000): Box3 {
  const n = splats.numSplats
  const stride = Math.max(1, Math.floor(n / samples))
  const xs: number[] = []
  const ys: number[] = []
  const zs: number[] = []
  for (let i = 0; i < n; i += stride) {
    const { center } = splats.getSplat(i)
    xs.push(center.x)
    ys.push(center.y)
    zs.push(center.z)
  }
  const q = (a: number[], t: number) => {
    a.sort((p, r) => p - r)
    return a[Math.min(a.length - 1, Math.max(0, Math.floor(t * a.length)))]
  }
  const qs = (a: number[], i: number) => [q(a, lo[i]), q(a, hi[i])]
  const [x0, x1] = qs(xs, 0)
  const [y0, y1] = qs(ys, 1)
  const [z0, z1] = qs(zs, 2)
  return new Box3(new Vector3(x0, y0, z0), new Vector3(x1, y1, z1))
}

export interface Fit {
  quaternion: Quaternion
  scale: number
  /** Mesh position relative to the diorama centre. */
  position: Vector3
  /** Crop box centre and half-size, native units (the SDF's local frame). */
  cropCentre: Vector3
  cropHalf: Vector3
}

/** Pose that puts the rotated crop box centred in a cube of half-size `half`. */
export function fitCrop(crop: Box3, euler: [number, number, number], half: number): Fit {
  const quaternion = new Quaternion().setFromEuler(new Euler(...euler))
  const cropCentre = crop.getCenter(new Vector3())
  const cropHalf = crop.getSize(new Vector3()).multiplyScalar(0.5)
  const rotatedHalf = cropHalf.clone().applyQuaternion(quaternion)
  const maxHalf = Math.max(Math.abs(rotatedHalf.x), Math.abs(rotatedHalf.y), Math.abs(rotatedHalf.z), 1e-6)
  const scale = half / maxHalf
  const position = cropCentre.clone().applyQuaternion(quaternion).multiplyScalar(-scale)
  return { quaternion, scale, position, cropCentre, cropHalf }
}
