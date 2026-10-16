import { describe, expect, it } from 'vitest'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import type { InteractionEvent, NodeRecord } from '../../src/domain/types.ts'
import { buildIndex, idf, queryTerms, search, tokenize } from '../../src/overlay/bm25.ts'
import {
  DEMON,
  K_B,
  LN2,
  demonCandidates,
  ease,
  foldLedger,
  kTEff,
  landauerCost,
  landauerJoules,
  latticeSlot,
  matchBits,
  planDemons,
  rampWeight,
} from '../../src/overlay/demon.ts'
import type { AnchorOf } from '../../src/overlay/demon.ts'

const T = Date.UTC(2026, 0, 1)

function rec(id: string, p: Partial<NodeRecord>): NodeRecord {
  return {
    id,
    slug: id,
    archetype: 'idea',
    title: '',
    contentMd: '',
    tags: [],
    temporalOrigin: T,
    temporalPrecision: 'day',
    referenceDate: null,
    thermo: { mass: 1, temperature: 0.5 },
    anchorXZ: [0, 0],
    links: [],
    attachments: [],
    visibility: 'private',
    createdAt: T,
    updatedAt: T,
    deletedAt: null,
    schemaVersion: 1,
    ...p,
  }
}

const demon = (id: string, query: string, at: [number, number], radius = 12, active = true) =>
  rec(id, { archetype: 'demon', title: id, anchorXZ: at, demon: { query, radius, active }, thermo: { mass: 1, temperature: 0.2 } })

// Y from a fake T0 so tests can place nodes in time too: 1 day = 1 u.
const anchorOf: AnchorOf = (n) => [n.anchorXZ[0], (n.temporalOrigin - T) / 86_400_000, n.anchorXZ[1]]

describe('bm25-lite', () => {
  it('tokenizes with accent folding and stopwords', () => {
    expect(tokenize('The Ëntropy of a Café, 1877!')).toEqual(['entropy', 'cafe', '1877'])
    expect(queryTerms('entropy entropy arrow')).toEqual(['entropy', 'arrow'])
  })

  it('ranks title over tags over content and only returns docs with a query term', () => {
    const idx = buildIndex([
      rec('a', { title: 'Entropy', contentMd: 'notes' }),
      rec('b', { title: 'Notes', tags: ['entropy'] }),
      rec('c', { title: 'Misc', contentMd: 'about entropy here' }),
      rec('d', { title: 'Unrelated' }),
    ])
    const hits = search(idx, 'entropy')
    expect(hits.map((h) => h.id)).toEqual(['a', 'b', 'c'])
    expect(search(idx, '')).toEqual([])
    expect(search(idx, 'entropy', ['c', 'd']).map((h) => h.id)).toEqual(['c'])
    expect(idf(idx, 'entropy')).toBeGreaterThan(0)
    expect(idf(idx, 'unrelated')).toBeGreaterThan(idf(idx, 'entropy'))
  })
})

