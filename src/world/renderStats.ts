import { create } from 'zustand'

// Render statistics for the HUD Stats panel and #/lab/perf.
//
// Two tiers, so the hot path never touches React:
// - `liveStats` is a mutable object written once per frame by the canvas collector
//   (HyperspaceCanvas). Read it imperatively (perf lab, devApi) whenever you like.
// - `useRenderStats` is a zustand snapshot published at PUBLISH_HZ for React consumers.
//   Subscribe with a selector (`useRenderStats((s) => s.calls)`), never the whole store.
//
// gl.info is cumulative for the whole frame because the canvas sets
// `gl.info.autoReset = false` and resets exactly once, after every pass (composer, Spark,
// reflector) has rendered. Without that, only the last fullscreen pass would be counted.

/** Frames kept for percentiles: ~5 s at 60 Hz, ~2.5 s at 120 Hz. */
export const FRAME_RING_SIZE = 300
const PUBLISH_HZ = 4

export interface FrameTimeSummary {
  p50: number
  p95: number
  p99: number
  max: number
  mean: number
}

export interface RenderStatsSnapshot {
  /** Draw calls in the last frame (all passes). */
  calls: number
  triangles: number
  points: number
  lines: number
  /** Live GPU resources (gl.info.memory). */
  geometries: number
  textures: number
  /** Compiled shader programs. */
  programs: number
  /** Wall-clock frame interval (rAF to rAF), ms. */
  frameMs: FrameTimeSummary
  /** CPU time from the first before-frame callback to the end of rendering, ms. */
  cpuMs: FrameTimeSummary
  fps: number
  /** Samples currently in the ring (≤ FRAME_RING_SIZE). */
  samples: number
  /** Total frames recorded since the last reset. */
  frames: number
}

interface MutableStats {
  calls: number
  triangles: number
  points: number
  lines: number
  geometries: number
  textures: number
  programs: number
  frames: number
}

const ZERO_SUMMARY: FrameTimeSummary = { p50: 0, p95: 0, p99: 0, max: 0, mean: 0 }

/** Per-frame counters, overwritten in place. */
export const liveStats: Readonly<MutableStats> = {
  calls: 0,
  triangles: 0,
  points: 0,
  lines: 0,
  geometries: 0,
  textures: 0,
  programs: 0,
  frames: 0,
}
const live = liveStats as MutableStats

const frameRing = new Float32Array(FRAME_RING_SIZE)
const cpuRing = new Float32Array(FRAME_RING_SIZE)
const scratch = new Float32Array(FRAME_RING_SIZE)
let ringHead = 0
let ringCount = 0
let lastFrameStamp = -1
let lastPublish = 0

export const useRenderStats = create<RenderStatsSnapshot>()(() => ({
  calls: 0,
  triangles: 0,
  points: 0,
  lines: 0,
  geometries: 0,
  textures: 0,
  programs: 0,
  frameMs: ZERO_SUMMARY,
  cpuMs: ZERO_SUMMARY,
  fps: 0,
  samples: 0,
  frames: 0,
}))

/** The subset of WebGLRenderer.info the collector reads (keeps this module renderer-agnostic). */
export interface RendererInfoLike {
  render: { calls: number; triangles: number; points: number; lines: number }
  memory: { geometries: number; textures: number }
  programs: readonly unknown[] | null
}

/**
 * Records one finished frame. `now` is performance.now() at the end of rendering and
 * `cpuMs` the CPU time spent producing the frame. Called by the canvas collector only.
 */
export function recordFrame(info: RendererInfoLike, now: number, cpuMs: number): void {
  live.calls = info.render.calls
  live.triangles = info.render.triangles
  live.points = info.render.points
  live.lines = info.render.lines
  live.geometries = info.memory.geometries
  live.textures = info.memory.textures
  live.programs = info.programs ? info.programs.length : 0
  live.frames++

  if (lastFrameStamp >= 0) {
    const dt = now - lastFrameStamp
    // A hidden tab pauses rAF; a multi-second gap is not a frame and would poison p99.
    if (dt < 1000) {
      frameRing[ringHead] = dt
      cpuRing[ringHead] = cpuMs
      ringHead = (ringHead + 1) % FRAME_RING_SIZE
      if (ringCount < FRAME_RING_SIZE) ringCount++
    }
  }
  lastFrameStamp = now

  if (now - lastPublish >= 1000 / PUBLISH_HZ) {
    lastPublish = now
    publishRenderStats()
  }
}

function summarize(ring: Float32Array): FrameTimeSummary {
  if (ringCount === 0) return ZERO_SUMMARY
  const view = scratch.subarray(0, ringCount)
  view.set(ring.subarray(0, ringCount))
  view.sort()
  let sum = 0
  for (let i = 0; i < ringCount; i++) sum += view[i]
  return {
    p50: pick(view, 0.5),
    p95: pick(view, 0.95),
    p99: pick(view, 0.99),
    max: view[ringCount - 1],
    mean: sum / ringCount,
  }
}

function pick(sorted: Float32Array, p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[i]
}

/** Computes percentiles now and pushes a snapshot to `useRenderStats`. */
export function publishRenderStats(): RenderStatsSnapshot {
  const frameMs = summarize(frameRing)
  const snap: RenderStatsSnapshot = {
    calls: live.calls,
    triangles: live.triangles,
    points: live.points,
    lines: live.lines,
    geometries: live.geometries,
    textures: live.textures,
    programs: live.programs,
    frameMs,
    cpuMs: summarize(cpuRing),
    fps: frameMs.mean > 0 ? 1000 / frameMs.mean : 0,
    samples: ringCount,
    frames: live.frames,
  }
  useRenderStats.setState(snap)
  return snap
}

/** Percentile (0..1) of recorded frame intervals in ms; 0 if empty. */
export function frameTimePercentile(p: number): number {
  if (ringCount === 0) return 0
  const view = scratch.subarray(0, ringCount)
  view.set(frameRing.subarray(0, ringCount))
  view.sort()
  return pick(view, p)
}

/** Copies the recorded frame intervals (oldest first) into `out`, returning the filled view. */
export function readFrameTimes(out: Float32Array = new Float32Array(FRAME_RING_SIZE)): Float32Array {
  const n = Math.min(ringCount, out.length)
  const start = (ringHead - n + FRAME_RING_SIZE) % FRAME_RING_SIZE
  for (let i = 0; i < n; i++) out[i] = frameRing[(start + i) % FRAME_RING_SIZE]
  return out.subarray(0, n)
}

/** Clears the frame-time rings (e.g. at the start of a perf-lab capture). */
export function resetFrameTimes(): void {
  ringHead = 0
  ringCount = 0
  lastFrameStamp = -1
  live.frames = 0
}
