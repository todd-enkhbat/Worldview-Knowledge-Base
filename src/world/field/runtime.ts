import type { NodeRecord, WorldSettings } from '../../domain/types.ts'
import { computeSpatialWorld } from '../../domain/spatial.ts'
import type { PoseTable } from '../poses.ts'
import { registerDevApi } from '../../app/devApi.ts'
import { markOnce } from '../../app/timings.ts'
import { layoutBounds, spatialWorldFor, type VerticalBounds, type XZ } from './layout.ts'
import { attentionVersion, ensureAttention, lastTouch } from './attention.ts'
import { activeRipples, noteState, type Heightfield, type Ripple } from './state.ts'

// Read-only presentation arrays for the shared semantic 3-D world. The simulation, static
// fallback and GPU dust use the same pure spatial anchors. History controls birth/evolution;
// this adapter never replaces the actual pose table or derives coordinates from dates.

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
  /** Legacy envelope metadata, never used to position a record. */
  amp: Float32Array
  width: Float32Array
  order: Float32Array
  condense: Float32Array
  born: Uint8Array
  heightfield: Heightfield
  ripples: Ripple[]
  extent: { cx: number; cz: number; half: number }
  playheadMs: number
  verticalBounds: VerticalBounds
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
  verticalBounds: { minY: 0, maxY: 0, centerY: 0 },
})

let frame = empty()
let lastNodes: ReadonlyMap<string, NodeRecord> | null = null
let lastAttention = -1
let previewVersion = 0
let lastPreview = -1
const dragOverrides = new Map<string, XZ>()
let lastSettings: WorldSettings | null | undefined
/** Last layout and per-evaluation cost (dev hook __wv.fieldStats()). */
const stats = { layoutMs: 0, layoutN: 0, evalMs: 0 }

export function getFieldFrame(): FieldFrame {
  return frame
}

/** Only an in-progress drag is a presentation offset; saved pins are already in P. */
export function fieldPinOffsets(nodes: ReadonlyMap<string, NodeRecord>): Map<string, XZ> {
  const pins = new Map<string, XZ>()
  if (!dragOverrides.size) return pins
  const spatial = spatialWorldFor(nodes)
  for (const [id, target] of dragOverrides) {
    const anchor = spatial.positions.get(id)
    if (anchor) pins.set(id, [target[0] - anchor[0], target[1] - anchor[2]])
  }
  return pins
}

export function previewFieldAnchor(id: string, xz: XZ | null): void {
  if (xz) dragOverrides.set(id, [...xz])
  else dragOverrides.delete(id)
  previewVersion++
}

/** The layout for these records (cached on the records' identity). For the camera. */
export function fieldLayoutFor(nodes: ReadonlyMap<string, NodeRecord>): Map<string, XZ> {
  rebuildIfNeeded(nodes)
  return frame.layout
}

function rebuildIfNeeded(nodes: ReadonlyMap<string, NodeRecord>): boolean {
  if (nodes === lastNodes) return false
  lastNodes = nodes
  const records = [...nodes.values()].filter((r) => r.deletedAt === null).sort((a, b) => (a.id < b.id ? -1 : 1))
  const t0 = performance.now()
  const world = spatialWorldFor(nodes)
  const layout = new Map<string, XZ>([...world.positions].map(([id, p]) => [id, [p[0], p[2]]]))
  stats.layoutMs = Math.round(performance.now() - t0)
  stats.layoutN = records.length
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
 * Read-only adapter for the canonical P→pin→O table. It never publishes replacement poses.
 * The optional static fallback uses the same pure 3-D cluster anchors as the worker.
 */
export function updateField(
  nodes: ReadonlyMap<string, NodeRecord>, settings: WorldSettings | null, playheadMs: number,
  nowS: number, canonical?: PoseTable,
): FieldFrame {
  const rebuilt = rebuildIfNeeded(nodes)
  ensureAttention()
  const attention = attentionVersion()
  const changedSettings = settings !== lastSettings
  const evaluate = rebuilt || changedSettings || attention !== lastAttention || previewVersion !== lastPreview || playheadMs !== frame.playheadMs
  lastAttention = attention
  lastSettings = settings
  lastPreview = previewVersion
  const n = frame.ids.length
  const t1 = performance.now()
  let changed = rebuilt || evaluate
  if (evaluate) {
    for (let i = 0; i < n; i++) {
      const state = noteState(frame.records[i]!, playheadMs, frame.degree[i]!, lastTouch(frame.ids[i]!, playheadMs))
      frame.sigma[i] = state.sigma
      frame.amp[i] = state.amp
      frame.width[i] = state.width
      frame.order[i] = state.order
      frame.condense[i] = state.condense
    }
    // Kept as an empty compatibility envelope for older media readers, never a position source.
    frame.heightfield = { res: 2, x0: frame.extent.cx - frame.extent.half, z0: frame.extent.cz - frame.extent.half, size: frame.extent.half * 2, h: new Float32Array(4) }
    frame.ripples = activeRipples(frame.records.map((rec) => ({ rec, xz: frame.layout.get(rec.id)! })), playheadMs)
  }
  const spatial = spatialWorldFor(nodes).positions
  let minY = 0, maxY = 0
  for (let i = 0; i < n; i++) {
    const rec = frame.records[i]!
    const row = canonical?.index.get(rec.id)
    const anchor = spatial.get(rec.id) ?? computeSpatialWorld([rec]).positions.get(rec.id)!
    const drag = dragOverrides.get(rec.id)
    const x = row === undefined ? drag?.[0] ?? anchor[0] : canonical!.pos[row * 3]!
    const y = row === undefined ? anchor[1] : canonical!.pos[row * 3 + 1]!
    const z = row === undefined ? drag?.[1] ?? anchor[2] : canonical!.pos[row * 3 + 2]!
    const born = row === undefined ? Number(playheadMs >= rec.temporalOrigin) : canonical!.born[row]!
    const offset = i * 3
    if (frame.centers[offset] !== Math.fround(x) || frame.centers[offset + 1] !== Math.fround(y) || frame.centers[offset + 2] !== Math.fround(z) || frame.born[i] !== born) changed = true
    frame.centers.set([x, y, z], offset)
    frame.born[i] = born
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  frame.verticalBounds = { minY, maxY, centerY: (minY + maxY) / 2 }
  frame.playheadMs = playheadMs
  if (changed) frame.version++
  stats.evalMs = Math.round((performance.now() - t1) * 10) / 10
  if (n) markOnce('field-first-frame')
  void nowS
  return frame
}

/** Forget everything (tests, a world wipe). */
export function resetField(): void {
  frame = empty()
  lastNodes = null
  lastAttention = -1
  lastPreview = -1
  dragOverrides.clear()
  lastSettings = undefined
}

registerDevApi('fieldStats', () => ({ ...stats, notes: frame.ids.length }))

registerDevApi('field', (filter?: string) =>
  frame.ids
    .map((_, i) => ({
      title: frame.records[i].title,
      center: Array.from(frame.centers.subarray(i * 3, i * 3 + 3), (v) => Math.round(v * 10) / 10),
      sigma: Math.round(frame.sigma[i] * 100) / 100,
      born: frame.born[i],
      condense: Math.round(frame.condense[i] * 100) / 100,
      media: frame.records[i].attachments.map((a) => a.mime),
    }))
    .filter((n) => !filter || n.title.toLowerCase().includes(filter.toLowerCase())),
)
