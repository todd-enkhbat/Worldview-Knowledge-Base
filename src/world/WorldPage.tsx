import { useEffect } from 'react'
import { Color } from 'three'
import { markOnce } from '../app/timings.ts'
import { Hud } from '../hud/Hud.tsx'
import { CameraRig } from './camera/index.tsx'
import { DustLayer } from './dust/DustLayer.tsx'
import { EnvironmentScene } from './environment/index.tsx'
import { HyperspaceCanvas } from './HyperspaceCanvas.tsx'
import { LinkHover, LinkLayer } from './links/index.tsx'
import { NodeLayer } from './nodes/index.tsx'
import { Overlays } from './overlays/index.tsx'
import { PostStack } from './post/PostStack.tsx'
import { SplatLayer } from './splats/index.tsx'
import { usePlayheadClock } from './time/usePlayheadClock.ts'
import { usePhysicsPoses } from './time/usePhysicsPoses.ts'
import { AgentLayer } from './agents/AgentLayer.tsx'
import { FieldLayer } from './field/FieldLayer.tsx'
import { FieldPicker } from './field/FieldPicker.tsx'
import { useApp, useWorld } from '../app/store.ts'
import { Worldline } from './worldline/index.ts'

// #/ — the world. The data layer boots outside React (app/boot.ts); until first run completes
// the scene renders with a provisional T0 and the HUD shows FirstRun on top.

function Scene() {
  useEffect(() => markOnce('scene-mounted'), [])
  // The playhead clock (frame priority −3), then the pose writer (−2): physics worker
  // frames, or the static anchors when workers are unavailable.
  usePlayheadClock()
  usePhysicsPoses()
  // XYZ is semantic space. History controls births and evolution independently of height.
  // The World/Structure choice only changes the bounded molecular presentation around it.
  const field = useApp((s) => s.view.world === 'field')
  return (
    <>
      <EnvironmentScene />
      <NodeLayer />
      <LinkLayer />
      {field && <><FieldLayer /><FieldPicker /></>}
      <AgentLayer />
      <LinkHover />
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
      <CameraRig />
      <PostStack bokehScale={0} grain={0.006} bloomIntensity={0.4} fog={{ color: new Color('#07101d'), density: 0.00012, heightDensity: 0, heightFalloff: 1 / 45 }} />
    </>
  )
}

export default function WorldPage() {
  const ready = useWorld((s) => s.settings?.firstRunComplete === true)
  const chat = useApp((s) => s.panels.chat)
  return (
    <div className={`world-workspace relative h-full w-full ${ready ? 'is-ready' : ''} ${chat ? 'has-chat' : ''}`}>
      <div className="world-viewport">
      <HyperspaceCanvas>
        <Scene />
      </HyperspaceCanvas>
      </div>
      <div id="hud-root" className="pointer-events-none absolute inset-0">
        <Hud />
      </div>
    </div>
  )
}
