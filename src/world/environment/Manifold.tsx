import { Suspense, useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  BufferGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  MeshStandardMaterial,
  TorusGeometry,
  type Group,
} from 'three'
import { LAYER } from '../layers.ts'
import type { PathGraph } from '../paths.ts'
import { Engraved } from './Labels.tsx'
import { inwardLabel } from './layout.ts'
import { PALETTE, hdr } from './materials.ts'

// The torus manifold (T²), the stand-in for the Calabi–Yau piece that ships later: a polished
// obsidian torus with ember coordinate lines, slowly turning outside the colonnade, hung at the
// Present height so it is in view from the Present landing.

export const MANIFOLD_MAJOR = 16
export const MANIFOLD_MINOR = 4.6
/** Outside the colonnade and its pylons (r 96 + 2.9) for any spin: 121 − (16 + 4.6) = 100.4. */
const MANIFOLD_DISTANCE = 121

/** Meridians and parallels of a torus, as line segments. */
export function createTorusGridGeometry(R: number, r: number, meridians = 24, parallels = 8, seg = 96): BufferGeometry {
  const pts: number[] = []
  const at = (u: number, v: number): [number, number, number] => [
    (R + r * Math.cos(v)) * Math.cos(u),
    (R + r * Math.cos(v)) * Math.sin(u),
    r * Math.sin(v),
  ]
  for (let i = 0; i < meridians; i++) {
    const u = (i / meridians) * Math.PI * 2
    for (let j = 0; j < seg / 2; j++) {
      pts.push(...at(u, (j / (seg / 2)) * Math.PI * 2), ...at(u, ((j + 1) / (seg / 2)) * Math.PI * 2))
    }
  }
  for (let i = 0; i < parallels; i++) {
    const v = (i / parallels) * Math.PI * 2
    for (let j = 0; j < seg; j++) {
      pts.push(...at((j / seg) * Math.PI * 2, v), ...at(((j + 1) / seg) * Math.PI * 2, v))
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pts, 3))
  return g
}

export function Manifold({ graph }: { graph: PathGraph }) {
  const spin = useRef<Group>(null)
  const res = useMemo(
    () => ({
      torus: new TorusGeometry(MANIFOLD_MAJOR, MANIFOLD_MINOR, 64, 192),
      grid: createTorusGridGeometry(MANIFOLD_MAJOR, MANIFOLD_MINOR * 1.004),
      body: new MeshStandardMaterial({ color: '#16161a', metalness: 1, roughness: 0.16, envMapIntensity: 1.4 }),
      lines: new LineBasicMaterial({ color: hdr(PALETTE.ember, 1.5), toneMapped: false }),
    }),
    [],
  )
  useEffect(
    () => () => {
      res.torus.dispose()
      res.grid.dispose()
      res.body.dispose()
      res.lines.dispose()
    },
    [res],
  )

  const p = graph.present
  const a = p.angle
  const y = Math.max(p.y + 22, 34)
  const pos: [number, number, number] = [MANIFOLD_DISTANCE * Math.cos(a), y, MANIFOLD_DISTANCE * Math.sin(a)]
  const label = useMemo(
    () => inwardLabel(a, MANIFOLD_DISTANCE - MANIFOLD_MINOR - 2, y - MANIFOLD_MAJOR - MANIFOLD_MINOR - 4),
    [a, y],
  )

  useFrame((_, dt) => {
    const g = spin.current
    if (!g) return
    g.rotation.z += dt * 0.07
    g.rotation.x = 0.9 + Math.sin(g.rotation.z * 0.37) * 0.12
  })

  return (
    <group>
      {/* Face the core so the ring opens towards the catwalk. */}
      <group position={pos} rotation={[0, -a + Math.PI / 2, 0]}>
        <group ref={spin}>
          <mesh geometry={res.torus} material={res.body} layers={LAYER.SOLID} />
          <lineSegments geometry={res.grid} material={res.lines} layers={LAYER.SOLID} />
        </group>
      </group>
      {/* troika suspends until the font is parsed; keep the torus itself out of that boundary. */}
      <Suspense fallback={null}>
        <Engraved placement={label} size={3.2} spacing={0.28} color={PALETTE.bone} emissive={PALETTE.bone} emissiveIntensity={0.35}>
          MANIFOLD · T²
        </Engraved>
      </Suspense>
    </group>
  )
}
