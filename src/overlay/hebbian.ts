import type { InteractionEvent, InteractionKind } from '../domain/types.ts'

// Hebbian plasticity: a dissipative overlay, a pure fold over the interaction log.
// Everything here is a function of (wall-clock t, events); the physics P never reads it.
//
// Trace (per node):  E ← E·e^{−Δt/T_E} + A_k at each event k, storing the post-event value
//                    and its time, so E(t) = E_post·e^{−(t − t_E)/T_E}. T_E is an e-folding
//                    time (λ = 1/T_E), not a half-life.
// Neglect:           n(t) = 1 − e^{−(t − t_ref)/T_N}, t_ref = the node's last event (or its
//                    creation when never visited). Visits reset it.
// Elevation:         Y_h = clamp(Y_MAX·tanh(E/E_RISE) − Y_SINK·n, ±Y_MAX). The baseline is 0
//                    right after a visit and decays toward −Y_SINK as the node goes unvisited;
//                    the trace lifts frequently visited nodes up to +Y_MAX. Bounded, so Y
//                    stays time (PLAN: "Y is time").
// Mist:              m = n·(1 − tanh(E/E_RISE)) ∈ [0, 1): long-unvisited, cold nodes fog over.
// Citadel:           h = CITADEL_MAX·tanh(E/E_CITADEL), a plinth under the node.
// Synapses:          each event co-activates every other node with an event in the previous
//                    CO_WINDOW; c = √(A_new·A_partner) (partner's largest amplitude in the
//                    window). w ← w_max − (w_max − w·e^{−Δt/T_w})·e^{−η c}. Weights below
//                    W_PRUNE are dead; degree is capped at DEGREE_CAP (weakest dropped first,
//                    ties by key) at update time, so the fold stays deterministic.
//                    'demon-match' events feed the trace but never co-activate: a demon
//                    matching M nodes at once would wire an M-clique that says nothing about
//                    the user's attention.
//
// Incremental folding and a full recompute run the same arithmetic in the same (t, id)
// order, so they agree bit for bit (tests/overlay/hebbian.test.ts).

const DAY = 86_400_000

export const HEBB = {
  T_E_MS: 7 * DAY,
  T_NEGLECT_MS: 30 * DAY,
  Y_MAX: 2.5,
  Y_SINK: 0.8,
  E_RISE: 4,
  CITADEL_MAX: 6,
  E_CITADEL: 4,
  CO_WINDOW_MS: 30 * 60_000,
  T_W_MS: 90 * DAY,
  W_MAX: 1,
  ETA: 0.35,
  W_PRUNE: 0.02,
  DEGREE_CAP: 24,
} as const

/**
 * Fallback A_k for events that carry no amplitude (repo.logEvent always writes one; imported
 * logs may not). Mirrors DEFAULT_AMPLITUDE in data/repo.ts (a test keeps them equal); kept
 * here so this module stays free of the data layer.
 */
export const FALLBACK_AMPLITUDE: Readonly<Record<InteractionKind, number>> = {
  dwell: 0.5,
  inspect: 1,
  enter: 2,
  'demon-match': 0.25,
}

export interface NodeTrace {
  /** Post-event trace value at tE. */
  e: number
  /** Time of the node's last event (epoch ms). */
  tE: number
  count: number
}

export interface Synapse {
  a: string
  b: string
  /** Post-update weight at t. */
  w: number
  t: number
}

interface RecentEvent {
  nodeId: string
  t: number
  amp: number
}

export interface PlasticityState {
  traces: Map<string, NodeTrace>
  synapses: Map<string, Synapse>
  /** nodeId → synapse keys. */
  adjacency: Map<string, Set<string>>
  /** Events inside the co-activation window of the newest processed event. */
  recent: RecentEvent[]
  /** Newest processed event, by (t, id). */
  last: { t: number; id: string } | null
  /** Ids already folded whose t is within FOLD_SKEW_MS of `last` (incremental de-duplication). */
  recentIds: Map<string, number>
  events: number
  /** Bumped on every folded event. */
  version: number
}

