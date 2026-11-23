import { create } from 'zustand'
import { Vector3 } from 'three'
import type { CameraControlsImpl } from '@react-three/drei'
import { useApp, useWorld } from '../../app/store.ts'

interface OrbitMotionState {
  playing: boolean
  /** Interruptions stop immediately; the explicit pause button may ease to rest. */
  stopVersion: number
}

/** Session-only and always off initially, including for reduced-motion preferences. */
export const useOrbitMotion = create<OrbitMotionState>()(() => ({ playing: false, stopVersion: 0 }))

export function toggleOrbitMotion(): void {
  const motion = useOrbitMotion.getState()
  if (motion.playing) {
    useOrbitMotion.setState({ playing: false })
    return
  }
  const app = useApp.getState()
  if (app.mode !== 'orbit' && !app.setMode('orbit')) return
  // Starting motion is an explicit action; no ambient motion preference is changed.
  useOrbitMotion.setState({ playing: true })
}

export function stopOrbitMotion(): void {
  useOrbitMotion.setState((state) => ({ playing: false, stopVersion: state.stopVersion + 1 }))
}

export const ORBIT_MOTION_RATE = 5 * Math.PI / 180
export const ORBIT_POLAR_AMPLITUDE = .065
const EASE_SECONDS = .65
const POLAR_FREQUENCY = .16

export interface OrbitMotionSample {
  phase: number
  speed: number
}

/** Exact exponential speed integration keeps the same gentle path at different frame rates. */
export function sampleOrbitMotion(previous: OrbitMotionSample, delta: number, playing: boolean): OrbitMotionSample & { azimuthDelta: number; polarDelta: number } {
  const dt = Number.isFinite(delta) ? Math.max(0, Math.min(.1, delta)) : 0
  const wanted = Number(playing)
  const decay = Math.exp(-dt / EASE_SECONDS)
  const elapsed = wanted * dt + (previous.speed - wanted) * EASE_SECONDS * (1 - decay)
  const phase = previous.phase + elapsed
  let speed = wanted + (previous.speed - wanted) * decay
  if (!playing && speed < .001) speed = 0
  return {
    phase, speed,
    azimuthDelta: elapsed * ORBIT_MOTION_RATE,
    polarDelta: ORBIT_POLAR_AMPLITUDE * (Math.sin(phase * POLAR_FREQUENCY) - Math.sin(previous.phase * POLAR_FREQUENCY)),
  }
}

/** One camera owner: updates real controls around their current target and cleans up on handoff. */
export function createOrbitMotionDriver(controls: CameraControlsImpl): { update: (delta: number) => void; dispose: () => void } {
  let sample: OrbitMotionSample = { phase: 0, speed: 0 }
  let stopVersion = useOrbitMotion.getState().stopVersion
  let wasPlaying = false
  const position = new Vector3(), target = new Vector3()
  const reset = () => { sample = { phase: 0, speed: 0 }; wasPlaying = false }
  controls.addEventListener('controlstart', stopOrbitMotion)
  const offApp = useApp.subscribe((state, previous) => {
    if (state.mode !== previous.mode && state.mode !== 'orbit' || state.selectedId !== previous.selectedId || state.focusedId !== previous.focusedId || state.view.world !== previous.view.world) stopOrbitMotion()
  })
  const offWorld = useWorld.subscribe((state, previous) => {
    if (state.settings !== previous.settings || !state.loaded && previous.loaded || state.nodes.size === 0 && previous.nodes.size > 0) stopOrbitMotion()
  })
  return {
    update(delta) {
      const motion = useOrbitMotion.getState()
      if (motion.stopVersion !== stopVersion) { reset(); stopVersion = motion.stopVersion }
      if (useApp.getState().mode !== 'orbit') return
      if (motion.playing && !wasPlaying) {
        reset()
        // Adopt the visible pose before rotating, avoiding a jump to an unfinished fly's end.
        controls.getPosition(position, false)
        controls.getTarget(target, false)
        void controls.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, false)
      }
      wasPlaying = motion.playing
      if (!motion.playing && sample.speed === 0) return
      const next = sampleOrbitMotion(sample, delta, motion.playing)
      sample = next
      void controls.rotate(next.azimuthDelta, next.polarDelta, false)
      controls.update(0)
    },
    dispose() {
      controls.removeEventListener('controlstart', stopOrbitMotion)
      offApp()
      offWorld()
      stopOrbitMotion()
      reset()
    },
  }
}
