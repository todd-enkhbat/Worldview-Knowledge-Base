/** Pure 2D presentation. These coordinates never enter NodeRecord, physics, or saved links. */
export interface GraphPosition { x: number; y: number }
export interface GraphCamera { x: number; y: number; scale: number }
export interface GraphLayoutNode { key: string; kind: 'source' | 'topic' }
export interface GraphLayoutEdge { id: string; from: string; to: string }
export interface GraphFrame { positions: Map<string, GraphPosition>; camera: GraphCamera; progress: number; entering: Set<string>; geometryChanged?: boolean }
interface LabelCandidate { key: string; title: string; point: GraphPosition; radius: number; priority: number }
export interface LabelPlacement { x: number; y: number; anchor: 'middle' | 'start' | 'end' }
interface Box { left: number; top: number; right: number; bottom: number }
const intersects = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/** Work in screen pixels so a readable label keeps its footprint at any zoom. */
export function placeGraphLabels(nodes: LabelCandidate[], width: number, height: number, reserved: Box[] = [], limit = Infinity) {
  const placed = new Map<string, LabelPlacement>()
  const occupied = [...reserved, ...nodes.map(({ point, radius }) => ({
    left: point.x - radius - 2, right: point.x + radius + 2, top: point.y - radius - 2, bottom: point.y + radius + 2,
  }))]
  for (const { key, title, point, radius } of [...nodes].sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key))) {
    if (placed.size >= limit) break
    const size = [...title].reduce((total, char) => total + (/[MWasQG@%]/.test(char) ? 10 : /[lij .,’]/.test(char) ? 4 : (char.codePointAt(0) ?? 0) > 255 ? 13 : 8), 8)
    const options: LabelPlacement[] = [
      { x: 0, y: radius + 18, anchor: 'middle' }, { x: 0, y: -radius - 7, anchor: 'middle' },
      { x: radius + 8, y: 4, anchor: 'start' }, { x: -radius - 8, y: 4, anchor: 'end' },
    ]
    for (const option of options) {
      const left = point.x + option.x - (option.anchor === 'middle' ? size / 2 : option.anchor === 'end' ? size : 0)
      const top = point.y + option.y - 13
      const box = { left: left - 2, top: top - 1, right: left + size + 2, bottom: top + 17 }
      if (box.left < 3 || box.right > width - 3 || box.top < 3 || box.bottom > height - 3 || occupied.some(other => intersects(box, other))) continue
      placed.set(key, option)
      occupied.push(box)
      break
    }
  }
  return placed
}
const finite = (point: GraphPosition | undefined): point is GraphPosition => !!point && Number.isFinite(point.x) && Number.isFinite(point.y)
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
function seed(key: string) { let value = 2166136261; for (const code of key) value = Math.imul(value ^ code.charCodeAt(0), 16777619); return (value >>> 0) / 4294967296 }

export function graphTopology(nodes: readonly GraphLayoutNode[], edges: readonly GraphLayoutEdge[]): string { return `${nodes.map((node) => node.key).sort().join('\n')}\n|\n${edges.map((edge) => `${edge.id}:${edge.from}:${edge.to}`).sort().join('\n')}` }

