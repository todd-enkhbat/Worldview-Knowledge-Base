import { useApp } from '../../app/store.ts'
import { useProximity } from '../camera/proximity.ts'
import { getPoseTable, type PoseTable } from '../poses.ts'

// Which nodes are emphasised this frame: the selection, the hover, and the node the viewer
// is close to (the camera within NEAR_RADIUS, else the proximity store's nearest node to the
// avatar / orbit target). Shared by the node families and the link layer so the O(n) camera
// search runs once per sample, not once per consumer. Allocation-free.

export const NEAR_RADIUS = 6
/** The camera search is sampled at this rate; hover and selection are read every frame. */
const SAMPLE_INTERVAL = 0.125

export interface Emphasis {
  selected: string | null
  hovered: string | null
  near: string | null
}

const current: Emphasis = { selected: null, hovered: null, near: null }
let lastSample = -Infinity
let cachedIndex: PoseTable['index'] | null = null
let ids: string[] = []
let rows = new Int32Array(0)

function refreshRows(table: PoseTable): void {
  if (table.index === cachedIndex) return
  cachedIndex = table.index
  ids = new Array<string>(table.index.size)
  rows = new Int32Array(table.index.size)
  let i = 0
  for (const [id, row] of table.index) {
    ids[i] = id
    rows[i] = row
    i++
  }
}

function nearestBorn(x: number, y: number, z: number, radius: number): string | null {
  const table = getPoseTable()
  refreshRows(table)
  const { pos, born } = table
  let best: string | null = null
  let bestD2 = radius * radius
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (born[r] !== 1) continue
    const o = r * 3
    const dx = pos[o] - x
    const dy = pos[o + 1] - y
    const dz = pos[o + 2] - z
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 < bestD2) {
      bestD2 = d2
      best = ids[i]
    }
  }
  return best
}

/** The shared emphasis record (mutated in place; do not keep references across frames). */
export function sampleEmphasis(camera: { position: { x: number; y: number; z: number } }, t: number): Emphasis {
  const app = useApp.getState()
  current.selected = app.selectedId
  current.hovered = app.hoveredId
  if (t - lastSample >= SAMPLE_INTERVAL || t < lastSample) {
    lastSample = t
    const p = camera.position
    current.near = nearestBorn(p.x, p.y, p.z, NEAR_RADIUS) ?? useProximity.getState().nearestId
  }
  return current
}

/** 2 = selected, 1 = hovered or near, 0 = plain. */
export function emphasisLevel(e: Emphasis, id: string): 0 | 1 | 2 {
  if (id === e.selected) return 2
  if (id === e.hovered || id === e.near) return 1
  return 0
}
