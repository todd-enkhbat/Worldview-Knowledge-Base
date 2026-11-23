import { expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { buildPortableKnowledge, investigationBase, portableKnowledge, readPortableKnowledge } from '../../src/knowledge/portability.ts'
import { parseKnowledgeText } from '../../src/knowledge/parsers.ts'
import { zipVault } from '../../src/data/obsidian.ts'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'
import type { SavedInvestigation } from '../../src/workspace/collections.ts'

function fixture() {
  const sourceId = crypto.randomUUID(), versionId = crypto.randomUUID(), passageId = crypto.randomUUID(), nodeId = crypto.randomUUID()
  const text = '# Lighthouse\n\nThe reserve is eighteen hours. 😀'
  const snapshot: KnowledgeSnapshot = { schemaVersion: 1, revision: 2, sources: [{ id: sourceId, externalId: 'obsidian:Work/Lighthouse.md', title: 'Lighthouse "decision"', kind: 'obsidian', nodeId, currentVersionId: versionId, createdAt: 1, updatedAt: 2, excluded: false, aiAllowed: true, tags: ['energy'] }], versions: [{ id: versionId, sourceId, contentHash: 'a'.repeat(64), originalBlobId: 'original', originalName: 'Work/Lighthouse.md', text, authoredAt: null, createdAt: 2, origin: 'import', metadata: { path: 'Work/Lighthouse.md' } }], passages: [{ id: passageId, sourceId, versionId, nodeId, title: 'Lighthouse', text, start: 0, end: text.length, role: 'human', authoredAt: null, locator: 'Original words' }], jobs: [], proposals: [], imports: [] }
  const investigation: SavedInvestigation = { id: crypto.randomUUID(), title: 'Launch\n"question"', query: 'energy budget', sourceIds: [sourceId], role: 'human', sourceKind: 'obsidian', authoredAfter: '', authoredBefore: '', questions: ['What changed?'], updatedAt: 2 }
  return { snapshot, investigation, sourceId, versionId, passageId, nodeId }
}

it('exports valid Markdown/Canvas/Bases plus exact source text and reimportable citation identities', () => {
  const { snapshot, investigation, sourceId, versionId, passageId, nodeId } = fixture()
  const record = makeNodeDraft('document', { id: nodeId, title: 'Spatial anchor', fieldAnchorXZ: [23, 41] }, { now: 2 })
  const before = JSON.stringify(record)
  const files = buildPortableKnowledge(snapshot, [investigation], { records: [record], now: 3 })
  expect(files.get(`sources/${sourceId}/${versionId}.txt`)).toBe(snapshot.versions[0].text)
  const canvas = JSON.parse([...files.entries()].find(([name]) => name.endsWith('.canvas'))![1]) as { nodes: { id: string }[]; edges: { fromNode: string; toNode: string }[] }
  expect(new Set(canvas.nodes.map((node) => node.id)).size).toBe(canvas.nodes.length)
  expect(canvas.edges.every((edge) => canvas.nodes.some((node) => node.id === edge.fromNode) && canvas.nodes.some((node) => node.id === edge.toNode))).toBe(true)
  expect(JSON.stringify(record)).toBe(before)
  const zipped = unzipSync(zipVault(files))
  const parsed = parseKnowledgeText(strFromU8(zipped['Worldview/worldview-sources.json']), 'worldview-sources.json')
  expect(parsed[0].text).toBe(snapshot.versions[0].text)
  expect(parsed[0].metadata?.portableIdentity).toMatchObject({ sourceId, versionId, nodeId })
  expect((parsed[0].metadata?.portablePassages as { id: string }[])[0].id).toBe(passageId)
})

it('refuses invented evidence and invalid identifiers before any sources can be imported', () => {
  const { snapshot } = fixture()
  const exported = portableKnowledge(snapshot, [])
  exported.sources[0].passages[0].text = 'Invented quote'
  expect(() => readPortableKnowledge(exported)).toThrow('Nothing was imported')
  const another = portableKnowledge(snapshot, [])
  another.sources[0].source.id = '../escape'
  expect(() => readPortableKnowledge(another)).toThrow('Nothing was imported')
})

it('honors corpus/AI/source scope and never broadens an empty clipped investigation', () => {
  const { snapshot, investigation } = fixture()
  snapshot.sources[0].aiAllowed = false
  expect(portableKnowledge(snapshot, [investigation], { aiOnly: true }).sources).toEqual([])
  expect(portableKnowledge(snapshot, [investigation], { aiOnly: true }).investigations).toEqual([])
  expect(portableKnowledge(snapshot, [], { sourceIds: [] }).sources).toEqual([])
  snapshot.sources[0].excluded = true
  expect(portableKnowledge(snapshot, []).sources).toEqual([])
})

it('preserves history order and emits only a safe Bases filter/table subset', () => {
  const { snapshot, investigation } = fixture()
  const oldId = crypto.randomUUID()
  snapshot.versions.push({ ...snapshot.versions[0], id: oldId, text: 'Earlier wording', createdAt: 1, metadata: { portableIdentity: { stale: true }, portablePassages: ['stale'] } })
  const portable = portableKnowledge(snapshot, [investigation], { includeHistory: true })
  const parsed = parseKnowledgeText(JSON.stringify(portable), 'worldview-sources.json')
  expect(parsed.map((source) => source.text)).toEqual(['Earlier wording', snapshot.versions[0].text])
  const base = investigationBase(investigation)
  expect(base).toContain('type: table')
  expect(base).toContain('worldview_source_id')
  expect(base).not.toContain('formulas:')
  expect(base).toContain(JSON.stringify(investigation.title))
})

it('rewrites readable wikilinks for the exported vault while retaining exact source text and unresolved diagnostics', () => {
  const { snapshot } = fixture()
  const target = snapshot.sources[0], text = '![[Work/Lighthouse#^reserve|evidence]] [[Missing]] `[[literal]]`'
  const sourceId = crypto.randomUUID(), versionId = crypto.randomUUID()
  snapshot.sources.push({ ...target, id: sourceId, nodeId: crypto.randomUUID(), externalId: 'obsidian:Read.md', title: 'Read', currentVersionId: versionId })
  snapshot.versions.push({ ...snapshot.versions[0], id: versionId, sourceId, originalName: 'Read.md', metadata: { path: 'Read.md' }, text })
  const files = buildPortableKnowledge(snapshot, [])
  const read = [...files.entries()].find(([name]) => name.startsWith('notes/Read--'))![1]
  expect(read).toContain(`![[notes/${[...files.keys()].find((name) => name.startsWith('notes/Lighthouse'))!.slice(6)}#^reserve|evidence]]`)
  expect(read).toContain('`[[literal]]`')
  expect(files.get(`sources/${sourceId}/${versionId}.txt`)).toBe(text)
  expect(JSON.parse(files.get('link-diagnostics.json')!)).toEqual([{ sourceId, target: 'Missing', reason: 'missing', candidates: [] }])
})

it('imports Canvas text and preserves its 2D document without applying positions or evaluating Bases formulas', () => {
  const canvas = { nodes: [{ id: 'text-a', type: 'text', text: 'A retained Canvas question.', x: 1000, y: -2000, width: 300, height: 200 }, { id: 'file-b', type: 'file', file: 'notes/Plan.md', x: 0, y: 0 }], edges: [{ id: 'edge', fromNode: 'text-a', toNode: 'file-b', label: 'evidence' }], custom: { retained: true } }
  const parsed = parseKnowledgeText(JSON.stringify(canvas), 'Question.canvas')[0]
  expect(parsed.text).toContain('A retained Canvas question.')
  expect(parsed.metadata).toMatchObject({ canvas, coordinates: 'independent-2d; never applied to world placement' })
  expect(parsed.metadata?.portableIdentity).toBeUndefined()
  const base = 'filters:\n  all:\n    - file.ext == "md"\nformulas:\n  malicious: eval("never execute")\n'
  expect(parseKnowledgeText(base, 'View.base')[0]).toMatchObject({ text: base, metadata: { evaluation: 'none', formulasRetainedAsText: true } })
  expect(() => parseKnowledgeText(JSON.stringify({ ...canvas, edges: [{ fromNode: 'missing', toNode: 'file-b' }] }), 'Broken.canvas')).toThrow('endpoint')
})
