import { useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Color, DoubleSide, Object3D, type InstancedMesh, type Mesh, type MeshBasicMaterial } from 'three'
import { useApp, useWorld } from '../app/store.ts'
import { birthStep } from '../domain/time.ts'
import type { Vec3 } from '../domain/types.ts'
import { prefersStillCamera } from './camera/cameraFlight.ts'
import { EXPLORE_KINDS, type ExploreKind, type ExploreRecord } from './exploreRecords.ts'
import { spatialWorldFor } from './field/layout.ts'
import { groundYAt, spatialGroundFor } from './environment/knowledgeGround.ts'
import { isBorn, readPose } from './poses.ts'

const groups = Object.keys(EXPLORE_KINDS) as ExploreKind[]
const MAX_POINTS = 120

/** Records without an existing node share a lightweight layer within the scene's spatial bounds. */
export function exploreRecordPosition(record: ExploreRecord): Vec3 {
  const nodes = useWorld.getState().nodes
  const { center, radius } = spatialWorldFor(nodes).bounds
  let seed = 2166136261
  for (const letter of record.key) seed = Math.imul(seed ^ letter.charCodeAt(0), 16777619)
  const angle = (groups.indexOf(record.kind) + ((seed >>> 16) / 0xffff - 0.5) * 0.8) * Math.PI * 2 / groups.length
  const spread = Math.max(22, Math.min(radius * 0.48, 100))
  const distance = spread * (0.62 + (seed & 0xffff) / 0xffff * 0.38)
  const x = center[0] + Math.cos(angle) * distance, z = center[2] + Math.sin(angle) * distance
  return [x, Math.max(center[1], groundYAt(spatialGroundFor(nodes), x, z)) + 8 + (seed & 31) * 0.6, z]
}

export function ExploreRecordLayer({ records, selected, onSelect }: { records: readonly ExploreRecord[]; selected?: ExploreRecord; onSelect: (record: ExploreRecord) => void }) {
  const settings = useWorld(state => state.settings)
  const step = useApp(state => state.clock.step)
  const mode = useApp(state => state.mode)
  const sceneSelection = useApp(state => state.selectedId)
  const markers = useRef<InstancedMesh>(null)
  const ring = useRef<Mesh<never, MeshBasicMaterial>>(null)
  const phase = useRef(0)
  const supplemental = useMemo(() => {
    const unplaced = records.filter(record => !record.nodeId)
    return groups.flatMap(kind => unplaced.filter(record => record.kind === kind).slice(0, MAX_POINTS / groups.length))
  }, [records])
  const points = useMemo(() => supplemental.map(record => ({ record, position: exploreRecordPosition(record), step: settings ? birthStep(record.date, settings.T0, settings.stepsPerYear) : 0 })), [supplemental, settings])
  const visible = useMemo(() => points.filter(point => point.step <= step), [points, step])
  const unplacedSelection = useMemo(() => selected && !selected.nodeId ? exploreRecordPosition(selected) : null, [selected])
  const selectedStep = selected && settings ? birthStep(selected.date, settings.T0, settings.stepsPerYear) : 0

  useLayoutEffect(() => {
    const mesh = markers.current
    if (!mesh) return
    const marker = new Object3D()
    const color = new Color()
    for (const [index, point] of visible.entries()) {
      marker.position.set(...point.position)
      marker.updateMatrix()
      mesh.setMatrixAt(index, marker.matrix)
      mesh.setColorAt(index, color.set(EXPLORE_KINDS[point.record.kind].color))
    }
    mesh.count = visible.length
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [visible, mode])
  useLayoutEffect(() => { phase.current = 0 }, [selected?.key, sceneSelection])

  useFrame(({ camera }, delta) => {
    const mesh = ring.current
    if (!mesh) return
    const nodeId = selected?.nodeId ?? sceneSelection
    const born = nodeId ? isBorn(nodeId) && readPose(nodeId, mesh.position) : !!unplacedSelection
    mesh.visible = born && (!selected || selectedStep <= step)
    if (!mesh.visible) return
    if (!nodeId && unplacedSelection) mesh.position.set(...unplacedSelection)
    mesh.quaternion.copy(camera.quaternion)
    const resting = prefersStillCamera()
    phase.current = resting ? 1 : Math.min(1, phase.current + delta * 1.7)
    const ease = (1 - phase.current) ** 3
    const radius = Math.max(2.6, Math.min(6, camera.position.distanceTo(mesh.position) * 0.03))
    mesh.scale.setScalar(radius * (1 + ease * 0.85))
    mesh.material.opacity = 0.53 + ease * 0.32
  })

  if (mode !== 'orbit' && mode !== 'third_person' && mode !== 'first_person') return null
  return <>
    <instancedMesh name="workspace-record-markers" ref={markers} args={[undefined, undefined, MAX_POINTS]}
      onClick={event => {
        if (event.delta > 5 || event.instanceId === undefined) return
        const point = visible[event.instanceId]
        if (point) { event.stopPropagation(); onSelect(point.record) }
      }}>
      <octahedronGeometry args={[1.05]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
    <mesh name="workspace-record-focus" ref={ring} visible={false} renderOrder={5}>
      <ringGeometry args={[0.958, 1, 64]} />
      <meshBasicMaterial color={selected ? EXPLORE_KINDS[selected.kind].color : '#cce8fa'} side={DoubleSide} transparent depthWrite={false} toneMapped={false} />
    </mesh>
  </>
}
