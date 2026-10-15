import { Vector3 } from 'three'
import { HELIX_ARC_PER_Y, helixPoint, helixTangent, nearestSpurAt, sampleSpur, spurIndexOf, type WalkGraph } from './walkGraph.ts'

// Kinematic avatar on the walk graph. Pure state + step function, no React, no DOM, so the
// rules can be unit-tested and so the state survives mode switches (re-entering third person
// resumes where the walker left off).

export const WALK_SPEED = 4.5
export const RUN_SPEED = 13
/** How close (along the path) the avatar must be to a spur's attachment to step onto it. */
export const SPUR_REACH = 1.5

export interface AvatarInput {
  /** +1 forward (up the helix / out along a spur), −1 back, 0 idle. */
  move: number
  run: boolean
  /** Edge-triggered A/D (or ←/→) press since the last step. */
  side: boolean
}

export interface AvatarState {
  placed: boolean
  /** Height on the helix (meaningful while on the helix, and the return point from a spur). */
  y: number
  /** Index into graph.spurs, or −1 on the helix. */
  spur: number
  /** nodeId of the current spur, so a rebuilt graph can re-resolve the index. */
  spurNode: string | null
  /** Arc length along the current spur. */
  s: number
  /** Last direction of travel: +1 or −1. Sets which way the body faces. */
  dir: number
  /** World position of the feet. */
  pos: Vector3
  /** Unit facing direction (direction of travel). */
  facing: Vector3
  /** True while the last step moved. */
  moving: boolean
}

export function createAvatarState(): AvatarState {
  return {
    placed: false,
    y: 0,
    spur: -1,
    spurNode: null,
    s: 0,
    dir: 1,
    pos: new Vector3(),
    facing: new Vector3(1, 0, 0),
    moving: false,
  }
}

/** The one walker. Module-level so it outlives the AvatarRig mount (mode switches). */
export const avatar = createAvatarState()

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/** Put the avatar on the helix at the height nearest `y`. */
export function placeAvatar(a: AvatarState, graph: WalkGraph, y: number): void {
  a.placed = true
  a.y = clamp(y, graph.yMin, graph.yMax)
  a.spur = -1
  a.spurNode = null
  a.s = 0
  resolvePose(a, graph)
}

/** Re-resolve indices after the graph was rebuilt (nodes added/removed). */
export function rebindAvatar(a: AvatarState, graph: WalkGraph): void {
  if (a.spurNode !== null) {
    const i = spurIndexOf(graph, a.spurNode)
    if (i < 0) {
      a.spur = -1
      a.spurNode = null
    } else {
      a.spur = i
      a.s = Math.min(a.s, graph.spurs[i].length)
    }
  }
  a.y = clamp(a.y, graph.yMin, graph.yMax)
  resolvePose(a, graph)
}

function resolvePose(a: AvatarState, graph: WalkGraph): void {
  if (a.spur >= 0) {
    sampleSpur(graph.spurs[a.spur], a.s, a.pos, a.facing)
    // A pier stair is vertical; keep facing the last horizontal heading there.
    if (Math.abs(a.facing.y) > 0.95) a.facing.copy(horizontalFacing(graph, a))
    a.facing.multiplyScalar(a.dir)
  } else {
    helixPoint(a.y, a.pos).y += graph.deckY
    helixTangent(a.y, a.facing).multiplyScalar(a.dir)
  }
}

const tmpDir = new Vector3()
/** Outward radial direction of the current spur (horizontal). */
function horizontalFacing(graph: WalkGraph, a: AvatarState): Vector3 {
  const pts = graph.spurs[a.spur].pts
  tmpDir.set(pts[3] - pts[0], 0, pts[5] - pts[2])
  const len = tmpDir.length()
  return len > 1e-6 ? tmpDir.multiplyScalar(1 / len) : tmpDir.set(1, 0, 0)
}

/** Advance one frame. Allocation-free. */
export function stepAvatar(a: AvatarState, graph: WalkGraph, input: AvatarInput, dt: number): void {
  const speed = input.run ? RUN_SPEED : WALK_SPEED
  const mv = Math.sign(input.move)
  a.moving = false

  if (a.spur < 0) {
    if (input.side) {
      const i = nearestSpurAt(graph, a.y, SPUR_REACH)
      if (i >= 0) {
        a.spur = i
        a.spurNode = graph.spurs[i].nodeId
        a.s = 0
        a.y = graph.spurs[i].attachY
        a.dir = 1
      }
    }
    if (a.spur < 0 && mv !== 0) {
      const ny = clamp(a.y + (mv * speed * dt) / HELIX_ARC_PER_Y, graph.yMin, graph.yMax)
      a.moving = ny !== a.y
      a.y = ny
      a.dir = mv
    }
  } else {
    const spur = graph.spurs[a.spur]
    // Step off sideways near the helix, or by walking back past the attachment.
    const stepOff = (input.side && a.s <= SPUR_REACH) || (mv < 0 && a.s <= 0)
    if (stepOff) {
      a.y = spur.attachY
      a.spur = -1
      a.spurNode = null
      a.s = 0
      if (mv !== 0) a.dir = mv
    } else if (mv !== 0) {
      const ns = clamp(a.s + mv * speed * dt, 0, spur.length)
      a.moving = ns !== a.s
      a.s = ns
      a.dir = mv
    }
  }
  resolvePose(a, graph)
}
