import { useLayoutEffect } from 'react'
import { useWorld } from '../../app/store.ts'
import { computeSpatialWorld } from '../../domain/spatial.ts'
import type { NodeRecord, WorldSettings } from '../../domain/types.ts'
import { getPoseTable, setPoseTable, type PoseTable } from '../poses.ts'

// Static fallback uses exactly the shared spatial anchors. Dates never set XYZ; the
// Phase-3 writer independently marks records born/ghost from the history playhead.
// Rows are stable slots across rewrites so readers that cache row numbers between frames
// keep working: surviving ids keep their row, new ids fill freed rows before appending.

/** Pure: the pose table for (nodes, settings), reusing row assignments from `prev`. */
export function buildStaticPoseTable(
  nodes: ReadonlyMap<string, NodeRecord>,
  settings: WorldSettings | null,
  prev: Pick<PoseTable, 'index'>,
): Omit<PoseTable, 'version'> {
  const spatial = computeSpatialWorld(nodes.values()).positions
  void settings

  const index = new Map<string, number>()
  const used = new Set<number>()
  for (const id of spatial.keys()) {
    const row = prev.index.get(id)
    if (row !== undefined && !used.has(row)) {
      index.set(id, row)
      used.add(row)
    }
  }
  let next = 0
  for (const id of spatial.keys()) {
    if (index.has(id)) continue
    while (used.has(next)) next++
    index.set(id, next)
    used.add(next)
  }
  let rows = 0
  for (const r of used) rows = Math.max(rows, r + 1)

  const pos = new Float32Array(rows * 3)
  const born = new Uint8Array(rows)
  for (const [id, anchor] of spatial) {
    const r = index.get(id)!
    pos.set(anchor, r * 3)
    born[r] = 1
  }
  return { index, pos, born }
}

/** Rewrites the pose table whenever the world revision changes (records or settings). */
export function usePoseWriterStatic(): void {
  const revision = useWorld((s) => s.revision)
  // Layout effect: the table is ready before the first frame that renders the new records.
  useLayoutEffect(() => {
    const { nodes, settings } = useWorld.getState()
    setPoseTable(buildStaticPoseTable(nodes, settings, getPoseTable()))
  }, [revision])
}
