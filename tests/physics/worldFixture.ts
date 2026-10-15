// Deterministic WorldRecord sets for the world/clock/grid tests and the bench. The
// layout follows the real world: anchor y = 12 u per year and birthStep = 600 per year
// (Y is time), so births correlate with height. Records dated before T0 clamp to step 0.

import type { WorldRecord } from '../../src/physics/world.ts'
import { draw } from '../../src/physics/rng.ts'

export interface RecordOptions {
  readonly n: number
  readonly seed?: number
  /** Dates span [-preYears, years) in years; births before 0 clamp to step 0. */
  readonly years?: number
  readonly preYears?: number
  /** XZ half-width of the anchor box in u. */
  readonly halfWidth?: number
}

const u01 = (h: number): number => (h >>> 8) / 2 ** 24

/** uuid-shaped deterministic id. */
export function fakeId(seed: number, i: number): string {
  const h = (k: number): string => draw((seed * 7919 + i) | 0, 900 + k).toString(16).padStart(8, '0')
  const a = h(0) + h(1) + h(2) + h(3)
  return `${a.slice(0, 8)}-${a.slice(8, 12)}-4${a.slice(13, 16)}-a${a.slice(17, 20)}-${a.slice(20, 32)}`
}

export function makeRecords(opts: RecordOptions): WorldRecord[] {
  const seed = opts.seed ?? 1
  const years = opts.years ?? 5
  const pre = opts.preYears ?? years
  const w = opts.halfWidth ?? 15
  const out: WorldRecord[] = []
  for (let i = 0; i < opts.n; i++) {
    const h = (k: number) => draw((seed * 104729 + i) | 0, 200 + k)
    const t = -pre + (years + pre) * u01(h(0))
    out.push({
      id: fakeId(seed, i),
      anchor: [w * (2 * u01(h(1)) - 1), 12 * t, w * (2 * u01(h(2)) - 1)],
      birthStep: Math.floor(600 * t),
      mass: 0.25 + 3.75 * u01(h(3)),
      temperature: u01(h(4)),
    })
  }
  return out
}

/** Fisher–Yates with the kernel's counter PRNG (deterministic). */
export function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const out = xs.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.imul(draw(seed, i) >>> 16, i + 1) >>> 16
    const t = out[i]
    out[i] = out[j]
    out[j] = t
  }
  return out
}
