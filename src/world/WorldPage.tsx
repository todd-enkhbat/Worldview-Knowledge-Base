import { useEffect } from 'react'
import { markOnce } from '../app/timings.ts'
import { Hud } from '../hud/Hud.tsx'
import { CameraRig } from './camera/index.tsx'
import { DustLayer } from './dust/DustLayer.tsx'
import { EnvironmentScene, usePathGraph } from './environment/index.tsx'
import { HyperspaceCanvas } from './HyperspaceCanvas.tsx'
import { LinkHover, LinkLayer } from './links/index.tsx'
import { NodeLayer } from './nodes/index.tsx'
import { Overlays } from './overlays/index.tsx'
import { PostStack } from './post/PostStack.tsx'
import { SplatLayer } from './splats/index.tsx'
import { usePlayheadClock } from './time/usePlayheadClock.ts'
import { usePhysicsPoses } from './time/usePhysicsPoses.ts'
import { YearRings } from './time/YearRings.tsx'
import { FieldLayer } from './field/FieldLayer.tsx'
import { FieldPicker } from './field/FieldPicker.tsx'
import { FieldScenes } from './field/FieldMedia.tsx'
import { useApp } from '../app/store.ts'
import { Worldline } from './worldline/index.ts'

// #/ — the world. The data layer boots outside React (app/boot.ts); until first run completes
// the scene renders with a provisional T0 and the HUD shows FirstRun on top.

function Scene() {
  useEffect(() => markOnce('scene-mounted'), [])
  // The playhead clock (frame priority −3), then the pose writer (−2): physics worker
  // frames, or the static anchors when workers are unavailable.
  usePlayheadClock()
  usePhysicsPoses()
  // One path graph shared by the catwalk geometry and the avatar, so they always agree.
  const graph = usePathGraph()
  // Milestone 2: the particle world replaces the column, helix, rings, meshes and dust. Time
  // lives in the timeline; links become currents; notes become clouds of grains.
  const field = useApp((s) => s.view.world === 'field')
  if (field) {
    return (
      <>
        <EnvironmentScene graph={graph} classic={false} />
        <FieldLayer />
        {/* Outside the 'field' group: the fly-in hides the field but not the scene it enters. */}
        <FieldScenes />
        <FieldPicker />
        <NodeLayer labelsOnly />
        <LinkHover />
        <SplatLayer />
        <CameraRig paths={graph} />
        <PostStack />
      </>
    )
  }
  return (
    <>
      <EnvironmentScene graph={graph} />
      <NodeLayer />
      <LinkLayer />
      <LinkHover />
      <YearRings />
      {/* The dissipative O layer (citadels, mist, synapses, demon lattice, satellites) plus
          dwell logging. A top-level 'overlays' group so the interior's world-hide covers it. */}
      <group name="overlays">
        <Overlays />
      </group>
      {/* The ember worldline through the memories in date order; autonav rides it. It hides
          itself in the interior. */}
      <Worldline />
      {/* GPU dust, stepped to the same playhead step as the node worker (frame −2). */}
      <DustLayer />
      {/* The world's one SparkRenderer + diorama tiers; outside the world groups so it
          survives the interior's world-hide. */}
      <SplatLayer />
      <CameraRig paths={graph} />
      <PostStack />
    </>
  )
}

export default function WorldPage() {
  return (
    <div className="relative h-full w-full">
      <HyperspaceCanvas>
        <Scene />
      </HyperspaceCanvas>
      <div id="hud-root" className="pointer-events-none absolute inset-0">
        <Hud />
      </div>
    </div>
  )
}
