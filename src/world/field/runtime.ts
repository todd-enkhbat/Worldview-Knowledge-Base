import type { NodeRecord, WorldSettings } from '../../domain/types.ts'
import { isSemanticReady, semanticVectors } from '../../ai/semanticIndex.ts'
import { setPoseTable } from '../poses.ts'
import { computeFieldLayout, layoutBounds, type XZ } from './layout.ts'
import { attentionVersion, ensureAttention, lastTouch } from './attention.ts'
import { activeRipples, buildHeightfield, lift, noteState, sampleHeight, type Heightfield, type NoteState, type Ripple } from './state.ts'

// The field's per-frame state (milestone 2), outside React. It owns the layout (recomputed
// when the records change, warm-started), evaluates every note at the playhead, builds the
// land, and writes the shared pose table so labels, picking, links, fly-to and the camera
// all see the field. The renderer reads the same arrays.

export interface FieldFrame {
  /** Bumped whenever anything below changes. */
  version: number
  /** Bumped only when the set of notes or the layout changes (geometry rebuilds). */
  structure: number
  ids: string[]
  records: NodeRecord[]
  index: Map<string, number>
  layout: Map<string, XZ>
  degree: Int32Array
  /** Cloud centre per note (x, y, z). */
  centers: Float32Array
  sigma: Float32Array
  /** Height and width of each note's rise in the land. */
  amp: Float32Array
  width: Float32Array
  order: Float32Array
  condense: Float32Array
  born: Uint8Array
  heightfield: Heightfield
  ripples: Ripple[]
  extent: { cx: number; cz: number; half: number }
  playheadMs: number
}

const empty = (): FieldFrame => ({
  version: 0,
  structure: 0,
  ids: [],
  records: [],
  index: new Map(),
  layout: new Map(),
  degree: new Int32Array(0),
  centers: new Float32Array(0),
  sigma: new Float32Array(0),
  amp: new Float32Array(0),
  width: new Float32Array(0),
  order: new Float32Array(0),
  condense: new Float32Array(0),
  born: new Uint8Array(0),
  heightfield: { res: 2, x0: -50, z0: -50, size: 100, h: new Float32Array(4) },
  ripples: [],
  extent: { cx: 0, cz: 0, half: 60 },
  playheadMs: 0,
})

let frame = empty()
let lastNodes: ReadonlyMap<string, NodeRecord> | null = null
let lastSemantic = false
let lastCompute = -Infinity
let lastAttention = -1

export function getFieldFrame(): FieldFrame {
  return frame
}

/** The layout for these records (cached on the records' identity). For the camera. */
export function fieldLayoutFor(nodes: ReadonlyMap<string, NodeRecord>): Map<string, XZ> {
  rebuildIfNeeded(nodes)
  return frame.layout
}

function rebuildIfNeeded(nodes: ReadonlyMap<string, NodeRecord>): boolean {
  const semantic = isSemanticReady()
  if (nodes === lastNodes && semantic === lastSemantic) return false
  lastNodes = nodes
  lastSemantic = semantic
  const records = [...nodes.values()].filter((r) => r.deletedAt === null).sort((a, b) => (a.id < b.id ? -1 : 1))
  const layout = computeFieldLayout({ records, vectors: semantic ? semanticVectors() : undefined, previous: frame.layout })
  const ids = records.map((r) => r.id)
  const index = new Map(ids.map((id, i) => [id, i]))
  const degree = new Int32Array(ids.length)
  for (const r of records) {
    for (const l of r.links) {
      const j = index.get(l.targetId)
      if (j === undefined) continue
      degree[index.get(r.id)!]++
      degree[j]++
    }
  }
  const b = layoutBounds(layout)
  const n = ids.length
  frame = {
    ...frame,
    version: frame.version + 1,
    structure: frame.structure + 1,
    ids,
    records,
    index,
    layout,
    degree,
    centers: new Float32Array(n * 3),
    sigma: new Float32Array(n),
    amp: new Float32Array(n),
    width: new Float32Array(n),
    order: new Float32Array(n),
    condense: new Float32Array(n),
    born: new Uint8Array(n),
    extent: { cx: b.cx, cz: b.cz, half: b.radius * 1.35 + 30 },
  }
  return true
}

/**
 * Evaluate the field at the playhead and write the pose table. Small worlds update every
 * frame; big ones at ~8 Hz (the land is the costly part).
 */
export function updateField(nodes: ReadonlyMap<string, NodeRecord>, _settings: WorldSettings | null, playheadMs: number, nowS: number): FieldFrame {
  const rebuilt = rebuildIfNeeded(nodes)
  ensureAttention()
  const attention = attentionVersion()
  const touched = attention !== lastAttention
  lastAttention = attention
  const n = frame.ids.length
  const interval = n > 150 ? 0.12 : 0
  if (!rebuilt && !touched && playheadMs === frame.playheadMs && frame.version > 0) return frame
  if (!rebuilt && nowS - lastCompute < interval) return frame
  lastCompute = nowS

  const states: NoteState[] = new Array(n)
  for (let i = 0; i < n; i++) states[i] = noteState(frame.records[i], playheadMs, frame.degree[i], lastTouch(frame.ids[i], playheadMs))
  const hf = buildHeightfield(
    frame.ids.map((id, i) => ({ xz: frame.layout.get(id)!, state: states[i] })),
    frame.extent,
  )
  for (let i = 0; i < n; i++) {
    const s = states[i]
    const [x, z] = frame.layout.get(frame.ids[i])!
    frame.centers[i * 3] = x
    frame.centers[i * 3 + 1] = sampleHeight(hf, x, z) + lift(s, frame.records[i].thermo?.mass ?? 1)
    frame.centers[i * 3 + 2] = z
    frame.sigma[i] = s.sigma
    frame.amp[i] = s.amp
    frame.width[i] = s.width
    frame.order[i] = s.order
    frame.condense[i] = s.condense
    frame.born[i] = s.born ? 1 : 0
  }
  frame = {
    ...frame,
    version: frame.version + 1,
    heightfield: hf,
    ripples: activeRipples(frame.records.map((rec, i) => ({ rec, xz: frame.layout.get(frame.ids[i])! })), playheadMs),
    playheadMs,
  }
  setPoseTable({ index: frame.index, pos: frame.centers, born: frame.born })
  return frame
}

/** Forget everything (tests, a world wipe). */
export function resetField(): void {
  frame = empty()
  lastNodes = null
  lastCompute = -Infinity
  lastAttention = -1
}
