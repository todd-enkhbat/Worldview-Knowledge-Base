import { memo, useEffect, useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { BufferAttribute, BufferGeometry, Color, Points, PointsMaterial } from 'three'
import { livePositions } from './labClient.ts'

// The live lab world as points in a small R3F canvas. Each point is coloured by how far it
// has wandered from where it started (the Past-Hypothesis state is all anchors): concrete at
// home, ember at a few u, signal beyond. Running home after a flip or reversal visibly
// drains the colour back out; a 1-LSB perturbation does not.

const HOME = new Color('#8d8a84')
const MID = new Color('#e8b04a')
const FAR = new Color('#ff4a1c')
/** Displacement (u) at which a point is fully ember / fully signal. */
const MID_U = 1.5
const FAR_U = 6

function WorldPoints({ center }: { center: [number, number, number] }) {
  const { points, geometry, material } = useMemo(() => {
    const geometry = new BufferGeometry()
    const material = new PointsMaterial({ size: 0.42, sizeAttenuation: true, vertexColors: true, toneMapped: false })
    const points = new Points(geometry, material)
    points.frustumCulled = false
    return { points, geometry, material }
  }, [])
  const state = useMemo(() => ({ version: -1, origin: null as Float32Array | null, count: 0 }), [])

  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  useFrame(() => {
    if (livePositions.version === state.version) return
    state.version = livePositions.version
    const p = livePositions.positions
    const count = p.length / 3
    if (count === 0) return
    if (count !== state.count) {
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(p.length), 3))
      geometry.setAttribute('color', new BufferAttribute(new Float32Array(p.length), 3))
      state.count = count
      state.origin = null
    }
    if (!state.origin || livePositions.origin !== state.origin) state.origin = livePositions.origin
    const pos = geometry.getAttribute('position') as BufferAttribute
    const col = geometry.getAttribute('color') as BufferAttribute
    const P = pos.array as Float32Array
    const C = col.array as Float32Array
    const O = state.origin
    const c = new Color()
    for (let i = 0; i < count; i++) {
      const o = 3 * i
      P[o] = p[o] - center[0]
      P[o + 1] = p[o + 1] - center[1]
      P[o + 2] = p[o + 2] - center[2]
      let d = 0
      if (O && O.length === p.length) d = Math.hypot(p[o] - O[o], p[o + 1] - O[o + 1], p[o + 2] - O[o + 2])
      if (d <= MID_U) c.copy(HOME).lerp(MID, d / MID_U)
      else c.copy(MID).lerp(FAR, Math.min(1, (d - MID_U) / (FAR_U - MID_U)))
      C[o] = c.r
      C[o + 1] = c.g
      C[o + 2] = c.b
    }
    pos.needsUpdate = true
    col.needsUpdate = true
  })

  return <primitive object={points} />
}

export interface LabPointsProps {
  /** Box centre of the lab world (subtracted so the orbit pivots on it). */
  center: [number, number, number]
  className?: string
}

export const LabPoints = memo(function LabPoints({ center, className }: LabPointsProps) {
  return (
    <div className={className}>
      <Canvas camera={{ position: [48, 30, 48], fov: 45, near: 0.5, far: 500 }} gl={{ antialias: true }} dpr={[1, 2]}>
        <color attach="background" args={['#0b0b0c']} />
        <WorldPoints center={center} />
        <gridHelper args={[48, 12, '#3a3936', '#1c1c1c']} position={[0, -center[1], 0]} />
        <OrbitControls makeDefault enableDamping />
      </Canvas>
    </div>
  )
})
