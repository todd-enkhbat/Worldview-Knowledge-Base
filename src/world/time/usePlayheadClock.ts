import { useFrame } from '@react-three/fiber'
import { useApp, useWorld } from '../../app/store.ts'
import { getClock } from './clock.ts'

// The React side of the playhead clock (src/world/time/clock.ts), kept apart so the clock
// itself imports no three/R3F and stays testable in node.

/** Runs the clock first in every frame (priority −3), before the pose writer (−2). */
export function usePlayheadClock(): void {
  useFrame((state, delta) => {
    const app = useApp.getState()
    const patch = getClock().frame({
      dt: delta,
      time: state.clock.elapsedTime,
      now: Date.now(),
      settings: useWorld.getState().settings,
      clock: app.clock,
    })
    if (patch) app.setClock(patch)
  }, -3)
}
