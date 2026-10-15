import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, LineBasicMaterial, LineSegments } from 'three'
import { useWorld } from '../../app/store.ts'
import { DEMON, rampWeight } from '../../overlay/demon.ts'
import { getDemonPlan, getOverlayFields } from '../../overlay/index.ts'
import { LAYER, RENDER_ORDER } from '../layers.ts'
import { capacityFor } from '../nodes/instancing.ts'
import { getPoseTable } from '../poses.ts'

// The demon lattice: for every active demon, a square cell at the demon's height for each
// occupied slot, and a plumb line from the cell down (or up) to the sorted node, which keeps
// its own date. Brightness follows the easing weight w(t), so the lattice draws itself as
// the nodes slide in after an activation.

const HALF = 0.42 * DEMON.SPACING
/** Segments per occupied slot: 4 cell edges + 1 plumb line. */
const SEGS = 5
const SIGNAL = new Color('#ff4a1c')

function makeLines(capacity: number, material: LineBasicMaterial): LineSegments {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(capacity * SEGS * 6), 3).setUsage(DynamicDrawUsage))
  g.setAttribute('color', new BufferAttribute(new Float32Array(capacity * SEGS * 6), 3).setUsage(DynamicDrawUsage))
  g.setDrawRange(0, 0)
  const lines = new LineSegments(g, material)
  lines.name = 'demon-lattice'
  lines.layers.set(LAYER.DUST)
  lines.renderOrder = RENDER_ORDER.DUST
  lines.frustumCulled = false
  return lines
}

export function DemonLattice() {
  const nodes = useWorld((s) => s.nodes)
  const settings = useWorld((s) => s.settings)
  // Re-plan only when records or settings change; the plan is cached in overlay/index.ts.
  const slots = useMemo(() => (nodes && settings ? getDemonPlan().assignments.size : 0), [nodes, settings])
  const material = useMemo(() => new LineBasicMaterial({ vertexColors: true, toneMapped: false }), [])
  useEffect(() => () => material.dispose(), [material])
  const capacity = capacityFor(Math.max(1, slots))
  const lines = useMemo(() => makeLines(capacity, material), [capacity, material])
  useEffect(() => () => lines.geometry.dispose(), [lines])

  useFrame(() => {
    const t = Date.now()
    const f = getOverlayFields(t)
    const table = getPoseTable()
    const P = (lines.geometry.getAttribute('position') as BufferAttribute).array as Float32Array
    const C = (lines.geometry.getAttribute('color') as BufferAttribute).array as Float32Array
    let v = 0
    const seg = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, k: number) => {
      const o = v * 3
      P[o] = x0
      P[o + 1] = y0
      P[o + 2] = z0
      P[o + 3] = x1
      P[o + 4] = y1
      P[o + 5] = z1
      C[o] = C[o + 3] = SIGNAL.r * k
      C[o + 1] = C[o + 4] = SIGNAL.g * k
      C[o + 2] = C[o + 5] = SIGNAL.b * k
      v += 2
    }
    let used = 0
    for (const [id, a] of f.plan.assignments) {
      if (used >= capacity) break
      const drow = table.index.get(a.demonId)
      const row = table.index.get(id)
      if (drow === undefined || row === undefined) continue
      const w = rampWeight(t, f.activation.get(a.demonId) ?? null)
      if (w <= 0) continue
      const dx = table.pos[drow * 3]
      const dy = table.pos[drow * 3 + 1]
      const dz = table.pos[drow * 3 + 2]
      const sx = dx + a.dx
      const sz = dz + a.dz
      const ny = table.pos[row * 3 + 1]
      const k = 0.35 + 1.4 * w
      seg(sx - HALF, dy, sz - HALF, sx + HALF, dy, sz - HALF, k)
      seg(sx + HALF, dy, sz - HALF, sx + HALF, dy, sz + HALF, k)
      seg(sx + HALF, dy, sz + HALF, sx - HALF, dy, sz + HALF, k)
      seg(sx - HALF, dy, sz + HALF, sx - HALF, dy, sz - HALF, k)
      seg(sx, dy, sz, sx, ny, sz, 0.5 * k)
      used++
    }
    lines.geometry.setDrawRange(0, v)
    lines.geometry.getAttribute('position').needsUpdate = true
    lines.geometry.getAttribute('color').needsUpdate = true
  }, -1)

  return <primitive object={lines} />
}
