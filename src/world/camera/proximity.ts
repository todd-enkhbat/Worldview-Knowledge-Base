import { create } from 'zustand'
import { getPoseTable, type PoseTable } from '../poses.ts'

// Nearest live node to the viewer's focus point (the avatar in third person, the orbit
// target in orbit). Read by the metadata HUD and by link illumination. Writes happen from
// useFrame, so the store only changes when the answer changes: subscribers that select
// `nearestId` re-render on a new node, never per frame.

/** Search radius around the focus point (world units). */
export const PROXIMITY_RADIUS = 8
/** `distance` is published only when it moves by more than this, to keep HUD renders rare. */
const DISTANCE_QUANTUM = 0.1

interface ProximityState {
  nearestId: string | null
  /** Distance from the focus point to the nearest node; Infinity when there is none. */
  distance: number
}

export const useProximity = create<ProximityState>()(() => ({ nearestId: null, distance: Infinity }))

export function clearProximity(): void {
  const s = useProximity.getState()
  if (s.nearestId !== null || s.distance !== Infinity) useProximity.setState({ nearestId: null, distance: Infinity })
}

// Flattened (id, row) pairs, rebuilt only when the pose table's index map is replaced.
// Iterating a Map every frame would allocate an iterator; these arrays do not.
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

/**
 * Finds the nearest node to (x, y, z) within `radius` and publishes it. Unborn nodes (ghosts
 * ahead of the playhead) are skipped unless `includeUnborn`. Allocation-free.
 */
export function updateProximity(x: number, y: number, z: number, radius = PROXIMITY_RADIUS, includeUnborn = false): void {
  const table = getPoseTable()
  refreshRows(table)
  const pos = table.pos
  const born = table.born
  let best = -1
  let bestD2 = radius * radius
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (!includeUnborn && born[r] !== 1) continue
    const o = r * 3
    const dx = pos[o] - x
    const dy = pos[o + 1] - y
    const dz = pos[o + 2] - z
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 <= bestD2) {
      bestD2 = d2
      best = i
    }
  }
  const nearestId = best < 0 ? null : ids[best]
  const distance = best < 0 ? Infinity : Math.sqrt(bestD2)
  const s = useProximity.getState()
  if (s.nearestId !== nearestId || Math.abs(s.distance - distance) > DISTANCE_QUANTUM || (distance === Infinity) !== (s.distance === Infinity)) {
    useProximity.setState({ nearestId, distance })
  }
}
