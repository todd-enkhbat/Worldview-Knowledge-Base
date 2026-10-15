import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3 } from 'three'
import { DustLayer } from '../../world/dust/DustLayer.tsx'
import { EnvironmentScene, usePathGraph } from '../../world/environment/index.tsx'
import { HyperspaceCanvas } from '../../world/HyperspaceCanvas.tsx'
import { LinkLayer } from '../../world/links/index.tsx'
import { NodeLayer } from '../../world/nodes/index.tsx'
import { Overlays } from '../../world/overlays/index.tsx'
import { FRAME_PRIORITY } from '../../world/post/frameOwner.ts'
import { PostStack } from '../../world/post/PostStack.tsx'
import { liveStats } from '../../world/renderStats.ts'
import { SplatLayer, splatStats, whenSpark } from '../../world/splats/index.tsx'
import { usePhysicsPoses } from '../../world/time/usePhysicsPoses.ts'
import { usePlayheadClock } from '../../world/time/usePlayheadClock.ts'
import { Worldline } from '../../world/worldline/index.ts'
import { type FixtureWorld, attachFixtures } from './fixtureWorld.ts'
import { FrameGpuTimer } from './gpuTimer.ts'
import type { CanvasInfo, PerfRun } from './runner.ts'
import type { WorkSample } from './stats.ts'

// The perf scene: the world scene composed exactly as WorldPage does (clock, physics poses,
// environment, nodes, links, overlays, worldline, dust, splats, post), minus the HUD and the camera
// rig. A scripted camera and a frame probe take the rig's place. The shared world modules
// are used as they are; nothing here changes them.

/** Fixed device-pixel ratio for criterion P. */
export const PERF_DPR = 1.5
/** Give up waiting for the world SparkRenderer after this long (fixtures are then skipped). */
const SPARK_TIMEOUT_MS = 15_000

function PerfWorld() {
  // Same frame order as WorldPage: clock (−3), then the pose writer (−2).
  usePlayheadClock()
  usePhysicsPoses()
  const graph = usePathGraph()
  return (
    <>
      <EnvironmentScene graph={graph} />
      <NodeLayer />
      <LinkLayer />
      <group name="overlays">
        <Overlays />
      </group>
      <Worldline />
      <DustLayer />
      <SplatLayer />
      <PostStack />
    </>
  )
}

function rendererStrings(gl: WebGL2RenderingContext): { vendor: string | null; renderer: string | null } {
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  if (!dbg) return { vendor: null, renderer: null }
  return {
    vendor: String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)),
    renderer: String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)),
  }
}

/** Probe + script driver: frame timing, GPU timer, DPR guard and the scripted camera. */
function PerfDriver({ run, world }: { run: PerfRun; world: FixtureWorld }) {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const setDpr = useThree((s) => s.setDpr)
  const size = useThree((s) => s.size)
  const timer = useMemo(() => FrameGpuTimer.create<WorkSample | null>(gl.getContext() as WebGL2RenderingContext), [gl])
  const begin = useRef(0)
  const gpuOpen = useRef(false)
  const pos = useMemo(() => new Vector3(), [])
  const target = useMemo(() => new Vector3(), [])
  const sizeRef = useRef(size)
  sizeRef.current = size

  useEffect(() => () => timer?.dispose(), [timer])

  // Criterion P is about rAF cadence, so the recorder needs the browser's own rAF
  // timestamps; R3F's frame callbacks do not expose them. A second rAF loop is cheap and
  // stretches exactly when the R3F frame does.
  useEffect(() => {
    let id = requestAnimationFrame(function loop(ts: number) {
      run.recorder.raf(ts)
      id = requestAnimationFrame(loop)
    })
    return () => cancelAnimationFrame(id)
  }, [run])

  // Fixtures, then the script. Runs once per mounted run.
  useEffect(() => {
    let cancelled = false
    const ctx = gl.getContext() as WebGL2RenderingContext
    const deps = {
      canvasInfo: (): CanvasInfo => ({
        cssWidth: sizeRef.current.width,
        cssHeight: sizeRef.current.height,
        dpr: gl.getPixelRatio(),
        drawingBuffer: [ctx.drawingBufferWidth, ctx.drawingBufferHeight],
        ...rendererStrings(ctx),
        gpuTimer: timer !== null,
      }),
      rendererInfo: () => ({
        calls: liveStats.calls,
        triangles: liveStats.triangles,
        points: liveStats.points,
        lines: liveStats.lines,
        geometries: liveStats.geometries,
        textures: liveStats.textures,
        programs: liveStats.programs,
      }),
      splatInfo: () => {
        try {
          const s = splatStats()
          return { activeSplats: s.activeSplats, lodSplatCount: s.lodSplatCount, residentProxySplats: s.residentProxySplats, meshes: s.meshes }
        } catch {
          return null
        }
      },
      gpuDisjoint: () => timer?.disjoint ?? 0,
    }
    void (async () => {
      try {
        if (world.fixtures.length === 0) {
          run.setStatus('fixtures', 'waiting for the SparkRenderer')
          const spark = await Promise.race([whenSpark().then(() => true), new Promise<false>((r) => setTimeout(() => r(false), SPARK_TIMEOUT_MS))])
          if (cancelled) return
          if (spark) await attachFixtures(world, (msg) => !cancelled && run.setStatus('fixtures', msg))
        }
        if (!cancelled) run.begin(world, deps)
      } catch (e) {
        if (!cancelled) run.fail(e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [gl, run, world, timer])

  // First callback of the frame: stamp, advance the script, hold the DPR.
  useFrame(() => {
    const now = performance.now()
    begin.current = now
    run.tick(now)
    if (gl.getPixelRatio() !== PERF_DPR) setDpr(PERF_DPR)
  }, FRAME_PRIORITY.STATS_BEGIN - 1)

  // After the poses (−2): the scripted camera owns the camera (no rig is mounted).
  useFrame(() => {
    if (run.camera(begin.current, pos, target)) {
      camera.position.copy(pos)
      camera.lookAt(target)
    }
  }, -1)

  // After the dust step (0) and before the composer (1): open the GPU query.
  useFrame(() => {
    gpuOpen.current = run.recorder.phase !== null && timer !== null && timer.begin()
  }, 0.5)

  // After the stats collector rendered/reset (STATS_END): close the frame.
  useFrame(() => {
    const now = performance.now()
    const sample = run.recorder.frame(now, now - begin.current, liveStats.calls, liveStats.triangles, liveStats.points)
    if (gpuOpen.current) {
      timer!.end(sample)
      gpuOpen.current = false
    }
    timer?.poll((tag, ms) => {
      if (tag) tag.gpu = ms
    })
  }, FRAME_PRIORITY.STATS_END + 1)

  return null
}

export interface PerfSceneProps {
  run: PerfRun
  world: FixtureWorld
}

export function PerfScene({ run, world }: PerfSceneProps) {
  return (
    <HyperspaceCanvas adaptiveQuality={false}>
      <PerfWorld />
      <PerfDriver run={run} world={world} />
    </HyperspaceCanvas>
  )
}
