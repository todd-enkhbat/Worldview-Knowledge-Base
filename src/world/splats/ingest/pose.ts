import { Matrix4, Quaternion, Vector3 } from 'three'
import type { Pose, Quat, Vec3 } from '../../../domain/types.ts'

// Entry poses live in the capture's native frame (the SplatMesh's local frame), like the crop
// box. The diorama applies upFix as the mesh rotation, so "up" for a native-frame pose is
// upFix⁻¹ · +Y and the camera comes out level once the mesh is rotated.

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1]
/** Most captures (COLMAP, Scaniverse, Polycam PLY/SPZ) are y-down: a half turn about X. */
export const Y_DOWN_FIX: Quat = [1, 0, 0, 0]
/** Entry distance in bounding radii, and the elevation of the default view. */
export const ENTRY_RADII = 1.5
const ENTRY_ELEVATION = (20 * Math.PI) / 180

export interface BoxLike {
  min: readonly number[]
  max: readonly number[]
}

export function boxCentre(b: BoxLike): Vector3 {
  return new Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2)
}

/** Half the box diagonal: the radius of the sphere through its corners. */
export function boxRadius(b: BoxLike): number {
  return Math.max(1e-6, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2)
}

/** Centred on the box, looking at its centre from ENTRY_RADII × its radius, front and a little above. */
export function defaultEntryPose(frame: BoxLike, upFix: Quat = IDENTITY_QUAT): Pose {
  const toNative = new Quaternion(...upFix).normalize().invert()
  const centre = boxCentre(frame)
  const up = new Vector3(0, 1, 0).applyQuaternion(toNative)
  const dir = new Vector3(0, Math.sin(ENTRY_ELEVATION), Math.cos(ENTRY_ELEVATION)).applyQuaternion(toNative)
  const eye = centre.clone().addScaledVector(dir, ENTRY_RADII * boxRadius(frame))
  const q = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(eye, centre, up))
  return { position: round(eye.toArray()), quaternion: round(q.toArray()) as Quat }
}

/** A native-frame pose seen through a mesh rotated by upFix (mesh at the origin, scale 1). */
export function poseInDisplayFrame(pose: Pose, upFix: Quat): { position: Vector3; quaternion: Quaternion } {
  const fix = new Quaternion(...upFix).normalize()
  return {
    position: new Vector3(...pose.position).applyQuaternion(fix),
    quaternion: fix.clone().multiply(new Quaternion(...pose.quaternion).normalize()),
  }
}

function round<T extends number[]>(v: T): T {
  return v.map((x) => Math.round(x * 1e6) / 1e6) as T
}

export function isQuat(q: unknown): q is Quat {
  return Array.isArray(q) && q.length === 4 && q.every(Number.isFinite) && Math.hypot(...q) > 1e-6
}

export function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)
}
