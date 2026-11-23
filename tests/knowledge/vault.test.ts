import { expect, it } from 'vitest'
import { extractVaultLinks, normalizeVaultPath, parseVaultMetadata, resolveVaultLink, vaultGraph } from '../../src/knowledge/vault.ts'
import { exportVault, parseVault, parseVaultDate } from '../../src/data/obsidian.ts'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'

const candidates = [{ id: 'a', path: 'Ideas/Plan.md' }, { id: 'b', path: 'Work/Plan.md' }, { id: 'c', path: 'Work/Review.md', aliases: ['Retrospective'] }]

it('resolves explicit paths and relative paths without collapsing duplicate basenames', () => {
  expect(resolveVaultLink('Work/Review.md', 'Ideas/Plan', candidates)).toMatchObject({ status: 'resolved', id: 'a' })
  expect(resolveVaultLink('Work/Review.md', './Plan.md', candidates)).toMatchObject({ status: 'resolved', id: 'b' })
  expect(resolveVaultLink('Work/Review.md', '../Ideas/Plan', candidates)).toMatchObject({ status: 'resolved', id: 'a' })
  expect(resolveVaultLink('Other/Read.md', 'Plan', candidates)).toEqual({ status: 'ambiguous', candidates: ['Ideas/Plan.md', 'Work/Plan.md'] })
  expect(resolveVaultLink('Other/Read.md', 'Wrong/Plan', candidates)).toEqual({ status: 'missing', candidates: [] })
  expect(resolveVaultLink('Other/Read.md', 'Retrospective', candidates)).toMatchObject({ status: 'resolved', id: 'c' })
})

it('retains case collisions, root escape failures and source-relative fragments explicitly', () => {
  expect(resolveVaultLink('Read.md', 'PLAN', [{ id: 'a', path: 'Plan.md' }, { id: 'b', path: 'plan.md' }])).toMatchObject({ status: 'ambiguous' })
  expect(normalizeVaultPath('../../secrets')).toBeNull()
  expect(resolveVaultLink('Read.md', '../../../secrets', candidates)).toMatchObject({ status: 'invalid' })
  expect(resolveVaultLink('Ideas/Plan.md', '', candidates)).toMatchObject({ status: 'resolved', id: 'a' })
})

it('retains aliases, heading/block references, embeds and offsets but ignores literal code/comments', () => {
  const text = '[[Ideas/Plan#Next|plan]] ![[Work/Review#^claim]] `[[literal]]`\n```md\n[[code]]\n```\n%% [[private-comment]] %%'
  const refs = extractVaultLinks(text)
  expect(refs).toHaveLength(2)
  expect(refs[0]).toMatchObject({ target: 'Ideas/Plan', heading: 'Next', alias: 'plan', embed: false })
  expect(refs[1]).toMatchObject({ target: 'Work/Review', block: 'claim', embed: true })
  for (const ref of refs) expect(text.slice(ref.start, ref.end)).toBe(ref.raw)
})

it('keeps unrecognized frontmatter verbatim and exports it without losing nested values', () => {
  const original = '---\ntitle: Plan\ncustom:\n  nested: [one, two]\naliases: ["Next plan"]\n---\nOriginal body'
  const parsed = parseVault([{ path: 'Ideas/Plan.md', text: original, lastModified: 1 }], { now: 1 })
  expect(parsed.drafts[0].provenance?.source).toBe('obsidian')
  const draft = parsed.drafts[0]
  const node = { ...makeNodeDraft('document', { title: draft.title }, { now: 1 }), ...draft }
  const exported = [...exportVault([node]).values()][0]
  expect(exported).toContain('custom:\n  nested: [one, two]')
  expect(exported).toContain('aliases: ["Next plan"]')
  expect(parseVaultMetadata(original).rawFrontmatter + 'Original body').toBe(original)
})

it('reports unresolved/ambiguous links and keeps explicit path links in the actual legacy importer', () => {
  let id = 0
  const parsed = parseVault([
    { path: 'Read.md', text: '[[Plan]] [[Ideas/Plan#Next]] [[Missing]]', lastModified: 1 },
    { path: 'Ideas/Plan.md', text: 'A', lastModified: 1 },
    { path: 'Work/Plan.md', text: 'B', lastModified: 1 },
  ], { makeId: () => String(++id), now: 1 })
  expect(parsed.drafts[0].links?.map((link) => link.targetId)).toEqual(['2'])
  expect(parsed.diagnostics.map((item) => item.reason)).toEqual(['ambiguous', 'missing'])
  expect(parsed.unresolved).toBe(2)
})

it('does not invent source times from ambiguous or invalid calendar dates', () => {
  expect(parseVaultDate('2026-02-30')).toBeNull()
  expect(parseVaultDate('2026-02-30T12:30:00Z')).toBeNull()
  expect(parseVaultDate('2026-02-28T24:30:00Z')).toBeNull()
  expect(parseVaultDate('2026-13')).toBeNull()
  expect(parseVaultDate('03/04/26')).toBeNull()
  expect(parseVaultDate('2024-02-29')?.precision).toBe('day')
})

it('builds explicit corpus graph edges only for eligible sources and records unresolved locators', () => {
  const texts = ['[[Work/Plan#Budget]] [[Missing]]', '# Budget\nOriginal decision']
  const snapshot: KnowledgeSnapshot = { schemaVersion: 1, revision: 1, sources: texts.map((_, index) => ({ id: `s${index}`, nodeId: `n${index}`, currentVersionId: `v${index}`, externalId: `e${index}`, title: 'Plan', kind: 'obsidian', createdAt: 1, updatedAt: 1, excluded: false, aiAllowed: true, tags: [] })), versions: texts.map((text, index) => ({ id: `v${index}`, sourceId: `s${index}`, text, contentHash: 'h', originalBlobId: 'b', originalName: index ? 'Work/Plan.md' : 'Read.md', createdAt: 1, authoredAt: null, origin: 'import' })), passages: [], imports: [], proposals: [], jobs: [] }
  expect(vaultGraph(snapshot).edges[0]).toMatchObject({ sourceId: 's0', targetSourceId: 's1', reference: { heading: 'Budget' } })
  expect(vaultGraph(snapshot).diagnostics[0]).toMatchObject({ target: 'Missing', reason: 'missing' })
  snapshot.sources[1].excluded = true
  expect(vaultGraph(snapshot).edges).toEqual([])
})
