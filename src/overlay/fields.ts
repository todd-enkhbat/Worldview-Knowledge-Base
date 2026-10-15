import { yOf } from '../domain/time.ts'
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

export function anchorOfFor(settings: Pick<WorldSettings, 'T0' | 'yPerYear'>): AnchorOf {
  return (n) => [n.anchorXZ[0], yOf(n.temporalOrigin, settings.T0, settings.yPerYear), n.anchorXZ[1]]
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
