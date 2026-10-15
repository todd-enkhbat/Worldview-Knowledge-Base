import { useApp } from '../../app/store.ts'
import type { CameraMode } from '../../app/store.ts'
import { rampWeight } from '../../overlay/demon.ts'
import type { OverlayFields } from '../../overlay/fields.ts'
import { getOverlayFields } from '../../overlay/index.ts'
import type { PoseTable } from '../poses.ts'

// The O layer of render pose = O(P(n), t, log). The pose writer calls this once per frame
// after writing the physics poses and before readers see them. It adds, per node:
//   dy  the Hebbian elevation Y_h, bounded to ±HEBB.Y_MAX (Y stays time);
//   dxz the demon easing r = x + w(t)(s − x) toward the node's lattice slot (XZ only).
// Offsets are display-smoothed (TAU_MS) so a visit or a demon toggling off glides instead
// of jumping; the targets themselves are a pure function of (t, log, records). Nothing here
// feeds back into the physics.
//
// The writer does not rewrite positions on every call (paused frames, static anchors), so
// the hook keeps the P positions itself: a component equal to what the hook last wrote is
// still ours, anything else is a fresh P value and becomes the new base. The hook is
// therefore idempotent under repeated calls on an unchanged table.
//
// The node being flown into (or framed) holds its offset until the camera is back out, so
// the 'enter' event it logs cannot shift the diorama under the fly-in.

const HOLD_MODES: ReadonlySet<CameraMode> = new Set<CameraMode>(['entering', 'interior', 'exiting', 'framing'])

/** The node whose offset is frozen right now (fly-in or framing), if any. */
function heldId(): string | null {
  const s = useApp.getState()
  if (!HOLD_MODES.has(s.mode)) return null
  return s.focusedId ?? (s.mode === 'framing' ? s.selectedId : null)
}

/** Display smoothing time constant for offset changes, ms. */
export const TAU_MS = 350
/** Offsets closer than this to their target snap to it, so a settled table stops changing. */
const SNAP = 1e-3

interface HookState {
  pos: Float32Array | null
  /** P positions per row component, as last seen from the writer. */
  base: Float32Array
  /** What the hook last wrote per row component. */
  written: Float32Array
  /** 1 once a row's base has been taken from this pos array. */
  seen: Uint8Array
  /** Displayed offsets per node id: kept across slot-layout changes, so they keep gliding. */
  off: Map<string, Float64Array>
  lastT: number
}

const st: HookState = {
  pos: null,
  base: new Float32Array(0),
  written: new Float32Array(0),
  seen: new Uint8Array(0),
  off: new Map(),
  lastT: Number.NaN,
}

function step(cur: number, target: number, k: number): number {
  const d = target - cur
  return Math.abs(d) < SNAP ? target : cur + k * d
}

/**
 * Apply the overlays at wall-clock time `t` (epoch ms) to the table in place and return it.
 * `fields` defaults to the engine's cached fields at t (tests pass their own).
 */
export function applyOverlays(table: PoseTable, t: number, fields: OverlayFields = getOverlayFields(t)): PoseTable {
  const pos = table.pos
  if (st.pos !== pos) {
    // A new layout: the writer has just filled it with P positions.
    st.pos = pos
    st.base = new Float32Array(pos.length)
    st.written = new Float32Array(pos.length)
    st.seen = new Uint8Array(pos.length / 3)
    for (const id of [...st.off.keys()]) if (!table.index.has(id)) st.off.delete(id)
  }
  const { base, written, seen, off } = st
  const dt = Number.isFinite(st.lastT) ? Math.min(Math.max(t - st.lastT, 0), 1000) : 0
  st.lastT = t
  const k = 1 - Math.exp(-dt / TAU_MS)

  for (const row of table.index.values()) {
    const o = row * 3
    for (let c = 0; c < 3; c++) if (seen[row] === 0 || pos[o + c] !== written[o + c]) base[o + c] = pos[o + c]
    seen[row] = 1
  }

  let changed = false
  const { nodes, plan, activation } = fields
  const held = heldId()
  for (const [id, row] of table.index) {
    const o = row * 3
    let tx = 0
    let tz = 0
    const ty = nodes.get(id)?.y ?? 0
    const a = plan.assignments.get(id)
    if (a) {
      const drow = table.index.get(a.demonId)
      if (drow !== undefined) {
        const w = rampWeight(t, activation.get(a.demonId) ?? null)
        tx = w * (base[drow * 3] + a.dx - base[o])
        tz = w * (base[drow * 3 + 2] + a.dz - base[o + 2])
      }
    }
    let v = off.get(id)
    if (!v) off.set(id, (v = Float64Array.of(tx, ty, tz)))
    else if (id !== held) {
      v[0] = step(v[0], tx, k)
      v[1] = step(v[1], ty, k)
      v[2] = step(v[2], tz, k)
    }
    for (let c = 0; c < 3; c++) {
      const prev = pos[o + c]
      pos[o + c] = base[o + c] + v[c]
      written[o + c] = pos[o + c]
      if (pos[o + c] !== prev) changed = true
    }
  }
  if (changed) table.version++
  return table
}

/** Test hook: forget the kept P positions and smoothing state. */
export function resetOverlayHook(): void {
  st.pos = null
  st.off.clear()
  st.lastT = Number.NaN
}
