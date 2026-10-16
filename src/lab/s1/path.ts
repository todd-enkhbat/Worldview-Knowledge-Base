import { Vector3 } from 'three'

// Scripted camera paths for window.__s1. Deterministic in t (seconds) so runs in different
// browsers see the same views.
//
// orbit: one full revolution in 20 s around the dioramas, breathing in and out twice
//        (radius 10 → 22 u, so two passes come within ~2 u of the front glass), with a slow
//        height wave. The camera never stops, so Spark re-sorts continuously.
// static: a fixed wide view; only scene motion (moving LoD mesh, tween) drives sorting.

export const PATH_SECONDS = 20
const LOOK_AT = new Vector3(0, 2, -2)

export function pathPose(path: 'orbit' | 'static', t: number, pos: Vector3, target: Vector3): void {
  if (path === 'static') {
    pos.set(0, 6, 22)
    target.set(0, 2, -2)
    return
  }
  const theta = (2 * Math.PI * t) / PATH_SECONDS
  const r = 16 - 6 * Math.cos((2 * Math.PI * t) / (PATH_SECONDS / 2))
  pos.set(LOOK_AT.x + r * Math.sin(theta), 4 + 2 * Math.sin((2 * Math.PI * t) / 7), LOOK_AT.z + r * Math.cos(theta))
  target.copy(LOOK_AT)
}
