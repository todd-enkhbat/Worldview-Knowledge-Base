import type { WorldlinePath } from './path.ts'

// The history ride visits actual memory XYZ in date order. Its view follows the route,
// never a cylinder around a central axis; dates affect ordering, not spatial coordinates.
export interface Vec3Like { x: number; y: number; z: number; set(x: number, y: number, z: number): unknown }
export interface AutonavOptions {
  readonly duration: number
  readonly minSpeed: number
  readonly maxSpeed: number
  readonly ease: number
  readonly slowFactor: number
  readonly slowRadius: number
  readonly trail: number
  readonly lookAhead: number
  readonly lift: number
  /** Lateral viewing offset from the actual path, in world units. */
  readonly push: number
  readonly tauPos: number
  readonly tauLook: number
  /** Kept for callers of the former architectural tour. No origin cylinder exists. */
  readonly minRadius: number
  readonly minLookRadius: number
  readonly maxLookAngle: number
}
export const AUTONAV_STRUCTURE_RADIUS = 0
export const AUTONAV_CAMERA_RADIUS = 0
export const AUTONAV_DEFAULTS: AutonavOptions = {
  duration: 95, minSpeed: 8, maxSpeed: 28, ease: 2.5,
  slowFactor: .4, slowRadius: 12, trail: 10, lookAhead: 18,
  lift: 9, push: 7, tauPos: .55, tauLook: .8,
  minRadius: 0, minLookRadius: 0, maxLookAngle: Math.PI,
}
const smoothstep = (x: number) => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x)
export const dampFactor = (dt: number, tau: number) => tau <= 0 ? 1 : 1 - Math.exp(-dt / tau)

/** A side offset along the real route, with no radial/axis bias and no moved memory knots. */
export function navigationPointAt<T extends Vec3Like>(path: WorldlinePath, s: number, _minRadius: number, push: number, out: T): T {
  path.pointAt(s, out)
  if (push !== 0) {
    const tangent = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z } }
    path.tangentAt(s, tangent)
    const length = Math.hypot(tangent.x, tangent.z)
    out.x += (length > 1e-6 ? -tangent.z / length : 1) * push
    out.z += (length > 1e-6 ? tangent.x / length : 0) * push
  }
  return out
}

export class AutonavRide {
  s = 0
  t = 0
  done = false
  readonly opts: AutonavOptions
  readonly camera = { x: 0, y: 0, z: 0 }
  readonly look = { x: 0, y: 0, z: 0 }
  private primed = false
  private heading = 0
  private readonly p = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z } }
  constructor(opts: Partial<AutonavOptions> = {}) { this.opts = { ...AUTONAV_DEFAULTS, ...opts } }

  prime(camera: { x: number; y: number; z: number }, look: { x: number; y: number; z: number }): void {
    Object.assign(this.camera, camera)
    this.camera.y = Math.max(3, camera.y)
    Object.assign(this.look, look)
    this.heading = Math.atan2(look.x - camera.x, look.z - camera.z)
    this.clearLook(0)
    this.primed = true
  }

  private clearLook(dt: number): void {
    const dx = this.look.x - this.camera.x, dz = this.look.z - this.camera.z
    const candidate = Math.atan2(dx, dz)
    const delta = Math.atan2(Math.sin(candidate - this.heading), Math.cos(candidate - this.heading))
    if (dt > 0) this.heading += Math.max(-2 * dt, Math.min(2 * dt, delta))
    const distance = Math.max(2, Math.hypot(dx, dz))
    this.look.x = this.camera.x + Math.sin(this.heading) * distance
    this.look.z = this.camera.z + Math.cos(this.heading) * distance
  }
  cruiseSpeed(length: number): number { return Math.min(this.opts.maxSpeed, Math.max(this.opts.minSpeed, length / this.opts.duration)) }
  speedAt(path: WorldlinePath, s: number, t: number): number {
    const o = this.opts, cruise = this.cruiseSpeed(path.length)
    const easeIn = .15 + .85 * smoothstep(t / o.ease)
    const easeOut = .12 + .88 * smoothstep((path.length - s) / Math.max(1e-6, cruise * o.ease))
    const near = path.knots ? path.distanceToKnot(s) : Infinity
    return cruise * Math.min(easeIn, easeOut) * (o.slowFactor + (1 - o.slowFactor) * smoothstep(near / o.slowRadius))
  }
  update(dt: number, path: WorldlinePath): boolean {
    if (!path.count) return false
    const d = Math.min(.1, Math.max(0, dt)), o = this.opts
    this.t += d
    this.s = Math.min(this.s, path.length)
    if (!this.done) { this.s = Math.min(path.length, this.s + this.speedAt(path, this.s, this.t) * d); this.done = this.s >= path.length }
    const p = this.p
    navigationPointAt(path, this.s - o.trail, 0, o.push, p)
    const cx = p.x, cy = Math.max(3, p.y + o.lift), cz = p.z
    path.pointAt(this.s + o.lookAhead, p)
    if (!this.primed) this.prime({ x: cx, y: cy, z: cz }, p)
    const kp = dampFactor(d, o.tauPos), kl = dampFactor(d, o.tauLook)
    this.camera.x += (cx - this.camera.x) * kp
    this.camera.y += (cy - this.camera.y) * kp
    this.camera.z += (cz - this.camera.z) * kp
    this.look.x += (p.x - this.look.x) * kl
    this.look.y += (p.y - this.look.y) * kl
    this.look.z += (p.z - this.look.z) * kl
    this.clearLook(d)
    return !this.done
  }
  progress(path: WorldlinePath): number { return path.length > 0 ? Math.min(1, this.s / path.length) : 1 }
}
