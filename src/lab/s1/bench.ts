import { estimateVsync, FLAG, percentiles, round2, shareAbove, type Percentiles } from './metrics.ts'
import { PATH_SECONDS } from './path.ts'
import { resetCounters, rt, useS1, type Toggles } from './state.ts'

// window.__s1(): a scripted run of the camera path with the current (or given) toggles,
// returning everything the S1 write-up needs as one JSON object.

export interface S1RunOptions {
  label?: string
  durationMs?: number
  warmupMs?: number
  path?: 'orbit' | 'static'
  toggles?: Partial<Toggles>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function glInfo(): Record<string, unknown> {
  const gl = rt.gl
  if (!gl) return {}
  const ctx = gl.getContext()
  const dbg = ctx.getExtension('WEBGL_debug_renderer_info')
  const canvas = gl.domElement
  return {
    renderer: ctx.getParameter(ctx.RENDERER),
    vendor: ctx.getParameter(ctx.VENDOR),
    unmaskedRenderer: dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
    version: ctx.getParameter(ctx.VERSION),
    timerQuery: !!ctx.getExtension('EXT_disjoint_timer_query_webgl2'),
    dpr: gl.getPixelRatio(),
    drawingBuffer: [ctx.drawingBufferWidth, ctx.drawingBufferHeight],
    css: [canvas.clientWidth, canvas.clientHeight],
  }
}

/** Resolves when every diorama is ready (or failed), or after `timeoutMs`. */
export async function waitForDioramas(timeoutMs = 180_000): Promise<boolean> {
  const t0 = performance.now()
  for (;;) {
    const ds = useS1.getState().dioramas
    if (ds.length >= 4 && ds.every((d) => d.status === 'ready' || d.status === 'error')) return true
    if (performance.now() - t0 > timeoutMs) return false
    await sleep(250)
  }
}

function split(mask: number, want: number, vsync: number) {
  const iv = rt.ring.select('interval', mask, want)
  const mn = rt.ring.select('main', mask, want)
  return { frames: iv.length, interval: percentiles(iv), main: percentiles(mn), shareOver1_5Vsync: shareAbove(iv, 1.5 * vsync) }
}

export function collect(label: string, durationMs: number): Record<string, unknown> {
  const intervals = rt.ring.select('interval')
  const mains = rt.ring.select('main')
  const vsync = estimateVsync(intervals)
  const probe = rt.probe
  const seconds = durationMs / 1000
  const frames = Math.max(1, rt.info.frames)
  const sorts: Percentiles | null = probe ? probe.sorts.summary() : null
  const st = useS1.getState()
  const spark = rt.spark
  const glr = rt.gl
  return {
    label,
    when: new Date().toISOString(),
    userAgent: navigator.userAgent,
    gl: glInfo(),
    toggles: st.toggles,
    durationMs,
    frames: intervals.length,
    fps: round2(intervals.length / seconds),
    vsyncMs: round2(vsync),
    interval: percentiles(intervals),
    main: percentiles(mains),
    shareOver1_5Vsync: shareAbove(intervals, 1.5 * vsync),
    shareOver2Vsync: shareAbove(intervals, 2 * vsync),
    tweenFrames: split(FLAG.TWEEN, FLAG.TWEEN, vsync),
    nonTweenFrames: split(FLAG.TWEEN, 0, vsync),
    sortLandedFrames: split(FLAG.SORT_DONE, FLAG.SORT_DONE, vsync),
    lodTraverseFrames: split(FLAG.LOD_TRAVERSE, FLAG.LOD_TRAVERSE, vsync),
    spark: spark && {
      avgActiveSplats: Math.round(rt.splatSamples.active / Math.max(1, rt.splatSamples.frames)),
      avgGeneratedSplats: Math.round(rt.splatSamples.generated / Math.max(1, rt.splatSamples.frames)),
      forceSinglePass: spark.material.forceSinglePass,
      lodSplatScale: spark.lodSplatScale,
      defaultLodSplatTarget: spark.defaultSplatTarget(),
      sorts: probe && { count: probe.sorts.total, perSec: round2(probe.sorts.total / seconds), latencyMs: sorts },
      readPixelsMs: probe?.readPixels.summary(),
      getBufferSubDataMs: probe?.getBufferSubData.summary(),
      lodTraversals: probe && {
        count: probe.lodTraversals.total,
        perSec: round2(probe.lodTraversals.total / seconds),
        ms: probe.lodTraversals.summary(),
      },
      displaySwapsPerFrame: round2(rt.displaySwaps / frames),
      drawsPerFrame: { main: round2(rt.draws.main / frames), other: round2(rt.draws.other / frames) },
      framesWithReflectorSplatDraws: probe?.leakFrames ?? 0,
    },
    info: glr && {
      callsPerFrame: round2(rt.info.calls / frames),
      trianglesPerFrame: Math.round(rt.info.triangles / frames),
      pointsPerFrame: Math.round(rt.info.points / frames),
      linesPerFrame: Math.round(rt.info.lines / frames),
      geometries: glr.info.memory.geometries,
      textures: glr.info.memory.textures,
      programs: glr.info.programs?.length ?? null,
    },
    gpuMs: rt.gpu.total > 0 ? { ...rt.gpu.summary(), disjoint: rt.gpuDisjoint } : null,
    longTasks: rt.longTasks,
    dioramas: st.dioramas,
  }
}

let running: Promise<unknown> | null = null

export async function runS1(opts: S1RunOptions = {}): Promise<Record<string, unknown>> {
  if (running) await running
  const job = (async () => {
    const durationMs = opts.durationMs ?? PATH_SECONDS * 1000
    const warmupMs = opts.warmupMs ?? 2000
    const path = opts.path ?? 'orbit'
    const label = opts.label ?? `${path}${opts.toggles ? ' ' + JSON.stringify(opts.toggles) : ''}`
    const st = useS1.getState()
    const before = st.toggles
    await waitForDioramas()
    st.set({ ...opts.toggles, path })
    st.setBench(label)
    // t = 0 lands where measurement starts; the warm-up runs the path at negative t, so
    // the camera is already moving (and Spark already sorting) when the counters reset.
    rt.pathStart = performance.now() + warmupMs
    await sleep(warmupMs)
    resetCounters()
    await sleep(durationMs)
    const result = collect(label, durationMs)
    rt.pathStart = -1
    useS1.getState().set({ ...before })
    useS1.getState().setBench(null)
    return result
  })()
  running = job
  try {
    return await job
  } finally {
    if (running === job) running = null
  }
}
