import { Matrix4, Quaternion, Vector3, type Object3D } from 'three'
import type { Pose, Quat, Vec3 } from '../../domain/types.ts'

// Fly-in / fly-out geometry and the flight state machine (PLAN "Rendering specifics → Fly-in").
// Pure (three math only, no Spark, no React) so tests can drive it; FlyInRig applies it.
//
//   'entering'  approach: the camera glides to the entry pose while the diorama's content
//               (the non-LoD proxy, clipped) grows exponentially, s = G^e(u), ABOUT the entry
//               point, so that point stays put in the world and the scene swells around the
//               camera. The world group stays visible. lodSplatScale is lowered meanwhile.
//               arrive: at rest, crossfade proxy → focused lod:true interior, then 'interior'.
//   'interior'  InteriorRig: world group hidden, SparkControls 6-DOF with roll.
//   'exiting'   the exact reverse: return to the entry pose while the interior fades back to
//               the proxy, then shrink (u: 1 → 0) while the camera retreats to where it
//               started, then orbit at the memory.
//
// Units: a block's crop and entry pose are in native splat units (the mesh-local frame; the
// SplatEdit BOX lives there too). upFix rotates native → display ("up is +Y").

export const FLIGHT = {
  /** Approach duration bounds (s); the actual one grows with the starting distance. */
  minSeconds: 1.6,
  maxSeconds: 3.2,
  /** Proxy ⇄ interior crossfade (s). */
  fadeSeconds: 0.8,
  /** Exit: glide back to the entry pose (s). */
  returnSeconds: 0.7,
  /** World units per native unit once inside (captures are roughly metric). */
  interiorUnitsPerNative: 1,
  /** Bounds on the growth factor G (S1 tested 12×). */
  minGrowth: 4,
  maxGrowth: 400,
  /** SparkRenderer.lodSplatScale while the scale tween runs (S1: 1 → 0.5 lowers GPU time). */
  tweenLodScale: 0.5,
  /** Give up waiting for the interior at rest and enter on the proxy (s). */
  interiorWaitSeconds: 12,
  /** Interior flight speed, native units / s (Shift ×5, Ctrl ×0.2 as in Spark). */
  interiorMoveSpeed: 1.2,
} as const

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
export const smoothstep = (x: number) => {
  const t = clamp01(x)
  return t * t * (3 - 2 * t)
}
const smootherstep = (x: number) => {
  const t = clamp01(x)
  return t * t * t * (t * (6 * t - 15) + 10)
}

/** Camera position easing along the path. */
export const easePosition = (u: number) => smootherstep(u)
/** The camera turns to the entry orientation early, before the dive. */
export const easeTurn = (u: number) => smoothstep(u / 0.6)
/** The scale waits for the first fifth of the approach, then grows. */
export const easeScale = (u: number) => smoothstep((u - 0.2) / 0.8)

/** Exponential scale tween: 1 at u = 0, G at u = 1. */
export function flightScale(u: number, growth: number): number {
  return Math.pow(growth, easeScale(u))
}

/** Approach duration for a camera starting `distance` world units from the entry point. */
export function flightSeconds(distance: number): number {
  const s = FLIGHT.minSeconds + 0.35 * Math.log1p(Math.max(0, distance) / 4)
  return Math.min(FLIGHT.maxSeconds, Math.max(FLIGHT.minSeconds, s))
}

/** G such that a scene drawn at `worldPerNative` ends at FLIGHT.interiorUnitsPerNative. */
export function growthFor(worldPerNative: number): number {
  const g = FLIGHT.interiorUnitsPerNative / Math.max(worldPerNative, 1e-9)
  return Math.min(FLIGHT.maxGrowth, Math.max(FLIGHT.minGrowth, g))
}

// ─── fitting a block into the tesseract ──────────────────────────────────────────────

export interface Box {
  min: Vec3
  max: Vec3
}

export interface DioramaFit {
  /** upFix (native → display). */
  quaternion: Quaternion
  /** World units per native unit at node scale 1. */
  scale: number
  /** Puts the box centre at the origin of the fit's parent. */
  position: Vector3
  /** Box centre and half-size in native units (the SplatEdit BOX frame). */
  centre: Vector3
  half: Vector3
}

