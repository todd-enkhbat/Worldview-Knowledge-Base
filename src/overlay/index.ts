import { create } from 'zustand'
import { useWorld } from '../app/store.ts'
import { getStore, isRepoReady, logEvent, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import type { InteractionEvent, NodeRecord, WorldSettings } from '../domain/types.ts'
import { applyLedgerEvent, createLedger, foldLedger, isActiveDemon, kTEff, landauerCost, landauerJoules, matchDemon, planDemons, sortable } from './demon.ts'
import type { DemonLedger, DemonLedgerEntry, DemonMatch, DemonPlan } from './demon.ts'
import { buildIndex } from './bm25.ts'
import { EMPTY_PLAN, anchorOfFor, computeFields } from './fields.ts'
import type { OverlayFields } from './fields.ts'
import { FOLD_SKEW_MS, applyEvents, createPlasticity, foldLog, synapsesAt } from './hebbian.ts'
import type { PlasticityState } from './hebbian.ts'

// The overlay engine O: folds the interaction log (data/repo events) into the Hebbian state
// and the demon ledger, keeps both current as events are logged here or in another tab, and
// serves the fields the pose hook and renderers read each frame. Everything is rebuilt from
// the log on load, so the overlays are exactly reproducible from (log, wall-clock t). The
// physics never reads any of this.

export * from './bm25.ts'
export * from './demon.ts'
export * from './fields.ts'
export * from './hebbian.ts'
export * from './kepler.ts'

/** Device-local record of debt already paid (kv is not part of the archive). */
export const PAID_KV = 'overlay.landauerPaid'

export interface LandauerPaid {
  bits: number
  /** bits·kT_eff·ln 2 at each compaction, world energy units. */
  cost: number
  /** The same erasures in joules at 300 K. */
  joules: number
  events: number
  compactions: number
  lastAt: number | null
}

const ZERO_PAID: LandauerPaid = { bits: 0, cost: 0, joules: 0, events: 0, compactions: 0, lastAt: null }

export interface OverlaySummary {
  loaded: boolean
  error: string | null
  /** Events folded from the log. */
  events: number
  /** Unpaid recorded bits (Σ bits of demon-match events in the log). */
  bits: number
  demonEvents: number
  perDemon: Record<string, DemonLedgerEntry>
  synapses: number
  paid: LandauerPaid
  version: number
}

const INITIAL_SUMMARY: OverlaySummary = {
  loaded: false,
  error: null,
  events: 0,
  bits: 0,
  demonEvents: 0,
  perDemon: {},
  synapses: 0,
  paid: ZERO_PAID,
  version: 0,
}

/** HUD-facing summary (DemonPanel). Updated when the log changes, never per frame. */
export const useOverlaySummary = create<OverlaySummary>()(() => ({ ...INITIAL_SUMMARY }))

interface Runtime {
  plasticity: PlasticityState
  ledger: DemonLedger
  paid: LandauerPaid
  loaded: boolean
  version: number
}

const rt: Runtime = { plasticity: createPlasticity(), ledger: createLedger(), paid: ZERO_PAID, loaded: false, version: 0 }

export function getPlasticity(): PlasticityState {
  return rt.plasticity
}

export function getLedger(): DemonLedger {
  return rt.ledger
}

/** Bumped whenever the folded state changes. */
export function overlayVersion(): number {
  return rt.version
}

function publish(): void {
  rt.version++
  const perDemon: Record<string, DemonLedgerEntry> = {}
  for (const [id, d] of rt.ledger.perDemon) perDemon[id] = { ...d }
  useOverlaySummary.setState({
    loaded: rt.loaded,
    events: rt.plasticity.events,
    bits: rt.ledger.bits,
    demonEvents: rt.ledger.events,
    perDemon,
    synapses: synapsesAt(rt.plasticity, Date.now()).length,
    paid: rt.paid,
    version: rt.version,
  })
}

// ─── loading ─────────────────────────────────────────────────────────────────────────

/** Fold a whole log into the runtime (also the test entry point). */
export function loadEvents(events: readonly InteractionEvent[], paid: LandauerPaid = rt.paid): void {
  rt.plasticity = foldLog(events)
  rt.ledger = foldLedger(events)
  rt.paid = paid
  rt.loaded = true
  publish()
}

async function fullLoad(): Promise<void> {
  if (!isRepoReady()) return
  const store = getStore()
  const [events, paid] = await Promise.all([store.listEvents(), store.getKv<LandauerPaid>(PAID_KV)])
  loadEvents(events, paid ?? ZERO_PAID)
}

async function incrementalLoad(): Promise<void> {
  if (!isRepoReady()) return
  if (!rt.loaded || !rt.plasticity.last) return fullLoad()
  const events = await getStore().listEvents(rt.plasticity.last.t - FOLD_SKEW_MS)
  const unseen = events.filter((e) => !rt.plasticity.recentIds.has(e.id))
  if (unseen.length === 0) return
  if (!applyEvents(rt.plasticity, unseen)) return fullLoad()
  for (const e of unseen) applyLedgerEvent(rt.ledger, e)
  publish()
}

let pending: 'none' | 'inc' | 'full' = 'none'
let pump: Promise<void> | null = null

function schedule(kind: 'inc' | 'full'): Promise<void> {
  if (kind === 'full' || pending === 'none') pending = kind
  if (!pump) {
    pump = (async () => {
      while (pending !== 'none') {
        const k = pending
        pending = 'none'
        try {
          await (k === 'full' ? fullLoad() : incrementalLoad())
          useOverlaySummary.setState({ error: null })
        } catch (e) {
          useOverlaySummary.setState({ error: e instanceof Error ? e.message : String(e) })
        }
      }
      pump = null
    })()
  }
  return pump
}

/** Re-read the log now (full fold); resolves when the runtime is current. */
export function refreshOverlays(full = true): Promise<void> {
  return schedule(full ? 'full' : 'inc')
}

// ─── lifecycle ───────────────────────────────────────────────────────────────────────

let refs = 0
let teardown: (() => void) | null = null

/** Start the engine (ref-counted; <Overlays/> and DemonPanel both hold it). Returns stop. */
export function startOverlays(): () => void {
  if (refs++ === 0) teardown = boot()
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    if (--refs === 0) {
      teardown?.()
      teardown = null
    }
  }
}

