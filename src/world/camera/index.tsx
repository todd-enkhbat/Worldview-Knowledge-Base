import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import { useApp } from '../../app/store.ts'
import { enableMainCameraLayers } from '../layers.ts'
import { AvatarLamp, AvatarRig } from './AvatarRig.tsx'
import { FirstPersonRig } from './FirstPersonRig.tsx'
import { setOrbitHandoff } from './flyTo.ts'
import { useCameraKeys } from './keyboard.ts'
import { OrbitRig } from './OrbitRig.tsx'
import { SpatialWalkLamp, SpatialWalkRig } from './SpatialWalkRig.tsx'
import { clearProximity } from './proximity.ts'
import { prepareWalkGraph, type WalkGraphSource } from './walkGraph.ts'
import { FlyInRig, FramingRig, InteriorRig } from '../splats/index.tsx'
import { AutonavRig } from '../worldline/index.ts'

// The camera rig, driven by useApp().mode. Each mode's rig owns the camera only while
// mounted, so exactly one writer moves it:
//   orbit, framing  OrbitRig (drei CameraControls, makeDefault)
//   third_person    SpatialWalkRig (shared terrain + damped follow camera)
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
   * An optional legacy catwalk graph for lab scenes. The live world omits this and uses
   * free movement over its shared spatial ground.
   */
  paths?: WalkGraphSource | null
}

export function CameraRig({ paths = null }: CameraRigProps) {
  const mode = useApp((s) => s.mode)
  const camera = useThree((s) => s.camera)
  const graph = useMemo(() => paths ? prepareWalkGraph(paths) : null, [paths])

  useCameraKeys(!graph || graph.yMax > graph.yMin)

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
      {mode === 'third_person' && (graph ? <AvatarRig graph={graph} /> : <SpatialWalkRig />)}
      {mode === 'first_person' && <FirstPersonRig />}
      {(mode === 'entering' || mode === 'exiting') && <FlyInRig />}
      {mode === 'interior' && <InteriorRig />}
      {mode === 'framing' && <FramingRig />}
      {mode === 'autonav' && <AutonavRig />}
      {graph ? <AvatarLamp /> : <SpatialWalkLamp />}
    </>
  )
}
