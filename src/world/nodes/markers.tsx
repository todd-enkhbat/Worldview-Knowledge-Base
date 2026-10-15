import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Vector3, type Mesh } from 'three'
import { useApp } from '../../app/store.ts'
import type { Archetype, NodeRecord } from '../../domain/types.ts'
import { LAYER } from '../layers.ts'
import { readPose } from '../poses.ts'
import { farScale, nodeScale } from './instancing.ts'
import type { NodeKit } from './kit.ts'

// Selection reticle (signal-orange ring with ticks) and the thinner ember hover ring,
// circling the node at mid-height. Both are single meshes moved in useFrame.

const RETICLE_RADIUS: Record<Archetype, number> = {
  idea: 0.8,
  entity: 1.0,
  lens: 1.15,
  document: 1.45,
  memory: 2.05,
  demon: 1.15,
}

const _cam = new Vector3()

function place(m: Mesh | null, rec: NodeRecord | undefined, angle: number): void {
  if (!m) return
  if (!rec || !readPose(rec.id, m.position)) {
    m.visible = false
    return
  }
  m.visible = true
  m.rotation.y = angle
  // Same distance boost as the node mesh, so the ring keeps circling it.
  m.scale.setScalar(RETICLE_RADIUS[rec.archetype] * nodeScale(rec) * farScale(m.position.distanceTo(_cam)))
}

export function SelectionMarkers({ byId, kit }: { byId: ReadonlyMap<string, NodeRecord>; kit: NodeKit }) {
  const sel = useRef<Mesh>(null)
  const hov = useRef<Mesh>(null)
  useFrame((state) => {
    const { selectedId, hoveredId } = useApp.getState()
    const t = state.clock.elapsedTime
    state.camera.getWorldPosition(_cam)
    place(sel.current, selectedId ? byId.get(selectedId) : undefined, t * 0.45)
    place(hov.current, hoveredId && hoveredId !== selectedId ? byId.get(hoveredId) : undefined, -t * 0.3)
  }, -1)
  return (
    <>
      <mesh ref={sel} name="select-reticle" geometry={kit.geo.reticleSelect} material={kit.mat.selectRing} layers={LAYER.SOLID} visible={false} />
      <mesh ref={hov} name="hover-reticle" geometry={kit.geo.reticleHover} material={kit.mat.hoverRing} layers={LAYER.SOLID} visible={false} />
    </>
  )
}
