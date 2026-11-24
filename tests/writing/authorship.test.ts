import { describe, expect, it } from 'vitest'
import { splitPassages } from '../../src/knowledge/parsers.ts'
import type { ParsedSource } from '../../src/knowledge/types.ts'
import { writingAuthorshipMessages } from '../../src/writing/authorship.ts'
import { plainTextFromWriting } from '../../src/writing/model.ts'
import type { WritingNode } from '../../src/writing/types.ts'

const paragraph = (text: string): WritingNode => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const citation = (quote: string, sourceTitle = 'A retained source'): WritingNode => ({ type: 'writingCitation', attrs: { sourceId: 'source-one', versionId: 'version-one', sourceTitle, quote, start: 17, end: 17 + quote.length } })
const assertExact = (content: WritingNode) => {
  const text = plainTextFromWriting(content), messages = writingAuthorshipMessages(content, 123)
  expect(messages.map((message) => message.text).join('')).toBe(text)
  expect(messages[0]?.start ?? 0).toBe(0)
  expect(messages.at(-1)?.end ?? 0).toBe(text.length)
  messages.forEach((message, index) => {
    expect(message.text).toBe(text.slice(message.start, message.end))
    expect(message.end).toBeGreaterThan(message.start)
    if (index) { expect(message.start).toBe(messages[index - 1].end); expect(message.role).not.toBe(messages[index - 1].role) }
  })
  return messages
}

describe('source-aware writing publication', () => {
  it('keeps entire citation wording and attribution third-party with exact Unicode UTF16 offsets', () => {
    const content: WritingNode = { type: 'doc', content: [paragraph('My opening 🌍'), citation('Quoted 🧠 evidence', 'Research α'), paragraph('My conclusion 🪶')] }
    const messages = assertExact(content)
    expect(messages.map((message) => message.role)).toEqual(['human', 'third-party', 'human'])
    expect(messages[0]).toMatchObject({ text: 'My opening 🌍\n\n', authoredAt: 123 })
    expect(messages[1]).toMatchObject({ text: 'Quoted 🧠 evidence\n— Research α', start: 'My opening 🌍\n\n'.length, authoredAt: null })
    expect(messages[2].text).toBe('\n\nMy conclusion 🪶')
  })

  it('merges the writer’s adjacent inline/structural content while preserving table, list, footnote and media separators', () => {
    const content: WritingNode = { type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'An observation' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'A 🌙 ' }, { type: 'writingFootnote', attrs: { id: 'fn-one', text: 'My explanatory footnote' } }, { type: 'hardBreak' }, { type: 'writingTopicLink', attrs: { topicId: 'tag:measurement', label: 'Measurement' } }] },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [paragraph('Question')] }, { type: 'tableHeader', content: [paragraph('Observation')] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph('Copper α'), paragraph('Second line')] }, { type: 'tableCell', content: [paragraph('Changed 🧪')] }] }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('First point'), paragraph('A little detail')] }, { type: 'listItem', content: [paragraph('Second point')] }] },
      { type: 'horizontalRule' },
      { type: 'writingMedia', attrs: { assetId: `writing-${'a'.repeat(64)}`, mime: 'image/png', kind: 'image', name: 'figure.png', caption: 'My figure caption' } },
    ] }
    const messages = assertExact(content)
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('human')
    expect(messages[0].text).toContain('Question\tObservation\nCopper α\nSecond line\tChanged 🧪')
    expect(messages[0].text).toContain('[Note: My explanatory footnote]\n[[Measurement]]')
    expect(messages[0].text).toContain('My figure caption')
  })

  it('retains citation roles nested within table cells and blockquotes, including an all-quotation document', () => {
    const quoted = citation('Exact quotation', 'Historical paper')
    const content: WritingNode = { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'blockquote', content: [paragraph('My context'), quoted] }] }] }] }] }
    expect(assertExact(content).map((message) => message.role)).toEqual(['human', 'third-party'])
    expect(assertExact({ type: 'doc', content: [quoted] })).toEqual([{ text: 'Exact quotation\n— Historical paper', start: 0, end: 34, role: 'third-party', authoredAt: null }])
  })

  it('feeds Unicode-safe bounded passages into the existing parser without relabeling quoted text', () => {
    const content: WritingNode = { type: 'doc', content: [paragraph('My introduction 🧪 '.repeat(80)), citation('Published 🧠 evidence. '.repeat(100)), paragraph('My own response 🌙 '.repeat(80))] }
    const text = plainTextFromWriting(content), messages = writingAuthorshipMessages(content, 123)
    const source: ParsedSource = { externalId: 'writing:test', title: 'A source-backed essay', kind: 'document', text, messages, authoredAt: 123 }
    const passages = splitPassages(source)
    expect(passages.length).toBeGreaterThan(3)
    for (const passage of passages) {
      const message = messages.find((entry) => entry.start <= passage.start && entry.end >= passage.end)!
      expect(passage.role).toBe(message.role)
      expect(passage.text).toBe(text.slice(passage.start, passage.end))
      expect(new TextEncoder().encode(passage.text).byteLength).toBeLessThanOrEqual(1024)
    }
    expect(passages.filter((passage) => passage.role === 'third-party').every((passage) => !passage.text.includes('My own response'))).toBe(true)
  })

  it('does not invent empty messages and merges split Unicode text with valid authorship metadata', () => {
    expect(writingAuthorshipMessages({ type: 'doc', content: [{ type: 'paragraph' }] })).toEqual([])
    // Both halves belong to the same author and safely merge before ingestion.
    expect(writingAuthorshipMessages({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '\ud83c' }, { type: 'text', text: '\udf0d' }] }] })[0].text).toBe('🌍')
    expect(() => writingAuthorshipMessages({ type: 'doc', content: [{ type: 'paragraph' }] }, -1)).toThrow(/date/)
  })
})
