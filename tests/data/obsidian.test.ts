import { describe, expect, it } from 'vitest'
import { MS_PER_YEAR } from '../../src/domain/constants.ts'
import type { NodeRecord } from '../../src/domain/types.ts'
import { exportVault, parseVault, parseVaultDate, splitFrontmatter, wikilinkTargets, type VaultFile } from '../../src/data/obsidian.ts'
import { buildDemoWorld } from '../../src/data/seed/demo.ts'

const NOW = Date.UTC(2026, 9, 21)
const files = (m: Map<string, string>): VaultFile[] => [...m].map(([path, text]) => ({ path, text, lastModified: NOW }))

describe('Obsidian bridge', () => {
  it('exports and re-imports this app’s records losslessly (I4)', () => {
    const records = buildDemoWorld(NOW - 30 * MS_PER_YEAR, NOW)
    const live = records.filter((r: NodeRecord) => r.deletedAt === null)
    const vault = exportVault(live)
    expect(vault.size).toBe(live.length)
    const parsed = parseVault(files(vault))
    expect(parsed.lossless).toBe(live.length)
    const byId = new Map(parsed.drafts.map((d) => [d.id, d]))
    // Attachments come back as files (attachments/<note>/…), so the parsed record has none yet.
    for (const r of live) expect(byId.get(r.id)).toEqual({ ...r, attachments: [] })
  })

  it('reads a foreign vault: frontmatter, dates, tags and wikilinks', () => {
    const vault: VaultFile[] = [
      { path: 'Ideas/Entropy.md', text: '---\ndate: 2019-05\ntags: [physics, "time"]\n---\nLinks to [[Boltzmann|B.]] and [[Missing]]. #arrow', lastModified: 0 },
      { path: 'People/Boltzmann.md', text: '---\nkind: entity\ncreated: 1844-02-20\nlinks:\n  - "supports [[Entropy]]"\n---\nPhysicist.', lastModified: 0 },
      { path: '.obsidian/workspace.md', text: 'ignored', lastModified: 0 },
      { path: 'Plain.md', text: 'no frontmatter', lastModified: NOW },
    ]
    let n = 0
    const { drafts, unresolved } = parseVault(vault, { makeId: () => `id${++n}`, now: NOW })
    expect(drafts.map((d) => d.title)).toEqual(['Entropy', 'Boltzmann', 'Plain'])
    const [entropy, boltz, plain] = drafts
    expect(entropy.temporalPrecision).toBe('month')
    expect(entropy.tags).toEqual(['physics', 'time', 'arrow'])
    expect(entropy.links?.map((l) => [l.targetId, l.kind])).toEqual([['id2', 'relates']])
    expect(boltz.archetype).toBe('entity')
    expect(boltz.temporalOrigin).toBe(Date.UTC(1844, 1, 20))
    expect(boltz.links?.map((l) => [l.targetId, l.kind])).toEqual([['id1', 'supports']])
    expect(plain.temporalOrigin).toBe(NOW)
    expect(plain.archetype).toBe('document')
    expect(unresolved).toBe(1)
  })

  it('parses dates, frontmatter lists and wikilink forms', () => {
    expect(parseVaultDate('2019')).toEqual({ epochMs: Date.UTC(2019, 0, 1), precision: 'year' })
    expect(parseVaultDate('nope')).toBeNull()
    expect(splitFrontmatter('---\na: 1\nb:\n  - x\n  - y\n---\nbody').fm).toEqual({ a: '1', b: ['x', 'y'] })
    expect(wikilinkTargets('[[A]] ![[B.png]] [[C#Head|c]] [[D^block]]')).toEqual(['A', 'B.png', 'C', 'D'])
  })
})
