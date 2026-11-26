import { z } from 'zod'
import type { KnowledgeSnapshot, SourceVersion } from '../knowledge/types.ts'
import type { ShelfBook } from '../bookshelf/types.ts'

export const QUOTES_KV = 'quotes.v1'
const id = z.string().min(1).max(1000)
const originSchema = z.object({
  kind: z.enum(['writing', 'book', 'article', 'collection']),
  id,
  title: z.string().max(1000),
  authorship: z.enum(['human', 'ai', 'mixed', 'unknown']).optional(),
})
const sourceSchema = z.object({
  title: z.string().trim().max(1000),
  kind: z.enum(['book', 'article', 'library']).optional(),
  referenceStatus: z.enum(['identified', 'pending']).optional(),
  author: z.string().trim().max(500),
  edition: z.string().trim().max(1200),
  locator: z.string().trim().max(500),
  sourceId: id.optional(),
  versionId: id.optional(),
  bookId: id.optional(),
  catalogEditionId: id.optional(),
  isbn: z.string().max(100).optional(),
  url: z.string().trim().max(2000).refine(value => {
    try {
      const url = new URL(value)
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
    } catch { return false }
  }, 'Enter a valid http or https article URL without sign-in details.').optional(),
}).refine(source => source.referenceStatus === 'pending'
  ? source.kind === 'article' && !source.title && !source.url && !source.bookId && !source.sourceId && !source.versionId && !source.catalogEditionId && !source.isbn
  : !!source.title, 'Choose a source or save this as an article with the reference pending.')
const verificationSchema = z.object({
  status: z.enum(['exact', 'multiple', 'not-found', 'unavailable', 'unlinked']),
  checkedAt: z.number(),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().positive().optional(),
  contentHash: z.string().optional(),
  sourceAuthorship: z.enum(['human', 'assistant', 'third-party', 'mixed', 'unknown']).optional(),
})
const revisionSchema = z.object({
  at: z.number(),
  action: z.enum(['captured', 'amended', 'rechecked']),
  source: sourceSchema,
  verification: verificationSchema,
  attribution: z.enum(['source-metadata', 'bookshelf-metadata', 'user-supplied', 'unknown']),
})
const recordSchema = z.object({
  id, text: z.string().min(1).max(20000).refine(value => !!value.trim()),
  origin: originSchema, createdAt: z.number(), history: z.array(revisionSchema).min(1),
})
const schema = z.object({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), quotes: z.array(recordSchema) })
export type QuoteOrigin = z.infer<typeof originSchema>
export type QuoteSource = z.infer<typeof sourceSchema>
export type QuoteVerification = z.infer<typeof verificationSchema>
export type QuoteRevision = z.infer<typeof revisionSchema>
export type QuoteRecord = z.infer<typeof recordSchema>
export type QuoteLibrary = z.infer<typeof schema>
export type Corpus = Pick<KnowledgeSnapshot, 'sources' | 'versions' | 'passages'>
export type Anchor = { start: number; end: number }
export const emptyLibrary = (): QuoteLibrary => ({ schemaVersion: 1, revision: 0, quotes: [] })
export function decodeQuotes(value: unknown): QuoteLibrary {
  return value == null ? emptyLibrary() : schema.parse(value)
}
export function versionAuthor(version?: SourceVersion): string {
  const meta = version?.metadata
  for (const field of [meta?.author, meta?.authors, meta?.byline]) {
    const names = (Array.isArray(field) ? field : [field]).map(value => {
      if (typeof value === 'string') return value.trim()
      return value && typeof value === 'object' && typeof value.name === 'string' ? value.name.trim() : ''
    }).filter(Boolean)
    if (names.length) return names.join(', ').slice(0, 500)
  }
  return ''
}
export function verifiedAnchor(check: QuoteVerification): Anchor | undefined {
  if (check.status === 'exact' && check.start !== undefined && check.end !== undefined) return { start: check.start, end: check.end }
}