export function toQuaternion(q: Quat | null | undefined, out = new Quaternion()): Quaternion {
  if (!q || q.length !== 4 || q.some((v) => !Number.isFinite(v))) return out.identity()
  out.set(q[0], q[1], q[2], q[3])
  const len = out.length()
  return len < 1e-6 ? out.identity() : out.normalize()
}

/**
 * Uniform scale + rotation + offset that fits the upFix-rotated box inside a cube of half-size
 * `half`, centred. The rotated half-extent is |R|·h (exact for any rotation).
 */
export function fitBox(box: Box, upFix: Quat, half: number): DioramaFit {
  const quaternion = toQuaternion(upFix)
  const centre = new Vector3((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2)
  const h = new Vector3(
    Math.abs(box.max[0] - box.min[0]) / 2,
    Math.abs(box.max[1] - box.min[1]) / 2,
    Math.abs(box.max[2] - box.min[2]) / 2,
  )
  const e = new Matrix4().makeRotationFromQuaternion(quaternion).elements
  // Column-major: row r of R is (e[r], e[4 + r], e[8 + r]).
  let maxHalf = 1e-6
  for (let r = 0; r < 3; r++) {
    const ext = Math.abs(e[r]) * h.x + Math.abs(e[4 + r]) * h.y + Math.abs(e[8 + r]) * h.z
    if (ext > maxHalf) maxHalf = ext
  }
  const scale = half / maxHalf
  const position = centre.clone().applyQuaternion(quaternion).multiplyScalar(-scale)
  return { quaternion, scale, position, centre, half: h }
}

/** The fit as a local matrix (what the fit group carries). */
export function fitMatrix(fit: DioramaFit, out = new Matrix4()): Matrix4 {
  return out.compose(fit.position, fit.quaternion, new Vector3(fit.scale, fit.scale, fit.scale))
}

// ─── poses in the splat frame ────────────────────────────────────────────────────────

export interface CameraPose {
  position: Vector3
  quaternion: Quaternion
}

const _s = new Vector3()
const _q = new Quaternion()

/** World pose of a splat-local entry pose, given the mesh's world matrix. */
export function entryWorld(meshWorld: Matrix4, entry: Pose, out: CameraPose = { position: new Vector3(), quaternion: new Quaternion() }): CameraPose {
  const p = entry.position
  out.position.set(p?.[0] ?? 0, p?.[1] ?? 0, p?.[2] ?? 0)
  if (!out.position.toArray().every(Number.isFinite)) out.position.set(0, 0, 0)
  out.position.applyMatrix4(meshWorld)
  meshWorld.decompose(_s.set(0, 0, 0), _q, new Vector3())
  out.quaternion.copy(_q).multiply(toQuaternion(entry.quaternion))
  return out
}

/** Inverse of entryWorld: the camera expressed in the splat's native frame. */
export function captureEntryPose(meshWorld: Matrix4, camera: CameraPose, fov?: number): Pose {
  const inv = meshWorld.clone().invert()
  const p = camera.position.clone().applyMatrix4(inv)
  const meshQuat = new Quaternion()
  meshWorld.decompose(new Vector3(), meshQuat, new Vector3())
  const q = meshQuat.invert().multiply(camera.quaternion).normalize()
  const pose: Pose = { position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w] }
  if (fov !== undefined) pose.fov = fov
  return pose
}

// ─── up-fix and crop editing (framing) ───────────────────────────────────────────────

export type UpFixOp = '+x' | '-x' | '+z' | '-z' | 'flip'

const AXIS_X = new Vector3(1, 0, 0)
const AXIS_Z = new Vector3(0, 0, 1)

/** Rotate the display frame: the op is about a WORLD axis, applied after the current fix. */
export function applyUpFixOp(q: Quat, op: UpFixOp): Quat {
  const r = new Quaternion()
  if (op === '+x') r.setFromAxisAngle(AXIS_X, Math.PI / 2)
  else if (op === '-x') r.setFromAxisAngle(AXIS_X, -Math.PI / 2)
  else if (op === '+z') r.setFromAxisAngle(AXIS_Z, Math.PI / 2)
  else if (op === '-z') r.setFromAxisAngle(AXIS_Z, -Math.PI / 2)
  else r.setFromAxisAngle(AXIS_X, Math.PI)
  const out = r.multiply(toQuaternion(q)).normalize()
  // Snap float dust so repeated quarter turns stay exact (0, ±0.5, ±√½, ±1).
  const snap = (v: number) => {
    for (const k of [0, 0.5, Math.SQRT1_2, 1]) {
      if (Math.abs(Math.abs(v) - k) < 1e-9) return Math.sign(v) * k
    }
    return v
  }
  return [snap(out.x), snap(out.y), snap(out.z), snap(out.w)]
}

