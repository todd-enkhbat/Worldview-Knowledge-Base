import { describe, expect, it } from 'vitest'
import { buildGraphModel } from '../../src/reading/graphModel.ts'
import type { KnowledgeSource } from '../../src/knowledge/types.ts'
import { GRAPH_DAY, graph2dHref, graphAtDate, graphHistory, spatialGraphLayout } from '../../src/world/spatialGraph.ts'

function source(id: string, day: number, tags: string[] = []): KnowledgeSource {
  return {
    id, externalId: id, title: id, kind: 'document', currentVersionId: 'version',
    createdAt: day * GRAPH_DAY, updatedAt: day * GRAPH_DAY, excluded: false, aiAllowed: true, tags,
  }
}

describe('3D Knowledge Graph timeline', () => {
  const a = source('source-a', 10, ['Shared theme'])
  const b = source('source-b', 13, ['Shared theme'])
  const model = buildGraphModel([a, b, { ...source('excluded', 7, ['Hidden theme']), excluded: true }], [], [], [{
    id: 'actual-support', from: { kind: 'source', id: a.id }, to: { kind: 'source', id: b.id },
    relation: 'supports', createdAt: 15 * GRAPH_DAY,
  }])

  it('uses every canonical graph node and relationship at the final date', () => {
    const history = graphHistory(model, 17 * GRAPH_DAY)
    expect(graphAtDate(model, history, history.end)).toEqual({ nodes: model.nodes, edges: model.edges })
    expect(history.dates).toEqual([10, 13, 15, 17])
    expect(model.nodes.map(node => node.key)).toEqual(['tag:shared theme', 'source:source-a', 'source:source-b'])
    expect(history.births.get('tag:shared theme')).toBe(10)
  })

  it('keeps links hidden until their endpoints and saved creation date are present', () => {
    const history = graphHistory(model, 17 * GRAPH_DAY)
    expect(graphAtDate(model, history, 9)).toEqual({ nodes: [], edges: [] })
    expect(graphAtDate(model, history, 10).edges.map(edge => edge.origin)).toEqual(['tag'])
    expect(graphAtDate(model, history, 14).edges.map(edge => edge.origin)).toEqual(['tag', 'tag'])
    expect(graphAtDate(model, history, 15).edges.at(-1)?.id).toBe('actual-support')
  })

  it('positions every retained node in stable 3D and preserves the selected graph key across views', () => {
    const layout = spatialGraphLayout(model)
    expect(layout.positions.size).toBe(model.nodes.length)
    expect(layout.positions).toEqual(spatialGraphLayout(model).positions)
    expect(new Set(Array.from(layout.positions.values(), position => position[2])).size).toBeGreaterThan(1)
    expect(graph2dHref('tag:shared theme')).toBe('#/graph?topic=tag%3Ashared+theme')
    expect(graph2dHref('writing:draft#1')).toBe('#/graph?writing=draft%231')
  })
})
