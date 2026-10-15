import { MASS_RANGE, TEMPERATURE_RANGE } from '../../domain/constants.ts'
import { birthStep, yOf } from '../../domain/time.ts'
import type { NodeRecord, WorldSettings } from '../../domain/types.ts'
import type { WorldRecord } from '../../physics/world.ts'

// NodeRecord → WorldRecord, and the diff that keeps the worker's copy of the records in
// step with useWorld. Pure (no worker, no store) so the mapping is testable in node.
// Y is time: the anchor height is yOf(temporalOrigin) and the birth step is the same
// date on the physics clock, so a node is born exactly where the helix says it is.

export type MappingSettings = Pick<WorldSettings, 'T0' | 'yPerYear' | 'stepsPerYear' | 'physicsSeed'>

/** Everything the mapping depends on besides the records: a change means a full reload. */
export function settingsKey(s: MappingSettings): string {
  return `${s.T0}|${s.yPerYear}|${s.stepsPerYear}|${s.physicsSeed}`
}

const clamp = (v: number, [lo, hi]: readonly [number, number], fallback: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback

/**
 * The physics view of a record, or null when it cannot take part (soft-deleted, or a
 * non-finite date or anchor that validation should have stopped). Mass and temperature
 * are clamped to their ranges so one malformed record cannot trip the stability gate.
 */
export function toWorldRecord(n: NodeRecord, s: MappingSettings): WorldRecord | null {
  if (n.deletedAt !== null) return null
  const T = n.temporalOrigin
  const [ax, az] = n.anchorXZ
  if (!Number.isFinite(T) || !Number.isFinite(ax) || !Number.isFinite(az)) return null
  return {
    id: n.id,
    anchor: [ax, yOf(T, s.T0, s.yPerYear), az],
    birthStep: birthStep(T, s.T0, s.stepsPerYear),
    mass: clamp(n.thermo?.mass, MASS_RANGE, 1),
    temperature: clamp(n.thermo?.temperature, TEMPERATURE_RANGE, 0.5),
  }
}

export function sameWorldRecord(a: WorldRecord, b: WorldRecord): boolean {
  return (
    a.id === b.id &&
    a.anchor[0] === b.anchor[0] &&
    a.anchor[1] === b.anchor[1] &&
    a.anchor[2] === b.anchor[2] &&
    a.birthStep === b.birthStep &&
    a.mass === b.mass &&
    a.temperature === b.temperature
  )
}

/** What the worker currently holds, per id. */
export interface MirrorEntry {
  readonly updatedAt: number
  readonly rec: WorldRecord
}

export type Mirror = Map<string, MirrorEntry>

export interface RecordDiff {
  upserts: WorldRecord[]
  removes: string[]
}

/** Map every live record (initial load). */
export function mirrorAll(nodes: ReadonlyMap<string, NodeRecord>, s: MappingSettings): { mirror: Mirror; records: WorldRecord[] } {
  const mirror: Mirror = new Map()
  const records: WorldRecord[] = []
  for (const n of nodes.values()) {
    const rec = toWorldRecord(n, s)
    if (!rec) continue
    mirror.set(n.id, { updatedAt: n.updatedAt, rec })
    records.push(rec)
  }
  return { mirror, records }
}

/**
 * Edits that bring the worker from `prev` to `nodes`. Records whose updatedAt did not
 * move are skipped without mapping; a newer record whose physics inputs are unchanged
 * (a title or tag edit) only refreshes the mirror. Ids gone from `nodes` (deleted or
 * moved to the trash) are removed.
 */
export function diffRecords(
  prev: Mirror,
  nodes: ReadonlyMap<string, NodeRecord>,
  s: MappingSettings,
): { mirror: Mirror; diff: RecordDiff } {
  const mirror: Mirror = new Map()
  const diff: RecordDiff = { upserts: [], removes: [] }
  for (const n of nodes.values()) {
    const old = prev.get(n.id)
    if (old && old.updatedAt === n.updatedAt) {
      mirror.set(n.id, old)
      continue
    }
    const rec = toWorldRecord(n, s)
    if (!rec) continue
    mirror.set(n.id, { updatedAt: n.updatedAt, rec })
    if (!old || !sameWorldRecord(old.rec, rec)) diff.upserts.push(rec)
  }
  for (const id of prev.keys()) if (!mirror.has(id)) diff.removes.push(id)
  return { mirror, diff }
}
