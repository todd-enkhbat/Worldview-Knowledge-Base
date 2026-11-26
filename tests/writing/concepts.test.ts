import { describe, expect, it } from 'vitest'
import { conceptMentions, passageHref, recognizedPassages, writingPassages } from '../../src/writing/concepts.ts'
import { buildGraphModel } from '../../src/reading/KnowledgeGraph.tsx'
import { defaultWritingAppearance, validateWritingContent } from '../../src/writing/model.ts'
import type { WritingDocument, WritingNode } from '../../src/writing/types.ts'

const attrs = { id: 'passage', topicId: 'entity', relation: 'example', createdAt: 10, updatedAt: 20 }
const text = (value: string, linked = false): WritingNode => ({ type: 'text', text: value, ...(linked ? { marks: [{ type: 'writingConcept', attrs }] } : {}) })
const content: WritingNode = { type: 'doc', content: [
  { type: 'paragraph', content: [text('First', true), { type: 'hardBreak' }, text('line.', true)] },
  { type: 'paragraph', content: [text('Second', true), text(' other prose '), text('excerpt', true)] },
] }
describe('passage references', () => {
  it('retains formatting and block boundaries and excludes intervening unlinked text', () => {
    expect(writingPassages(validateWritingContent(content))).toEqual([
      { ...attrs, from: 1, to: 20, text: 'First\nline.\nSecond', part: 0 },
      { ...attrs, from: 33, to: 40, text: 'excerpt', part: 1 },
    ])
    expect(passageHref('A/B','passage',1)).toBe('#/write?doc=A%2FB&passage=passage&part=1')
  })
  it('recognizes whole terms, aliases, punctuation and case while suppressing ambiguous aliases', () => {
    const term = { id: 'p', label: 'Palantir', aliases: ['VIRTÙ', 'C++', 'Shared'] }
    const hits = conceptMentions([term, { id: 'q', label: 'Other', aliases: ['shared'] }])
    expect(hits('Palantirian, Palantir, Virtù, C++, shared.').map(hit => hit.id)).toEqual(['p','p','p'])
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [text('Palantir ',true), text('wrote about Virtù. '), { ...text('Palantir'), marks: [{ type: 'code' }] }] }] }
    expect(recognizedPassages(doc, term)).toEqual([{ text: 'wrote about Virtù. ', label: 'Virtù', from: 22, to: 27 }])
  })
  it('draws evidence edges only for explicit links and preserves the exact originating excerpt on each', () => {
    const doc: WritingDocument = { id: 'd', title: 'A draft', subtitle: '', byline: '', format: 'essay', appearance: defaultWritingAppearance(), content, createdAt: 1, updatedAt: 20, archivedAt: null }
    const topic = { id: 'entity', name: 'Palantir', createdAt: 1 }
    const graph = buildGraphModel([], [topic], [], [], new Map(), [doc, { ...doc, id: 'archived', archivedAt: 99 }])
    expect(graph.edges.map(edge => [edge.from, edge.to, edge.label, edge.passage?.text])).toEqual([
      ['writing:d','topic:entity','example of','First\nline.\nSecond'], ['writing:d','topic:entity','example of','excerpt'],
    ])
    expect(graph.byKey.has('writing:archived')).toBe(false)
  })
})

it('keeps explicit Wiki links and assigned notebook topics in the graph without inferring edges for bare words', () => {
  const doc: WritingDocument = { id:'d', title:'Reading notes', subtitle:'', byline:'', format:'note', appearance:defaultWritingAppearance(),
    content:{ type:'doc', content:[{ type:'paragraph', content:[text('Virtù '), { type:'writingTopicLink', attrs:{ topicId:'virtù', label:'Virtù' } }] }] },
    createdAt:1, updatedAt:2, archivedAt:null, topicIds:['fortuna'] }
  const graph = buildGraphModel([], ['virtù','fortuna'].map(name => ({ name, id:name, createdAt:1 })), [], [], new Map(), [doc])
  expect(graph.edges.map(edge => [edge.to, edge.label])).toEqual([['topic:fortuna','assigned topic'], ['topic:virtù','wiki link']])
  expect(graph.edges[1].writingHref).toBe('#/write?doc=d&atom=7&topic=virt%C3%B9')
})
