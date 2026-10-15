import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import { BufferGeometry, Points, type RawShaderMaterial, type WebGLRenderer } from 'three'
import { registerDevApi } from '../../app/devApi.ts'
import { useWorld } from '../../app/store.ts'
import { DUST_BUDGET_TEXELS, DUST_TEXTURE_WIDTH } from '../../gpu/dust/alloc.ts'
import { DustGpu, DustGpuUnsupportedError, assertHighpInt } from '../../gpu/dust/DustGpu.ts'
import { DustSim } from '../../gpu/dust/sim.ts'
import { GpuStepTimer, stepBudget } from '../../gpu/dust/timer.ts'
import { type PhysicsParams, makePhysicsParams } from '../../physics/params.ts'
import { LAYER, RENDER_ORDER } from '../layers.ts'
import { getPlayhead } from '../time/clock.ts'
import { type DustCheckResult, compareDustSnapshot, snapshotDust } from './dustCheck.ts'
import { createDustPointsMaterial } from './dustMaterial.ts'
import { DustAssigner, dustEntries } from './owners.ts'

// <DustLayer/>: the GPU dust. A fixed 512×256 RGBA32I budget, one 64-texel segment per
// funded node (memories first), stepped on the GPU toward the same playhead step the node
// worker uses (getPlayhead().step, read each frame after the clock at priority −3) and
// drawn as additive points on LAYER.DUST. Without 32-bit highp ints, or on any GPU
// failure, it renders nothing (the world is complete without dust).
//
// The points live in a top-level group named 'dust' (flyIn.ts WORLD_GROUP_NAMES): the
// interior hides that group while the frame loop keeps owning the points' own visibility.

interface DustRuntime {
  readonly params: PhysicsParams
  readonly gpu: DustGpu
  readonly sim: DustSim
  readonly assigner: DustAssigner
  readonly timer: GpuStepTimer | null
  readonly points: Points<BufferGeometry, RawShaderMaterial>
  fade: number
}

const HEIGHT = DUST_BUDGET_TEXELS / DUST_TEXTURE_WIDTH
/** Within this many steps of the playhead the dust is shown at the playhead (no fade). */
const SHOW_GAP = 64

let reported = false
function reportOnce(e: unknown): void {
  if (reported) return
  reported = true
  const msg = e instanceof Error ? e.message : String(e)
  if (e instanceof DustGpuUnsupportedError) console.info(`[dust] GPU dust unavailable: ${msg}`)
  else console.warn('[dust] GPU dust disabled:', e)
}

function createRuntime(gl: WebGLRenderer, seed: number, stepsPerYear: number): DustRuntime {
  const ctx = gl.getContext()
  if (!(ctx instanceof WebGL2RenderingContext)) throw new DustGpuUnsupportedError('WebGL2 required')
  // The points shader reads the integer state in the vertex stage too.
  assertHighpInt(ctx, ctx.VERTEX_SHADER)
  const params = makePhysicsParams({ seed })
  const gpu = new DustGpu(gl, params, DUST_TEXTURE_WIDTH, HEIGHT, { births: true })
  try {
    const sim = new DustSim(gpu, params)
    const geometry = new BufferGeometry()
    // No attributes: the vertex shader addresses texels by gl_VertexID; the draw range is the count.
    geometry.setDrawRange(0, 0)
    const material = createDustPointsMaterial(
      { x: gpu.positionTexture, d: gpu.velocityTexture, anchor: gpu.anchorTexture, meta: gpu.metaTexture },
      DUST_TEXTURE_WIDTH,
      stepsPerYear,
    )
    const points = new Points(geometry, material)
    points.name = 'dust-points'
    points.frustumCulled = false
    points.renderOrder = RENDER_ORDER.DUST
    points.layers.set(LAYER.DUST)
    points.raycast = () => {}
    points.visible = false
    return { params, gpu, sim, assigner: new DustAssigner(DUST_TEXTURE_WIDTH), timer: GpuStepTimer.create(ctx), points, fade: 0 }
  } catch (e) {
    gpu.dispose()
    throw e
  }
}

// ─── dev: __wv.dustCheck() ───────────────────────────────────────────────────────────

let live: DustRuntime | null = null

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

/**
 * Compare the running GPU dust with the CPU dust world at the GPU's current step (every
 * int of X and D over the drawn rows, births included). Waits (≤ timeoutMs) for pending
 * CPU edit rows and, unless `anyStep`, for the dust to reach the playhead.
 */
