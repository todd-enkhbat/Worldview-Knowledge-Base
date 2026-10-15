// Live render poses, read inside useFrame without React re-renders.
// Phase 1 fills this from static anchors; Phase 3 replaces the writer with worker frames
// (render pose = Overlay(Physics(n), t, log)). Readers never care which writer is active.

export interface PoseTable {
  /** Bumped on every write so readers can skip unchanged frames. */
  version: number
  /** Node id → row. Rows are stable slots; a deleted node's row is simply absent from the map. */
  index: Map<string, number>
  /** xyz per row, world units. */
  pos: Float32Array
  /** 1 if the node is born at the current playhead (otherwise it renders as a ghost). */
  born: Uint8Array
}

let table: PoseTable = { version: 0, index: new Map(), pos: new Float32Array(0), born: new Uint8Array(0) }

export function getPoseTable(): PoseTable {
  return table
}

export function setPoseTable(next: Omit<PoseTable, 'version'>): void {
  table = { ...next, version: table.version + 1 }
}

/** Overwrite positions in place (same index map). */
export function touchPoseTable(): void {
  table.version++
}

/** Copies the pose of `id` into `out` (any {x,y,z} with set()). Returns false if unknown. */
export function readPose(id: string, out: { set(x: number, y: number, z: number): unknown }): boolean {
  const row = table.index.get(id)
  if (row === undefined) return false
  const o = row * 3
  out.set(table.pos[o], table.pos[o + 1], table.pos[o + 2])
  return true
}

export function isBorn(id: string): boolean {
  const row = table.index.get(id)
  return row !== undefined && table.born[row] === 1
}
