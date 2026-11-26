import { expect, it } from 'vitest'
import { editionIsbn } from '../../src/bookshelf/catalog.ts'
import { courseCopy, findEvidence, identifies, publishedEvidence } from '../../src/bookshelf/recommendations.ts'
import { decodeBookshelf, emptyBookshelf } from '../../src/bookshelf/model.ts'
import type { BookAttribution } from '../../src/bookshelf/types.ts'

const personal: BookAttribution = { id: 'personal', name: 'Reading Group', title: 'Another Future Book', author: 'An Author', relation: 'Recommended', kind: 'Institution', scope: 'work', isbn: '', editionId: '', url: '' }
it('keeps course sections, editions, excerpts and institutional lists distinct', () => {
  expect(findEvidence('Hegel Phenomonology of Spirit')[0]).toMatchObject({ by: 'Bernard E. Harcourt', relation: 'Assigned' })
  expect(findEvidence('Iliad').map(s => s.isbn)).toEqual(['9780226470498', '9780226470498'])
  expect(findEvidence('Iliad Fagles')).toEqual([])
  expect(findEvidence('Republic Cicero').every(s => s.author === 'Cicero')).toBe(true)
  expect(findEvidence('Plato Republic').some(s => s.by.includes('Noé') && s.version.includes('Grube'))).toBe(true)
  expect(findEvidence('Ethics Spinoza')[0].version).toContain('Curley')
  expect(findEvidence('Francis Pedraza')[0].relation).toBe('Favorite')
  expect(findEvidence('Marc Andreessen').some(s => s.title === 'Zero to One')).toBe(true)
})
it('matches user-entered evidence for new works and limits copy-specific claims to the same copy', () => {
  expect(findEvidence('Another Future Book', [personal])[0]).toMatchObject({ personal: true, by: 'Reading Group' })
  expect(findEvidence('Reading Group', [personal])).toHaveLength(1)
  expect(identifies(personal, { ...personal, author: 'Another Author' })).toBe(false)
  const copy = { ...personal, scope: 'edition' as const, isbn: '9780198245971' }
  expect(identifies(copy, { ...personal, isbn: '0198245971' })).toBe(true)
  expect(identifies(copy, personal)).toBe(false)
  expect(decodeBookshelf({ ...emptyBookshelf(), attributions: [copy] }).attributions).toEqual([copy])
  expect(() => decodeBookshelf({ ...emptyBookshelf(), attributions: [{ ...copy, url: 'javascript:alert(1)' }] })).toThrow()
})
it('offers matching real catalog identifiers for each documented translation with a known copy', () => {
  for (const evidence of publishedEvidence.filter(e => e.isbn)) {
    const c = courseCopy(evidence)!
    expect(c.edition.isbn).toBe(editionIsbn(evidence.isbn))
    expect(c.edition.id).toMatch(/^OL\d+M$/)
    expect(c.work.id).toMatch(/^OL\d+W$/)
    expect(c.edition.translator).toBeTruthy()
  }
})