function boot(): () => void {
  const offs: (() => void)[] = []
  if (useRepoStatus.getState().ready) void schedule('full')
  offs.push(
    useRepoStatus.subscribe((s, prev) => {
      if (s.ready && !prev.ready) void schedule('full')
    }),
  )
  offs.push(
    subscribeRepo((change) => {
      if (change.type === 'events') void schedule('inc')
      else if (change.type === 'wipe' || change.type === 'import') {
        watcher.reset(true)
        void schedule('full')
      }
    }),
  )
  offs.push(watcher.start())
  return () => {
    for (const off of offs) off()
  }
}

/** Test hook: forget all folded state. */
export function resetOverlays(): void {
  rt.plasticity = createPlasticity()
  rt.ledger = createLedger()
  rt.paid = ZERO_PAID
  rt.loaded = false
  planCache = null
  fieldsCache = null
  watcher.reset(false)
  useOverlaySummary.setState({ ...INITIAL_SUMMARY })
  rt.version++
}

// ─── fields (per frame, cached) ──────────────────────────────────────────────────────

let planCache: { nodes: ReadonlyMap<string, NodeRecord>; settings: WorldSettings | null; plan: DemonPlan } | null = null

/** The demon plan for the current records (recomputed only when records or settings change). */
export function getDemonPlan(): DemonPlan {
  const { nodes, settings } = useWorld.getState()
  if (planCache && planCache.nodes === nodes && planCache.settings === settings) return planCache.plan
  const plan = settings ? planDemons(nodes.values(), anchorOfFor(settings)) : EMPTY_PLAN
  planCache = { nodes, settings, plan }
  return plan
}

/** Plasticity changes on the scale of days; between log changes, refresh at most this often. */
export const FIELDS_REFRESH_MS = 250

let fieldsCache: { fields: OverlayFields; version: number; nodes: ReadonlyMap<string, NodeRecord>; plan: DemonPlan } | null = null

/** Overlay fields at wall-clock t (cached; fresh after any log or record change). */
export function getOverlayFields(t: number = Date.now()): OverlayFields {
  const nodes = useWorld.getState().nodes
  const plan = getDemonPlan()
  const c = fieldsCache
  if (c && c.version === rt.version && c.nodes === nodes && c.plan === plan && Math.abs(t - c.fields.t) < FIELDS_REFRESH_MS) return c.fields
  const fields = computeFields(nodes, rt.loaded ? rt.plasticity : null, rt.ledger, plan, t)
  fieldsCache = { fields, version: rt.version, nodes, plan }
  return fields
}

// ─── demons ──────────────────────────────────────────────────────────────────────────

/** Current match of one demon (no logging). Null if it is not an active demon with a query. */
export function previewDemon(demonId: string): DemonMatch | null {
  const { nodes, settings } = useWorld.getState()
  const demon = nodes.get(demonId)
  if (!demon || !settings || !isActiveDemon(demon)) return null
  const population = sortable(nodes.values())
  return matchDemon(demon, population, buildIndex(population), anchorOfFor(settings))
}

