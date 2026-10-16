import { useLayoutEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { CameraControls, type CameraControlsImpl } from '@react-three/drei'
import { Vector3, type Camera, type PerspectiveCamera } from 'three'
import { useApp, useWorld } from '../../app/store.ts'
import { setPostFocus } from '../post/postMode.ts'
import { establishingShot } from './establish.ts'
import { registerOrbitControls, takeOrbitPivot } from './flyTo.ts'
import { updateProximity } from './proximity.ts'

// Free orbit around the world (the default mode). Mounted only while the mode wants it, so
// camera-controls never fights the avatar, Spark or the fly-in for the camera. On mount it
// adopts the pose the previous rig left behind (no snap back to an old orbit), then applies
// any flyTo() that was parked while switching modes.

/** World scale: the core is r 6, the helix r 13, memories sit ~20–60 u out, the column rises
 *  12 u a year, so a whole life is a few hundred units tall. */
export const ORBIT_LIMITS = {
  minDistance: 2.5,
  maxDistance: 900,
  /** Keep a sliver off the poles so the up vector never flips. */
  minPolarAngle: 0.04,
  /** Below the horizon, so you can look up the column; further capped per frame by FLOOR_Y. */
  maxPolarAngle: Math.PI * 0.62,
} as const

/** The camera never sinks under the reflector floor (y = 0) plus this clearance. */
const FLOOR_Y = 0.6

const pivot = new Vector3()
const target = new Vector3()

/** First mount keeps the camera the Canvas was created with (the page frames the world). */
let mountedBefore = false
/** The opening establishing shot is taken (or forfeited) once per page. */
let established = false
const _t = new Vector3()

/**
 * Once the world has nodes, glide to the establishing shot (establish.ts), unless the user
 * or a flyTo() moved the camera first (a drag, or an orbit target that is no longer the one
 * this mount started with). Returns the cleanup.
 */
function establishWhenLoaded(c: CameraControlsImpl, camera: Camera): () => void {
  let live = true
  const start = c.getTarget(new Vector3())
  const forfeit = () => {
    established = true
  }
  const attempt = (transition: boolean) => {
    if (!live || established) return
    if (c.getTarget(_t).distanceToSquared(start) > 1e-6) return forfeit()
    const { nodes, settings } = useWorld.getState()
    if (!settings || nodes.size === 0) return
    const cam = camera as PerspectiveCamera
    const shot = establishingShot(nodes.values(), settings, cam.fov ?? 50, cam.aspect || 1, ORBIT_LIMITS.maxDistance * 0.9)
    if (!shot) return
    established = true
    void c.setLookAt(...shot.position, ...shot.target, transition)
  }
  c.addEventListener('controlstart', forfeit)
  attempt(false)
  const unsubscribe = established ? () => {} : useWorld.subscribe(() => attempt(true))
  return () => {
    live = false
    unsubscribe()
    c.removeEventListener('controlstart', forfeit)
  }
}

export function OrbitRig({ proximity = true }: { proximity?: boolean }) {
  const ref = useRef<CameraControlsImpl>(null)
  const camera = useThree((s) => s.camera)

  // Layout phase: the previous rig's layout cleanup (handoff, lastOrbitTarget) has already
  // run, and the adoption lands before the next frame renders, so there is no one-frame snap.
  useLayoutEffect(() => {
    const c = ref.current
    if (!c) return
    if (mountedBefore) {
      takeOrbitPivot(camera, pivot)
      const p = camera.position
      void c.setLookAt(p.x, p.y, p.z, pivot.x, pivot.y, pivot.z, false)
    }
    mountedBefore = true
    // Before registering: a fly parked while switching modes is applied there and wins.
    const stopEstablish = established ? null : establishWhenLoaded(c, camera)
    registerOrbitControls(c)
    return () => {
      stopEstablish?.()
      registerOrbitControls(null)
      setPostFocus(null)
    }
  }, [camera])

  // Runs after camera-controls' own update (priority −1), so the cap applies next frame.
  useFrame(() => {
    const c = ref.current
    if (!c) return
    c.getTarget(target, false)
    // camY = targetY + d·cos(polar) ≥ FLOOR_Y  ⇒  polar ≤ acos((FLOOR_Y − targetY) / d)
    const d = Math.max(c.distance, 1e-3)
    const k = Math.min(1, Math.max(-1, (FLOOR_Y - target.y) / d))
    c.maxPolarAngle = Math.max(ORBIT_LIMITS.minPolarAngle, Math.min(ORBIT_LIMITS.maxPolarAngle, Math.acos(k)))
    // What you orbit is what is sharp: flyTo() moves the target onto a node, so this also
    // covers selection. Released on unmount so the next rig's focus rules apply.
    setPostFocus(target)
    // framing borrows these controls but has no use for a proximity highlight.
    if (proximity && useApp.getState().mode === 'orbit') updateProximity(target.x, target.y, target.z)
  })

  return (
    <CameraControls
      ref={ref}
      makeDefault
      minDistance={ORBIT_LIMITS.minDistance}
      maxDistance={ORBIT_LIMITS.maxDistance}
      minPolarAngle={ORBIT_LIMITS.minPolarAngle}
      maxPolarAngle={ORBIT_LIMITS.maxPolarAngle}
      smoothTime={0.32}
      draggingSmoothTime={0.12}
      dollyToCursor
      dollySpeed={0.6}
    />
  )
}
