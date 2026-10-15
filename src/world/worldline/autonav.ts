import type { WorldlinePath } from './path.ts'

// Autonav: the camera rides the worldline from the earliest memory to the latest. Pure
// math on {x, y, z} so it runs in node tests; AutonavRig applies it to the camera.
//
// The ride point moves along the curve by arc length. Speed is sized to the curve (a
// short worldline is not crossed in two seconds, a long one not in ten minutes), eases
// in and out at the ends and slows near each memory so the eye can land on it. The
// camera trails the ride point, lifted and pushed out from the column axis, and looks
// at a point further down the curve; both are exponentially damped, which gives the
// "gentle look-ahead": turns are anticipated and never snapped.

export interface Vec3Like {
  x: number
  y: number
  z: number
  set(x: number, y: number, z: number): unknown
}

export interface AutonavOptions {
  /** Target ride duration (s) at cruise speed; speed = length / duration, clamped. */
  readonly duration: number
  readonly minSpeed: number
  readonly maxSpeed: number
  /** Ease-in/out time at the ends (s). */
  readonly ease: number
  /** Speed factor at a memory, rising to 1 at `slowRadius` along the curve. */
  readonly slowFactor: number
  readonly slowRadius: number
  /** Camera trails the ride point by this arc length. */
  readonly trail: number
  /** Look target leads the ride point by this arc length. */
  readonly lookAhead: number
  /** Camera height above the curve and radial push away from the column axis (u). */
  readonly lift: number
  readonly push: number
  /** Damping time constants (s) for the camera position and the look target. */
  readonly tauPos: number
  readonly tauLook: number
}

export const AUTONAV_DEFAULTS: AutonavOptions = {
  duration: 75,
  minSpeed: 2.5,
  maxSpeed: 14,
  ease: 2.5,
  slowFactor: 0.4,
  slowRadius: 6,
  trail: 7,
  lookAhead: 14,
  lift: 2.6,
  push: 4.5,
  tauPos: 0.45,
  tauLook: 0.9,
}

const smoothstep = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))

/** Exponential damping factor for a frame of dt seconds at time constant tau. */
export function dampFactor(dt: number, tau: number): number {
  return tau <= 0 ? 1 : 1 - Math.exp(-dt / tau)
}

/** The ride's state; one per autonav session. */
export class AutonavRide {
  /** Arc length of the ride point. */
  s = 0
  /** Seconds since the ride started. */
  t = 0
  done = false
  readonly opts: AutonavOptions
  readonly camera = { x: 0, y: 0, z: 0 }
  readonly look = { x: 0, y: 0, z: 0 }
  private primed = false
  private readonly p = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z } }
  private readonly tan = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z } }

  constructor(opts: Partial<AutonavOptions> = {}) {
    this.opts = { ...AUTONAV_DEFAULTS, ...opts }
  }

  /** Start the damped camera and look target from the camera's current pose. */
  prime(cameraPos: { x: number; y: number; z: number }, lookAt: { x: number; y: number; z: number }): void {
    this.camera.x = cameraPos.x
    this.camera.y = cameraPos.y
    this.camera.z = cameraPos.z
    this.look.x = lookAt.x
    this.look.y = lookAt.y
    this.look.z = lookAt.z
    this.primed = true
  }

  /** Cruise speed for a curve of this length (u/s). */
  cruiseSpeed(length: number): number {
    const o = this.opts
    return Math.min(o.maxSpeed, Math.max(o.minSpeed, length / o.duration))
  }

  /** Speed at arc length s at ride time t on `path` (u/s). */
  speedAt(path: WorldlinePath, s: number, t: number): number {
    const o = this.opts
    const cruise = this.cruiseSpeed(path.length)
    const easeIn = 0.15 + 0.85 * smoothstep(t / o.ease)
    // Brake over the last cruise·ease units, but never to a standstill before the end.
    const remaining = path.length - s
    const easeOut = 0.12 + 0.88 * smoothstep(remaining / Math.max(1e-6, cruise * o.ease))
    const near = path.knots > 0 ? path.distanceToKnot(s) : Infinity
    const slow = o.slowFactor + (1 - o.slowFactor) * smoothstep(near / o.slowRadius)
    return cruise * Math.min(easeIn, easeOut) * slow
  }

  /**
   * Advance by dt seconds along `path` and update the damped camera and look target.
   * Returns false once the ride has reached the end of the curve (it then holds there).
   */
  update(dt: number, path: WorldlinePath): boolean {
    const o = this.opts
    if (path.count === 0) return false
    const d = Math.min(Math.max(dt, 0), 0.1)
    this.t += d
    if (this.s > path.length) this.s = path.length
    if (!this.done) {
      this.s += this.speedAt(path, this.s, this.t) * d
      if (this.s >= path.length) {
        this.s = path.length
        this.done = true
      }
    }
    // Desired camera: trailing point on the curve, lifted and pushed out from the axis.
    const p = this.p
    path.pointAt(this.s - o.trail, p)
    let rx = p.x
    let rz = p.z
    let r = Math.hypot(rx, rz)
    if (r < 1e-3) {
      // On the axis: push sideways from the tangent instead.
      path.tangentAt(this.s, this.tan)
      rx = -this.tan.z
      rz = this.tan.x
      r = Math.hypot(rx, rz) || 1
      if (Math.hypot(rx, rz) < 1e-6) {
        rx = 1
        rz = 0
        r = 1
      }
    }
    const cx = p.x + (rx / r) * o.push
    const cy = p.y + o.lift
    const cz = p.z + (rz / r) * o.push
    path.pointAt(this.s + o.lookAhead, p)
    if (!this.primed) this.prime({ x: cx, y: cy, z: cz }, p)
    const kp = dampFactor(d, o.tauPos)
    const kl = dampFactor(d, o.tauLook)
    this.camera.x += (cx - this.camera.x) * kp
    this.camera.y += (cy - this.camera.y) * kp
    this.camera.z += (cz - this.camera.z) * kp
    this.look.x += (p.x - this.look.x) * kl
    this.look.y += (p.y - this.look.y) * kl
    this.look.z += (p.z - this.look.z) * kl
    return !this.done
  }

  /** Fraction of the curve ridden, in [0, 1]. */
  progress(path: WorldlinePath): number {
    return path.length > 0 ? Math.min(1, this.s / path.length) : 1
  }
}
