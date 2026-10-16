import { catmullRom, sampleCount } from '../../world/worldline/path.ts'

// The scripted camera of #/lab/perf: an establishing shot, then a pass by each fixture
// memory in date order, then the present. Keyframes come from the world's static anchors
// (deterministic for the fixed fixture world); position and look target each follow a
// centripetal Catmull–Rom curve, timed uniformly per segment with an eased start and end.

export type V3 = [number, number, number]

export interface CameraKey {
  readonly pos: V3
  readonly target: V3
}

export interface PathMemory {
  /** Static anchor (x, y = date height, z). */
  readonly anchor: V3
}

const PER_SEGMENT = 96

const smoother = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (6 * x - 15) + 10))

/** Keyframes for the perf ride through `memories` (date order) in a column of height yNow. */
export function perfKeyframes(memories: readonly PathMemory[], yNow: number): CameraKey[] {
  const h = Math.max(24, yNow)
  const keys: CameraKey[] = [{ pos: [95, 0.55 * h + 60, 95], target: [0, 0.45 * h, 0] }]
  if (memories.length === 0) {
    // No memories: a descending half-spiral around the column.
    for (let k = 1; k <= 4; k++) {
      const a = (k / 4) * Math.PI
      keys.push({ pos: [55 * Math.cos(a), h * (1 - k / 5), 55 * Math.sin(a)], target: [0, h * (1 - k / 5) - 6, 0] })
    }
  }
  for (const m of memories) {
    const [x, y, z] = m.anchor
    const r = Math.hypot(x, z)
    // Outward from the column axis (or +x on the axis), lifted, a little to the side.
    const ox = r > 1e-3 ? x / r : 1
    const oz = r > 1e-3 ? z / r : 0
    const d = 13
    keys.push({ pos: [x + ox * d - oz * 5, y + 5, z + oz * d + ox * 5], target: [x, y, z] })
  }
  keys.push({ pos: [-75, h + 28, 45], target: [0, h - 18, 0] })
  return keys
}

export class CameraPath {
  readonly duration: number
  private readonly pos: Float32Array
  private readonly target: Float32Array
  private readonly count: number

  constructor(keys: readonly CameraKey[], duration: number) {
    if (keys.length < 2) throw new Error('a camera path needs two keyframes')
    this.duration = duration
    const n = keys.length
    const p = new Float64Array(3 * n)
    const t = new Float64Array(3 * n)
    keys.forEach((k, i) => {
      p.set(k.pos, 3 * i)
      t.set(k.target, 3 * i)
    })
    this.pos = catmullRom(p, n, PER_SEGMENT)
    this.target = catmullRom(t, n, PER_SEGMENT)
    this.count = sampleCount(n, PER_SEGMENT)
  }

  /** Camera position and look target at time t (s), clamped to [0, duration]. */
  at(t: number, pos: { set(x: number, y: number, z: number): unknown }, target: { set(x: number, y: number, z: number): unknown }): void {
    const u = smoother(Math.min(1, Math.max(0, t / this.duration)))
    const f = u * (this.count - 1)
    const i = Math.min(this.count - 2, Math.floor(f))
    const w = f - i
    const P = this.pos
    const T = this.target
    const o = 3 * i
    pos.set(P[o] + w * (P[o + 3] - P[o]), P[o + 1] + w * (P[o + 4] - P[o + 1]), P[o + 2] + w * (P[o + 5] - P[o + 2]))
    target.set(T[o] + w * (T[o + 3] - T[o]), T[o + 1] + w * (T[o + 4] - T[o + 1]), T[o + 2] + w * (T[o + 5] - T[o + 2]))
  }
}
