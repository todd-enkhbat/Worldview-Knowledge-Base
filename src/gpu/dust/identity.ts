// In-browser CPU ≡ GPU check of the full dust pipeline: births regenerated on the GPU,
// k-step draws forward and backward, checkpoint copies and restores, and CPU edit rows
// (sync and async), all driven by DustSim on the real WebGL2 backend and compared int for
// int with the CPU dust world after each phase. The lab calls runDustIdentity() next to
// the S2 check; tests/physics/gpuDustSim.test.ts runs the same DustSim logic in node.

import { WebGLRenderer } from 'three'
import { UNIT } from '../../physics/fixed.ts'
import { makePhysicsParams } from '../../physics/params.ts'
import { draw, fnv1a32, uniformBelow } from '../../physics/rng.ts'
import { DUST_SEGMENT, rowsForSegments } from './alloc.ts'
import { DustGpu } from './DustGpu.ts'
import { type DustOwner, createDustWorld, runDustTo, setDustSegment } from './dustWorld.ts'
import { compareDust, dustTextureSize } from './layout.ts'
import { DustSim } from './sim.ts'

export interface DustIdentityOptions {
  /** Owner segments (64 texels each). */
  readonly segments?: number
  /** Forward run length; births are spread over [0, steps]. */
  readonly steps?: number
  /** Checkpoint spacing for the run (the app uses 3000). */
  readonly interval?: number
  readonly seed?: number
  readonly onProgress?: (msg: string) => void
}

export interface DustIdentityCheck {
  readonly label: string
  readonly step: number
  readonly identical: boolean
  readonly mismatches: number
}

export interface DustIdentityResult {
  readonly texels: number
  readonly texture: { readonly width: number; readonly height: number }
  readonly identical: boolean
  readonly checks: readonly DustIdentityCheck[]
  readonly checkpoints: readonly number[]
  readonly error: string | null
}

const tick = () =>
  new Promise<void>((resolve) => {
    const ch = new MessageChannel()
    ch.port1.onmessage = () => {
      ch.port1.close()
      resolve()
    }
    ch.port2.postMessage(null)
  })

/** Deterministic owners: births over [0, span] (a few at 0, past the run, or free), anchors over the world and the torus seam. */
export function identityOwners(segments: number, span: number, seed: number): (DustOwner | null)[] {
  const out: (DustOwner | null)[] = []
  for (let s = 0; s < segments; s++) {
    const h = (k: number) => draw((seed ^ Math.imul(s, 0x9e3779b9)) | 0, k)
    if (s % 11 === 5) {
      out.push(null)
      continue
    }
    const id = `dust-identity-${seed}-${s}`
    const birth = s % 7 === 0 ? 0 : s % 13 === 3 ? span * 4 : uniformBelow(h(0), Math.min(span + 1, 0x8000))
    const seam = s < 2
    const ax = seam ? (s === 0 ? 1 : -1) * (4096 * UNIT - 1 - (h(1) & 0xffff)) : (uniformBelow(h(1), 128) - 64) * UNIT + (h(2) & (UNIT - 1))
    const ay = uniformBelow(h(3), 480) * UNIT
    const az = seam ? -ax : (uniformBelow(h(4), 128) - 64) * UNIT + (h(5) & (UNIT - 1))
    out.push({ id, anchor: [ax | 0, ay | 0, az | 0], birth, seed: fnv1a32(id) | 0, style: s % 6 })
  }
  return out
}

export async function runDustIdentity(opts: DustIdentityOptions = {}): Promise<DustIdentityResult> {
  const segments = opts.segments ?? 64
  const steps = opts.steps ?? 600
  const interval = opts.interval ?? 150
  const seed = opts.seed ?? 0xd1
  const log = opts.onProgress ?? (() => {})
  const params = makePhysicsParams({ seed: 0x5eed })
  const texels = segments * DUST_SEGMENT
  const { width, height } = dustTextureSize(texels)
  const owners = identityOwners(segments, steps, seed)
  const checks: DustIdentityCheck[] = []
  let checkpoints: number[] = []
  let error: string | null = null

  const ref = (step: number) => {
    const w = createDustWorld(params, texels)
    owners.forEach((o, s) => setDustSegment(w, s, o))
    runDustTo(w, step)
    return w
  }

  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  let renderer: WebGLRenderer | null = null
  let gpu: DustGpu | null = null
  try {
    renderer = new WebGLRenderer({ canvas, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' })
    gpu = new DustGpu(renderer, params, width, height, { births: true })
    const sim = new DustSim(gpu, params, { interval, ring: 3, maxStepsPerDraw: 50, syncEditSteps: 200, cpuStepsPerFrame: 300 })
    sim.setRows(rowsForSegments(segments, width))
    owners.forEach((o, s) => sim.setOwner(s, o))
    const g = gpu
    const check = (label: string) => {
      const w = ref(sim.step)
      const r = g.read()
      const c = compareDust(texels, w.sys.x, w.sys.d, r.x, r.d)
      checks.push({ label, step: sim.step, identical: c.identical, mismatches: c.mismatches })
    }
    check('spawn at 0')
    log('forward…')
    let frames = 0
    while (sim.step !== steps) {
      sim.frame(steps, 37)
      if (++frames % 4 === 0) check('forward')
      await tick()
    }
    check('forward end')
    log('seeks…')
    sim.frame(Math.round(interval * 1.5), 10_000)
    check('seek back (checkpoint restore)')
    sim.frame(3, 10_000)
    check('seek to 3 (step-0 restore)')
    sim.frame(steps - 7, 10_000)
    check('seek forward')
    log('edits…')
    // Sync edit: re-anchor an owner born recently; and a new owner on the free segment.
    const live = sim.step
    const k = owners.findIndex((o) => o !== null && o.birth > live - 150 && o.birth <= live)
    if (k >= 0) {
      const o = owners[k]!
      owners[k] = { ...o, anchor: [o.anchor[0] + UNIT, o.anchor[1], o.anchor[2] - UNIT] }
      sim.setOwner(k, owners[k])
    }
    const free = owners.indexOf(null)
    if (free >= 0) {
      owners[free] = { id: 'dust-identity-new', anchor: [5 * UNIT, 40 * UNIT, -5 * UNIT], birth: live - 20, seed: fnv1a32('dust-identity-new') | 0, style: 4 }
      sim.setOwner(free, owners[free])
    }
    check('sync edits')
    for (const c of sim.checkpointSteps) {
      sim.frame(c, 0)
      check(`restore ${c} after edits`)
    }
    // Async edit: an owner born at 0, edited at the end of the run.
    sim.frame(steps, 10_000)
    const old = owners.findIndex((o) => o !== null && o.birth === 0)
    if (old >= 0) {
      const o = owners[old]!
      owners[old] = { ...o, anchor: [o.anchor[0], o.anchor[1] + 2 * UNIT, o.anchor[2]] }
      sim.setOwner(old, owners[old])
      while (sim.pending > 0) {
        sim.frame(steps, 20)
        await tick()
      }
      check('async edit done')
    }
    log('backward…')
    while (sim.step !== 0) {
      sim.frame(0, 41)
      await tick()
    }
    check('backward to 0')
    checkpoints = sim.checkpointSteps
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  } finally {
    gpu?.dispose()
    if (renderer) {
      renderer.dispose()
      renderer.forceContextLoss()
    }
  }
  return {
    texels,
    texture: { width, height },
    identical: error === null && checks.length > 0 && checks.every((c) => c.identical),
    checks,
    checkpoints,
    error,
  }
}
