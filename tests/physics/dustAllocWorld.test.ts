// Records → dust owners, and the glue that keeps DustSim's segments in line with them.

import { describe, expect, it } from 'vitest'
import { MS_PER_YEAR } from '../../src/domain/constants.ts'
import { birthStep, yOf } from '../../src/domain/time.ts'
import { ARCHETYPES, type Archetype, type NodeRecord } from '../../src/domain/types.ts'
import type { DustOwner } from '../../src/gpu/dust/dustWorld.ts'
import { UNIT } from '../../src/physics/fixed.ts'
import { fnv1a32 } from '../../src/physics/rng.ts'
import { DustAssigner, type DustOwnerSink, archetypeStyle, dustEntries, sameOwner } from '../../src/world/dust/owners.ts'

const T0 = Date.UTC(1990, 0, 1)
const settings = { T0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 0x5eed }

function node(id: string, years: number, archetype: Archetype = 'idea', mass = 1, xz: [number, number] = [3.25, -7.5]): NodeRecord {
  return {
    id,
    archetype,
    temporalOrigin: T0 + years * MS_PER_YEAR,
    anchorXZ: xz,
    thermo: { mass, temperature: 0.5 },
    deletedAt: null,
  } as unknown as NodeRecord
}

const mapOf = (ns: NodeRecord[]) => new Map(ns.map((n) => [n.id, n]))

class FakeSim implements DustOwnerSink {
  readonly owners = new Map<number, DustOwner>()
  readonly calls: string[] = []
  rows = -1
  ownerOf(segment: number): DustOwner | null {
    return this.owners.get(segment) ?? null
  }
  setOwner(segment: number, owner: DustOwner | null): void {
    this.calls.push(`set ${segment} ${owner?.id ?? '-'}`)
    if (owner) this.owners.set(segment, owner)
    else this.owners.delete(segment)
  }
  replaceOwners(changes: Iterable<readonly [number, DustOwner | null]>): void {
    let n = 0
    for (const [segment, owner] of changes) {
      n++
      if (owner) this.owners.set(segment, owner)
      else this.owners.delete(segment)
    }
    this.calls.push(`replace ${n}`)
  }
  setRows(rows: number): void {
    this.rows = rows
  }
}

describe('dust owners from records', () => {
  it('tethers dust to the node anchor and birth, quantised like the node world', () => {
    const e = dustEntries(mapOf([node('m', 10.5, 'memory', 2)]), settings).get('m')!
    expect(e.owner.anchor).toEqual([Math.round(3.25 * UNIT), Math.round(yOf(T0 + 10.5 * MS_PER_YEAR, T0) * UNIT), Math.round(-7.5 * UNIT)])
    expect(e.owner.birth).toBe(birthStep(T0 + 10.5 * MS_PER_YEAR, T0))
    expect(e.owner.seed).toBe(fnv1a32('m') | 0)
    expect(e.owner.style).toBe(ARCHETYPES.indexOf('memory'))
    expect(e.candidate).toEqual({ id: 'm', memory: true, significance: 2, birth: e.owner.birth })
    expect(archetypeStyle('idea')).toBe(0)
  })

  it('has no dust before settings exist and skips unmappable records', () => {
    expect(dustEntries(mapOf([node('a', 1)]), null).size).toBe(0)
    const bad = node('bad', Number.NaN)
    expect(dustEntries(mapOf([bad, node('ok', 2)]), settings).size).toBe(1)
  })
})

describe('DustAssigner', () => {
  it('applies a small change per segment and a large one as a restart', () => {
    const a = new DustAssigner(512, 2048, 4)
    const sim = new FakeSim()
    const few = [node('a', 1), node('m', 2, 'memory')]
    let r = a.apply(dustEntries(mapOf(few), settings), sim)
    expect(r).toMatchObject({ changed: 2, physics: 2, bulk: false, rows: 1, funded: 2 })
    expect(sim.calls).toEqual(['set 0 m', 'set 1 a'])
    const many = [...few, ...Array.from({ length: 9 }, (_, i) => node(`n${i}`, 3 + i))]
    sim.calls.length = 0
    r = a.apply(dustEntries(mapOf(many), settings), sim)
    expect(r.bulk).toBe(true)
    expect(sim.calls).toEqual(['replace 9'])
    // 11 segments of 64 texels need 2 rows of 512.
    expect(sim.rows).toBe(2)
  })

  it('touches only the edited segment, frees removed ones and passes style-only edits through', () => {
    const a = new DustAssigner(64, 2048, 100)
    const sim = new FakeSim()
    const ns = [node('a', 1), node('b', 2), node('c', 3)]
    a.apply(dustEntries(mapOf(ns), settings), sim)
    const segOf = (id: string) => a.allocation!.segmentOf.get(id)!
    const before = new Map(sim.owners)
    sim.calls.length = 0
    // Re-date b; nothing else changes.
    ns[1] = node('b', 2.5)
    a.apply(dustEntries(mapOf(ns), settings), sim)
    expect(sim.calls).toEqual([`set ${segOf('b')} b`])
    expect(sim.owners.get(segOf('a'))).toBe(before.get(segOf('a')))
    // Archetype change only: same physics, new style.
    sim.calls.length = 0
    ns[0] = node('a', 1, 'lens')
    const r = a.apply(dustEntries(mapOf(ns), settings), sim)
    expect(r).toMatchObject({ changed: 1, physics: 0 })
    expect(sameOwner(sim.ownerOf(segOf('a')), dustEntries(mapOf(ns), settings).get('a')!.owner)).toBe(true)
    // Remove c: its segment is freed.
    sim.calls.length = 0
    const cSeg = segOf('c')
    a.apply(dustEntries(mapOf(ns.slice(0, 2)), settings), sim)
    expect(sim.calls).toEqual([`set ${cSeg} -`])
    // A no-op apply does nothing.
    sim.calls.length = 0
    expect(a.apply(dustEntries(mapOf(ns.slice(0, 2)), settings), sim).changed).toBe(0)
    expect(sim.calls).toEqual([])
  })

  it('funds memories first when the budget is short', () => {
    const a = new DustAssigner(64, 2, 100)
    const sim = new FakeSim()
    a.apply(dustEntries(mapOf([node('heavy', 1, 'entity', 4), node('mem', 5, 'memory', 0.25), node('mid', 2, 'idea', 2)]), settings), sim)
    expect([...a.allocation!.segmentOf.keys()].sort()).toEqual(['heavy', 'mem'])
  })
})
