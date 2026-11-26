import copies from './courseEditions.json'
import { editionIsbn, type EditionResult } from './catalog.ts'
import { readingLists } from './readingLists.ts'
import type { BookAttribution } from './types.ts'

export const normalized = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/\bphenomonology\b/g, 'phenomenology').replace(/\billiad\b/g, 'iliad')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const titleKey = (s: string) => normalized(s).replace(/^(?:the|an|a) /, '')
const tokens = (s: string) => normalized(s).split(' ').filter(w => w && !['a', 'an', 'the', 'of', 'on', 's'].includes(w))
export interface BookSubject { title: string; author: string; isbn: string; editionId: string }
export function subjectOf({ work, edition }: EditionResult): BookSubject {
  return { title: edition.title, author: work.authors.map(a => a.name).join(', '), isbn: editionIsbn(edition.isbn), editionId: edition.id }
}
export function identifies(source: BookAttribution, subject: BookSubject) {
  if (source.scope === 'edition') return !!source.editionId && source.editionId === subject.editionId ||
    !!editionIsbn(source.isbn) && editionIsbn(source.isbn) === editionIsbn(subject.isbn)
  return titleKey(source.title) === titleKey(subject.title) && normalized(source.author) === normalized(subject.author)
}
export interface Evidence {
  title: string; author: string; by: string; relation: string; version: string; isbn: string; context: string; url: string; editionId?: string; personal?: boolean
}
export const publishedEvidence: Evidence[] = readingLists.flatMap(list => list.readings.map(([title, author, version = '', isbn = '']) =>
  ({ title, author, version, isbn, by: list.by, relation: list.relation, context: list.context, url: list.url })))

export function findEvidence(query: string, personal: BookAttribution[] = []) {
  const words = tokens(query), isbn = editionIsbn(query)
  if (!words.length) return []
  const own: Evidence[] = personal.map(r => ({ title: r.title, author: r.author, by: r.name, version: r.scope === 'edition' ? 'Edition · ' + (r.isbn || r.editionId) : '',
    isbn: r.scope === 'edition' ? r.isbn : '', editionId: r.editionId, relation: r.relation, context: 'Added by you · ' + r.kind, url: r.url, personal: true }))
  return [...publishedEvidence, ...own].filter(row => {
    if (isbn) return isbn === row.isbn
    if (normalized(row.by) === normalized(query)) return true
    const title = tokens(row.title), author = tokens(row.author)
    if (normalized(row.author) === normalized(query) || words.length === 1 && words[0].length >= 4 && words[0] === author.at(-1)) return true
    const allowed = new Set([...title, ...author, ...tokens(row.version)])
    return words.every(w => allowed.has(w)) && (title.every(w => words.includes(w)) ||
      words.some(w => author.includes(w)) && words.some(w => title.includes(w)))
  })
}

export function workKey(subject: Pick<BookSubject, 'title' | 'author'>) {
  return JSON.stringify([titleKey(subject.title), normalized(subject.author)])
}

export function attributionIndex(entries: BookAttribution[] = []) {
  const names = new Map<string, Set<string>>()
  for (const e of entries) {
    const keys = e.scope === 'work' ? [workKey(e)] : [e.editionId, editionIsbn(e.isbn)].filter(Boolean)
    for (const key of keys) {
      const group = names.get(key) ?? new Set<string>()
      group.add(e.name)
      names.set(key, group)
    }
  }
  return (subject: BookSubject) => [workKey(subject), subject.editionId, editionIsbn(subject.isbn)].flatMap(key => [...names.get(key) ?? []]).join(' ')
}

const publishedByTitle = new Map<string, Evidence[]>()
const publishedByIsbn = new Map<string, Evidence[]>()
for (const record of publishedEvidence) {
  const title = titleKey(record.title)
  publishedByTitle.set(title, [...publishedByTitle.get(title) ?? [], record])
  if (record.isbn) publishedByIsbn.set(record.isbn, [...publishedByIsbn.get(record.isbn) ?? [], record])
}

export function publicSourcesFor(subject: BookSubject) {
  const authorWords = new Set(tokens(subject.author))
  const matches = publishedByTitle.get(titleKey(subject.title))?.filter(r => tokens(r.author).every(w => authorWords.has(w))) ?? []
  return [...new Set([...publishedByIsbn.get(editionIsbn(subject.isbn)) ?? [], ...matches])]
}

export function courseCopy(hit: Evidence): EditionResult | undefined {
  const c = copies.find(c => c.isbn === hit.isbn)
  if (!c || hit.personal) return
  return { work: { id: c.workId, title: hit.title, authors: [{ name: hit.author, id: null }], preferredEdition: c.editionId, year: null, editionCount: 1 },
    edition: { id: c.editionId, isbn: c.isbn, publisher: c.publisher, translator: c.translator, title: hit.title, subtitle: '',
      editionLabel: c.format, coverId: c.coverId, year: c.year, pages: c.pages, date: String(c.year), language: 'eng' } }
}
