// Shared test fixtures: a realistic node world built from a seed, integer-only.

import { UNIT, invMassFromMass } from '../../src/physics/fixed.ts'
import { type ParticleSystem, createSystem, setParticle } from '../../src/physics/integrator.ts'
import { type PhysicsParams, RAMP_STEPS, makePhysicsParams } from '../../src/physics/params.ts'
import { draw, uniformBelow } from '../../src/physics/rng.ts'
import { spawnDust, spawnNode } from '../../src/physics/spawn.ts'

export interface WorldOptions {
  readonly n: number
  readonly seed?: number
  /** Half-width of the anchor box in XZ, in u. */
  readonly halfWidth?: number
  /** Anchor height range in u (12 u = one year). */
  readonly height?: number
  /** Births are drawn in [0, maxBirth]; omitted = birth-free (every ramp saturated at step 0). */
  readonly maxBirth?: number
  readonly params?: PhysicsParams
  readonly pairs?: boolean
}

/** Anchors in a (2w)² × height box, mass uniform in [0.25, 4], τ = T uniform in [0, 1). */
export function makeNodeWorld(opts: WorldOptions): ParticleSystem {
  const seed = opts.seed ?? 1
  const params = opts.params ?? makePhysicsParams({ seed: 0x5eed })
  const sys = createSystem(params, opts.n, 'node')
  sys.pairs = opts.pairs ?? true
  const w = opts.halfWidth ?? 15
  const ht = opts.height ?? 12
  for (let i = 0; i < opts.n; i++) {
    const h = (k: number) => draw((seed * 7919 + i) | 0, 100 + k)
    sys.anchor[3 * i] = Math.imul(uniformBelow(h(0), 2 * w * 1024) - w * 1024, UNIT >> 10)
    sys.anchor[3 * i + 1] = Math.imul(uniformBelow(h(1), ht * 512), UNIT >> 9)
    sys.anchor[3 * i + 2] = Math.imul(uniformBelow(h(2), 2 * w * 1024) - w * 1024, UNIT >> 10)
    const mass = 0.25 + (3.75 * (h(3) >>> 8)) / 2 ** 24
    const tau = uniformBelow(h(4), 32768)
    const birth = opts.maxBirth ? uniformBelow(h(5), opts.maxBirth + 1) : -RAMP_STEPS
    setParticle(sys, i, invMassFromMass(mass), tau, birth)
    spawnNode(sys, i, h(6))
  }
  return sys
}

export function makeDustWorld(n: number, seed = 3, params?: PhysicsParams): ParticleSystem {
  const sys = createSystem(params ?? makePhysicsParams({ seed: 0x5eed }), n, 'dust')
  for (let i = 0; i < n; i++) {
    const owner = i >> 6
    sys.anchor[3 * i] = Math.imul(uniformBelow(draw(seed, 3 * owner), 30 * 1024) - 15 * 1024, UNIT >> 10)
    sys.anchor[3 * i + 1] = Math.imul(uniformBelow(draw(seed, 3 * owner + 1), 12 * 1024), UNIT >> 10)
    sys.anchor[3 * i + 2] = Math.imul(uniformBelow(draw(seed, 3 * owner + 2), 30 * 1024) - 15 * 1024, UNIT >> 10)
    spawnDust(sys, i, draw(seed ^ 0xd057, i))
  }
  return sys
}

export function cloneState(sys: ParticleSystem): { x: Int32Array; d: Int32Array } {
  return { x: sys.x.slice(), d: sys.d.slice() }
}

/** Deterministic test PRNG (not part of the kernel). */
export function testRng(seed: number): () => number {
  let k = 0
  return () => draw(seed, k++)
}
