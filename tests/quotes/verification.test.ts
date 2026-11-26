import { describe, expect, it } from 'vitest'
import type { KnowledgeSource, KnowledgePassage, SourceVersion } from '../../src/knowledge/types.ts'
import { decodeQuotes, emptyLibrary, originHref, retainedHref, updateQuote, verifiedAnchor, verifyQuote, versionAuthor, type Corpus, type QuoteSource } from '../../src/quotes/model.ts'

const source: KnowledgeSource = { id: 'work', externalId: 'work', title: 'Field notes', kind: 'document', currentVersionId: 'v2', createdAt: 1, updatedAt: 2, excluded: false, aiAllowed: false, tags: [] }
const original = '🍃 repeat\nrepeat. Another line.'
const first: SourceVersion = { id: 'v1', sourceId: 'work', text: original, createdAt: 1, authoredAt: null, origin: 'import', originalName: 'notes.txt', originalBlobId: 'blob', contentHash: 'original-hash', metadata: { authors: [{ name: 'A Writer' }] } }
const second: SourceVersion = { ...first, id: 'v2', text: 'The revision has different wording.', contentHash: 'next-hash', createdAt: 2 }
const start = original.lastIndexOf('repeat'), end = start + 6
const passage: KnowledgePassage = { id: 'a', versionId: 'v1', sourceId: 'work', start, end, title: 'Field notes', role: 'assistant', text: original.slice(start, end), authoredAt: null }
const corpus: Corpus = { sources: [source], versions: [first, second], passages: [passage] }
const reference: QuoteSource = { sourceId: source.id, versionId: first.id, title: source.title, author: 'A Writer', edition: 'First edition', locator: 'Chapter 2' }

describe('retained quotation evidence', () => {
  it('pins an exact occurrence in the chosen version, with UTF-16 coordinates, authorship and hash', () => {
    expect(verifyQuote('repeat', reference, corpus, 7)).toEqual({ status: 'multiple', checkedAt: 7, contentHash: 'original-hash' })
    expect(verifyQuote('repeat', reference, corpus, 8, { start, end })).toEqual({ status: 'exact', start, end, contentHash: 'original-hash', checkedAt: 8, sourceAuthorship: 'assistant' })
    expect(verifyQuote('Repeat', reference, corpus, 9).status).toBe('not-found')
    expect(verifyQuote('repeat repeat', reference, corpus, 9).status).toBe('not-found')
    expect(verifyQuote('repeat', { ...reference, versionId: 'v2' }, corpus, 9).status).toBe('not-found')
    expect(verifyQuote('repeat', { ...reference, sourceId: 'wrong' }, corpus, 9).status).toBe('unavailable')
    expect(verifyQuote('repeat', reference, { ...corpus, sources: [{ ...source, deleted: true }] }, 9).status).toBe('unavailable')
    expect(verifyQuote('repeat', reference, { ...corpus, sources: [{ ...source, excluded: true }] }, 9).status).toBe('unavailable')
    expect(verifyQuote('repeat', { ...reference, sourceId: undefined, versionId: undefined }, corpus, 9).status).toBe('unlinked')
    expect(verifyQuote('repeat', reference, { ...corpus, passages: [{ ...passage, end: end - 1 }] }, 9, { start, end }).sourceAuthorship).toBe('unknown')
    expect(versionAuthor(first)).toBe('A Writer')
  })

  it('keeps original text, origin, edition and each verification date when references are amended or sources disappear', () => {
    const library = emptyLibrary(), origin = { kind: 'writing', id: 'doc/1', title: 'Notes', authorship: 'ai' } as const
    const input = { text: 'repeat', origin, source: { ...reference, bookId: 'edition-in-worldview', catalogEditionId: 'OL123M', isbn: '9780340000000' }, anchor: { start, end } }
    updateQuote(library, input, corpus, 11, 'quote-1', 'captured')
    updateQuote(library, input, corpus, 12, 'quote-1', 'captured')
    expect(library.revision).toBe(1)
    expect(library.quotes[0].history[0].attribution).toBe('source-metadata')
    const revised = { ...input, source: { ...input.source, author: 'My attribution', locator: 'p. 33' } }
    updateQuote(library, revised, corpus, 13, 'quote-1', 'amended')
    updateQuote(library, revised, { sources: [], versions: [], passages: [] }, 14, 'quote-1', 'rechecked')
    const quote = decodeQuotes(JSON.parse(JSON.stringify(library))).quotes[0]
    expect(quote).toMatchObject({ text: 'repeat', origin, createdAt: 11 })
    expect(quote.history.map(rev => [rev.at, rev.verification.checkedAt, rev.verification.status])).toEqual([[11, 11, 'exact'], [13, 13, 'exact'], [14, 14, 'unavailable']])
    expect(quote.history[0].source.locator).toBe('Chapter 2')
    expect(quote.history[1]).toMatchObject({ source: { bookId: 'edition-in-worldview', catalogEditionId: 'OL123M', locator: 'p. 33' }, attribution: 'user-supplied' })
    expect(verifiedAnchor(quote.history[1].verification)).toEqual({ start, end })
    expect(verifiedAnchor(quote.history[2].verification)).toBeUndefined()
    expect(retainedHref(revised.source)).toBe('#/library?source=work&version=v1')
    expect(originHref(origin)).toBe('#/write?doc=doc%2F1')
    expect(() => updateQuote(library, { ...input, text: 'replacement' }, corpus, 15, 'quote-1', 'amended')).toThrow(/reopen/i)
    expect(() => updateQuote(library, { ...input, source: { ...reference, sourceId: 'different' } }, corpus, 16, 'other', 'captured')).toThrow(/another source/i)
  })
})