/** Warm starts preserve the mental map; a bounded relaxation settles once, without ambient simulation. */
export function layoutGraph(nodes: readonly GraphLayoutNode[], edges: readonly GraphLayoutEdge[], previous: ReadonlyMap<string, GraphPosition> = new Map(), pins: ReadonlyMap<string, GraphPosition> = new Map()): Map<string, GraphPosition> {
  const ordered = [...nodes].slice(0, 320).sort((a, b) => a.key.localeCompare(b.key)), index = new Map(ordered.map((node, i) => [node.key, i]))
  const links = edges.slice(0, 400).filter((edge) => index.has(edge.from) && index.has(edge.to))
  const neighbors = new Map<string, string[]>()
  for (const edge of links) { const a = neighbors.get(edge.from) ?? [], b = neighbors.get(edge.to) ?? []; a.push(edge.to); b.push(edge.from); neighbors.set(edge.from, a); neighbors.set(edge.to, b) }
  // Seed disconnected groups around separate centers. Only saved links determine membership.
  const components: string[][] = [], seen = new Set<string>()
  for (const {key} of ordered) {
    if (seen.has(key)) continue
    const members = [key]; seen.add(key)
    for (const member of members) for (const next of neighbors.get(member) ?? []) {
      if (!seen.has(next)) { seen.add(next);members.push(next) }
    }
    components.push(members)
  }
  components.sort((a,b)=>b.length-a.length || a[0].localeCompare(b[0]))
  const centers = new Map<string,GraphPosition>()
  const distance = 125*Math.sqrt(components[0]?.length ?? 1)
  components.forEach((component,i)=>{
    const angle = i*2.39996, radius = Math.sqrt(i)*distance
    const center = {x:radius*Math.cos(angle)*1.25,y:radius*Math.sin(angle)*.85}
    for (const key of component) centers.set(key,center)
  })
  const positions = new Map<string, GraphPosition>()
  // A newly opened local graph often has one source and several tags. Give each
  // spoke its own angle instead of allowing near-parallel lines out of its hub.
  const hub = ordered.length >= 4 && ordered.length <= 18
    ? ordered.find(node => new Set(neighbors.get(node.key)).size === ordered.length - 1) : undefined
  if (hub && !ordered.some(node => previous.has(node.key) || pins.has(node.key))) {
    positions.set(hub.key, { x: 0, y: 0 })
    const rim = ordered.filter(node => node !== hub)
    rim.forEach((node, index) => {
      const angle = (index + .375) * 2 * Math.PI / rim.length
      positions.set(node.key, { x: Math.cos(angle) * 212, y: Math.sin(angle) * 162 })
    })
  }
  for (const node of ordered) {
    if (positions.has(node.key)) continue
    const pin = pins.get(node.key), old = previous.get(node.key)
    if (finite(pin) || finite(old)) { positions.set(node.key, { ...(finite(pin) ? pin : old!) }); continue }
    const known = (neighbors.get(node.key) ?? []).map((key) => pins.get(key) ?? previous.get(key)).filter(finite)
    const value = seed(node.key), angle = value * Math.PI * 2
    const center = known.length ? { x: known.reduce((sum, point) => sum + point.x, 0) / known.length, y: known.reduce((sum, point) => sum + point.y, 0) / known.length } : centers.get(node.key)!
    const radius = known.length ? 90 + seed(`${node.key}:radius`) * 70 : 110 + seed(`${node.key}:radius`) * Math.max(180, Math.sqrt(neighbors.get(node.key)?.length ?? 1) * 55)
    positions.set(node.key, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius })
  }
  const x = Float64Array.from(ordered, (node) => positions.get(node.key)!.x), y = Float64Array.from(ordered, (node) => positions.get(node.key)!.y)
  const fx = new Float64Array(ordered.length), fy = new Float64Array(ordered.length)
  for (let step = 0; step < 72; step++) {
    fx.fill(0); fy.fill(0)
    for (let a = 0; a < ordered.length; a++) for (let b = a + 1; b < ordered.length; b++) {
      const dx = x[a] - x[b] || .01, dy = y[a] - y[b] || .01, distance = Math.max(12, Math.hypot(dx, dy)), strength = Math.min(22, 7500 / (distance * distance))
      const px = dx / distance * strength, py = dy / distance * strength
      fx[a] += px; fy[a] += py; fx[b] -= px; fy[b] -= py
    }
    for (const edge of links) {
      const a = index.get(edge.from)!, b = index.get(edge.to)!, dx = x[b] - x[a], dy = y[b] - y[a], distance = Math.max(1, Math.hypot(dx, dy))
      const spring = (distance - 120) * .025
      fx[a] += dx / distance * spring; fy[a] += dy / distance * spring; fx[b] -= dx / distance * spring; fy[b] -= dy / distance * spring
    }
    const cooling = 1 - step / 90
    for (let a = 0; a < ordered.length; a++) {
      const node = ordered[a], pin = pins.get(node.key), old = previous.get(node.key)
      if (finite(pin)) { x[a] = pin.x; y[a] = pin.y; continue }
      // An existing position has a gentle restoring force when a neighborhood expands.
      const anchor = finite(old) ? old : centers.get(node.key)!, strength = finite(old) ? .18 : .016
      x[a] += clamp(fx[a] - (x[a] - anchor.x) * strength, -12, 12) * cooling
      y[a] += clamp(fy[a] - (y[a] - anchor.y) * strength, -12, 12) * cooling
    }
  }
  ordered.forEach((node, i) => positions.set(node.key, { x: x[i], y: y[i] }))
  return positions
}

