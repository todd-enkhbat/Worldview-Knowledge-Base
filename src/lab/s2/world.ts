// The S2 test world: realistic radial-burst dust spawns around owner anchors spread
// over the world, in 64-texel segments (the PLAN's dust allocation unit). Pure integer
// code, so the node tests and the lab build the identical world.

import { Y_PER_YEAR } from '../../domain/constants.ts'
import { UNIT } from '../../physics/fixed.ts'
import { type ParticleSystem, createSystem } from '../../physics/integrator.ts'
import { type PhysicsParams, makePhysicsParams } from '../../physics/params.ts'
import { draw, fnv1a32, uniformBelow } from '../../physics/rng.ts'
import { spawnDust } from '../../physics/spawn.ts'

export const DUST_SEGMENT = 64

export interface S2WorldOptions {
  readonly n: number
  readonly seed?: number
  readonly params?: PhysicsParams
}

/** A Q.19 coordinate in [lo, hi) u (hi − lo ≤ 2^15): whole units from the top bits, LSBs from the low bits. */
function coord(h: number, lo: number, hi: number): number {
  return (lo * UNIT + Math.imul(uniformBelow(h, hi - lo), UNIT) + (h & (UNIT - 1))) | 0
}

/**
 * Owners (one per 64-particle segment):
 *  - 2 at the torus seam (|x| ≈ 4096 u), so X − A and X itself wrap mod 2^32;
 *  - 1 in 8 anywhere on the ±4096 u torus in XZ (large phases, every LUT region);
 *  - the rest in a realistic world: ±64 u in XZ and 40 years of Y.
 */
export function ownerAnchor(owner: number, seed: number, out: Int32Array, o: number): void {
  const h = (k: number) => draw((seed ^ Math.imul(owner, 0x9e3779b9)) | 0, k)
  if (owner < 2) {
    const edge = 4096 * UNIT - 1 - (h(0) & 0xffff)
    out[o] = owner === 0 ? edge : -edge
    out[o + 1] = coord(h(1), 0, 40 * Y_PER_YEAR)
    out[o + 2] = owner === 0 ? -edge : edge
  } else if ((h(3) & 7) === 0) {
    out[o] = h(0) | 0
    out[o + 1] = coord(h(1), -2048, 2048)
    out[o + 2] = h(2) | 0
  } else {
    out[o] = coord(h(0), -64, 64)
    out[o + 1] = coord(h(1), 0, 40 * Y_PER_YEAR)
    out[o + 2] = coord(h(2), -64, 64)
  }
}

export function makeS2DustWorld(opts: S2WorldOptions): ParticleSystem {
  const seed = opts.seed ?? 0x52
  const params = opts.params ?? makePhysicsParams({ seed: 0x5eed })
  const sys = createSystem(params, opts.n, 'dust')
  const a = new Int32Array(3)
  for (let i = 0; i < opts.n; i++) {
    const owner = Math.floor(i / DUST_SEGMENT)
    if (i % DUST_SEGMENT === 0) ownerAnchor(owner, seed, a, 0)
    sys.anchor[3 * i] = a[0]
    sys.anchor[3 * i + 1] = a[1]
    sys.anchor[3 * i + 2] = a[2]
    // Per-particle spawn seed as in the app: the owner id hash keyed by slot.
    spawnDust(sys, i, draw(fnv1a32(`s2-owner-${seed}-${owner}`), i % DUST_SEGMENT))
  }
  return sys
}
