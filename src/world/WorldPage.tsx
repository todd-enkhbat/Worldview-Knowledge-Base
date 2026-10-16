import { Hud } from '../hud/Hud.tsx'
import { CameraRig } from './camera/index.tsx'
import { DustLayer } from './dust/DustLayer.tsx'
import { EnvironmentScene, usePathGraph } from './environment/index.tsx'
import { HyperspaceCanvas } from './HyperspaceCanvas.tsx'
import { LinkLayer } from './links/index.tsx'
import { NodeLayer } from './nodes/index.tsx'
import { Overlays } from './overlays/index.tsx'
import { PostStack } from './post/PostStack.tsx'
import { SplatLayer } from './splats/index.tsx'
import { usePlayheadClock } from './time/usePlayheadClock.ts'
import { usePhysicsPoses } from './time/usePhysicsPoses.ts'
import { Worldline } from './worldline/index.ts'

// #/ — the world. The data layer boots outside React (app/boot.ts); until first run completes
// the scene renders with a provisional T0 and the HUD shows FirstRun on top.

function Scene() {
  // The playhead clock (frame priority −3), then the pose writer (−2): physics worker
  // frames, or the static anchors when workers are unavailable.
  usePlayheadClock()
  usePhysicsPoses()
  // One path graph shared by the catwalk geometry and the avatar, so they always agree.
  const graph = usePathGraph()
  return (
    <>
      <EnvironmentScene graph={graph} />
      <NodeLayer />
      <LinkLayer />
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
