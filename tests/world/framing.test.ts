import { describe, expect, it } from 'vitest'
import { HELIX_PITCH } from '../../src/domain/constants.ts'
import { RADIAL_JITTER, RING_RADIUS } from '../../src/domain/placement.ts'
import { PERISTYLE_RADIUS, STOA_YEARS, buildArchitecture, type BoxInst } from '../../src/world/environment/layout.ts'
import { FAR_SCALE, farScale } from '../../src/world/nodes/instancing.ts'

// The nodes are the hero of the world: architecture must frame the node rings, never stand
// in them, and nodes must keep a readable apparent size from a wide shot.

const OUTER_NODE_R = Math.max(...Object.values(RING_RADIUS)) + RADIAL_JITTER
/** Clear air between the outermost node ring and any architecture. */
const CLEARANCE = 20

/** Closest horizontal distance from the world axis to a box's footprint (YXZ: tilt ignored). */
function footprintDistance(b: BoxInst): number {
  const ry = b.ry ?? 0
  // World → box-local: undo the translation, then the rotation about y.
  const dx = -b.p[0]
  const dz = -b.p[2]
  const c = Math.cos(ry)
  const s = Math.sin(ry)
  const lx = c * dx - s * dz
  const lz = s * dx + c * dz
  const qx = Math.max(Math.abs(lx) - b.s[0] / 2, 0)
  const qz = Math.max(Math.abs(lz) - b.s[2] / 2, 0)
  return Math.hypot(qx, qz)
}

describe('architecture frames the node rings', () => {
  const helixTop = 40 * HELIX_PITCH
  const arch = buildArchitecture(helixTop, HELIX_PITCH)

  it('keeps every column and pylon outside the outermost node ring', () => {
    expect(PERISTYLE_RADIUS).toBeGreaterThan(OUTER_NODE_R + CLEARANCE)
    for (const sh of arch.shafts) expect(Math.hypot(sh.x, sh.z) - sh.radius).toBeGreaterThan(OUTER_NODE_R + CLEARANCE)
  })

  it('keeps every slab, beam and monolith footprint outside the node rings', () => {
    for (const b of arch.boxes) expect(footprintDistance(b)).toBeGreaterThan(OUTER_NODE_R + CLEARANCE)
  })

  it('caps the colonnade ring low; only a few free-standing pylons rise above it', () => {
    const stoaTop = STOA_YEARS * HELIX_PITCH
    const tall = arch.shafts.filter((s) => s.y0 + s.height > stoaTop + 1)
    expect(tall.length).toBeGreaterThan(0)
    expect(tall.length).toBeLessThanOrEqual(arch.shafts.length / 3)
  })
})

describe('farScale', () => {
  it('is the true size near the camera', () => {
    expect(farScale(0)).toBe(1)
    expect(farScale(FAR_SCALE.near)).toBe(1)
  })

  it('grows monotonically with distance and is capped', () => {
    let prev = 1
    for (let d = 0; d <= 1000; d += 5) {
      const s = farScale(d)
      expect(s).toBeGreaterThanOrEqual(prev)
      expect(s).toBeLessThanOrEqual(FAR_SCALE.max)
      prev = s
    }
    expect(farScale(1e6)).toBe(FAR_SCALE.max)
  })

  it('keeps a 2.4 u tesseract at least 36 px tall in a 768 px, 50° view from 100–200 u', () => {
    const pxPerUnit = (d: number) => 768 / (2 * d * Math.tan((25 * Math.PI) / 180))
    for (const d of [100, 150, 200]) expect(2.4 * farScale(d) * pxPerUnit(d)).toBeGreaterThan(36)
  })
})
