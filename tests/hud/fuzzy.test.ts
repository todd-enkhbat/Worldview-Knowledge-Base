import { describe, expect, it } from 'vitest'
import { fuzzyMatch, fuzzyMatchFields, fuzzyRank, highlightSegments } from '../../src/hud/fuzzy.ts'

describe('fuzzyMatch', () => {
  it('matches subsequences case-insensitively and rejects non-subsequences', () => {
    expect(fuzzyMatch('BLTZ', 'Boltzmann')?.positions).toEqual([0, 2, 3, 4])
    expect(fuzzyMatch('zb', 'Boltzmann')).toBeNull()
    expect(fuzzyMatch('boltzmannn', 'Boltzmann')).toBeNull()
  })

  it('treats an empty or whitespace query as a zero-score match', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] })
    expect(fuzzyMatch('   ', 'anything')).toEqual({ score: 0, positions: [] })
  })

  it('prefers word-start alignments over the first occurrence', () => {
    expect(fuzzyMatch('bar', 'foobar bar')?.positions).toEqual([7, 8, 9])
    expect(fuzzyMatch('bh', 'Boltzmann H-theorem')?.positions).toEqual([0, 10])
    expect(fuzzyMatch('ht', 'Boltzmann H-theorem')?.positions).toEqual([10, 12])
  })

  it('treats camelCase and digit boundaries as word starts', () => {
    expect(fuzzyMatch('fb', 'fooBar')?.positions).toEqual([0, 3])
    expect(fuzzyMatch('p2', 'phase2')?.positions).toEqual([0, 5])
  })

  it('ignores whitespace inside the query', () => {
    expect(fuzzyMatch('new mem', 'New memory')?.positions).toEqual([0, 1, 2, 4, 5, 6])
  })

  it('ranks exact > prefix > word start > scattered', () => {
    const exact = fuzzyMatch('lens', 'Lens')!.score
    const prefix = fuzzyMatch('lens', 'Lenses of time')!.score
    const word = fuzzyMatch('lens', 'Absolute lens')!.score
    const scattered = fuzzyMatch('lens', 'Lasting emotions')!.score
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(word)
    expect(word).toBeGreaterThan(scattered)
  })

  it('keeps indices aligned when lowercasing lengthens a character', () => {
    // 'İ'.toLowerCase() is two code units; the match index must still point at the original.
    expect(fuzzyMatch('ix', 'İx')?.positions).toEqual([0, 1])
  })
})

describe('fuzzyMatchFields', () => {
  it('lets each token match in a different field', () => {
    const r = fuzzyMatchFields('physics boltz', ['Boltzmann', 'physics'])
    expect(r).not.toBeNull()
    expect(r!.positions[0]).toEqual([0, 1, 2, 3, 4])
    expect(r!.positions[1]).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('fails when any token matches nowhere', () => {
    expect(fuzzyMatchFields('physics zzz', ['Boltzmann', 'physics'])).toBeNull()
  })

  it('applies a per-field bias', () => {
    const inTitle = fuzzyMatchFields('ent', [{ text: 'Entropy' }, { text: 'misc', bias: -4 }])!.score
    const inTag = fuzzyMatchFields('ent', [{ text: 'misc' }, { text: 'Entropy', bias: -4 }])!.score
    expect(inTitle).toBeGreaterThan(inTag)
  })

  it('returns empty positions per field for an empty query', () => {
    expect(fuzzyMatchFields('  ', ['a', 'b'])).toEqual({ score: 0, positions: [[], []] })
  })
})

describe('fuzzyRank', () => {
  const titles = ['Some element', 'Memory of Paris', 'Maxwell', 'Memory']
  const rank = (q: string, limit?: number) => fuzzyRank(titles, q, (t) => [t], limit).map((r) => r.item)

  it('filters and orders by score', () => {
    expect(rank('mem')).toEqual(['Memory', 'Memory of Paris', 'Some element'])
  })

  it('keeps input order for an empty query and honours the limit', () => {
    expect(rank('')).toEqual(titles)
    expect(rank('', 2)).toEqual(titles.slice(0, 2))
    expect(rank('mem', 1)).toEqual(['Memory'])
  })

  it('breaks ties by input order', () => {
    expect(fuzzyRank(['abc', 'abc'], 'abc', (t) => [t]).map((r) => r.score)).toHaveLength(2)
    const items = [{ id: 1, t: 'abc' }, { id: 2, t: 'abc' }]
    expect(fuzzyRank(items, 'abc', (i) => [i.t]).map((r) => r.item.id)).toEqual([1, 2])
  })
})

describe('highlightSegments', () => {
  it('splits text into hit and miss runs', () => {
    expect(highlightSegments('Boltzmann', [0, 1, 5])).toEqual([
      { text: 'Bo', hit: true },
      { text: 'ltz', hit: false },
      { text: 'm', hit: true },
      { text: 'ann', hit: false },
    ])
  })

  it('handles no positions and empty text', () => {
    expect(highlightSegments('abc', [])).toEqual([{ text: 'abc', hit: false }])
    expect(highlightSegments('abc', undefined)).toEqual([{ text: 'abc', hit: false }])
    expect(highlightSegments('', [])).toEqual([])
  })
})
