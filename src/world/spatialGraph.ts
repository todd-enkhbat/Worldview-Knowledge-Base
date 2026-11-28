import type { GraphEdge, GraphModel, GraphNode } from '../reading/graphModel.ts'

export type Point3 = [number, number, number]
export const GRAPH_DAY = 86_400_000

export function graphDay(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 8.64e15
    ? Math.floor(value / GRAPH_DAY)
    : undefined
}

export function graphHistory(model: GraphModel, now: number) {
  const today = graphDay(now)!
  const births = new Map<string, number>()
  for (const node of model.nodes) {
    const day = graphDay(node.at)
    if (day !== undefined) births.set(node.key, day)
  }
  for (const node of model.nodes) {
    if (births.has(node.key)) continue
    let earliest = Infinity
    for (const key of model.adjacent.get(node.key) ?? []) {
      const day = graphDay(model.byKey.get(key)?.at)
      if (day !== undefined) earliest = Math.min(earliest, day)
    }
    births.set(node.key, earliest === Infinity ? today : earliest)
  }
  const links = new Map(model.edges.map(edge => {
    const endpoints = Math.max(births.get(edge.from)!, births.get(edge.to)!)
    return [edge.id, Math.max(endpoints, graphDay(edge.at) ?? endpoints)]
  }))
  const dates = [...new Set([...births.values(), ...links.values(), today])].sort((a, b) => a - b)
  return { births, links, dates, start: dates[0], end: dates[dates.length - 1] }
}

export function graphAtDate(model: GraphModel, history: ReturnType<typeof graphHistory>, day: number) {
  return {
    nodes: model.nodes.filter(node => history.births.get(node.key)! <= day),
    edges: model.edges.filter(edge => history.links.get(edge.id)! <= day),
  }
}

export function graphNodeKind(node: GraphNode) {
  if (node.kind === 'topic') return 'topic'
  return node.writingId || node.source?.externalId?.startsWith('writing:') ? 'writing' : 'source'
}

export function graphEdgeColor(edge: GraphEdge) {
  const relation = edge.connection?.relation ?? edge.worldLink?.relation
  if (relation === 'contradicts') return '#f3929b'
  if (relation === 'supports') return '#85ebbd'
  if (relation === 'builds-on' || edge.origin === 'writing') return '#baa4f2'
  if (edge.origin === 'manual' || edge.origin === 'world') return '#9abfef'
  return '#7096ab'
}

export function graph2dHref(key?: string) {
  if (!key) return '#/graph'
  const param = key.startsWith('source:') ? 'source' : key.startsWith('writing:') ? 'writing' : 'topic'
  const id = key.startsWith('tag:') ? key : key.slice(param.length + 1)
  return '#/graph?' + new URLSearchParams({ [param]: id })
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
function spherePoint(index: number, count: number, phase = 0): Point3 {
  const y = 1 - 2 * (index + 0.5) / count
  const radius = Math.sqrt(1 - y * y), angle = index * GOLDEN_ANGLE + phase
  return [Math.cos(angle) * radius, y, Math.sin(angle) * radius]
}

export function spatialGraphLayout(model: GraphModel) {
  const positions = new Map<string, Point3>()
  const weight = new Map<string, number>()
  for (const edge of model.edges) {
    const value = edge.origin === 'tag' ? 1 : edge.origin === 'assigned' ? 2 : 4
    weight.set(edge.from, (weight.get(edge.from) ?? 0) + value)
    weight.set(edge.to, (weight.get(edge.to) ?? 0) + value)
  }
  const degree = (key: string) => model.adjacent.get(key)?.size ?? 0
  const ranked = [...model.nodes].sort((a, b) => degree(b.key) - degree(a.key)
    || Number(b.kind === 'topic') - Number(a.kind === 'topic')
    || (weight.get(b.key) ?? 0) - (weight.get(a.key) ?? 0) || a.key.localeCompare(b.key))
  const assigned = new Set<string>()
  const groups: string[][] = []
  const independent: string[] = []

  for (const node of ranked) {
    if (assigned.has(node.key)) continue
    if (!degree(node.key)) {
      independent.push(node.key)
      continue
    }
    const group = [node.key]
    assigned.add(node.key)
    for (let i = 0; i < group.length && group.length < 24; i++) {
      for (const neighbor of model.adjacent.get(group[i]) ?? []) {
        if (assigned.has(neighbor)) continue
        // Give a second hub room for its own neighborhood.
        if (i === 0 && degree(neighbor) >= 5 && degree(neighbor) * 1.5 >= degree(node.key)) continue
        group.push(neighbor)
        assigned.add(neighbor)
        if (group.length === 24) break
      }
      if (i > 5) break
    }
    groups.push(group)
  }

  const span = Math.max(10, Math.sqrt(groups.length) * 8)
  groups.forEach((group, index) => {
    const direction = spherePoint(index, groups.length, 0.46)
    const distance = groups.length === 1 ? 0 : span * (0.68 + 0.32 * ((index * 7) % 11) / 10)
    const center: Point3 = [direction[0] * distance * 1.35, direction[1] * distance * 0.77, direction[2] * distance * 0.88]
    positions.set(group[0], center)
    group.slice(1).forEach((key, neighborIndex) => {
      const [x, y, z] = spherePoint(neighborIndex, group.length - 1, index * 2.1)
      const distance = (3.4 + Math.sqrt(group.length) * 1.05) * (0.68 + 0.32 * ((neighborIndex * 7) % 11) / 10)
      positions.set(key, [center[0] + x * distance, center[1] + y * distance, center[2] + z * distance])
    })
  })
  const outer = groups.length ? span * 1.17 + Math.sqrt(independent.length) * 0.8 : Math.max(6, Math.sqrt(independent.length) * 2.6)
  independent.forEach((key, index) => {
    const [x, y, z] = spherePoint(index, independent.length, 1.8)
    const distance = independent.length === 1 && !groups.length ? 0 : outer * (0.75 + 0.25 * ((index * 11) % 29) / 28)
    positions.set(key, [x * distance * 1.3, y * distance * 0.72, z * distance * 0.84])
  })
  let radius = 7
  for (const point of positions.values()) radius = Math.max(radius, Math.hypot(...point))
  return { positions, ranked, radius }
}
