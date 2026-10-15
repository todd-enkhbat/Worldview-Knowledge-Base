import { useEffect, useMemo } from 'react'
import { MeshReflectorMaterial } from '@react-three/drei'
import { Color } from 'three'
import { LAYER } from '../layers.ts'
import { FLOOR_TILE, PALETTE, createFloorTextures } from './materials.ts'

// The ground: dark polished concrete with saw-cut joints. In third person (and when the quality
// ladder allows) it is drei's MeshReflectorMaterial, whose virtual camera renders only layer 0
// (architecture and solid nodes). In every other mode it is the same concrete without the
// reflection pass, so the ground never disappears.

export const FLOOR_Y = -0.02
const FLOOR_SIZE = 6000

export interface FloorProps {
  reflective: boolean
  /** Reflector render-target size (1024 'full', 512 on the quality ladder). */
  resolution: number
}

export function Floor({ reflective, resolution }: FloorProps) {
  const tex = useMemo(() => {
    const t = createFloorTextures()
    const rep = FLOOR_SIZE / FLOOR_TILE
    t.map.repeat.set(rep, rep)
    t.roughnessMap.repeat.set(rep, rep)
    return t
  }, [])
  useEffect(() => () => tex.dispose(), [tex])
  const color = useMemo(() => new Color(PALETTE.floor), [])

  return (
    <mesh rotation-x={-Math.PI / 2} position-y={FLOOR_Y} layers={LAYER.SOLID}>
      <planeGeometry args={[FLOOR_SIZE, FLOOR_SIZE]} />
      {reflective ? (
        <MeshReflectorMaterial
          key={resolution}
          resolution={resolution}
          blur={[420, 120]}
          mixBlur={0.85}
          mixStrength={0.6}
          mixContrast={1.15}
          depthScale={1.1}
          minDepthThreshold={0.35}
          maxDepthThreshold={1.4}
          depthToBlurRatioBias={0.3}
          mirror={0}
          color={color}
          map={tex.map}
          roughnessMap={tex.roughnessMap}
          roughness={0.82}
          metalness={0.12}
          envMapIntensity={0.55}
        />
      ) : (
        <meshStandardMaterial
          color={color}
          map={tex.map}
          roughnessMap={tex.roughnessMap}
          roughness={0.68}
          metalness={0.06}
          envMapIntensity={0.7}
        />
      )}
    </mesh>
  )
}
