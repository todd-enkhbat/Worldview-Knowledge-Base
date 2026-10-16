import { useEffect } from 'react'
import { startOverlays } from '../../overlay/index.ts'
import { Citadels } from './Citadels.tsx'
import { DemonLattice } from './DemonLattice.tsx'
import { KeplerSatellites } from './KeplerSatellites.tsx'
import { Mist } from './Mist.tsx'
import { Synapses } from './Synapses.tsx'
import { useDwell } from './useDwell.ts'

// <Overlays/>: the dissipative O layer's visuals (inside the Canvas, with the world groups).
// Starts the overlay engine (event-log fold + demon watcher) and dwell logging; the pose
// offsets themselves are applied by world/time/overlayHook.ts in the pose writer.

export { DwellTracker, DWELL_MS, useDwell } from './useDwell.ts'

export function Overlays() {
  useEffect(() => startOverlays(), [])
  useDwell()
  return (
    <>
      <Citadels />
      <Mist />
      <Synapses />
      <DemonLattice />
      <KeplerSatellites />
    </>
  )
}
