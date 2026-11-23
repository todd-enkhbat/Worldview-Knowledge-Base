import { useLayoutEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { CameraControls, type CameraControlsImpl } from '@react-three/drei'
import { Vector3, type Camera, type PerspectiveCamera } from 'three'
import { useApp, useWorld } from '../../app/store.ts'
import { setPostFocus } from '../post/postMode.ts'
import { spatialWorldFor } from '../field/layout.ts'
import { groundYAt, spatialGroundFor, type SpatialGroundPlan } from '../environment/knowledgeGround.ts'
import { spatialShot } from './spatialFrame.ts'
import { getOrbitControls, registerOrbitControls, takeOrbitPivot } from './flyTo.ts'
import { registerDevApi } from '../../app/devApi.ts'
import { updateProximity } from './proximity.ts'
import { createOrbitMotionDriver, stopOrbitMotion } from './orbitMotion.ts'

// Free orbit around the world (the default mode). Mounted only while the mode wants it, so
// camera-controls never fights the avatar, Spark or the fly-in for the camera. On mount it
// adopts the pose the previous rig left behind (no snap back to an old orbit), then applies
// any flyTo() that was parked while switching modes.

/** The semantic world spans multiple 3-D neighborhoods, with close inspection available. */
export const ORBIT_LIMITS = {
  minDistance: 2.5,
  maxDistance: 9000,
  /** Keep a sliver off the poles so the up vector never flips. */
  minPolarAngle: 0.04,
  /** Allow a low view across neighborhoods; the local ground further caps this each frame. */
  maxPolarAngle: Math.PI * 0.62,
} as const

/** Clearance above the shared ground, including raised districts and connecting ramps. */
export const ORBIT_GROUND_CLEARANCE = 0.6

const pivot = new Vector3()
const target = new Vector3()
const position = new Vector3()

/** Update the controls themselves so their next interpolation cannot undo the clearance. */
export function applyOrbitGroundClearance(c: CameraControlsImpl, ground: SpatialGroundPlan): void {
  c.getTarget(target, false)
  c.getPosition(position, false)
  const floorY = groundYAt(ground, position.x, position.z) + ORBIT_GROUND_CLEARANCE
  if (position.y < floorY - 1e-5) {
    // Lifting at the same XZ avoids sliding sideways into a still higher part of a district.
    // Correct the live controls, preserving the pivot, rather than fighting their camera.
    void c.setLookAt(position.x, floorY, position.z, target.x, target.y, target.z, false)
    c.update(0)
    c.getPosition(position, false)
  }
  const distance = Math.max(position.distanceTo(target), 1e-3)
  const k = Math.min(1, Math.max(-1, (floorY - target.y) / distance))
  c.maxPolarAngle = Math.max(ORBIT_LIMITS.minPolarAngle, Math.min(ORBIT_LIMITS.maxPolarAngle, Math.acos(k)))
}

/** First mount keeps the camera the Canvas was created with (the page frames the world). */
let mountedBefore = false
/** The opening establishing shot is taken (or forfeited) once per page. */
let established = false
/** Why the last establishing attempt ended (dev hook). */
let establishNote = 'none'

/**
 * A reframe asked for by switching worlds. It stays pending until a frame has rendered, so a
 * remount in the same commit (React's dev double-mount) takes the shot again instead of
 * restoring the previous view.
 */
let requested = false

/** Frame the world afresh on the next orbit mount (after switching between field and classic). */
export function requestEstablishingShot(): void {
  stopOrbitMotion()
  established = false
  requested = true
}

function worldShot(camera: Camera) {
  const { nodes, settings } = useWorld.getState()
  if (!settings) return null
  const cam = camera as PerspectiveCamera
  return spatialShot(spatialWorldFor(nodes).bounds, cam.fov ?? 50, cam.aspect || 1, ORBIT_LIMITS.maxDistance * 0.9)
}

/** Explicit user action: reframe live orbit controls, or park the shot until orbit mounts. */
export function recenterWorld(): boolean {
  const app = useApp.getState()
  if (app.mode !== 'orbit' && !app.setMode('orbit')) return false
  requestEstablishingShot()
  const c = getOrbitControls()
  if (!c) return true
  const shot = worldShot(c.camera)
  if (!shot) return false
  establishNote = `recenter ${app.view.world} ${shot.target.map(Math.round).join(',')}`
  established = true
  requested = false
  void c.setLookAt(...shot.position, ...shot.target, true)
  return true
}
const _t = new Vector3()

registerDevApi('orbit', () => {
  const c = getOrbitControls()
  const t = c?.getTarget(new Vector3())
  const p = c?.getPosition(new Vector3())
  return { established, note: establishNote, target: t?.toArray().map(Math.round), position: p?.toArray().map(Math.round) }
})

/**
 * Once the world has nodes, glide to its shared spatial bounds, unless the user
 * or a flyTo() moved the camera first (a drag, or an orbit target that is no longer the one
 * this mount started with). Returns the cleanup.
 */
function establishWhenLoaded(c: CameraControlsImpl, camera: Camera): () => void {
  let live = true
  const start = c.getTarget(new Vector3())
  const forfeit = () => {
    establishNote = 'forfeit'
    established = true
  }
  const attempt = (transition: boolean) => {
    if (!live || (established && !requested)) return
    if (c.getTarget(_t).distanceToSquared(start) > 1e-6) return forfeit()
    const { nodes, settings } = useWorld.getState()
    if (!settings || nodes.size === 0) return
    const shot = worldShot(camera)
    if (!shot) return
    establishNote = `shot ${useApp.getState().view.world} ${shot.target.map(Math.round).join(',')}`
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
  const motion = useRef<ReturnType<typeof createOrbitMotionDriver> | null>(null)
  const camera = useThree((s) => s.camera)

  // Layout phase: the previous rig's layout cleanup (handoff, lastOrbitTarget) has already
  // run, and the adoption lands before the next frame renders, so there is no one-frame snap.
  useLayoutEffect(() => {
    const c = ref.current
    if (!c) return
    if (mountedBefore && !requested) {
      takeOrbitPivot(camera, pivot)
      const p = camera.position
      void c.setLookAt(p.x, p.y, p.z, pivot.x, pivot.y, pivot.z, false)
    }
    mountedBefore = true
    // Before registering: a fly parked while switching modes is applied there and wins.
    const stopEstablish = established && !requested ? null : establishWhenLoaded(c, camera)
    registerOrbitControls(c)
    motion.current = createOrbitMotionDriver(c)
    return () => {
      motion.current?.dispose()
      motion.current = null
      stopEstablish?.()
      registerOrbitControls(null)
      setPostFocus(null)
    }
  }, [camera])

  // Runs after camera-controls' own update (priority −1), before this frame is drawn.
  useFrame((_, delta) => {
    const c = ref.current
    if (!c) return
    if (established) requested = false
    motion.current?.update(delta)
    applyOrbitGroundClearance(c, spatialGroundFor(useWorld.getState().nodes))
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
