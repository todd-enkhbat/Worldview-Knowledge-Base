import type { InteractionEvent, NodeRecord } from '../domain/types.ts'
import { buildIndex, search } from './bm25.ts'
import type { Bm25Index, Hit } from './bm25.ts'

// Maxwell's demons: standing BM25-lite queries that sort matching nodes onto a lattice.
//
// Matching. A demon's candidates are the live, non-demon nodes whose ANCHOR (anchorXZ, Y of
// temporalOrigin) lies within `radius` of the demon's anchor (3D). Anchors, not live poses,
// so a match depends on the records only and is reproducible. A node claimed by several
// active demons goes to the one that scores it highest (ties: smaller demon id).
//
// Placement. Matched nodes ease toward square-lattice slots around the demon's live XZ pose,
// best match nearest: r = x + w(t)(s − x), XZ only. Y stays the node's date (plus the bounded
// Hebbian offset): Y is time. Diorama-bearing memories are measured (they count toward C and
// M) but never moved: they are the cold nodes PLAN keeps still for Spark (#347). w(t) ramps 0 → 1 over RAMP_MS of wall-clock time after the
// demon's latest activation in the log (smoothstep); with no activation logged (log
// compacted, another tab) an active demon is simply settled, w = 1.
//
// Information. An activation measures C candidates and records which M of them match. Each
// matched node's 'demon-match' event stores bits = log2(C/M), the surprisal of a match, so an
// activation records M·log2(C/M) bits in all, a lower bound on log2 binom(C, M), the size of
// the record needed to say which subset matched. The log is the demon's memory (Bennett):
// the recorded bits stay on the ledger as UNPAID Landauer debt, bits·kT_eff·ln 2, until the
// user erases them by compacting the log.
//
// kT_eff. The physics uses temperature as an energy: a node's thermal speed is √(T/m), so
// kT is T in world energy units (mass·u²·s⁻², the units of the Timeline's ΔE ledger).
// kT_eff is the mean `thermo.temperature` of the live nodes. For scale the panel also shows
// the SI cost at 300 K: bits·k_B·300 K·ln 2 ≈ bits·2.87 zJ.

export const DEMON = {
  /** Wall-clock easing ramp after an activation. */
  RAMP_MS: 2000,
  /** Lattice pitch (world units), just over σ so sorted nodes do not overlap. */
  SPACING: 4,
} as const

export const LN2 = Math.LN2
/** Boltzmann constant, J/K (exact SI). */
export const K_B = 1.380649e-23

export interface DemonMatch {
  demonId: string
  /** Nodes within radius (C). */
  candidates: number
  /** Matching nodes (M = hits.length), best first. */
  hits: Hit[]
  /** log2(C/M) per matched node; 0 when nothing matched. */
  bitsPerMatch: number
}

export interface DemonAssignment {
  demonId: string
  /** Slot offset from the demon's XZ pose. */
  dx: number
  dz: number
  score: number
  rank: number
}

export interface DemonPlan {
  matches: Map<string, DemonMatch>
  /** Matched node id → its slot (the node's winning demon). */
  assignments: Map<string, DemonAssignment>
}

export function matchBits(candidates: number, matches: number): number {
  return matches > 0 && candidates >= matches ? Math.log2(candidates / matches) : 0
}

export type AnchorOf = (n: NodeRecord) => readonly [number, number, number]

export function isActiveDemon(n: NodeRecord): boolean {
  return n.archetype === 'demon' && n.deletedAt === null && n.demon?.active === true && n.demon.query.trim() !== ''
}

/** A memory holding a splat diorama: measured by demons, never moved by them. */
export function isPinned(n: NodeRecord): boolean {
  return n.splat !== undefined && (n.splat.proxyAssetId !== null || n.splat.interiorAssetId !== null)
}

/** Live non-demon records: the population demons sort. */
export function sortable(nodes: Iterable<NodeRecord>): NodeRecord[] {
  const out: NodeRecord[] = []
  for (const n of nodes) if (n.archetype !== 'demon' && n.deletedAt === null) out.push(n)
  return out
}

export function demonCandidates(demon: NodeRecord, population: readonly NodeRecord[], anchorOf: AnchorOf): string[] {
  const r = demon.demon?.radius ?? 0
  const [x, y, z] = anchorOf(demon)
  const r2 = r * r
  const out: string[] = []
  for (const n of population) {
    if (n.id === demon.id) continue
    const [nx, ny, nz] = anchorOf(n)
    const dx = nx - x
    const dy = ny - y
    const dz = nz - z
    if (dx * dx + dy * dy + dz * dz <= r2) out.push(n.id)
  }
  return out
}

export function matchDemon(demon: NodeRecord, population: readonly NodeRecord[], index: Bm25Index, anchorOf: AnchorOf): DemonMatch {
  const cands = demonCandidates(demon, population, anchorOf)
  const hits = demon.demon ? search(index, demon.demon.query, cands) : []
  return { demonId: demon.id, candidates: cands.length, hits, bitsPerMatch: matchBits(cands.length, hits.length) }
}

