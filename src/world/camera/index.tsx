import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import { useApp, useWorld } from '../../app/store.ts'
import { FUTURE_YEARS, MS_PER_YEAR, Y_PER_YEAR } from '../../domain/constants.ts'
import { anchorY } from '../../domain/placement.ts'
import type { WorldSettings } from '../../domain/types.ts'
import { yOf } from '../../domain/time.ts'
import { enableMainCameraLayers } from '../layers.ts'
import { AvatarLamp, AvatarRig } from './AvatarRig.tsx'
import { FirstPersonRig } from './FirstPersonRig.tsx'
import { setOrbitHandoff } from './flyTo.ts'
import { useCameraKeys } from './keyboard.ts'
import { OrbitRig } from './OrbitRig.tsx'
import { clearProximity } from './proximity.ts'
import { prepareWalkGraph, stubWalkGraph, type WalkGraphSource } from './walkGraph.ts'
import { FlyInRig, FramingRig, InteriorRig } from '../splats/index.tsx'
import { AutonavRig } from '../worldline/index.ts'

// The camera rig, driven by useApp().mode. Each mode's rig owns the camera only while
// mounted, so exactly one writer moves it:
//   orbit, framing  OrbitRig (drei CameraControls, makeDefault)
//   third_person    AvatarRig (walker on the catwalk + damped follow cam)
//   first_person    FirstPersonRig (the canvas's single SparkControls)
//   entering, exiting  FlyInRig (splats/: the scale tween + crossfade, both directions)
//   interior        InteriorRig (splats/: world hidden, SparkControls 6-DOF with roll)
//   framing         OrbitRig plus FramingRig (splats/: the lifted, unclipped diorama)
//   autonav         AutonavRig (worldline/: a damped ride along the worldline ribbon)
// The worldline ribbon autonav rides is mounted by the scene (WorldPage), not here.
// Keys (window): Esc → useApp.escape(), F first person, T third person, O orbit.

export { flyTo, getOrbitControls, type FlyToOptions } from './flyTo.ts'
export { useProximity, PROXIMITY_RADIUS } from './proximity.ts'
export type { WalkGraphSource } from './walkGraph.ts'

export interface CameraRigProps {
  /**
   * The catwalk path graph (world/paths.ts buildPathGraph(), structurally compatible). When
   * omitted, the rig derives a stand-in from the world records with the placement contract.
   */
  paths?: WalkGraphSource | null
}

export function CameraRig({ paths = null }: CameraRigProps) {
  const mode = useApp((s) => s.mode)
  const camera = useThree((s) => s.camera)
  const revision = useWorld((s) => s.revision)
  const settings = useWorld((s) => s.settings)

  const fallback = useMemo(() => (paths ? null : fallbackWalkSource(settings, revision)), [paths, settings, revision])
  const graph = useMemo(() => prepareWalkGraph(paths ?? fallback!), [paths, fallback])

  useCameraKeys(graph.yMax > graph.yMin)

  useEffect(() => enableMainCameraLayers(camera), [camera])

  // Orbit and third person publish proximity every frame; every other mode has no focus point.
  // A third-person handoff is only meaningful for an immediate switch to orbit (OrbitRig's
  // mount effect, which runs before this one, consumes it); any other mode voids it.
  useEffect(() => {
    if (mode !== 'orbit' && mode !== 'third_person') clearProximity()
    if (mode !== 'orbit' && mode !== 'framing') setOrbitHandoff(null)
  }, [mode])

  return (
    <>
      {(mode === 'orbit' || mode === 'framing') && <OrbitRig proximity={mode === 'orbit'} />}
      {mode === 'third_person' && <AvatarRig graph={graph} />}
      {mode === 'first_person' && <FirstPersonRig />}
      {(mode === 'entering' || mode === 'exiting') && <FlyInRig />}
      {mode === 'interior' && <InteriorRig />}
      {mode === 'framing' && <FramingRig />}
      {mode === 'autonav' && <AutonavRig />}
      <AvatarLamp />
    </>
  )
}

/**
 * Helix from T0 to now + FUTURE_YEARS with a spur per live memory, built from the records.
 * `_revision` only keys the memo; the records are read from the store snapshot.
 */
function fallbackWalkSource(settings: WorldSettings | null, _revision: number): WalkGraphSource {
  const { nodes } = useWorld.getState()
  const yPerYear = settings?.yPerYear ?? Y_PER_YEAR
  const yMax = settings
    ? Math.max(Y_PER_YEAR, yOf(Date.now() + FUTURE_YEARS * MS_PER_YEAR, settings.T0, yPerYear))
    : (FUTURE_YEARS + 1) * Y_PER_YEAR
  const memories: { id: string; anchorXZ: readonly [number, number]; y: number }[] = []
  if (settings) {
    for (const n of nodes.values()) {
      if (n.archetype !== 'memory' || n.deletedAt !== null) continue
      memories.push({ id: n.id, anchorXZ: n.anchorXZ, y: anchorY(n, { T0: settings.T0, yPerYear }) })
    }
  }
  return stubWalkGraph(memories, 0, yMax)
}
