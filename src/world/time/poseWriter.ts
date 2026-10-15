import { birthStep } from '../../domain/time.ts'
import type { NodeRecord, WorldSettings } from '../../domain/types.ts'
import { buildStaticPoseTable } from '../nodes/staticPoses.ts'
import { type PoseTable, getPoseTable, setPoseTable, touchPoseTable } from '../poses.ts'
import type { PhysicsFrame } from './physicsClient.ts'

// Writes src/world/poses.ts once per frame, from worker frames or (without a worker, and
// until the first frame) from the static anchors. Pure apart from the pose-table module,
// so node tests can drive it. Allocates only when the slot layout changes.
//
// Physics rows are the worker's slots. A slot's pose at the playhead (step + acc) is
//   unborn at the playhead       → its anchor, born = 0 (a ghost)
//   born, and active in the frame → pos + off·vel, off = step + acc − frame.step
//   born, not yet in the frame    → its anchor (spawn sits within 0.05 u of it)
// The frame lags the playhead by about one frame, so `off` is a short linear
// extrapolation; past EXTRAPOLATE_MAX steps (a seek in flight) it holds the frame.

/** Beyond this many steps from the frame, hold rather than extrapolate. */
export const EXTRAPOLATE_MAX = 64

const NEVER = 0x7fffffff

export class PoseWriter {
  private mode: 'none' | 'physics' | 'static' = 'none'
  private gen = -1
  private slotsVersion = -1
  private pos: Float32Array = new Float32Array(0)
  private born: Uint8Array = new Uint8Array(0)
  /** Static rows: birth step per row (−1 = always born, NEVER = free row). */
  private staticBirth = new Int32Array(0)
  private staticRevision = -1
  private staticSettings: WorldSettings | null = null
  private lastFrame: PhysicsFrame | null = null
  private lastStep = Number.NaN
  private lastAcc = Number.NaN

  writePhysics(frame: PhysicsFrame, step: number, acc: number): PoseTable {
    const { slots } = frame
    if (this.mode !== 'physics' || this.gen !== frame.gen || this.slotsVersion !== slots.version) {
      const index = new Map<string, number>()
      for (let s = 0; s < slots.ids.length; s++) {
        const id = slots.ids[s]
        if (id !== null) index.set(id, s)
      }
      this.pos = new Float32Array(3 * slots.ids.length)
      this.born = new Uint8Array(slots.ids.length)
      this.mode = 'physics'
      this.gen = frame.gen
      this.slotsVersion = slots.version
      setPoseTable({ index, pos: this.pos, born: this.born })
    } else if (frame === this.lastFrame && step === this.lastStep && acc === this.lastAcc) {
      // Paused on the same frame: leave the version alone so readers can skip the frame.
      return getPoseTable()
    } else touchPoseTable()
    this.lastFrame = frame
    this.lastStep = step
    this.lastAcc = acc
    const pos = this.pos
    const born = this.born
    const off0 = step + acc - frame.step
    const off = Math.abs(off0) <= EXTRAPOLATE_MAX ? off0 : 0
    const { ids, birth, anchor } = slots
    const fp = frame.pos
    const fv = frame.vel
    const fb = frame.born
    const n = Math.min(ids.length, fb.length)
    for (let s = 0; s < n; s++) {
      const o = 3 * s
      if (ids[s] === null) {
        born[s] = 0
        continue
      }
      if (birth[s] <= step && fb[s] === 1) {
        pos[o] = fp[o] + off * fv[o]
        pos[o + 1] = fp[o + 1] + off * fv[o + 1]
        pos[o + 2] = fp[o + 2] + off * fv[o + 2]
      } else {
        pos[o] = anchor[o]
        pos[o + 1] = anchor[o + 1]
        pos[o + 2] = anchor[o + 2]
      }
      born[s] = birth[s] <= step ? 1 : 0
    }
    return getPoseTable()
  }

  /**
   * Static anchors (the Phase-1 table), with ghosts for records born after the playhead.
   * Rebuilt when the world revision changes; born flags refresh every call. Without
   * settings everything counts as born, as in Phase 1.
   */
  writeStatic(nodes: ReadonlyMap<string, NodeRecord>, settings: WorldSettings | null, revision: number, step: number): PoseTable {
    if (this.mode !== 'static' || this.staticRevision !== revision || this.staticSettings !== settings) {
      const next = buildStaticPoseTable(nodes, settings, getPoseTable())
      // Birth step per row: free rows are never born; without settings (no T0 yet) every
      // record counts as born, as in Phase 1.
      const births = new Int32Array(next.born.length).fill(NEVER)
      for (const [id, n] of nodes) {
        births[next.index.get(id)!] = settings ? birthStep(n.temporalOrigin, settings.T0, settings.stepsPerYear) : -1
      }
      this.staticBirth = births
      this.pos = next.pos
      this.born = next.born
      this.mode = 'static'
      this.staticRevision = revision
      this.staticSettings = settings
      this.lastFrame = null
      setPoseTable(next)
    }
    const table = getPoseTable()
    const born = table.born
    let changed = false
    for (let r = 0; r < born.length; r++) {
      const b = this.staticBirth[r] <= step ? 1 : 0
      if (born[r] !== b) {
        born[r] = b
        changed = true
      }
    }
    if (changed) touchPoseTable()
    return table
  }
}
