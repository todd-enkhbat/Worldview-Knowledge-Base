// S2 acceptance harness: the real dust kernel on the GPU must match the TS reference
// in every int after each draw, forward and backward; 500 forward + 500 backward must
// return the uploaded state exactly. Also measures GPU and CPU time per step.

import { WebGLRenderer } from 'three'
import { DustGpu } from '../../gpu/dust/DustGpu.ts'
import { dustStepFragmentShader } from '../../gpu/dust/glsl.ts'
import { type DustMismatch, compareDust, dustTextureSize, packDust } from '../../gpu/dust/layout.ts'
import { stepForward } from '../../physics/integrator.ts'
import { fnv1aWords } from '../../physics/rng.ts'
import { assertStable, makePhysicsParams } from '../../physics/params.ts'
import { sinLutHash } from '../../physics/sinlut.ts'
import { makeS2DustWorld } from './world.ts'

export interface S2Options {
  /** Particle count (≥ 4096 for acceptance). */
  readonly n?: number
  /** Forward steps, then the same number backward. */
  readonly steps?: number
  /** Steps per draw (the shader loop length). */
  readonly drawSteps?: number
  readonly seed?: number
  /** Landscape amplitude, Q.8 (256 = 1×). */
  readonly landscapeAmp?: number
  /** Forward steps timed on the GPU (after a warm-up draw). */
  readonly timingSteps?: number
  readonly onProgress?: (msg: string) => void
}

export interface S2Checkpoint {
  readonly phase: 'load' | 'forward' | 'backward'
  readonly step: number
  readonly identical: boolean
  readonly mismatches: number
}

export interface S2Result {
  readonly n: number
  readonly steps: number
  readonly identicalAfterForward: boolean
  readonly identicalAfterBackward: boolean
  readonly firstMismatch: (DustMismatch & { phase: string; step: number }) | null
  readonly gpuMsPerStep: number | null
  readonly renderer: string
  readonly unmaskedRenderer: string | null
  readonly timing: {
    readonly method: string
    readonly steps: number
    readonly wallMsPerStep: number | null
    readonly queryMsPerStep: number | null
    readonly gpuParticleStepsPerSec: number | null
    readonly cpuMsPerStep: number
    readonly cpuParticleStepsPerSec: number
  }
  readonly checkpoints: readonly S2Checkpoint[]
  readonly drawSteps: number
  readonly texture: { readonly width: number; readonly height: number }
  readonly highInt: { readonly rangeMin: number; readonly rangeMax: number; readonly precision: number } | null
  readonly sinLutHash: string
  /** stateHash (fnv1a over X then D) of the CPU reference at step 0 and after the forward run. */
  readonly initialHash: string
  readonly forwardHash: string
  readonly landscapeAmp: number
  readonly omegaMaxDt: number
  readonly glslBytes: number
  readonly path: string
  readonly error: string | null
}

// MessageChannel yields are not throttled in background tabs (setTimeout and rAF are).
const tick = () =>
  new Promise<void>((resolve) => {
    const ch = new MessageChannel()
    ch.port1.onmessage = () => {
      ch.port1.close()
      resolve()
    }
    ch.port2.postMessage(null)
  })
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Draw lengths: one single-step draw first (bisects to a single step), then drawSteps-aligned chunks. */
export function s2Schedule(steps: number, drawSteps: number): number[] {
  const out: number[] = []
  let done = 0
  if (steps > 0) {
    out.push(1)
    done = 1
  }
  while (done < steps) {
    const k = Math.min(drawSteps - (done % drawSteps), steps - done)
    out.push(k)
    done += k
  }
  return out
}

