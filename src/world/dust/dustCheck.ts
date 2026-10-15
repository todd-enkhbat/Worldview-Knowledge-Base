import type { PhysicsParams } from '../../physics/params.ts'
import { DUST_SEGMENT } from '../../gpu/dust/alloc.ts'
import { type DustOwner, createDustWorld, runDustTo, setDustSegment } from '../../gpu/dust/dustWorld.ts'
import { type DustMismatch, compareDust } from '../../gpu/dust/layout.ts'

// __wv.dustCheck(): the live app's GPU dust against the CPU dust world, int for int, at
// the step the GPU is at. The reference is built independently of the edit-row path: every
// owner set at step 0 and the whole world run forward with births (runDustTo), so a
// mismatch in births, checkpoints, restores or CPU rows all show up.

/** What the check needs from the running dust (DustLayer's runtime). */
export interface DustCheckSource {
  readonly params: PhysicsParams
  /** Texels per row. */
  readonly width: number
  /** Rows the sim draws (every owned segment lies inside). */
  readonly rows: number
  /** Step of the live GPU state. */
  readonly step: number
  /** Segments still waiting for asynchronous CPU rows. */
  readonly pending: number
  ownerOf(segment: number): DustOwner | null
  /** The live X and D as RGBA texels (stride 4), synchronously. */
  read(): { x: Int32Array; d: Int32Array }
}

/** A consistent snapshot: the step, the owners and the GPU state from the same moment. */
export interface DustSnapshot {
  readonly params: PhysicsParams
  readonly step: number
  readonly texels: number
  readonly owners: readonly (DustOwner | null)[]
  readonly x: Int32Array
  readonly d: Int32Array
}

export interface DustCheckResult {
  readonly step: number
  readonly texels: number
  readonly owned: number
  /** Owned segments born before the step (their dust is moving). */
  readonly born: number
  readonly identical: boolean
  readonly mismatches: number
  readonly first: DustMismatch | null
  readonly cpuMs: number
}

export function snapshotDust(src: DustCheckSource): DustSnapshot {
  if (src.pending > 0) throw new Error(`dust has ${src.pending} segment(s) waiting for CPU rows`)
  const texels = src.rows * src.width
  const segments = texels / DUST_SEGMENT
  const owners: (DustOwner | null)[] = []
  for (let s = 0; s < segments; s++) owners.push(src.ownerOf(s))
  const { x, d } = src.read()
  return { params: src.params, step: src.step, texels, owners, x, d }
}

/** Rebuild the CPU dust world for the snapshot's owners at its step and compare every int. */
export function compareDustSnapshot(snap: DustSnapshot): DustCheckResult {
  const t0 = performance.now()
  const owned = snap.owners.filter((o) => o !== null)
  if (snap.texels === 0) {
    return { step: snap.step, texels: 0, owned: 0, born: 0, identical: true, mismatches: 0, first: null, cpuMs: 0 }
  }
  const w = createDustWorld(snap.params, snap.texels)
  snap.owners.forEach((o, s) => {
    if (o) setDustSegment(w, s, o)
  })
  runDustTo(w, snap.step)
  const c = compareDust(snap.texels, w.sys.x, w.sys.d, snap.x, snap.d)
  return {
    step: snap.step,
    texels: snap.texels,
    owned: owned.length,
    born: owned.filter((o) => o.birth < snap.step).length,
    identical: c.identical,
    mismatches: c.mismatches,
    first: c.first,
    cpuMs: Math.round(performance.now() - t0),
  }
}