describe('demon matching', () => {
  it('counts candidates by 3D anchor distance and records log2(C/M) bits per match', () => {
    const d = demon('dm', 'boltzmann', [0, 0])
    const near = [
      rec('n1', { title: 'Boltzmann', anchorXZ: [3, 0] }),
      rec('n2', { title: 'Gibbs', anchorXZ: [0, 5] }),
      rec('n3', { title: 'Maxwell', anchorXZ: [-4, 4] }),
      rec('n4', { title: 'Boltzmann brain', anchorXZ: [0, 0], temporalOrigin: T + 5 * 86_400_000 }),
    ]
    const far = [rec('f1', { title: 'Boltzmann', anchorXZ: [50, 0] }), rec('f2', { title: 'Boltzmann', anchorXZ: [0, 0], temporalOrigin: T + 40 * 86_400_000 })]
    const all = [d, ...near, ...far]
    expect(demonCandidates(d, all, anchorOf).sort()).toEqual(['n1', 'n2', 'n3', 'n4'])
    const plan = planDemons(all, anchorOf)
    const m = plan.matches.get('dm')!
    expect(m.candidates).toBe(4)
    expect(m.hits.map((h) => h.id).sort()).toEqual(['n1', 'n4'])
    expect(m.bitsPerMatch).toBe(1)
    expect(matchBits(4, 2)).toBe(1)
    expect(matchBits(8, 1)).toBe(3)
    expect(matchBits(5, 0)).toBe(0)
    expect(plan.assignments.size).toBe(2)
  })

  it('ignores inactive, empty-query and deleted demons, and gives contested nodes to the best scorer', () => {
    const shared = rec('s', { title: 'entropy', tags: ['arrow'], anchorXZ: [0, 0] })
    const a = demon('da', 'entropy', [2, 0])
    const b = demon('db', 'arrow', [-2, 0])
    const off = demon('dc', 'entropy', [0, 2], 12, false)
    const empty = demon('dd', '  ', [0, -2])
    const plan = planDemons([shared, a, b, off, empty], anchorOf)
    expect([...plan.matches.keys()].sort()).toEqual(['da', 'db'])
    // Title weight 3 beats tag weight 2.
    expect(plan.assignments.get('s')!.demonId).toBe('da')
  })

  it('measures diorama-bearing memories but never moves them', () => {
    const splat = { proxyAssetId: 'p', interiorAssetId: null, thumbAssetId: null, entryPose: { position: [0, 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number] }, crop: null, upFix: [0, 0, 0, 1] as [number, number, number, number], counts: { interior: 0, proxy: 0 }, sourceFormat: 'spz' as const }
    const mem = rec('m', { archetype: 'memory', title: 'entropy', anchorXZ: [2, 0], splat })
    const idea = rec('i', { title: 'entropy', anchorXZ: [-2, 0] })
    const plan = planDemons([demon('d', 'entropy', [0, 0]), mem, idea], anchorOf)
    expect(plan.matches.get('d')!.hits).toHaveLength(2)
    expect([...plan.assignments.keys()]).toEqual(['i'])
    expect(plan.assignments.get('i')!.rank).toBe(0)
  })

  it('places matches on distinct lattice slots, best first, centre excluded', () => {
    const seen = new Set<string>()
    for (let k = 0; k < 8 + 16 + 24; k++) {
      const [x, z] = latticeSlot(k)
      expect(x === 0 && z === 0).toBe(false)
      const ring = Math.max(Math.abs(x), Math.abs(z)) / DEMON.SPACING
      expect(ring).toBe(k < 8 ? 1 : k < 24 ? 2 : 3)
      seen.add(`${x},${z}`)
    }
    expect(seen.size).toBe(48)
  })

  it('ramps w(t) over 2 s of wall-clock time after the latest activation', () => {
    expect(rampWeight(T, null)).toBe(1)
    expect(rampWeight(T - 1, T)).toBe(0)
    expect(rampWeight(T + DEMON.RAMP_MS / 2, T)).toBeCloseTo(0.5, 12)
    expect(rampWeight(T + DEMON.RAMP_MS, T)).toBe(1)
    expect(ease(10, 20, 0)).toBe(10)
    expect(ease(10, 20, 1)).toBe(20)
    expect(ease(10, 20, 0.25)).toBe(12.5)
  })
})

describe('Landauer ledger', () => {
  const evs: InteractionEvent[] = [
    { id: '1', t: T, kind: 'demon-match', nodeId: 'a', demonId: 'd1', bits: 1 },
    { id: '2', t: T, kind: 'demon-match', nodeId: 'b', demonId: 'd1', bits: 1 },
    { id: '3', t: T + 5, kind: 'demon-match', nodeId: 'a', demonId: 'd2', bits: 2.5 },
    { id: '4', t: T + 9, kind: 'inspect', nodeId: 'a' },
  ]

  it('sums recorded bits per demon', () => {
    const l = foldLedger(evs)
    expect(l.bits).toBe(4.5)
    expect(l.events).toBe(3)
    expect(l.perDemon.get('d1')).toEqual({ bits: 2, events: 2, lastT: T })
    expect(l.perDemon.get('d2')).toEqual({ bits: 2.5, events: 1, lastT: T + 5 })
  })

  it('prices the debt as bits·kT_eff·ln2, kT_eff the mean node temperature', () => {
    const nodes = [rec('a', { thermo: { mass: 1, temperature: 0.2 } }), rec('b', { thermo: { mass: 1, temperature: 0.6 } }), rec('c', { deletedAt: T, thermo: { mass: 1, temperature: 1 } })]
    expect(kTEff(nodes)).toBeCloseTo(0.4, 12)
    expect(kTEff([])).toBe(0)
    expect(landauerCost(4.5, 0.4)).toBeCloseTo(4.5 * 0.4 * LN2, 12)
    expect(landauerJoules(1)).toBeCloseTo(K_B * 300 * LN2, 30)
  })

  it('demon drafts are active with a radius', () => {
    const d = makeNodeDraft('demon', {}, { now: T })
    expect(d.demon?.active).toBe(true)
    expect(d.demon!.radius).toBeGreaterThan(0)
  })
})