/**
 * Activate a demon: measure its candidates now and log one 'demon-match' event per matched
 * node, each carrying bits = log2(C/M), all stamped with the same activation time. The
 * latest activation restarts the lattice easing ramp. Read-only tabs log nothing.
 */
export async function activateDemon(demonId: string, t: number = Date.now()): Promise<{ match: DemonMatch; logged: number } | null> {
  const match = previewDemon(demonId)
  if (!match) return null
  let logged = 0
  for (const h of match.hits) {
    const e = await logEvent('demon-match', h.id, { demonId, bits: match.bitsPerMatch, t })
    if (e) logged++
  }
  return { match, logged }
}

/**
 * Logs an activation whenever an active demon appears or its query, radius, anchor or date
 * changes (the NodeEditor or DemonPanel edited it). Changes are read after a short settle so
 * a rehydrate (import, wipe) can re-baseline first instead of counting as activations.
 */
const watcher = (() => {
  let sigs: Map<string, string> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const signatures = (nodes: ReadonlyMap<string, NodeRecord>) => {
    const out = new Map<string, string>()
    for (const n of nodes.values()) {
      if (isActiveDemon(n)) out.set(n.id, JSON.stringify([n.demon!.query.trim(), n.demon!.radius, n.anchorXZ, n.temporalOrigin]))
    }
    return out
  }

  const clear = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const check = () => {
    clear()
    const w = useWorld.getState()
    if (!w.loaded || !useRepoStatus.getState().ready) return
    const next = signatures(w.nodes)
    const prev = sigs
    sigs = next
    if (!prev) return
    for (const [id, sig] of next) if (prev.get(id) !== sig) void activateDemon(id).catch((e) => console.warn('[overlay] demon activation', e))
  }

  return {
    start(): () => void {
      check()
      const off = useWorld.subscribe((s, p) => {
        if (s.nodes === p.nodes) return
        if (timer === null) timer = setTimeout(check, 400)
      })
      return () => {
        off()
        clear()
      }
    },
    /** Forget the baseline; with `rebaseline`, take a new one once a rehydrate has landed. */
    reset(rebaseline: boolean): void {
      clear()
      sigs = null
      if (rebaseline) timer = setTimeout(check, 400)
    },
  }
})()

// ─── ledger: paying the Landauer debt ────────────────────────────────────────────────

/** kT_eff of the current world (mean node temperature, world energy units). */
export function kTEffNow(): number {
  return kTEff(useWorld.getState().nodes.values())
}

export interface CompactPreview {
  events: number
  bits: number
  cost: number
  joules: number
  kT: number
}

/** What compacting events older than `before` (default: everything) would erase and pay. */
export async function previewCompaction(before?: number): Promise<CompactPreview> {
  const events = await getStore().listEvents()
  const erased = before === undefined ? events : events.filter((e) => e.t < before)
  const bits = foldLedger(erased).bits
  const kT = kTEffNow()
  return { events: erased.length, bits, cost: landauerCost(bits, kT), joules: landauerJoules(bits), kT }
}

export interface CompactResult extends CompactPreview {
  paid: LandauerPaid
}

/**
 * Erase the log before `before` (default: now, i.e. everything so far) and charge the
 * recorded bits of the erased demon events as paid Landauer debt. This also erases the
 * plasticity those events carried: compacting only events older than a year changes nothing
 * visible (their traces are below 1e-20 and their influence on any current synapse weight is
 * at most e^{−365/90} ≈ 0.017), compacting everything resets plasticity. Requires confirm: true.
 */
export async function compactLog(opts: { confirm: boolean; before?: number; now?: number }): Promise<CompactResult> {
  if (!opts.confirm) throw new Error('compactLog needs { confirm: true }')
  const now = opts.now ?? Date.now()
  const before = opts.before ?? now
  const store = getStore()
  const preview = await previewCompaction(before)
  const erasedCount = await store.clearEvents(before)
  const prev = (await store.getKv<LandauerPaid>(PAID_KV)) ?? ZERO_PAID
  const paid: LandauerPaid = {
    bits: prev.bits + preview.bits,
    cost: prev.cost + preview.cost,
    joules: prev.joules + preview.joules,
    events: prev.events + erasedCount,
    compactions: prev.compactions + 1,
    lastAt: now,
  }
  await store.putKv(PAID_KV, paid)
  rt.paid = paid
  await schedule('full')
  return { ...preview, events: erasedCount, paid }
}
