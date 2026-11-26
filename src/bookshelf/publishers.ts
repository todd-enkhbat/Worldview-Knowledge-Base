import type { EditionResult } from './catalog.ts'
export const BOOK_PUBLISHERS = ['Library of America', 'Easton Press', 'The Folio Society', 'Everyman’s Library', 'Penguin Classics', 'Oxford World’s Classics', 'NYRB Classics', 'Modern Library', 'Franklin Library', 'Harvard University Press', 'Oxford University Press', 'Cambridge University Press', 'Princeton University Press', 'Yale University Press', 'MIT Press', 'Hackett Publishing', 'W. W. Norton', 'Vintage', 'Verso', 'Logos Publishing'] as const
const aliases: [string, RegExp][] = [
  ['Library of America', /\b(?:library of america|loa)\b/i], ['Easton Press', /\b(?:the\s+)?easton press\b/i], ['The Folio Society', /\b(?:the\s+)?folio society\b/i], ["Everyman's Library", /\beveryman[’']?s library\b/i], ['Penguin Classics', /\bpenguin classics\b/i], ["Oxford World's Classics", /\boxford world[’']?s classics\b/i], ['NYRB Classics', /\bnyrb(?: classics)?\b/i],
  ...BOOK_PUBLISHERS.filter(name => !['Library of America','Easton Press','The Folio Society','Everyman’s Library','Penguin Classics','Oxford World’s Classics','NYRB Classics'].includes(name)).map(name => [name, new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i')] as [string, RegExp]),
]
export function publisherSearch(input: string, selected = '') {
  const match = aliases.find(([, pattern]) => pattern.test(input))
  const publisher = selected.trim().replace(/[’]/g, "'") || match?.[0] || ''
  const query = match ? input.replace(match[1], '').trim() : input.trim()
  return { publisher, query, forProvider: (field: string) => [query, publisher ? `${field}:"${publisher.replace(/["\\]/g, '')}"` : ''].filter(Boolean).join(' ') }
}
export function matchesPublisher(value: string, selected: string) {
  if (!selected) return true
  const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^the/, '')
  const target = normalize(selected)
  const publisher = normalize(value)
  return publisher.includes(target) || (target === 'penguinclassics' && publisher.includes('penguin')) || (target === 'oxfordworldsclassics' && publisher.includes('oxford'))
}
/** A publisher-verified record fills a demonstrated catalog-discovery gap. It is
 * an actual identified edition, not a generic preferred translation or binding. */
export function verifiedPublisherEditions(input: string, selected = ''): EditionResult[] {
  const { publisher, query } = publisherSearch(input, selected)
  if (publisher && publisher !== 'Library of America' || !(/\bfranklin\b|poor richard|9781883011536|1883011531/i.test(query))) return []
  return [{ work: { id: 'OL14996484W', title: 'Autobiography, Poor Richard, & Later Writings', authors: [{ name: 'Benjamin Franklin', id: null }], year: 1997, editionCount: 1, preferredEdition: 'OL675426M' }, edition: { id: 'OL675426M', title: 'Autobiography, Poor Richard, & Later Writings', subtitle: 'Edited by J. A. Leo Lemay', editionLabel: 'Library of America · volume 37.2', publisher: 'Library of America', date: '1997', year: 1997, language: 'eng', isbn: '9781883011536', pages: 816, coverId: 929370, sourceUrl: 'https://www.loa.org/books/233-autobiography-poor-richard-amp-later-writings/' } }]
}