/** Minimum crop extent per axis (native units). */
export const MIN_CROP_EXTENT = 1e-3

/** Order and separate min/max per axis; non-finite values fall back to `fallback`. */
export function normalizeCrop(box: Box, fallback: Box): Box {
  const min: Vec3 = [0, 0, 0]
  const max: Vec3 = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    let a = Number.isFinite(box.min[i]) ? box.min[i] : fallback.min[i]
    let b = Number.isFinite(box.max[i]) ? box.max[i] : fallback.max[i]
    if (a > b) [a, b] = [b, a]
    if (b - a < MIN_CROP_EXTENT) {
      const c = (a + b) / 2
      a = c - MIN_CROP_EXTENT / 2
      b = c + MIN_CROP_EXTENT / 2
    }
    min[i] = a
    max[i] = b
  }
  return { min, max }
}

// ─── the flight ─────────────────────────────────────────────────────────────────────

export interface FlightPlan {
  id: string
  /** World matrix of the diorama content at rest in its slot, captured at departure. */
  base: Matrix4
  /** World entry point: the fixed point of the scale tween and the camera's destination. */
  pivot: Vector3
  /** Camera orientation at rest (world). */
  entryQuat: Quaternion
  growth: number
  /** Camera pose at departure (the exit returns here). */
  start: CameraPose
  /** Memory centre (world), for the orbit handoff after the exit. */
  centre: Vector3
  /** Approach duration (s). */
  seconds: number
}

export interface PlanInput {
  id: string
  base: Matrix4
  /** Fit-group local matrix (base × fit = the mesh's world matrix at rest). */
  fit: Matrix4
  entry: Pose
  camera: CameraPose
  centre: Vector3
}

export function planFlight(input: PlanInput): FlightPlan {
  const meshWorld = input.base.clone().multiply(input.fit)
  const e = entryWorld(meshWorld, input.entry)
  // World units per native unit at departure: the mesh's (uniform) world scale.
  meshWorld.decompose(new Vector3(), new Quaternion(), _s)
  const growth = growthFor(Math.abs(_s.x))
  return {
    id: input.id,
    base: input.base.clone(),
    pivot: e.position.clone(),
    entryQuat: e.quaternion.clone(),
    growth,
    start: { position: input.camera.position.clone(), quaternion: input.camera.quaternion.clone() },
    centre: input.centre.clone(),
    seconds: flightSeconds(input.camera.position.distanceTo(e.position)),
  }
}

const _t = new Matrix4()
const _sc = new Matrix4()

/** Content world matrix at scale s about the pivot: T(p)·S(s)·T(−p)·base. */
export function contentMatrix(plan: FlightPlan, s: number, out = new Matrix4()): Matrix4 {
  const p = plan.pivot
  out.makeTranslation(p.x, p.y, p.z)
  out.multiply(_sc.makeScale(s, s, s))
  out.multiply(_t.makeTranslation(-p.x, -p.y, -p.z))
  return out.multiply(plan.base)
}

/** Camera on the approach path at u. */
export function cameraOnPath(plan: FlightPlan, u: number, out: CameraPose): CameraPose {
  out.position.copy(plan.start.position).lerp(plan.pivot, easePosition(u))
  out.quaternion.copy(plan.start.quaternion).slerp(plan.entryQuat, easeTurn(u))
  return out
}

export type FlightPhase = 'idle' | 'approach' | 'arrive' | 'inside' | 'return' | 'retreat'

export interface FlightState {
  phase: FlightPhase
  /** Path parameter: 0 = departure pose / scale 1, 1 = entry pose / scale G. */
  u: number
  /** Seconds spent in the current phase. */
  t: number
  /** Proxy ⇄ interior blend the diorama should head for (0 proxy, 1 interior). */
  blendTarget: 0 | 1
  /** Camera pose when the exit started (the 'return' glide starts here). */
  returnFrom: CameraPose
}

