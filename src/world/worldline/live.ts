import { useWorld } from '../../app/store.ts'
import { getPoseTable } from '../poses.ts'
import { WorldlinePath, knotsFromPoses, memoryOrder } from './path.ts'

// The one live worldline, rebuilt at most once per pose-table write. The ribbon and the
// autonav rig both call refreshWorldline() inside useFrame (after the pose writer at −2),
// so whichever runs first pays and the other gets the cached path.

const path = new WorldlinePath()
let order: string[] = []
let orderRevision = -1
let builtVersion = -1
let builtRevision = -1
let pts = new Float64Array(0)
let born = new Float32Array(0)
// Reused every rebuild (the path keeps a reference; it is rebuilt in place).
const ids: string[] = []

/** The live worldline through the current memory render poses, in date order. */
export function refreshWorldline(): WorldlinePath {
  const w = useWorld.getState()
  if (w.revision !== orderRevision) {
    order = memoryOrder(w.nodes.values())
    orderRevision = w.revision
  }
  const table = getPoseTable()
  if (table.version === builtVersion && orderRevision === builtRevision) return path
  builtVersion = table.version
  builtRevision = orderRevision
  if (pts.length < 3 * order.length) {
    pts = new Float64Array(3 * order.length)
    born = new Float32Array(order.length)
  }
  const knots = knotsFromPoses(order, table, pts, born, ids)
  path.set(pts, born, knots, ids)
  return path
}

/** The path as last built (no rebuild). */
export function currentWorldline(): WorldlinePath {
  return path
}