export async function runS2(opts: S2Options = {}): Promise<S2Result> {
  const n = opts.n ?? 16384
  const steps = opts.steps ?? 500
  const drawSteps = opts.drawSteps ?? 100
  const landscapeAmp = opts.landscapeAmp ?? 256
  const timingSteps = opts.timingSteps ?? 1000
  const log = opts.onProgress ?? (() => {})
  const params = makePhysicsParams({ seed: 0x5eed, landscapeAmp })
  const omegaMaxDt = assertStable(params, [params.dustInvMass], [params.dustTau], params.dust, false)
  const sys = makeS2DustWorld({ n, seed: opts.seed, params })
  const { width, height } = dustTextureSize(n)
  const packed0 = packDust(sys, width, height)
  const schedule = s2Schedule(steps, drawSteps)

  // CPU reference with snapshots at every draw boundary (step 0 included).
  log('cpu reference…')
  const snaps = new Map<number, { x: Int32Array; d: Int32Array }>()
  snaps.set(0, { x: sys.x.slice(), d: sys.d.slice() })
  let step = 0
  let cpuMs = 0
  for (const k of schedule) {
    const t0 = performance.now()
    for (let j = 0; j < k; j++) stepForward(sys, step + j)
    cpuMs += performance.now() - t0
    step += k
    snaps.set(step, { x: sys.x.slice(), d: sys.d.slice() })
    await tick()
  }
  const cpuMsPerStep = cpuMs / steps

  const checkpoints: S2Checkpoint[] = []
  let firstMismatch: S2Result['firstMismatch'] = null
  const check = (phase: S2Checkpoint['phase'], at: number, gpu: { x: Int32Array; d: Int32Array }) => {
    const ref = snaps.get(at)!
    const c = compareDust(n, ref.x, ref.d, gpu.x, gpu.d)
    checkpoints.push({ phase, step: at, identical: c.identical, mismatches: c.mismatches })
    if (c.first && !firstMismatch) firstMismatch = { phase, step: at, ...c.first }
    return c.identical
  }

  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  let renderer: WebGLRenderer | null = null
  let dust: DustGpu | null = null
  let rendererName = 'n/a'
  let unmasked: string | null = null
  let highInt: S2Result['highInt'] = null
  let identicalAfterForward = false
  let identicalAfterBackward = false
  let wallMsPerStep: number | null = null
  let queryMsPerStep: number | null = null
  let error: string | null = null
  try {
    renderer = new WebGLRenderer({ canvas, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' })
    const gl = renderer.getContext() as WebGL2RenderingContext
    rendererName = String(gl.getParameter(gl.RENDERER))
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    unmasked = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null
    dust = new DustGpu(renderer, params, width, height)
    highInt = dust.precision

    log('gpu forward…')
    dust.load(packed0)
    check('load', 0, dust.read())
    step = 0
    let fwdOk = true
    for (const k of schedule) {
      dust.step(k, false)
      step += k
      fwdOk = check('forward', step, dust.read()) && fwdOk
      await tick()
    }
    identicalAfterForward = fwdOk && checkpoints[checkpoints.length - 1].identical

    log('gpu backward…')
    for (const k of [...schedule].reverse()) {
      dust.step(k, true)
      step -= k
      check('backward', step, dust.read())
      await tick()
    }
    identicalAfterBackward = step === 0 && checkpoints[checkpoints.length - 1].identical

    log('gpu timing…')
    const t = await timeGpu(renderer, dust, packed0, drawSteps, timingSteps)
    wallMsPerStep = t.wallMsPerStep
    queryMsPerStep = t.queryMsPerStep
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  } finally {
    dust?.dispose()
    if (renderer) {
      renderer.dispose()
      renderer.forceContextLoss()
    }
  }

  const gpuMsPerStep = queryMsPerStep ?? wallMsPerStep
  return {
    n,
    steps,
    identicalAfterForward,
    identicalAfterBackward,
    firstMismatch,
    gpuMsPerStep: gpuMsPerStep === null ? null : round4(gpuMsPerStep),
    renderer: rendererName,
    unmaskedRenderer: unmasked,
    timing: {
      method: queryMsPerStep !== null ? 'EXT_disjoint_timer_query_webgl2' : 'wall clock, synced by 1-texel readPixels',
      steps: timingSteps,
      wallMsPerStep: wallMsPerStep === null ? null : round4(wallMsPerStep),
      queryMsPerStep: queryMsPerStep === null ? null : round4(queryMsPerStep),
      gpuParticleStepsPerSec: gpuMsPerStep ? Math.round((n * 1000) / gpuMsPerStep) : null,
      cpuMsPerStep: round4(cpuMsPerStep),
      cpuParticleStepsPerSec: Math.round((n * 1000) / cpuMsPerStep),
    },
    checkpoints,
    drawSteps,
    texture: { width, height },
    highInt,
    sinLutHash: `0x${sinLutHash().toString(16)}`,
    initialHash: hashOf(snaps.get(0)!),
    forwardHash: hashOf(snaps.get(steps)!),
    landscapeAmp,
    omegaMaxDt: round4(omegaMaxDt),
    glslBytes: dustStepFragmentShader(params).length,
    path: 'three WebGLRenderTarget(count 2, RGBA32I) + GLSL3 RawShaderMaterial; readRenderTargetPixels RGBA_INTEGER/INT',
    error,
  }
}

function hashOf(s: { x: Int32Array; d: Int32Array }): string {
  return fnv1aWords(s.d, 4, fnv1aWords(s.x)).toString(16)
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4
}

interface TimerQueryExt {
  readonly TIME_ELAPSED_EXT: number
  readonly GPU_DISJOINT_EXT: number
}

async function timeGpu(
  renderer: WebGLRenderer,
  dust: DustGpu,
  packed: Parameters<DustGpu['load']>[0],
  drawSteps: number,
  timingSteps: number,
): Promise<{ wallMsPerStep: number; queryMsPerStep: number | null }> {
  const gl = renderer.getContext() as WebGL2RenderingContext
  dust.load(packed)
  dust.step(drawSteps)
  dust.sync()
  const draws = Math.max(1, Math.round(timingSteps / drawSteps))
  const total = draws * drawSteps

  const t0 = performance.now()
  for (let i = 0; i < draws; i++) dust.step(drawSteps)
  dust.sync()
  const wallMsPerStep = (performance.now() - t0) / total

  let queryMsPerStep: number | null = null
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null
  if (ext) {
    const q = gl.createQuery()
    if (q) {
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q)
      for (let i = 0; i < draws; i++) dust.step(drawSteps)
      gl.endQuery(ext.TIME_ELAPSED_EXT)
      dust.sync()
      // Results only become available after returning to the event loop; poll up to ~2 s.
      const deadline = performance.now() + 2000
      for (let f = 0; performance.now() < deadline; f++) {
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
          if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
            queryMsPerStep = Number(gl.getQueryParameter(q, gl.QUERY_RESULT)) / 1e6 / total
          }
          break
        }
        await (f < 50 ? tick() : sleep(16))
      }
      gl.deleteQuery(q)
    }
  }
  return { wallMsPerStep, queryMsPerStep }
}