export function verifyQuote(text: string, reference: QuoteSource, corpus: Corpus, at: number, anchor?: Anchor): QuoteVerification {
  if (!reference.sourceId) return { status: 'unlinked', checkedAt: at }
  const source = corpus.sources.find(s => s.id === reference.sourceId && !s.deleted && !s.excluded)
  const version = source && corpus.versions.find(v => v.id === reference.versionId && v.sourceId === source.id)
  if (!source || !version?.text) return { status: 'unavailable', checkedAt: at }

  const checked = { checkedAt: at, contentHash: version.contentHash }
  if (!text.trim()) return { ...checked, status: 'not-found' }
  const anchored = anchor && Number.isInteger(anchor.start) && anchor.start >= 0
    && anchor.end === anchor.start + text.length && version.text.slice(anchor.start, anchor.end) === text
  const start = anchored ? anchor.start : version.text.indexOf(text)
  if (start < 0) return { ...checked, status: 'not-found' }
  if (!anchored && version.text.indexOf(text, start + 1) >= 0) return { ...checked, status: 'multiple' }

  const end = start + text.length
  const passages = corpus.passages.filter(p =>
    p.sourceId === source.id && p.versionId === version.id && p.end > start && p.start < end,
  ).sort((a, b) => a.start - b.start)
  let covered = start
  const roles = new Set(passages.map(p => p.role))
  for (const passage of passages) {
    if (passage.start > covered) break
    covered = Math.max(covered, passage.end)
  }
  const sourceAuthorship = covered < end || !roles.size ? 'unknown' : roles.size === 1 ? passages[0].role : 'mixed'
  return { ...checked, status: 'exact', start, end, sourceAuthorship }
}

export interface QuoteInput { text: string; origin: QuoteOrigin; source: QuoteSource; anchor?: Anchor }
export function updateQuote(library: QuoteLibrary, input: QuoteInput, corpus: Corpus, at: number, quoteId: string, action: QuoteRevision['action'], book?: ShelfBook) {
  const source = sourceSchema.parse(input.source)
  if (source.versionId && !source.sourceId) throw new Error('Choose the source that owns this version.')
  if (source.sourceId && source.versionId && corpus.versions.some(v => v.id === source.versionId && v.sourceId !== source.sourceId)) {
    throw new Error('This version belongs to another source.')
  }
  const visibleSource = corpus.sources.find(s => s.id === source.sourceId && !s.deleted && !s.excluded)
  const version = visibleSource && corpus.versions.find(v => v.id === source.versionId && v.sourceId === visibleSource.id)
  const verification = verifyQuote(input.text, source, corpus, at, input.anchor)
  const bookAuthor = book?.id === source.bookId && book?.catalog?.editionId === source.catalogEditionId
    ? book?.authors.join(', ').slice(0, 500) : undefined
  const attribution = !source.author ? 'unknown' : source.author === versionAuthor(version) ? 'source-metadata'
    : source.author === bookAuthor ? 'bookshelf-metadata' : 'user-supplied'
  const revision: QuoteRevision = { at, action, source, verification, attribution }
  const existing = library.quotes.find(q => q.id === quoteId)
  if (action === 'captured') {
    if (existing) return
    library.quotes.unshift(recordSchema.parse({ id: quoteId, text: input.text, origin: input.origin, createdAt: at, history: [revision] }))
  } else {
    if (!existing || existing.text !== input.text) throw new Error('Reopen the saved quotation before changing its reference.')
    existing.history.push(revision)
  }
  library.revision++
}
export const verificationLabel: Record<QuoteVerification['status'], string> = {
  exact: 'Exact text match', multiple: 'Multiple text matches', 'not-found': 'No exact text match',
  unavailable: 'Version text unavailable', unlinked: 'No retained source linked',
}
export function originHref(origin: QuoteOrigin) {
  const base = { book: '#/bookshelf?book=', writing: '#/write?doc=', article: '#/library?source=', collection: '' }[origin.kind]
  return base ? base + encodeURIComponent(origin.id) : ''
}
export function retainedHref(source: QuoteSource) {
  if (!source.sourceId) return ''
  const params = new URLSearchParams({ source: source.sourceId })
  if (source.versionId) params.set('version', source.versionId)
  return '#/library?' + params.toString()
}
