import { describe, expect, it } from 'vitest'
import { editionIsbn } from '../../src/bookshelf/catalog.ts'
import { reviewedEdition, translationGuide } from '../../src/bookshelf/translationGuide.ts'

describe('translation recommendations', () => {
  it('compares distinct reviewers for the same work and preserves the reviewed copy', () => {
    const match = translationGuide('Hegel Phenomonology of Spirit')!
    expect(match.ranked.map(t => t.translator)).toEqual(['Michael Inwood', 'Terry Pinkard'])
    const result = reviewedEdition(match.guide, match.ranked[0])
    expect(result.edition).toMatchObject({ isbn: '9780198790624', id: 'OL27369032M', translator: 'Michael Inwood' })
    expect(result.work.authors[0].name).toContain('Hegel')
  })
  it('preserves explicit choices and avoids related titles and secondary literature', () => {
    for (const query of ['The Little Prince', 'The Iliad of the Climate', 'Iliad Fagles', 'Hegel Easton Press', 'Republicanism', 'Notes on the Republic', 'Epictetus Discourses', '']) {
      expect(translationGuide(query)).toBeNull()
    }
    expect(translationGuide('Hegel Phenomenology Pinkard')?.ranked.map(t => t.translator)).toEqual(['Terry Pinkard'])
    expect(translationGuide('0-521-85579-9')?.ranked[0].translator).toBe('Terry Pinkard')
  })
  it('keeps traceable edition identity and signed assessments for every offered book', () => {
    for (const query of ['Plato Republic', 'The Prince', 'Discourses on Livy', 'Iliad', 'Hegel Phenomenology']) {
      const match = translationGuide(query)!
      for (const t of match.ranked) {
        expect(editionIsbn(t.isbn)).toBe(t.isbn)
        expect(t.assessments.every(s => s.by && s.url.startsWith('https://'))).toBe(true)
        expect(reviewedEdition(match.guide, t).edition.id).toMatch(/^OL\d+M$/)
      }
    }
  })
})
