import { describe, expect, it } from 'vitest'
import { ARCHETYPES, type NodeRecord } from '../../src/domain/types.ts'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import { createMolecularPacket, molecularBonds, molecularCounts } from '../../src/world/field/molecules.ts'

const rec = (id: string, mass = 1, deletedAt: number | null = null): NodeRecord =>
  makeNodeDraft('idea', { id, title: 'A thought', thermo: { mass, temperature: 0.4 }, contentMd: 'A thought', deletedAt })

describe('data-associated volumetric formations', () => {
  it('creates no structures without records and skips deleted records', () => {
    expect(molecularCounts([])).toEqual([])
    expect(molecularCounts([rec('deleted', 1, 100)])).toEqual([0])
    const packet = createMolecularPacket(rec('empty'), 0)
    expect(packet.offsets.length).toBe(0)
    expect(packet.roles.length).toBe(0)
  })

  it('scales samples and formation extent with significance while respecting a fixed budget', () => {
    const small = [rec('same', 0.25), rec('same', 4)]
    const counts = molecularCounts(small)
    expect(counts[1]).toBeGreaterThan(counts[0]!)
    const radius = (r: NodeRecord) => {
      const packet = createMolecularPacket(r, 1000)
      const radii = Array.from({ length: 1000 }, (_, i) => Math.hypot(...packet.offsets.subarray(i * 3, i * 3 + 3)))
      return radii.sort((a, b) => a - b)[500]!
    }
    expect(radius(small[1]!)).toBeGreaterThan(radius(small[0]!))
    const many = Array.from({ length: 1000 }, (_, i) => rec(String(i), 4))
    expect(molecularCounts(many).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(260000)
  })

  it('is repeatable by record identity and fully three-dimensional rather than a flat sheet', () => {
    const a = createMolecularPacket(rec('memory-a'), 1600)
    expect(createMolecularPacket(rec('memory-a'), 1600)).toEqual(a)
    expect(createMolecularPacket(rec('memory-b'), 1600).offsets).not.toEqual(a.offsets)
    const means = [0, 1, 2].map((axis) => Array.from({ length: 1600 }, (_, i) => a.offsets[i * 3 + axis]!).reduce((sum, x) => sum + x, 0) / 1600)
    const covariance = (axis: number, other: number) => Array.from({ length: 1600 }, (_, i) => (a.offsets[i * 3 + axis]! - means[axis]!) * (a.offsets[i * 3 + other]! - means[other]!)).reduce((sum, x) => sum + x, 0) / 1600
    const xx = covariance(0, 0), yy = covariance(1, 1), zz = covariance(2, 2)
    const xy = covariance(0, 1), xz = covariance(0, 2), yz = covariance(1, 2)
    const det = xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy
    expect(det / Math.pow((xx + yy + zz) / 3, 3)).toBeGreaterThan(0.15)
    const radii = Array.from({ length: 1600 }, (_, i) => Math.hypot(...a.offsets.subarray(i * 3, i * 3 + 3))).sort((x, y) => x - y)
    expect(radii[800]!).toBeLessThan(radii[1440]! * 0.8)
  })

  it('uses different radial populations by archetype and keeps every formation bounded', () => {
    const idea = rec('one', 4)
    const lens = createMolecularPacket({ ...idea, archetype: 'lens' }, 2000, 8)
    const document = createMolecularPacket({ ...idea, archetype: 'document' }, 2000, 8)
    const filaments = (roles: Float32Array) => Array.from(roles).filter((r) => r === 1).length
    expect(filaments(lens.roles)).toBeGreaterThan(filaments(document.roles) * 1.5)
    for (const archetype of ARCHETYPES) {
      const packet = createMolecularPacket({ ...idea, archetype }, 1200, 10)
      for (let i = 0; i < 1200; i++) expect(Math.hypot(...packet.offsets.subarray(i * 3, i * 3 + 3))).toBeLessThan(60)
    }
  })

  it('scaffolds real volume samples with bounded, repeatable local bonds', () => {
    expect(molecularBonds(createMolecularPacket(rec('empty'), 0))).toHaveLength(0)
    const packet = createMolecularPacket(rec('scaffold'), 4000)
    const before = packet.offsets.slice()
    const bonds = molecularBonds(packet, 96, 2)
    expect(bonds).toEqual(molecularBonds(packet, 96, 2))
    expect(bonds.length).toBeGreaterThan(100)
    expect(bonds.length).toBeLessThanOrEqual(96 * 2 * 2)
    const unique = new Set<string>()
    for (let i = 0; i < bonds.length; i += 2) {
      const a = bonds[i]!, b = bonds[i + 1]!
      expect(a).toBeLessThan(b)
      expect(b).toBeLessThan(packet.roles.length)
      expect(packet.roles[a]).not.toBe(2)
      expect(packet.roles[b]).not.toBe(2)
      expect(unique.has(`${a}:${b}`)).toBe(false)
      unique.add(`${a}:${b}`)
    }
    expect(packet.offsets).toEqual(before)
  })
})