/** Late events may arrive this far behind the newest one and still fold incrementally. */
export const FOLD_SKEW_MS = 60_000

export function createPlasticity(): PlasticityState {
  return {
    traces: new Map(),
    synapses: new Map(),
    adjacency: new Map(),
    recent: [],
    last: null,
    recentIds: new Map(),
    events: 0,
    version: 0,
  }
}

/** Total order of the log: wall-clock time, then id (the order both stores return). */
export function compareEvents(a: Pick<InteractionEvent, 't' | 'id'>, b: Pick<InteractionEvent, 't' | 'id'>): number {
  return a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export function synapseKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

export function amplitudeOf(e: Pick<InteractionEvent, 'kind' | 'amplitude'>): number {
  const a = e.amplitude ?? FALLBACK_AMPLITUDE[e.kind]
  return Number.isFinite(a) && a > 0 ? a : 0
}

function decay(value: number, dt: number, tau: number): number {
  return dt > 0 ? value * Math.exp(-dt / tau) : value
}

/** Synapse weight at t (no pruning). */
export function synapseWeightAt(s: Synapse, t: number): number {
  return decay(s.w, t - s.t, HEBB.T_W_MS)
}

function dropSynapse(state: PlasticityState, key: string): void {
  const s = state.synapses.get(key)
  if (!s) return
  state.synapses.delete(key)
  state.adjacency.get(s.a)?.delete(key)
  state.adjacency.get(s.b)?.delete(key)
}

function enforceDegree(state: PlasticityState, nodeId: string, t: number): void {
  const keys = state.adjacency.get(nodeId)
  if (!keys) return
  const live: { key: string; w: number }[] = []
  for (const key of [...keys].sort()) {
    const w = synapseWeightAt(state.synapses.get(key)!, t)
    if (w < HEBB.W_PRUNE) dropSynapse(state, key)
    else live.push({ key, w })
  }
  if (live.length <= HEBB.DEGREE_CAP) return
  live.sort((x, y) => x.w - y.w || (x.key < y.key ? -1 : 1))
  for (let i = 0; i < live.length - HEBB.DEGREE_CAP; i++) dropSynapse(state, live[i].key)
}

function strengthen(state: PlasticityState, a: string, b: string, c: number, t: number): void {
  const key = synapseKey(a, b)
  const prev = state.synapses.get(key)
  let w0 = prev ? synapseWeightAt(prev, t) : 0
  if (w0 < HEBB.W_PRUNE) w0 = 0
  const w = HEBB.W_MAX - (HEBB.W_MAX - w0) * Math.exp(-HEBB.ETA * c)
  const [lo, hi] = a < b ? [a, b] : [b, a]
  state.synapses.set(key, { a: lo, b: hi, w, t })
  for (const id of [lo, hi]) {
    let set = state.adjacency.get(id)
    if (!set) state.adjacency.set(id, (set = new Set()))
    set.add(key)
  }
  enforceDegree(state, lo, t)
  enforceDegree(state, hi, t)
}

/**
 * Fold one event (which must sort after `state.last`). Returns false, leaving the state
 * untouched, when it is out of order: the caller must then recompute from the whole log.
 */
export function applyEvent(state: PlasticityState, e: InteractionEvent): boolean {
  if (state.last && compareEvents(e, state.last) <= 0) return false
  const t = e.t
  const amp = amplitudeOf(e)
  if (amp > 0) {
    const tr = state.traces.get(e.nodeId)
    if (tr) {
      tr.e = decay(tr.e, t - tr.tE, HEBB.T_E_MS) + amp
      tr.tE = t
      tr.count++
    } else state.traces.set(e.nodeId, { e: amp, tE: t, count: 1 })
  }
  if (amp > 0 && e.kind !== 'demon-match') {
    // Co-activation partners: the strongest event of every other node inside the window.
    let keep = 0
    while (keep < state.recent.length && t - state.recent[keep].t > HEBB.CO_WINDOW_MS) keep++
    if (keep > 0) state.recent.splice(0, keep)
    const partners = new Map<string, number>()
    for (const r of state.recent) {
      if (r.nodeId !== e.nodeId && r.amp > (partners.get(r.nodeId) ?? 0)) partners.set(r.nodeId, r.amp)
    }
    for (const p of [...partners.keys()].sort()) strengthen(state, e.nodeId, p, Math.sqrt(amp * partners.get(p)!), t)
    state.recent.push({ nodeId: e.nodeId, t, amp })
  }
  state.last = { t, id: e.id }
  state.recentIds.set(e.id, t)
  if (state.recentIds.size > 64) {
    for (const [id, ti] of state.recentIds) if (t - ti > FOLD_SKEW_MS) state.recentIds.delete(id)
  }
  state.events++
  state.version++
  return true
}

/**
 * Fold a batch of new events into the state (incremental update). Events already folded
 * (by id, within FOLD_SKEW_MS) are skipped. Returns false, leaving the state untouched, if
 * an unseen event sorts before the newest folded one: rebuild with foldLog() then.
 */
export function applyEvents(state: PlasticityState, events: readonly InteractionEvent[]): boolean {
  const fresh = events.filter((e) => !state.recentIds.has(e.id)).sort(compareEvents)
  if (fresh.length > 0 && state.last && compareEvents(fresh[0], state.last) <= 0) return false
  for (const e of fresh) applyEvent(state, e)
  return true
}

/** Full recompute from the log. */
export function foldLog(events: readonly InteractionEvent[]): PlasticityState {
  const state = createPlasticity()
  for (const e of [...events].sort(compareEvents)) applyEvent(state, e)
  return state
}

// ─── read-outs at wall-clock t ───────────────────────────────────────────────────────

export function traceAt(state: PlasticityState, nodeId: string, t: number): number {
  const tr = state.traces.get(nodeId)
  return tr ? decay(tr.e, t - tr.tE, HEBB.T_E_MS) : 0
}

/** 0 right after a visit (or creation), → 1 after long neglect. */
export function neglectAt(tRef: number, t: number): number {
  const dt = t - tRef
  return dt > 0 ? 1 - Math.exp(-dt / HEBB.T_NEGLECT_MS) : 0
}

export function elevation(e: number, neglect: number): number {
  const y = HEBB.Y_MAX * Math.tanh(e / HEBB.E_RISE) - HEBB.Y_SINK * neglect
  return y > HEBB.Y_MAX ? HEBB.Y_MAX : y < -HEBB.Y_MAX ? -HEBB.Y_MAX : y
}

export function mistAmount(e: number, neglect: number): number {
  return neglect * (1 - Math.tanh(e / HEBB.E_RISE))
}

export function citadelHeight(e: number): number {
  return HEBB.CITADEL_MAX * Math.tanh(e / HEBB.E_CITADEL)
}

export interface NodePlasticity {
  e: number
  neglect: number
  /** Signed Y offset (world units), |y| ≤ Y_MAX. */
  y: number
  mist: number
  citadel: number
}

/** Everything the renderer needs for one node. `createdAt` is the neglect reference before any visit. */
export function nodePlasticity(state: PlasticityState, nodeId: string, createdAt: number, t: number): NodePlasticity {
  const tr = state.traces.get(nodeId)
  const e = tr ? decay(tr.e, t - tr.tE, HEBB.T_E_MS) : 0
  const neglect = neglectAt(tr ? Math.max(tr.tE, createdAt) : createdAt, t)
  return { e, neglect, y: elevation(e, neglect), mist: mistAmount(e, neglect), citadel: citadelHeight(e) }
}

export interface LiveSynapse {
  a: string
  b: string
  w: number
}

/** Synapses alive at t (w ≥ W_PRUNE), sorted by key. */
export function synapsesAt(state: PlasticityState, t: number): LiveSynapse[] {
  const out: LiveSynapse[] = []
  for (const key of [...state.synapses.keys()].sort()) {
    const s = state.synapses.get(key)!
    const w = synapseWeightAt(s, t)
    if (w >= HEBB.W_PRUNE) out.push({ a: s.a, b: s.b, w })
  }
  return out
}