export function newFlightState(): FlightState {
  return { phase: 'idle', u: 0, t: 0, blendTarget: 0, returnFrom: { position: new Vector3(), quaternion: new Quaternion() } }
}

export interface FlightInput {
  /** 'in' while the mode is entering, 'out' while exiting. */
  dir: 'in' | 'out'
  dt: number
  seconds: number
  /** The interior can be shown (loaded, LoD tree live). */
  interiorReady: boolean
  /** An interior is still on its way (false: none, or it failed). */
  interiorPending: boolean
  /** The diorama's current blend (it animates toward blendTarget). */
  blend: number
}

/** 'inside': arrived (switch to interior). 'out': the exit finished (switch to orbit). */
export type FlightEvent = 'none' | 'inside' | 'out'

/**
 * Advance the flight by one frame. The caller snapshots the camera into returnFrom before the
 * first 'out' step from 'arrive'/'inside' (the 'return' glide starts from wherever the user
 * flew to in the interior).
 */
export function stepFlight(s: FlightState, i: FlightInput): FlightEvent {
  const dt = Math.max(0, Math.min(i.dt, 0.1))
  s.t += dt
  if (i.dir === 'in') {
    switch (s.phase) {
      case 'idle':
      case 'retreat':
      case 'return':
        s.phase = 'approach'
        s.t = 0
        s.blendTarget = 0
        return 'none'
      case 'approach':
        s.u = Math.min(1, s.u + dt / Math.max(i.seconds, 1e-3))
        if (s.u >= 1) {
          s.phase = 'arrive'
          s.t = 0
        }
        return 'none'
      case 'arrive':
        if (i.interiorReady) {
          s.blendTarget = 1
          if (i.blend >= 1) return enter(s)
        } else if (!i.interiorPending || s.t >= FLIGHT.interiorWaitSeconds) {
          // No interior (or it is taking too long): enter on the proxy. The diorama keeps
          // blendTarget 1 and fades the interior in whenever it becomes ready.
          s.blendTarget = 1
          return enter(s)
        }
        return 'none'
      case 'inside':
        return 'none'
    }
  }
  switch (s.phase) {
    case 'idle':
      return 'out'
    case 'approach':
      s.phase = 'retreat'
      s.t = 0
      s.blendTarget = 0
      return 'none'
    case 'arrive':
    case 'inside':
      s.phase = 'return'
      s.t = 0
      s.blendTarget = 0
      return 'none'
    case 'return':
      if (s.t >= FLIGHT.returnSeconds && i.blend <= 0) {
        s.phase = 'retreat'
        s.t = 0
      }
      return 'none'
    case 'retreat':
      s.u = Math.max(0, s.u - dt / Math.max(i.seconds, 1e-3))
      if (s.u <= 0) {
        s.phase = 'idle'
        s.t = 0
        return 'out'
      }
      return 'none'
  }
}

function enter(s: FlightState): FlightEvent {
  s.phase = 'inside'
  s.t = 0
  return 'inside'
}

/** Camera during the exit's 'return' glide (returnFrom → entry pose). */
export function cameraOnReturn(plan: FlightPlan, s: FlightState, out: CameraPose): CameraPose {
  const k = smoothstep(s.t / FLIGHT.returnSeconds)
  out.position.copy(s.returnFrom.position).lerp(plan.pivot, k)
  out.quaternion.copy(s.returnFrom.quaternion).slerp(plan.entryQuat, k)
  return out
}

// ─── the world group (hidden inside a diorama and while framing) ─────────────────────

/** Top-level scene groups that make up "the world" (environment, nodes, links, dust, overlays). */
export const WORLD_GROUP_NAMES: ReadonlySet<string> = new Set(['environment', 'node-layer', 'links', 'dust', 'overlays'])

let hiddenByUs: Object3D[] = []

/**
 * Hide/show the world group. Only objects this call hid are shown again, so a group another
 * module hid on purpose stays hidden.
 */
export function setWorldHidden(scene: Object3D, hidden: boolean): void {
  if (hidden) {
    for (const c of scene.children) {
      if (WORLD_GROUP_NAMES.has(c.name) && c.visible) {
        c.visible = false
        hiddenByUs.push(c)
      }
    }
    return
  }
  for (const o of hiddenByUs) o.visible = true
  hiddenByUs = []
}

export function isWorldHidden(): boolean {
  return hiddenByUs.length > 0
}
