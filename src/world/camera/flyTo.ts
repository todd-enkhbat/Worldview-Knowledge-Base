import { Vector3 } from 'three'
import type { CameraControlsImpl } from '@react-three/drei'
import { useApp } from '../../app/store.ts'
import type { Vec3 } from '../../domain/types.ts'
import { readPose } from '../poses.ts'

// Programmatic camera moves, callable from outside the Canvas (editor after save, Library,
// Cmd+K palette). The orbit CameraControls only exist while the rig is in orbit, so a fly
// requested from another mode switches to orbit and is parked here until OrbitRig mounts.

export interface FlyToOptions {
  /** Camera distance from the target (world units). Default 16, clamped to the orbit limits. */
  distance?: number
  /** Animate the move (default true). */
  transition?: boolean
  /** Direction from the target towards the camera. Defaults to the current viewing direction. */
  from?: Vec3
}

let controls: CameraControlsImpl | null = null
let pending: { point: Vector3; opts: FlyToOptions } | null = null

/** Last orbit target, kept when OrbitRig unmounts (third person starts from its height). */
export const lastOrbitTarget = new Vector3()
/** Orbit distance when OrbitRig last unmounted; first person hands back at this range. */
let lastOrbitDistance = 24

// Where the next OrbitRig mount should pivot: third person hands over the point its follow
// camera was looking at, so pressing O orbits around the walker instead of jumping away.
const handoff = new Vector3()
let hasHandoff = false

export function setOrbitHandoff(point: { x: number; y: number; z: number } | null): void {
  hasHandoff = point !== null
  if (point) handoff.set(point.x, point.y, point.z)
}

/**
 * Orbit pivot for a camera that was driven by another rig: the handed-over point if any,
 * else a point straight ahead at the last orbit distance. Consumes the handoff.
 */
export function takeOrbitPivot(camera: { position: Vector3; getWorldDirection(out: Vector3): Vector3 }, out: Vector3): Vector3 {
  if (hasHandoff) {
    hasHandoff = false
    return out.copy(handoff)
  }
  return camera.getWorldDirection(out).multiplyScalar(lastOrbitDistance).add(camera.position)
}

export function getOrbitControls(): CameraControlsImpl | null {
  return controls
}

/** Called by OrbitRig on mount/unmount. Applies a fly that was waiting for the controls. */
export function registerOrbitControls(c: CameraControlsImpl | null): void {
  if (c === null && controls) {
    controls.getTarget(lastOrbitTarget)
    lastOrbitDistance = controls.distance
  }
  controls = c
  if (c && pending) {
    const p = pending
    pending = null
    applyFly(c, p.point, p.opts)
  }
}

const DEFAULT_DISTANCE = 16
/** Fly-ins look down on the node at least this much (y of the unit view direction). */
const MIN_ELEVATION = 0.15
const FALLBACK_DIR = new Vector3(0.62, 0.42, 0.66).normalize()

const tmpTarget = new Vector3()
const tmpPos = new Vector3()
const tmpDir = new Vector3()

function applyFly(c: CameraControlsImpl, point: Vector3, opts: FlyToOptions): void {
  if (opts.from) tmpDir.set(opts.from[0], opts.from[1], opts.from[2])
  else tmpDir.subVectors(c.getPosition(tmpPos, true), c.getTarget(tmpTarget, true))
  if (tmpDir.lengthSq() < 1e-8) tmpDir.copy(FALLBACK_DIR)
  tmpDir.normalize()
  if (tmpDir.y < MIN_ELEVATION) {
    const h = Math.hypot(tmpDir.x, tmpDir.z)
    const k = h > 1e-6 ? Math.sqrt(1 - MIN_ELEVATION * MIN_ELEVATION) / h : 0
    tmpDir.set(tmpDir.x * k, MIN_ELEVATION, tmpDir.z * k)
    if (k === 0) tmpDir.copy(FALLBACK_DIR)
  }
  const d = Math.min(Math.max(opts.distance ?? DEFAULT_DISTANCE, c.minDistance), c.maxDistance)
  tmpPos.copy(point).addScaledVector(tmpDir, d)
  void c.setLookAt(tmpPos.x, tmpPos.y, tmpPos.z, point.x, point.y, point.z, opts.transition ?? true)
}

/**
 * Fly the orbit camera to a node (by id, at its current render pose) or to a world point.
 * From third/first person this switches to orbit first. Returns false if the node has no
 * pose or the current mode cannot hand over to orbit (entering/interior/exiting).
 */
export function flyTo(target: string | Vec3, opts: FlyToOptions = {}): boolean {
  const point = new Vector3()
  if (typeof target === 'string') {
    if (!readPose(target, point)) return false
  } else {
    point.set(target[0], target[1], target[2])
  }
  const app = useApp.getState()
  if (app.mode !== 'orbit' && !app.setMode('orbit')) return false
  if (controls) applyFly(controls, point, opts)
  else pending = { point, opts }
  return true
}
