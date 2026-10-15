import { Vector3 } from 'three'
import type { CameraMode } from '../../app/store.ts'

// Mode-dependent post (PLAN "Rendering specifics"). Pure, so tests and the perf lab can
// assert the policy without a GL context.
//
// Height fog: off while the camera is inside or flying into a diorama, and in free flight
// (the analytic column of haze reads as a wall when you can roll through it).
//
// DOF: on everywhere except while entering, inside a diorama and in first_person. Splats
// write no depth, so the CoC would focus on the depth-proxy back faces instead of the
// splats (PLAN "Rendering specifics"). The quality-ladder flag dofOnlyFlyIn (rung 3) turns
// it off everywhere: since the fly-in is already DOF-free, "DOF only during the fly-in"
// collapses to "no DOF", the one consistent reading of both rules. In orbit the focus is
// the orbit target (OrbitRig calls setPostFocus every frame).

const NO_POST_MODES: ReadonlySet<CameraMode> = new Set<CameraMode>(['entering', 'interior', 'first_person'])

export interface PostModeFlags {
  dof: boolean
  heightFog: boolean
}

/** Allocation-free; safe to call every frame. */
export function dofActive(mode: CameraMode, dofOnlyFlyIn: boolean): boolean {
  return !dofOnlyFlyIn && !NO_POST_MODES.has(mode)
}

/** Allocation-free; safe to call every frame. */
export function heightFogActive(mode: CameraMode): boolean {
  return !NO_POST_MODES.has(mode)
}

export function postModeFlags(mode: CameraMode, dofOnlyFlyIn: boolean): PostModeFlags {
  return { dof: dofActive(mode, dofOnlyFlyIn), heightFog: heightFogActive(mode) }
}

// ─── DOF focus ──────────────────────────────────────────────────────────────────────
// Priority: explicit override (camera rigs, framing modal) > the focused memory while
// entering/exiting > the selected node > a fixed fallback distance in front of the camera.

const override = new Vector3()
let hasOverride = false

/** Pin the DOF focus to a world point (e.g. the orbit target), or release it with null. */
export function setPostFocus(point: { x: number; y: number; z: number } | null): void {
  if (point === null) {
    hasOverride = false
    return
  }
  override.set(point.x, point.y, point.z)
  hasOverride = true
}

/** Copies the override into `out`; false when none is set. */
export function readPostFocusOverride(out: Vector3): boolean {
  if (!hasOverride) return false
  out.copy(override)
  return true
}
