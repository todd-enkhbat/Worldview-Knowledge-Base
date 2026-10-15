// Records → dust owners and the allocation glue. A node's dust is tethered to the node's
// own anchor and born at its birth step, both quantised by the node world's own boundary
// (toWorldRecord + quantizeRecord), so dust and node agree to the last bit about where
// and when a memory happens. Pure: tested in node against a fake DustSim.

import { ARCHETYPES, type Archetype, type NodeRecord } from '../../domain/types.ts'
import {
  DUST_BUDGET_SEGMENTS,
  type DustAllocation,
  type DustCandidate,
  allocateDust,
  rowsForSegments,
} from '../../gpu/dust/alloc.ts'
import type { DustOwner } from '../../gpu/dust/dustWorld.ts'
import { quantizeRecord } from '../../physics/world.ts'
import { type MappingSettings, toWorldRecord } from '../time/records.ts'

/** meta.y archetype index (the renderer's palette order is ARCHETYPES). */
export function archetypeStyle(a: Archetype): number {
  return ARCHETYPES.indexOf(a)
}

export interface DustEntry {
  readonly owner: DustOwner
  readonly candidate: DustCandidate
}

/** Every live record that can carry dust, keyed by id. Empty without settings (no T0 yet). */
export function dustEntries(nodes: ReadonlyMap<string, NodeRecord>, settings: MappingSettings | null): Map<string, DustEntry> {
  const out = new Map<string, DustEntry>()
  if (!settings) return out
  for (const n of nodes.values()) {
    const rec = toWorldRecord(n, settings)
    if (!rec) continue
    let q: ReturnType<typeof quantizeRecord>
    try {
      q = quantizeRecord(rec)
    } catch {
      continue
    }
    out.set(n.id, {
      owner: { id: n.id, anchor: [q.ax, q.ay, q.az], birth: q.birth, seed: q.seed, style: archetypeStyle(n.archetype) },
      candidate: { id: n.id, memory: n.archetype === 'memory', significance: rec.mass, birth: q.birth },
    })
  }
  return out
}

/** The part of DustSim the glue drives. */
export interface DustOwnerSink {
  ownerOf(segment: number): DustOwner | null
  setOwner(segment: number, owner: DustOwner | null): void
  replaceOwners(changes: Iterable<readonly [number, DustOwner | null]>): void
  setRows(rows: number): void
}

export function sameOwner(a: DustOwner | null, b: DustOwner | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return samePhysics(a, b) && a.id === b.id && a.style === b.style
}

function samePhysics(a: DustOwner, b: DustOwner): boolean {
  return a.birth === b.birth && a.seed === b.seed && a.anchor[0] === b.anchor[0] && a.anchor[1] === b.anchor[1] && a.anchor[2] === b.anchor[2]
}

export interface AssignResult {
  /** Segments whose owner changed (physics or style). */
  readonly changed: number
  /** Of those, segments whose physics changed. */
  readonly physics: number
  /** Applied as one bulk replacement (restart from step 0) instead of per-segment edits. */
  readonly bulk: boolean
  readonly rows: number
  readonly funded: number
}

/**
 * Keeps a DustSim's segments in line with the records. Small changes are per-segment
 * edits (CPU rows); more than `bulkThreshold` physics changes at once (first load,
 * settings change, an import) restart the GPU run from step 0 instead.
 */
export class DustAssigner {
  readonly budgetSegments: number
  readonly width: number
  readonly bulkThreshold: number
  private alloc: DustAllocation | null = null

  constructor(width: number, budgetSegments = DUST_BUDGET_SEGMENTS, bulkThreshold = 8) {
    this.width = width
    this.budgetSegments = budgetSegments
    this.bulkThreshold = bulkThreshold
  }

  get allocation(): DustAllocation | null {
    return this.alloc
  }

  apply(entries: ReadonlyMap<string, DustEntry>, sim: DustOwnerSink): AssignResult {
    const { allocation, diff } = allocateDust(
      this.alloc,
      [...entries.values()].map((e) => e.candidate),
      this.budgetSegments,
    )
    this.alloc = allocation
    const changes = new Map<number, DustOwner | null>()
    for (const r of diff.released) changes.set(r.segment, null)
    for (const [id, segment] of allocation.segmentOf) {
      const owner = entries.get(id)!.owner
      if (!sameOwner(sim.ownerOf(segment), owner)) changes.set(segment, owner)
      else changes.delete(segment)
    }
    // Released segments nobody took: nothing to do if the sim already has them free.
    for (const [segment, owner] of changes) if (owner === null && sim.ownerOf(segment) === null) changes.delete(segment)
    let physics = 0
    for (const [segment, owner] of changes) {
      const cur = sim.ownerOf(segment)
      if (!cur || !owner || !samePhysics(cur, owner)) physics++
    }
    const rows = rowsForSegments(allocation.used, this.width)
    sim.setRows(rows)
    const bulk = physics > this.bulkThreshold
    if (bulk) sim.replaceOwners(changes)
    else for (const [segment, owner] of changes) sim.setOwner(segment, owner)
    return { changed: changes.size, physics, bulk, rows, funded: allocation.segmentOf.size }
  }
}
