import { MeshReflectorMaterial } from '@react-three/drei'
import { LAYER } from '../layers.ts'
import { useApp } from '../../app/store.ts'

// Matte cool concrete stays continuous at an overview distance; an untiled material avoids
// distant texture aliasing. KnowledgeGround draws the measured grid separately. Walking can
// add a restrained reflection of layer0 without turning the world into a mirror.

export const FLOOR_Y = -0.02
const FLOOR_SIZE = 6000

export interface FloorProps {
  reflective: boolean
  /** Reflector render-target size (1024 'full', 512 on the quality ladder). */
  resolution: number
}

export function Floor({ reflective, resolution }: FloorProps) {
  const walking = useApp((s) => s.mode === 'third_person')
  return (
    <mesh rotation-x={-Math.PI / 2} position-y={FLOOR_Y} layers={LAYER.SOLID} renderOrder={-700}>
      <planeGeometry args={[FLOOR_SIZE, FLOOR_SIZE]} />
      {reflective ? (
        <MeshReflectorMaterial
          key={resolution}
          resolution={resolution}
          blur={[420, 120]}
          mixBlur={0.96}
          mixStrength={0.1}
          mixContrast={1}
          depthScale={1.1}
          minDepthThreshold={0.35}
          maxDepthThreshold={1.4}
          depthToBlurRatioBias={0.3}
          mirror={0}
          color="#060d17"
          emissive="#020812"
          emissiveIntensity={0.12}
          roughness={0.97}
          metalness={0}
          envMapIntensity={0.015}
          transparent
          opacity={walking ? .18 : .025}
          depthWrite={false}
        />
      ) : (
        <meshStandardMaterial
          color="#060d17"
          emissive="#020812"
          emissiveIntensity={0.12}
          roughness={0.98}
          metalness={0}
          envMapIntensity={0.015}
          transparent
          opacity={walking ? .18 : .025}
          depthWrite={false}
        />
      )}
    </mesh>
  )
}