export function fitGraphCamera(positions: ReadonlyMap<string, GraphPosition>, width: number, height: number): GraphCamera {
  const points = [...positions.values()].filter(finite)
  const minX = Math.min(0, ...points.map((point) => point.x)), maxX = Math.max(0, ...points.map((point) => point.x)), minY = Math.min(0, ...points.map((point) => point.y)), maxY = Math.max(0, ...points.map((point) => point.y))
  const scale = Math.min(1.5, Math.max(80, width - 180) / Math.max(220, maxX - minX), Math.max(80, height - 150) / Math.max(220, maxY - minY))
  return { x: width / 2 - (minX + maxX) / 2 * scale, y: height / 2 - (minY + maxY) / 2 * scale, scale: Math.max(.001, scale) }
}
export function focusGraphCamera(position: GraphPosition, width: number, height: number, scale: number): GraphCamera { return { x: width / 2 - position.x * scale, y: height / 2 - position.y * scale, scale } }
export function focusGraphNeighborhood(center: GraphPosition, adjacent: GraphPosition[], width: number, height: number, targetScale: number) {
  if (!adjacent.length) return focusGraphCamera(center, width, height, targetScale)
  const points = [center, ...adjacent]
  const left = Math.min(...points.map(p => p.x)), right = Math.max(...points.map(p => p.x))
  const top = Math.min(...points.map(p => p.y)), bottom = Math.max(...points.map(p => p.y))
  const marginX = Math.min(94, width * .19), marginY = Math.min(80, height * .19)
  const scale = Math.max(.001, Math.min(targetScale, (width - 2 * marginX) / Math.max(1, right - left), (height - 2 * marginY) / Math.max(1, bottom - top)))
  const camera = focusGraphCamera(center, width, height, scale)
  return {
    x: clamp(camera.x, marginX - left * scale, width - marginX - right * scale),
    y: clamp(camera.y, marginY - top * scale, height - marginY - bottom * scale),
    scale,
  }
}
export function graphPoint(client: GraphPosition, camera: GraphCamera): GraphPosition { return { x: (client.x - camera.x) / camera.scale, y: (client.y - camera.y) / camera.scale } }
export function zoomGraphCamera(camera: GraphCamera, factor: number, anchor: GraphPosition, min: number, max: number): GraphCamera { const scale = clamp(camera.scale * factor, min, max), point = graphPoint(anchor, camera); return { x: anchor.x - point.x * scale, y: anchor.y - point.y * scale, scale } }
export function graphCurve(from: GraphPosition, to: GraphPosition, offset: number): { d: string; x: number; y: number } { const dx = to.x - from.x, dy = to.y - from.y, distance = Math.max(1, Math.hypot(dx, dy)), x = (from.x + to.x) / 2 - dy / distance * offset, y = (from.y + to.y) / 2 + dx / distance * offset; return { d: `M${from.x},${from.y} Q${x},${y} ${to.x},${to.y}`, x: (from.x + to.x) / 2 - dy / distance * offset / 2, y: (from.y + to.y) / 2 + dx / distance * offset / 2 } }

export interface GraphScheduler { now(): number; request(callback: (time: number) => void): number; cancel(handle: number): void }
export const browserGraphScheduler = (): GraphScheduler => ({ now: () => performance.now(), request: (callback) => requestAnimationFrame(callback), cancel: (handle) => cancelAnimationFrame(handle) })

/** One finite transition, explicitly interruptible. No animation loop survives completion or cleanup. */
export class GraphPresentation {
  private handle: number | null = null
  private revision = 0
  frame: GraphFrame | null = null
  private scheduler: GraphScheduler
  constructor(scheduler: GraphScheduler = browserGraphScheduler()) { this.scheduler = scheduler }
  get running() { return this.handle !== null }
  stop(): void { this.revision++; if (this.handle !== null) this.scheduler.cancel(this.handle); this.handle = null }
  set(frame: GraphFrame): void { this.stop(); this.frame = frame }
  transition(positions: ReadonlyMap<string, GraphPosition>, camera: GraphCamera, render: (frame: GraphFrame) => void, options: { duration?: number; origins?: ReadonlyMap<string, GraphPosition> } = {}): void {
    this.stop()
    const previous = this.frame, target = new Map([...positions].map(([key, point]) => [key, { ...point }]))
    const entering = new Set(previous ? [...target.keys()].filter((key) => !previous.positions.has(key)) : [])
    const from = new Map([...target].map(([key, point]) => [key, { ...(previous?.positions.get(key) ?? options.origins?.get(key) ?? point) }]))
    const origin = previous?.camera ?? camera
    const geometryChanged = !previous || target.size !== previous.positions.size || [...target].some(([key,point]) => {
      const old = previous.positions.get(key)
      return !old || Math.abs(old.x-point.x) > .000001 || Math.abs(old.y-point.y) > .000001
    })
    const unchanged = !geometryChanged && Math.abs(origin.x-camera.x)<.000001 && Math.abs(origin.y-camera.y)<.000001 && Math.abs(origin.scale-camera.scale)<.000001
    const duration = previous && !unchanged ? clamp(options.duration ?? 460, 0, 1200) : 0
    const started = this.scheduler.now(), revision = this.revision
    const draw = (time: number) => {
      if (revision !== this.revision) return
      const progress = duration ? clamp((time - started) / duration, 0, 1) : 1, eased = 1 - Math.pow(1 - progress, 3)
      const interpolate = (a: number, b: number) => a + (b - a) * eased
      const frame: GraphFrame = { geometryChanged, positions: !geometryChanged ? target : new Map([...target].map(([key, point]) => { const old = from.get(key)!; return [key, { x: interpolate(old.x, point.x), y: interpolate(old.y, point.y) }] })), camera: { x: interpolate(origin.x, camera.x), y: interpolate(origin.y, camera.y), scale: interpolate(origin.scale, camera.scale) }, progress, entering }
      this.frame = frame; render(frame)
      if (progress < 1 && revision === this.revision) this.handle = this.scheduler.request(draw)
      else this.handle = null
    }
    draw(started)
  }
}
