// Realistic worlds for the full-size physics tiers (scripts/accept-physics.ts and
// scripts/bench-physics.ts). Layout follows the app: anchor y = 12 u per year and
// birthStep = 600 steps per year (Y is time), anchors ≥ σ apart (the app's validation
// guarantees it), masses in [0.25, 4], temperatures in [0, 1]. Deterministic: every draw
// comes from the kernel's counter PRNG.

import { UNIT, invMassFromMass, tauFromUnit } from '../src/physics/fixed.ts'
import { createPairGrid, gridPairAccumulator } from '../src/physics/grid.ts'
import {
  type PairAccumulator,
  type ParticleSystem,
  createSystem,
  setParticle,
  stepBackwardFor,
  stepForwardFor,
} from '../src/physics/integrator.ts'
import { AMP_ONE, RAMP_STEPS, assertStable, makePhysicsParams } from '../src/physics/params.ts'
import { draw, fnv1a32 } from '../src/physics/rng.ts'
import { spawnNode } from '../src/physics/spawn.ts'
import type { WorldRecord } from '../src/physics/world.ts'

export const STEPS_PER_YEAR = 600
export const Y_PER_YEAR = 12
/** Minimum anchor separation: σ = 3 u plus a margin that survives Q.19 rounding. */
export const MIN_SEPARATION = 3 + 1e-3

const u01 = (h: number): number => (h >>> 8) / 2 ** 24

/** uuid-shaped deterministic id. */
export function fakeUuid(seed: number, i: number): string {
  const h = (k: number): string => draw((seed * 7919 + i) | 0, 900 + k).toString(16).padStart(8, '0')
  const a = h(0) + h(1) + h(2) + h(3)
  return `${a.slice(0, 8)}-${a.slice(8, 12)}-4${a.slice(13, 16)}-a${a.slice(17, 20)}-${a.slice(20, 32)}`
}

/**
 * Anchor points ≥ MIN_SEPARATION apart by random sequential addition in a box
 * [−w, w] × [y0, y1] × [−w, w]; `yOf(h)` maps a draw to a height (time) when given.
 */
function separatedPoints(
  n: number,
  seed: number,
  w: number,
  y0: number,
  y1: number,
): { x: number; y: number; z: number; h: number }[] {
  const cell = MIN_SEPARATION
  const grid = new Map<string, number[]>()
  const pts: { x: number; y: number; z: number; h: number }[] = []
  const key = (a: number, b: number, c: number) => `${a},${b},${c}`
  for (let k = 0; pts.length < n; k++) {
    if (k > 200 * n) throw new Error(`cannot place ${n} anchors ≥ σ apart in this box (density too high)`)
    const h = (j: number) => draw((seed * 104729 + k) | 0, 300 + j)
    const p = { x: w * (2 * u01(h(0)) - 1), y: y0 + (y1 - y0) * u01(h(1)), z: w * (2 * u01(h(2)) - 1), h: h(3) }
    const cx = Math.floor(p.x / cell)
    const cy = Math.floor(p.y / cell)
    const cz = Math.floor(p.z / cell)
    let ok = true
    for (let dx = -1; dx <= 1 && ok; dx++) {
      for (let dy = -1; dy <= 1 && ok; dy++) {
        for (let dz = -1; dz <= 1 && ok; dz++) {
          for (const q of grid.get(key(cx + dx, cy + dy, cz + dz)) ?? []) {
            const o = pts[q]
            if ((o.x - p.x) ** 2 + (o.y - p.y) ** 2 + (o.z - p.z) ** 2 < cell * cell) {
              ok = false
              break
            }
          }
        }
      }
    }
    if (!ok) continue
    const kk = key(cx, cy, cz)
    const list = grid.get(kk)
    if (list) list.push(pts.length)
    else grid.set(kk, [pts.length])
    pts.push(p)
  }
  return pts
}

export interface RecordOptions {
  readonly n: number
  readonly seed?: number
  /** Births spread over [0, years·600) steps; dates before 0 (preYears) clamp to step 0. */
  readonly years: number
  readonly preYears?: number
  /** XZ half-width of the anchor box in u. */
  readonly halfWidth: number
}

/** Main-world records: births spread over the span, y = 12 u/year, anchors ≥ σ apart. */
export function realisticRecords(opts: RecordOptions): WorldRecord[] {
  const seed = opts.seed ?? 1
  const pre = opts.preYears ?? 0
  const pts = separatedPoints(opts.n, seed, opts.halfWidth, -pre * Y_PER_YEAR, opts.years * Y_PER_YEAR)
  return pts.map((p, i) => {
    const h = (k: number) => draw(p.h, k)
    const t = p.y / Y_PER_YEAR
    return {
      id: fakeUuid(seed, i),
      anchor: [p.x, p.y, p.z],
      birthStep: Math.max(0, Math.floor(STEPS_PER_YEAR * t)),
      mass: 0.25 + 3.75 * u01(h(0)),
      temperature: u01(h(1)),
    }
  })
}

/** A birth-free lab world on the bare kernel: every ramp saturated at step 0, so K is n-independent. */
export interface LabWorld {
  readonly sys: ParticleSystem
  /** All slots, ascending (the active set never changes). */
  readonly list: Int32Array
  readonly n: number
  readonly ids: string[]
  readonly pairs: PairAccumulator
}

export interface LabOptions {
  readonly n: number
  readonly seed?: number
  /** Landscape amplitude (Q.8); the lab uses ≈ 6× AMP_ONE. */
  readonly amp?: number
  readonly halfWidth: number
  readonly height: number
}

/**
 * Lab: records quantised as world.ts does (anchor round(a·2^19), invMassFromMass,
 * tauFromUnit), spawned from fnv1a32(id), birth = −RAMP_STEPS (birth-free). world.ts
 * clamps births to ≥ 0, which would leave the initial pairs ramping for 120 steps.
 */
export function buildLab(opts: LabOptions): LabWorld {
  const seed = opts.seed ?? 7
  const params = makePhysicsParams({ seed: 0x5eed, landscapeAmp: opts.amp ?? 6 * AMP_ONE })
  const pts = separatedPoints(opts.n, seed, opts.halfWidth, 0, opts.height)
  const sys = createSystem(params, opts.n, 'node')
  const ids: string[] = []
  for (let i = 0; i < opts.n; i++) {
    const p = pts[i]
    const h = (k: number) => draw(p.h, k)
    const id = fakeUuid(seed + 1000, i)
    ids.push(id)
    sys.anchor[3 * i] = Math.round(p.x * UNIT) | 0
    sys.anchor[3 * i + 1] = Math.round(p.y * UNIT) | 0
    sys.anchor[3 * i + 2] = Math.round(p.z * UNIT) | 0
    setParticle(sys, i, invMassFromMass(0.25 + 3.75 * u01(h(0))), tauFromUnit(u01(h(1))), -RAMP_STEPS)
    spawnNode(sys, i, fnv1a32(id))
  }
  assertStable(params, sys.invMass, sys.tau)
  const list = Int32Array.from({ length: opts.n }, (_, i) => i)
  return { sys, list, n: opts.n, ids, pairs: gridPairAccumulator(createPairGrid(params.pairSigma, opts.n)) }
}

export function labForward(lab: LabWorld, step: number): void {
  stepForwardFor(lab.sys, step, lab.list, lab.n, lab.pairs)
}

export function labBackward(lab: LabWorld, step: number): void {
  stepBackwardFor(lab.sys, step, lab.list, lab.n, lab.pairs)
}

/** ISO date stamp for result files. */
export function dateStamp(): string {
  return new Date().toISOString().slice(0, 10)
}
