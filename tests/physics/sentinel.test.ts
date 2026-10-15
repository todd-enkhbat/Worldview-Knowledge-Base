import { describe, expect, it } from 'vitest'
import { UNIT, invMassFromMass } from '../../src/physics/fixed.ts'
import { computeKicks, createSystem, overflowSentinel } from '../../src/physics/integrator.ts'
import { RAMP_STEPS, makePhysicsParams } from '../../src/physics/params.ts'

// A node buried in a dense same-side cluster: the per-node impulse sum wraps i32 once
// ~250 neighbours push the same way. The wrap is reversible but physically wrong, so the
// runtime sentinel (criterion B) must see it even though no tether saturates.
function cluster(m: number) {
  const sys = createSystem(makePhysicsParams({ seed: 0x5eed }), m + 1, 'node')
  const r = Math.round((3 / Math.sqrt(5)) * UNIT)
  for (let i = 0; i <= m; i++) {
    const o = 3 * i
    if (i > 0) {
      // 0.4 u patch on +x at r = σ/√5, deterministic jitter
      sys.anchor[o] = r + ((i * 7919) % 41) * (UNIT / 100) - (UNIT / 5)
      sys.anchor[o + 1] = ((i * 104729) % 41) * (UNIT / 100) - (UNIT / 5)
      sys.anchor[o + 2] = ((i * 1299709) % 41) * (UNIT / 100) - (UNIT / 5)
    }
    sys.x.set(sys.anchor.subarray(o, o + 3), o)
    sys.invMass[i] = invMassFromMass(1)
    sys.birth[i] = -RAMP_STEPS
  }
  computeKicks(sys, 0)
  return sys
}

describe('overflow sentinel', () => {
  it('stays 0 for a moderate cluster', () => {
    const sys = cluster(50)
    expect(sys.impulseWraps).toBe(0)
    expect(overflowSentinel(sys)).toBe(0)
  })

  it('counts a wrapped impulse sum even when no tether saturates', () => {
    const sys = cluster(320)
    expect(sys.saturations).toBe(0)
    expect(sys.impulseWraps).toBeGreaterThan(0)
    expect(overflowSentinel(sys)).toBeGreaterThan(0)
  })
})