// ─── lattice ─────────────────────────────────────────────────────────────────────────

const rings: [number, number][][] = []

/** Cells (i, j) with max(|i|, |j|) = r, by angle from +x. */
function ring(r: number): [number, number][] {
  while (rings.length <= r) {
    const q = rings.length
    const cells: [number, number][] = []
    if (q === 0) cells.push([0, 0])
    else for (let i = -q; i <= q; i++) for (let j = -q; j <= q; j++) if (Math.max(Math.abs(i), Math.abs(j)) === q) cells.push([i, j])
    const ang = (c: [number, number]) => {
      const a = Math.atan2(c[1], c[0])
      return a < 0 ? a + 2 * Math.PI : a
    }
    cells.sort((a, b) => ang(a) - ang(b))
    rings.push(cells)
  }
  return rings[r]
}

/** Slot k (0-based) on square rings around the demon, the centre cell excluded. */
export function latticeSlot(k: number, spacing: number = DEMON.SPACING): [number, number] {
  let r = 1
  let before = 0
  while (before + 8 * r <= k) {
    before += 8 * r
    r++
  }
  const [i, j] = ring(r)[k - before]
  return [i * spacing, j * spacing]
}

/** Plan every active demon over the current records. */
export function planDemons(nodes: Iterable<NodeRecord>, anchorOf: AnchorOf): DemonPlan {
  const all = [...nodes]
  const demons = all.filter(isActiveDemon).sort((a, b) => (a.id < b.id ? -1 : 1))
  const matches = new Map<string, DemonMatch>()
  const assignments = new Map<string, DemonAssignment>()
  if (demons.length === 0) return { matches, assignments }
  const population = sortable(all)
  const index = buildIndex(population)
  const best = new Map<string, { demonId: string; score: number }>()
  for (const d of demons) {
    const m = matchDemon(d, population, index, anchorOf)
    matches.set(d.id, m)
    for (const h of m.hits) {
      const prev = best.get(h.id)
      if (!prev || h.score > prev.score) best.set(h.id, { demonId: d.id, score: h.score })
    }
  }
  const byId = new Map(population.map((n) => [n.id, n]))
  for (const d of demons) {
    let rank = 0
    for (const h of matches.get(d.id)!.hits) {
      if (best.get(h.id)?.demonId !== d.id || isPinned(byId.get(h.id)!)) continue
      const [dx, dz] = latticeSlot(rank)
      assignments.set(h.id, { demonId: d.id, dx, dz, score: h.score, rank })
      rank++
    }
  }
  return { matches, assignments }
}

/** Easing weight w(t) after an activation at tAct (null = none logged: settled). */
export function rampWeight(t: number, tAct: number | null, rampMs: number = DEMON.RAMP_MS): number {
  if (tAct === null) return 1
  const x = (t - tAct) / rampMs
  if (x <= 0) return 0
  if (x >= 1) return 1
  return x * x * (3 - 2 * x)
}

/** r = x + w(s − x). */
export function ease(x: number, s: number, w: number): number {
  return x + w * (s - x)
}

// ─── ledger ──────────────────────────────────────────────────────────────────────────

export interface DemonLedgerEntry {
  bits: number
  events: number
  /** Latest activation (newest demon-match event), epoch ms. */
  lastT: number
}

export interface DemonLedger {
  /** Recorded, unpaid bits: Σ bits over the demon-match events in the log. */
  bits: number
  events: number
  perDemon: Map<string, DemonLedgerEntry>
}

export function createLedger(): DemonLedger {
  return { bits: 0, events: 0, perDemon: new Map() }
}

export function applyLedgerEvent(ledger: DemonLedger, e: InteractionEvent): void {
  if (e.kind !== 'demon-match') return
  const bits = Number.isFinite(e.bits) && e.bits! > 0 ? e.bits! : 0
  ledger.bits += bits
  ledger.events++
  const key = e.demonId ?? ''
  const d = ledger.perDemon.get(key)
  if (d) {
    d.bits += bits
    d.events++
    if (e.t > d.lastT) d.lastT = e.t
  } else ledger.perDemon.set(key, { bits, events: 1, lastT: e.t })
}

export function foldLedger(events: readonly InteractionEvent[]): DemonLedger {
  const l = createLedger()
  for (const e of events) applyLedgerEvent(l, e)
  return l
}

/** Mean temperature of the live nodes (world energy units); 0 for an empty world. */
export function kTEff(nodes: Iterable<NodeRecord>): number {
  let s = 0
  let n = 0
  for (const r of nodes) {
    if (r.deletedAt !== null) continue
    s += r.thermo.temperature
    n++
  }
  return n > 0 ? s / n : 0
}

/** Landauer cost of erasing `bits` at kT (same units as kT). */
export function landauerCost(bits: number, kT: number): number {
  return bits * kT * LN2
}

/** The same erasure in joules at a physical temperature (default 300 K). */
export function landauerJoules(bits: number, kelvin = 300): number {
  return bits * K_B * kelvin * LN2
}
