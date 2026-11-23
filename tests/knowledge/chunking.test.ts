import { expect, it } from 'vitest'
import { structuralSpans } from '../../src/knowledge/chunking.ts'
import { parseKnowledgeText, splitPassages } from '../../src/knowledge/parsers.ts'

it('retains an intact fitting code fence while preserving exact source spans', () => {
  const code = '```ts\nconst energy = 42;\nconst entropy = 3;\n```\n'
  const text = `${'Background words. '.repeat(8)}\n\n${code}\n# Decision\n${'Retained evidence. '.repeat(10)}`
  const spans = structuralSpans(text, { start: 0, end: text.length }, { maxChars: 150, overlapChars: 20 })
  expect(spans.some((span) => text.slice(span.start, span.end).includes(code))).toBe(true)
  expect(spans.every((span) => span.end - span.start <= 150)).toBe(true)
  const covered = new Set(spans.flatMap((span) => Array.from({ length: span.end - span.start }, (_, index) => span.start + index)))
  for (let index = 0; index < text.length; index++) if (text[index].trim()) expect(covered.has(index)).toBe(true)
})

it('never splits a surrogate pair and honors a supplied tokenizer budget', () => {
  const text = '😀🛰️世界 energy budget '.repeat(30)
  const countTokens = (value: string) => Array.from(value).length
  const spans = structuralSpans(text, { start: 0, end: text.length }, { maxChars: 100, maxTokens: 30, countTokens, overlapChars: 5 })
  for (const span of spans) {
    const chunk = text.slice(span.start, span.end)
    expect(countTokens(chunk)).toBeLessThanOrEqual(30)
    expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk)).toBe(false)
  }
})

it('preserves message role/time and PDF page boundaries while splitting oversized text', () => {
  const messages = [{ id: 'human', text: 'Human evidence '.repeat(40), role: 'human' as const, authoredAt: 1 }, { id: 'assistant', text: 'Assistant suggestion '.repeat(40), role: 'assistant' as const, authoredAt: 2 }]
  const text = `${messages[0].text}\n\n${messages[1].text}`
  const source = { externalId: 'chat:1', title: 'Decision', kind: 'conversation' as const, text, authoredAt: 1, messages: messages.map((message, index) => ({ ...message, start: index ? messages[0].text.length + 2 : 0, end: index ? text.length : message.text.length })) }
  for (const passage of splitPassages(source, 160)) {
    expect(passage.text).toBe(text.slice(passage.start, passage.end))
    expect(passage.role === 'human' ? passage.end <= messages[0].text.length : passage.start >= messages[0].text.length + 2).toBe(true)
  }
  const pdf = parseKnowledgeText('First page evidence.\fSecond page evidence.', 'paper.txt')[0]
  pdf.metadata = { pages: [{ page: 1, start: 0, end: 20 }, { page: 2, start: 21, end: pdf.text.length }] }
  expect(splitPassages(pdf).map((passage) => passage.locator)).toEqual(['Page 1', 'Page 2'])
})

it('labels audio chunks with timed locators instead of inventing source calendar dates', () => {
  const text = 'Original voice words.'
  const source = { externalId: 'audio:1', title: 'Voice', kind: 'document' as const, text, authoredAt: null, messages: [{ id: 'a', text, role: 'unknown' as const, authoredAt: null, start: 0, end: text.length }], metadata: { audioChunks: [{ start: 65, end: 75 }] } }
  expect(splitPassages(source)[0]).toMatchObject({ locator: 'Audio 1:05–1:15', role: 'unknown', authoredAt: null })
})
