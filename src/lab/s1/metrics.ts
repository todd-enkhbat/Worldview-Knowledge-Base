// Frame-time instrumentation for the S1 spike.
//
// Two numbers per frame, kept in fixed ring buffers so recording never allocates:
// - interval: rAF-to-rAF wall time (what the user perceives as smoothness);
// - main: main-thread time inside the frame callback, from the first useFrame callback to
//   the end of the last render call (Spark's generate/sort kick, reflector, composer).
// Flags tag frames (tween active, sort landed, display swapped) so a run can split its
// percentiles by condition instead of needing a separate run per condition.

export const RING = 8192

export const FLAG = {
  TWEEN: 1,
  SORT_DONE: 2,
  DISPLAY_SWAP: 4,
  LOD_TRAVERSE: 8,
} as const

export interface Percentiles {
  n: number
  mean: number
  p50: number
  p95: number
  p99: number
  max: number
}

export class FrameRing {
  readonly interval = new Float32Array(RING)
  readonly main = new Float32Array(RING)
  readonly flags = new Uint8Array(RING)
  head = 0
  count = 0
  private lastStamp = -1

  reset(): void {
    this.head = 0
    this.count = 0
    this.lastStamp = -1
  }

  /** `stamp` is the frame-begin time; the first frame after a reset has no interval. */
  push(stamp: number, mainMs: number, flags: number): void {
    if (this.lastStamp < 0) {
      this.lastStamp = stamp
      return
    }
    this.interval[this.head] = stamp - this.lastStamp
    this.main[this.head] = mainMs
    this.flags[this.head] = flags
    this.lastStamp = stamp
    this.head = (this.head + 1) % RING
    if (this.count < RING) this.count++
  }

  /** Values of `which` for frames matching (flags & mask) === want, oldest first. */
  select(which: 'interval' | 'main', mask = 0, want = 0, last = this.count): Float32Array {
    const src = this[which]
    const n = Math.min(last, this.count)
    const out = new Float32Array(n)
    let k = 0
    for (let i = 0; i < n; i++) {
      const idx = (this.head - n + i + RING) % RING
      if ((this.flags[idx] & mask) === want) out[k++] = src[idx]
    }
    return out.subarray(0, k)
  }

  flagCount(flag: number, last = this.count): number {
    const n = Math.min(last, this.count)
    let c = 0
    for (let i = 0; i < n; i++) if (this.flags[(this.head - n + i + RING) % RING] & flag) c++
    return c
  }
}

export function percentiles(values: Float32Array): Percentiles {
  const n = values.length
  if (n === 0) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 }
  const s = Float32Array.from(values).sort()
  let sum = 0
  for (let i = 0; i < n; i++) sum += s[i]
  const at = (q: number) => s[Math.min(n - 1, Math.floor(q * n))]
  return { n, mean: round2(sum / n), p50: round2(at(0.5)), p95: round2(at(0.95)), p99: round2(at(0.99)), max: round2(s[n - 1]) }
}

/**
 * The display's refresh period, estimated from the intervals themselves: the common
 * refresh rate whose ±15 % window holds the most intervals (the mode). A low percentile
 * snapped to a rate fails at 120 Hz, where catch-up frames of ~7 ms pull it to 144 Hz.
 */
export function estimateVsync(intervals: Float32Array): number {
  if (intervals.length < 10) return 1000 / 60
  const rates = [240, 165, 144, 120, 100, 90, 75, 60, 50, 48, 30]
  let best = 60
  let bestCount = -1
  for (const hz of rates) {
    const t = 1000 / hz
    let c = 0
    for (let i = 0; i < intervals.length; i++) if (Math.abs(intervals[i] - t) <= 0.15 * t) c++
    if (c > bestCount) {
      best = hz
      bestCount = c
    }
  }
  return 1000 / best
}

export function shareAbove(values: Float32Array, threshold: number): number {
  if (values.length === 0) return 0
  let c = 0
  for (let i = 0; i < values.length; i++) if (values[i] > threshold) c++
  return Math.round((c / values.length) * 10000) / 10000
}

/** Small timing accumulator for events that happen off the frame (sorts, readbacks). */
export class EventTimes {
  private values: number[] = []
  total = 0
  push(ms: number): void {
    this.total++
    this.values.push(ms)
    if (this.values.length > 4096) this.values.splice(0, this.values.length - 4096)
  }
  reset(): void {
    this.values = []
    this.total = 0
  }
  summary(): Percentiles {
    return percentiles(Float32Array.from(this.values))
  }
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100
}
