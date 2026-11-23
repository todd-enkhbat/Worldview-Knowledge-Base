import type { PoseTable } from '../poses.ts'
import { sampleAgentRoute, type AgentPoint } from './model.ts'

export const AGENT_BODY_DIAMETER = 4.8
export const AGENT_BODY_PIXELS = 32
export const AGENT_ROUTE_SPEED = .6
export type AgentOverlayBox = readonly [number, number, number, number]
export interface AgentOffset { x: number; y: number }
export interface AgentScreenPoint { x: number; y: number; captionWidth: number }

/** Exponential damping is independent of frame rate and holds exactly while paused. */
export function smoothAgentOffset(current: AgentOffset, target: AgentOffset, delta: number, enabled: boolean, limit = 180): AgentOffset {
  if (!enabled || !Number.isFinite(delta) || delta <= 0) return { ...current }
  const blend = -Math.expm1(-4 * Math.min(delta, .1))
  let x = current.x + (target.x - current.x) * blend
  let y = current.y + (target.y - current.y) * blend
  const distance = Math.hypot(x, y)
  if (distance > limit) { x *= limit / distance; y *= limit / distance }
  return { x, y }
}

/** A minimal, bounded camera-plane sidestep; route samples and saved positions stay intact. */
export function agentPresentationOffset(point: AgentScreenPoint, others: readonly AgentScreenPoint[], boxes: readonly AgentOverlayBox[], height: number, maxShift: number, current: AgentOffset = { x: 0, y: 0 }): AgentOffset {
  const { x, y, captionWidth } = point
  const overlayY = agentOverlayShift(x, y, boxes, height, maxShift)
  const candidates = [{ x: 0, y: overlayY }, current]
  // Sample around actual preceding bodies, not predetermined display rows. Their
  // captions can also clear one another when the bounded neighborhood permits it.
  for (const other of others) for (const radius of [76.1, 106, 136]) for (let i = 0; i < 24; i++) {
    const angle = i * Math.PI / 12
    candidates.push({ x: other.x + Math.cos(angle) * radius - x, y: other.y + Math.sin(angle) * radius - y })
  }
  const hudClear = (p: AgentScreenPoint) => boxes.every(([left, top, right, bottom]) => p.x + 48 < left - 6 || p.x - 48 > right + 6 || p.y + 80 < top - 6 || p.y - 40 > bottom + 6)
  const bodyClear = (p: AgentScreenPoint) => others.every((other) => Math.hypot(p.x - other.x, p.y - other.y) >= 76)
  const overlap = (a: AgentOverlayBox, b: AgentOverlayBox) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
  const bodyBox = (p: AgentScreenPoint): AgentOverlayBox => [p.x - 38, p.y - 35, p.x + 38, p.y + 35]
  const captionBox = (p: AgentScreenPoint): AgentOverlayBox => [p.x - p.captionWidth / 2 - 4, p.y + 48, p.x + p.captionWidth / 2 + 4, p.y + 80]
  const captionsClear = (p: AgentScreenPoint) => others.every((other) => !overlap(captionBox(p), captionBox(other)) && !overlap(bodyBox(p), captionBox(other)) && !overlap(captionBox(p), bodyBox(other)))
  // Prefer continuing on the same side of a neighbor. Symmetric candidate costs used
  // to swap sides every frame, producing visible snaps even on a steady route.
  const cost = (p: AgentOffset) => (p.x - current.x) ** 2 + (p.y - current.y) ** 2 + .1 * (p.x * p.x + p.y * p.y)
  const valid = candidates.filter((shift) => Math.hypot(shift.x, shift.y) <= maxShift && hudClear({ x: x + shift.x, y: y + shift.y, captionWidth }))
    .sort((a, b) => cost(a) - cost(b))
  const clear = valid.filter((shift) => bodyClear({ x: x + shift.x, y: y + shift.y, captionWidth }))
  const origin = { x, y, captionWidth }
  if (hudClear(origin) && bodyClear(origin) && captionsClear(origin)) return { x: 0, y: 0 }
  return clear.find((shift) => captionsClear({ x: x + shift.x, y: y + shift.y, captionWidth })) ?? clear[0] ?? candidates[0]
}

/** Move a presentation avatar only far enough to clear a real HUD overlay. */
export function agentOverlayShift(x: number, y: number, boxes: readonly AgentOverlayBox[], height: number, maxShift: number): number {
  const blocked = boxes.filter(([left, , right]) => x + 48 > left && x - 48 < right)
  const clear = (shift: number) => y + shift - 40 >= 8 && y + shift + 80 <= height - 8
    && blocked.every(([, top, , bottom]) => y + shift + 80 < top - 6 || y + shift - 40 > bottom + 6)
  if (blocked.every(([, top, , bottom]) => y + 80 < top - 6 || y - 40 > bottom + 6)) return 0
  const candidates = blocked.flatMap(([, top, , bottom]) => [top - 87 - y, bottom + 47 - y])
    .filter((shift) => Math.abs(shift) <= maxShift && clear(shift))
    .sort((a, b) => Math.abs(a) - Math.abs(b))
  return candidates[0] ?? 0
}

/** A companion remains recognizable without growing enormous when inspected close up. */
export function agentBodyScale(depth: number, verticalFov: number, viewportHeight: number): number {
  const unitsPerPixel = 2 * Math.tan(verticalFov * Math.PI / 360) * Math.max(.1, depth) / Math.max(1, viewportHeight)
  return Math.max(.006, Math.min(80, AGENT_BODY_PIXELS * unitsPerPixel / AGENT_BODY_DIAMETER))
}

/** Ambient pause freezes travel, bobbing, articulated parts and their sampled trail. */
export function advanceAgentTime(seconds: number, delta: number, flow: boolean, active: boolean): number {
  return flow && active ? seconds + Math.max(0, Math.min(.1, Number.isFinite(delta) ? delta : 0)) : seconds
}

/** Local world-space patrol around actual born route points; never a screen-space lane. */
export function sampleAgentPresentation(
  ids: readonly string[], poses: Pick<PoseTable, 'index' | 'pos' | 'born'>,
  seconds: number, home: AgentPoint, index: number, out: AgentPoint,
): number {
  const t = Math.max(0, seconds)
  const visits = sampleAgentRoute(ids, poses, t * AGENT_ROUTE_SPEED, home, out)
  const phase = index * 2.399963
  const angle = t * .065 + phase
  const radius = 70 + Math.sin(t * .09 + phase) * 2
  out.x += Math.cos(angle) * radius
  out.z += Math.sin(angle) * radius
  out.y += 38 + Math.sin(phase) * 8 + Math.sin(t * .22 + phase) * 1.2
  return visits
}
