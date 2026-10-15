import { useLayoutEffect } from 'react'
import { useWorld } from '../../app/store.ts'
import { Y_PER_YEAR } from '../../domain/constants.ts'
import { yOf } from '../../domain/time.ts'
import type { NodeRecord, WorldSettings } from '../../domain/types.ts'
import { getPoseTable, setPoseTable, type PoseTable } from '../poses.ts'

// Phase-1 pose writer: every live node sits on its frozen anchor at the height of its
// temporal origin, and everything counts as born (the Phase-3 time scrub marks the unborn).
// Rows are stable slots across rewrites so readers that cache row numbers between frames
// keep working: surviving ids keep their row, new ids fill freed rows before appending.

/** Pure: the pose table for (nodes, settings), reusing row assignments from `prev`. */
export function buildStaticPoseTable(
  nodes: ReadonlyMap<string, NodeRecord>,
  settings: WorldSettings | null,
  prev: Pick<PoseTable, 'index'>,
): Omit<PoseTable, 'version'> {
  // Without settings there is no T0; the earliest node stands in so heights stay finite.
  let T0 = settings?.T0 ?? Infinity
  if (!Number.isFinite(T0)) for (const n of nodes.values()) T0 = Math.min(T0, n.temporalOrigin)
  if (!Number.isFinite(T0)) T0 = 0
  const yPerYear = settings?.yPerYear ?? Y_PER_YEAR

  const index = new Map<string, number>()
  const used = new Set<number>()
  for (const id of nodes.keys()) {
    const row = prev.index.get(id)
    if (row !== undefined && !used.has(row)) {
      index.set(id, row)
      used.add(row)
    }
  }
  let next = 0
  for (const id of nodes.keys()) {
    if (index.has(id)) continue
    while (used.has(next)) next++
    index.set(id, next)
    used.add(next)
  }
  let rows = 0
  for (const r of used) rows = Math.max(rows, r + 1)

  const pos = new Float32Array(rows * 3)
  const born = new Uint8Array(rows)
  for (const [id, n] of nodes) {
    const r = index.get(id)!
    pos[r * 3] = n.anchorXZ[0]
    pos[r * 3 + 1] = yOf(n.temporalOrigin, T0, yPerYear)
    pos[r * 3 + 2] = n.anchorXZ[1]
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
