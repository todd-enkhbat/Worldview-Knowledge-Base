import { describe, expect, it } from 'vitest'
import type { KnowledgeSource } from '../../src/knowledge/types.ts'
import { LocalTextIndex } from '../../src/reading/search.ts'
import { resolveTopics, topicMatches } from '../../src/reading/topics.ts'

const source = (id: string, tags: string[], extra: Partial<KnowledgeSource> = {}) => ({ id, tags, title: id, ...extra } as KnowledgeSource)
describe('local indexed retrieval and canonical topic identity', () => {
  it('finds body and margin text with Unicode folding, AND terms and substring matching', () => {
    const index = new LocalTextIndex().update([{ id: 'a', text: 'Title\nA mitochondrial observation\nMy margin remark: Café experiments' }, { id: 'b', text: 'Another title with a different observation' }])
    expect([...index.search('CHONDRI café')]).toEqual(['a'])
    expect([...index.search('margin observation')]).toEqual(['a'])
    expect([...index.search('observation')]).toEqual(['a', 'b'])
    expect([...index.search('unavailable')]).toEqual([])
    expect([...index.search('')]).toEqual(['a', 'b'])
  })
  it('replaces changed postings and removes old identities instead of retaining stale or excluded text', () => {
    const index = new LocalTextIndex().update([{ id: 'a', text: 'old confidential phrase' }, { id: 'b', text: 'retained text' }])
    index.update([{ id: 'a', text: 'replacement wording' }])
    expect([...index.search('old')]).toEqual([])
    expect([...index.search('retained')]).toEqual([])
    expect([...index.search('replacement')]).toEqual(['a'])
    expect([...index.search('pl')]).toEqual(['a'])
  })
  it('unifies tag spelling variants and duplicate named topics without rewriting their retained identities', () => {
    const sources = [source('one', ['Machine-Learning', 'machine_learning']), source('two', []), source('hidden', ['Secret topic'], { excluded: true })]
    const topics = [{ id: 'older', name: 'Machine learning', createdAt: 1 }, { id: 'newer', name: ' machine-learning ', createdAt: 2 }]
    const before = structuredClone({ sources, topics })
    const canonical = resolveTopics(sources, topics, [{ sourceId: 'two', topicIds: ['newer'] } as never])
    expect(canonical).toHaveLength(1)
    expect(canonical[0]).toMatchObject({ id: 'older', name: 'Machine learning', readingTopicIds: ['older', 'newer'], sourceIds: ['one', 'two'] })
    expect(topicMatches(canonical[0], ['tag:machine learning'])).toBe(true)
    expect(topicMatches(canonical[0], ['newer'])).toBe(true)
    expect({ sources, topics }).toEqual(before)
  })
})
