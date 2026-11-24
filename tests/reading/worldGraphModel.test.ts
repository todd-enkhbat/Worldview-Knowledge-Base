import { describe, expect, it } from 'vitest'
import { buildGraphModel } from '../../src/reading/KnowledgeGraph.tsx'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import type { KnowledgeSource } from '../../src/knowledge/types.ts'

describe('shared 3D and knowledge graph relationships', () => {
  it('shows the same saved world relationships, keeps their direction, and excludes unavailable evidence', () => {
    const original = makeNodeDraft('document', { title: 'Original source' }), derived = makeNodeDraft('idea', { title: 'My derived idea' })
    derived.links = [{ targetId: original.id, kind: 'derives', createdAt: 1 }]
    const sources = [original, derived].map((node): KnowledgeSource => ({ id: `source-${node.id}`, nodeId: node.id, externalId: node.id, title: node.title, kind: 'legacy', currentVersionId: 'version', createdAt: 1, updatedAt: 1, excluded: false, aiAllowed: false, tags: [] }))
    const records = new Map([original, derived].map((node) => [node.id, node])), before = structuredClone([...records])
    const model = buildGraphModel(sources, [], [], [], records)
    expect(model.edges).toHaveLength(1)
    expect(model.edges[0]).toMatchObject({ from: `source:${sources[0].id}`, to: `source:${sources[1].id}`, origin: 'world', worldLink: { recordId: derived.id, directed: true, relation: 'builds-on' } })
    expect(buildGraphModel([{ ...sources[0], excluded: true }, sources[1]], [], [], [], records).edges).toHaveLength(0)
    expect([...records]).toEqual(before)
  })
})
