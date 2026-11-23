import { computeSpatialWorld } from '../domain/spatial.ts'
import type { PoseTable } from '../world/poses.ts'
import type { NodeRecord, WorldSettings } from '../domain/types.ts'
import type { AnchorOf, DemonLedger, DemonPlan } from './demon.ts'
import { nodePlasticity, synapsesAt } from './hebbian.ts'
import type { LiveSynapse, NodePlasticity, PlasticityState } from './hebbian.ts'

// The overlay read-out at one wall-clock instant: what the pose hook and the overlay
// renderers draw. Pure: (records, folded log, demon plan, t) → fields.

export interface OverlayFields {
  /** Wall-clock time the fields were evaluated at (epoch ms). */
  t: number
  /** Live node id → plasticity at t. */
  nodes: Map<string, NodePlasticity>
  /** Live synapses whose endpoints are both live nodes. */
  synapses: LiveSynapse[]
  plan: DemonPlan
  /** Active demon id → its latest logged activation (null: none in the log, i.e. settled). */
  activation: Map<string, number | null>
}

export function anchorOfFor(
  _settings: Pick<WorldSettings, 'T0' | 'yPerYear'>, records: Iterable<NodeRecord> = [],
  poses?: Pick<PoseTable, 'index' | 'pos' | 'born'>,
): AnchorOf {
  const spatial = computeSpatialWorld(records).positions
  return (record) => {
    const row = poses?.index.get(record.id)
    if (row !== undefined && poses!.born[row] === 1) return [poses!.pos[row * 3]!, poses!.pos[row * 3 + 1]!, poses!.pos[row * 3 + 2]!]
    return spatial.get(record.id) ?? computeSpatialWorld([record]).positions.get(record.id) ?? [0, 0, 0]
  }
}

export function computeFields(
  records: ReadonlyMap<string, NodeRecord>,
  /** Null until the log has loaded: no plasticity yet (rather than everything "unvisited"). */
  plasticity: PlasticityState | null,
  ledger: DemonLedger,
  plan: DemonPlan,
  t: number,
): OverlayFields {
  const nodes = new Map<string, NodePlasticity>()
  if (plasticity) for (const r of records.values()) nodes.set(r.id, nodePlasticity(plasticity, r.id, r.createdAt, t))
  const synapses = plasticity ? synapsesAt(plasticity, t).filter((s) => records.has(s.a) && records.has(s.b)) : []
  const activation = new Map<string, number | null>()
  for (const id of plan.matches.keys()) activation.set(id, ledger.perDemon.get(id)?.lastT ?? null)
  return { t, nodes, synapses, plan, activation }
}

export const EMPTY_PLAN: DemonPlan = { matches: new Map(), assignments: new Map() }