async function dustCheck(opts: { anyStep?: boolean; timeoutMs?: number } = {}): Promise<DustCheckResult & { playhead: number }> {
  const deadline = performance.now() + (opts.timeoutMs ?? 30_000)
  for (;;) {
    const r = live
    if (!r) throw new Error('GPU dust is not running')
    const ready = r.sim.pending === 0 && (opts.anyStep || r.sim.step === getPlayhead().step)
    if (ready) {
      const snap = snapshotDust({
        params: r.params,
        width: r.gpu.width,
        rows: r.gpu.drawnRows,
        step: r.sim.step,
        pending: r.sim.pending,
        ownerOf: (s) => r.sim.ownerOf(s),
        read: () => r.gpu.read(),
      })
      const playhead = getPlayhead().step
      return { ...compareDustSnapshot(snap), playhead }
    }
    if (performance.now() > deadline) throw new Error(`dust did not settle (step ${r.sim.step}, playhead ${getPlayhead().step}, pending ${r.sim.pending})`)
    await nextFrame()
  }
}

if (import.meta.env.DEV) registerDevApi('dustCheck', dustCheck)

function disposeRuntime(rt: DustRuntime): void {
  rt.timer?.dispose()
  rt.gpu.dispose()
  rt.points.geometry.dispose()
  rt.points.material.dispose()
}

export function DustLayer() {
  const gl = useThree((s) => s.gl)
  const settings = useWorld((s) => s.settings)
  const nodes = useWorld((s) => s.nodes)
  const seed = settings?.physicsSeed ?? null
  const stepsPerYear = settings?.stepsPerYear ?? null
  const [rt, setRt] = useState<DustRuntime | null>(null)
  const rtRef = useRef<DustRuntime | null>(null)

  useEffect(() => {
    if (seed === null || stepsPerYear === null) return
    let runtime: DustRuntime
    try {
      runtime = createRuntime(gl, seed, stepsPerYear)
    } catch (e) {
      reportOnce(e)
      return
    }
    rtRef.current = runtime
    live = runtime
    setRt(runtime)
    const canvas = gl.domElement
    const restored = () => {
      runtime.gpu.onContextRestored()
      runtime.sim.reset()
    }
    canvas.addEventListener('webglcontextrestored', restored)
    return () => {
      canvas.removeEventListener('webglcontextrestored', restored)
      if (rtRef.current === runtime) rtRef.current = null
      if (live === runtime) live = null
      setRt(null)
      disposeRuntime(runtime)
    }
  }, [gl, seed, stepsPerYear])

  // Records → segments: small edits as CPU rows, loads and imports as a GPU restart.
  useEffect(() => {
    if (!rt) return
    try {
      rt.assigner.apply(dustEntries(nodes, settings), rt.sim)
    } catch (e) {
      reportOnce(e)
    }
  }, [rt, nodes, settings])

  useFrame((state, delta) => {
    const r = rtRef.current
    if (!r) return
    const ph = getPlayhead()
    const texels = r.gpu.drawnRows * r.gpu.width
    let gap = 0
    try {
      if (texels > 0) {
        r.timer?.poll()
        const budget = stepBudget(texels, r.timer?.nsPerTexelStep ?? null)
        const timing = r.timer?.begin() ?? false
        const f = r.sim.frame(ph.step, budget)
        if (timing) r.timer!.end(f.stepsRun * texels)
        gap = Math.abs(ph.step - f.step)
      }
    } catch (e) {
      // A failed first draw (shader or framebuffer) turns dust off for this session.
      reportOnce(e)
      rtRef.current = null
      if (live === r) live = null
      r.points.visible = false
      return
    }
    // Fade out while a long seek is being stepped through, back in once at the playhead.
    const want = gap <= SHOW_GAP ? 1 : 0
    r.fade += (want - r.fade) * Math.min(1, delta * 6)
    const u = r.points.material.uniforms
    u.uX.value = r.gpu.positionTexture
    u.uD.value = r.gpu.velocityTexture
    u.uStep.value = r.sim.step
    u.uAcc.value = gap === 0 ? ph.acc : 0
    u.uFade.value = r.fade
    u.uPixelScale.value = state.camera.projectionMatrix.elements[5] * 0.5 * state.size.height * state.viewport.dpr
    r.points.geometry.setDrawRange(0, texels)
    r.points.visible = texels > 0 && r.fade > 0.003
  }, -2)

  return <group name="dust">{rt && <primitive object={rt.points} />}</group>
}
