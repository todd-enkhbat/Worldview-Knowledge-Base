import type { Camera, WebGLRenderer } from 'three'
import type { SparkRenderer } from '@sparkjsdev/spark'
import { EventTimes } from './metrics.ts'

// Instrumentation hooks on the one SparkRenderer and the GL context. Spark exposes no
// timing, so the probe wraps a few of its (TS-private, JS-public) methods:
// - sorting (a field, trapped with a setter): true → false spans one sort, covering the
//   1 ms readPause, the depth readback, the worker sort and the ordering upload;
// - driveLodExclusive: one LoD traversal on the LoD worker;
// - onBeforeRender: counts which cameras draw the splats (the reflector must not).
// and two GL entry points, because the depth readback's synchronous cost (#407) lives in
// readPixels (into a PBO) and getBufferSubData, both of which run outside the rAF frame.

type AnyFn = (...args: never[]) => unknown
interface SparkInternals {
  driveLodExclusive: (...args: unknown[]) => Promise<void>
  display: { version: number; numSplats: number }
  current: { numSplats: number }
}

export interface SparkProbe {
  sorts: EventTimes
  lodTraversals: EventTimes
  readPixels: EventTimes
  getBufferSubData: EventTimes
  /** onBeforeRender calls this frame, by camera kind. */
  drawsMain: number
  drawsOther: number
  /** Cumulative since reset: frames on which a non-main camera drew splats. */
  leakFrames: number
  sortsSinceFrame: number
  lodSinceFrame: number
  lastDisplayVersion: number
  reset(): void
  dispose(): void
}

export function attachSparkProbe(spark: SparkRenderer, gl: WebGLRenderer, isMainCamera: (c: Camera) => boolean): SparkProbe {
  const s = spark as unknown as SparkInternals
  const probe: SparkProbe = {
    sorts: new EventTimes(),
    lodTraversals: new EventTimes(),
    readPixels: new EventTimes(),
    getBufferSubData: new EventTimes(),
    drawsMain: 0,
    drawsOther: 0,
    leakFrames: 0,
    sortsSinceFrame: 0,
    lodSinceFrame: 0,
    lastDisplayVersion: -1,
    reset() {
      this.sorts.reset()
      this.lodTraversals.reset()
      this.readPixels.reset()
      this.getBufferSubData.reset()
      this.leakFrames = 0
    },
    dispose: () => undefined,
  }

  // `sorting` flips true when a sort starts (before the readback) and false once the new
  // ordering is uploaded; driveSort re-enters itself at the end, so timing the call
  // would measure the next sort's start instead.
  let sorting = spark.sorting
  let sortStart = 0
  Object.defineProperty(spark, 'sorting', {
    configurable: true,
    get: () => sorting,
    set: (v: boolean) => {
      if (v && !sorting) sortStart = performance.now()
      if (!v && sorting) {
        probe.sorts.push(performance.now() - sortStart)
        probe.sortsSinceFrame++
      }
      sorting = v
    },
  })

  const origLod = s.driveLodExclusive
  s.driveLodExclusive = async function (this: SparkInternals, ...args: unknown[]) {
    const t0 = performance.now()
    await origLod.apply(this, args)
    probe.lodTraversals.push(performance.now() - t0)
    probe.lodSinceFrame++
  }

  const origOBR = spark.onBeforeRender
  spark.onBeforeRender = function (this: SparkRenderer, ...args: Parameters<SparkRenderer['onBeforeRender']>) {
    if (isMainCamera(args[2])) probe.drawsMain++
    else probe.drawsOther++
    return origOBR.apply(this, args)
  }

  const ctx = gl.getContext() as WebGL2RenderingContext & Record<string, AnyFn>
  const origRead = ctx.readPixels
  const origGet = ctx.getBufferSubData
  const timed = (fn: AnyFn, sink: EventTimes) =>
    function (this: unknown, ...a: never[]) {
      const t0 = performance.now()
      const r = fn.apply(this, a)
      sink.push(performance.now() - t0)
      return r
    }
  ctx.readPixels = timed(origRead as AnyFn, probe.readPixels) as typeof ctx.readPixels
  ctx.getBufferSubData = timed(origGet as AnyFn, probe.getBufferSubData) as typeof ctx.getBufferSubData

  probe.dispose = () => {
    Object.defineProperty(spark, 'sorting', { configurable: true, writable: true, enumerable: true, value: sorting })
    s.driveLodExclusive = origLod
    spark.onBeforeRender = origOBR
    ctx.readPixels = origRead
    ctx.getBufferSubData = origGet
  }
  return probe
}

export function sparkCounts(spark: SparkRenderer): { active: number; generated: number; displayVersion: number } {
  const s = spark as unknown as SparkInternals
  return { active: spark.activeSplats, generated: s.display?.numSplats ?? 0, displayVersion: s.display?.version ?? -1 }
}
