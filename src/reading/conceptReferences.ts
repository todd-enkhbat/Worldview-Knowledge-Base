import type { ShelfBook } from '../bookshelf/types.ts'
import type { NodeRecord } from '../domain/types.ts'
import type { KnowledgeSource, SourceVersion } from '../knowledge/types.ts'
import { extractVaultLinks, vaultLiteralRanges } from '../knowledge/vault.ts'
import { verificationLabel, type QuoteRecord } from '../quotes/model.ts'
import { conceptMentions, recognizedPassages, writingPassages, writingReferenceStructure } from '../writing/concepts.ts'
import { plainTextFromWriting } from '../writing/model.ts'
import { conceptNoteId } from '../writing/store.ts'
import type { WritingDocument } from '../writing/types.ts'
import { topicMatches, type CanonicalTopic } from './topics.ts'
import type { ReadingSnapshot } from './types.ts'

export interface ConceptExcerpt { text: string; href: string; relation: 'Linked passage' | 'Example' | 'Mention' | 'Wiki link' | 'Quotation' | 'Highlight' | 'Quoted in this note' | 'Assigned topic' }
export interface ConceptReference {
  id: string
  kind: 'note' | 'quote'
  title: string
  detail: string
  at: number
  excerpts: ConceptExcerpt[]
}
export interface ConceptCorpus {
  docs: WritingDocument[]
  books: ShelfBook[]
  quotes: QuoteRecord[]
  sources: KnowledgeSource[]
  versions: SourceVersion[]
  nodes: Map<string, NodeRecord>
  reading: Pick<ReadingSnapshot, 'items' | 'notes' | 'highlights' | 'pdfHighlights'>
}
const encode = encodeURIComponent
const sourceHref = (id: string) => '#/library?source=' + encode(id)
const snapshot = (value: string) => value.length > 280 ? value.slice(0, 277) + '…' : value
const around = (text: string, start: number, end: number) => snapshot(text.slice(Math.max(0, start - 75), end + 100).trim())

export function conceptReferences(topic: CanonicalTopic, topics: CanonicalTopic[], corpus: ConceptCorpus): ConceptReference[] {
  const term = { id: topic.id, label: topic.name, aliases: topic.terms }
  const match = conceptMentions(topics.map(t => ({ id: t.id, label: t.name, aliases: t.terms })))
  const hits = (text: string) => match(text).filter(hit => hit.id === topic.id)
  const refs: ConceptReference[] = []
  const visibleSources = new Map(corpus.sources.filter(s => !s.excluded && !s.deleted).map(s => [s.id, s]))
  const hidden = new Set(corpus.reading.items.filter(item => item.libraryVisible === false).map(item => item.sourceId))
  const editions = new Map(corpus.books.filter(book => book.archivedAt == null && !hidden.has('book:' + book.id)).map(book => [book.id, book]))
  const ownNotebooks = new Set([topic.id, ...topic.aliases].map(conceptNoteId))
  const selectedQuotes = new Set<string>()
  const quotesById = new Map(corpus.quotes.map(q => [q.id, q]))
  const highlights = [...corpus.reading.highlights, ...(corpus.reading.pdfHighlights ?? [])]
  const citationKey = (source: unknown, version: unknown, start: unknown, end: unknown, page: unknown, text: string) =>
    JSON.stringify([source, version, page ?? null, page ? null : start, page ? null : end, text])
  const retainedQuotations = new Set(highlights.map(h => citationKey(h.sourceId, h.versionId, 'start' in h ? h.start : null, 'end' in h ? h.end : null, 'page' in h ? h.page : null, h.quote)))
  for (const q of corpus.quotes) {
    const last = q.history.at(-1)
    if (last?.verification.status === 'exact') retainedQuotations.add(citationKey(last.source.sourceId, last.source.versionId, last.verification.start, last.verification.end, null, q.text))
  }

  function mentions(text: string, href: string, relation: ConceptExcerpt['relation'] = 'Mention') {
    return hits(text).map(hit => ({ href, text: around(text, hit.from, hit.to), relation }))
  }
  function add(id: string, kind: ConceptReference['kind'], title: string, detail: string, at: number, excerpts: ConceptExcerpt[]) {
    if (excerpts.length) refs.push({ id, kind, title, detail, at, excerpts })
  }
  for (const doc of corpus.docs) {
    if (doc.archivedAt != null || ownNotebooks.has(doc.id) || hidden.has('writing:' + doc.id) || doc.sourceId && !visibleSources.has(doc.sourceId)) continue
    const book = doc.bookEditionId && editions.get(doc.bookEditionId)
    const href = book ? '#/bookshelf?book=' + encode(book.id) + '&note=' + encode(doc.id) : '#/write?doc=' + encode(doc.id)
    const detail = book ? 'Reading note · ' + book.title : 'Writing Studio'
    const { blocks, atoms, savedQuoteMarks } = writingReferenceStructure(doc.content)
    const excerpts: ConceptExcerpt[] = [], explicitlyQuoted = new Set<string>()
    for (const link of writingPassages(doc.content).filter(link => topicMatches(topic, [link.topicId]))) {
      const quoteMark = savedQuoteMarks.find(mark => mark.start <= link.from && mark.end > link.from)
      if (quoteMark && savedQuoteMarks.filter(mark => mark.quote === quoteMark.quote && mark.end > link.from && mark.start < link.to)
        .reduce((end, span) => span.start <= end ? Math.max(end, span.end) : end, link.from) >= link.to) {
        selectedQuotes.add(quoteMark.quote); explicitlyQuoted.add(quoteMark.quote)
        continue
      }
      const block = blocks.find(block => block.start <= link.from && block.end >= link.to)
      excerpts.push({ relation: link.relation === 'example' ? 'Example' : 'Linked passage', text: block ? around(block.text, link.from - block.start, link.to - block.start) : snapshot(link.text), href: href + '&passage=' + encode(link.id) + (link.part ? '&part=' + link.part : '') })
    }
    for (const id of new Set(savedQuoteMarks.map(mark => mark.quote))) {
      const saved = quotesById.get(id), sourceId = saved?.history.at(-1)?.source.sourceId
      if (!saved || sourceId && !visibleSources.has(sourceId)) continue
      const hit = hits(saved.text)[0], span = savedQuoteMarks.find(mark => mark.quote === id)!
      if (hit || explicitlyQuoted.has(id)) {
        const block = blocks.find(block => block.start <= span.start && block.end >= span.end)
        const words = block?.text.slice(span.start - block.start, span.end - block.start)
        excerpts.push({ relation: 'Quoted in this note', text: hit ? around(saved.text, hit.from, hit.to) : snapshot(saved.text),
          href: words ? href + '&from=' + span.start + '&term=' + encode(words.slice(0, 100)) : href })
      }
    }
    for (const { node, at } of atoms) {
      const attrs = node.attrs ?? {}
      if (node.type === 'writingTopicLink' && topicMatches(topic, [String(attrs.topicId)])) {
        const block = blocks.find(block => block.start <= at && block.end > at), label = String(attrs.label ?? topic.name)
        const text = block ? block.text.slice(0, at - block.start) + label + block.text.slice(at - block.start + 1) : label
        const offset = block ? at - block.start : 0
        excerpts.push({ text: around(text, offset, offset + label.length), relation: 'Wiki link', href: href + '&atom=' + at + '&topic=' + encode(String(attrs.topicId)) })
      }
      if (node.type === 'writingCitation' && visibleSources.has(String(attrs.sourceId))) {
        const text = String(attrs.quote ?? '')
        const hit = hits(text)[0]
        if (hit) {
          const excerpt = around(text, hit.from, hit.to)
          excerpts.push({ text: excerpt, href, relation: 'Quoted in this note' })
          const source = sourceHref(String(attrs.sourceId)) + '&version=' + encode(String(attrs.versionId))
          const target = attrs.page ? '&page=' + attrs.page : typeof attrs.start === 'number' ? '&from=' + (attrs.start + hit.from) + '&term=' + encode(text.slice(hit.from, hit.to)) : ''
          const key = citationKey(attrs.sourceId, attrs.versionId, attrs.start, attrs.end, attrs.page, text)
          if (!retainedQuotations.has(key)) {
            retainedQuotations.add(key)
            add('citation:' + doc.id + ':' + at, 'quote', String(attrs.sourceTitle), attrs.page ? 'Page ' + attrs.page : 'Cited in ' + doc.title, doc.updatedAt,
              [{ text: excerpt, href: source + target, relation: 'Quotation' }])
          }
        }
      }
    }
    for (const hit of recognizedPassages(doc.content, term, match)) {
      excerpts.push({ relation: 'Mention', text: hit.text.trim(), href: href + '&from=' + hit.from + '&term=' + encode(hit.label) })
    }
    if (!excerpts.length) excerpts.push(...mentions(doc.title, href))
    if (!excerpts.length && (topicMatches(topic, doc.topicIds) || topicMatches(topic, corpus.reading.items.find(item => item.sourceId === 'writing:' + doc.id)?.topicIds))) {
      excerpts.push({ text: snapshot(plainTextFromWriting(doc.content).trim()) || doc.title, relation: 'Assigned topic', href })
    }
    add('writing:' + doc.id, 'note', doc.title || 'Untitled writing', detail, doc.updatedAt, excerpts)
  }
  for (const q of corpus.quotes) {
    const last = q.history.at(-1)
    if (!last || last.source.sourceId && !visibleSources.has(last.source.sourceId)) continue
    const matches = hits(q.text)
    if (!matches.length && !selectedQuotes.has(q.id)) continue
    const s = last.source
    add('quote:' + q.id, 'quote', s.referenceStatus === 'pending' ? 'Article · reference pending' : s.title,
      [s.author, s.locator, verificationLabel[last.verification.status]].filter(Boolean).join(' · '), q.createdAt,
      [{ text: matches.length ? around(q.text, matches[0].from, matches[0].to) : snapshot(q.text), relation: 'Quotation', href: '#/quotes?quote=' + encode(q.id) }])
  }
  for (const book of editions.values()) {
    add('book:' + book.id, 'note', book.title, 'Bookshelf note', book.updatedAt, mentions(book.notes, '#/bookshelf?book=' + encode(book.id) + '&legacyNote=1'))
  }
  for (const note of corpus.reading.notes) {
    const source = visibleSources.get(note.sourceId)
    if (source) add('annotation:' + note.id, 'note', source.title, 'Margin note', note.updatedAt, mentions(note.text, sourceHref(source.id) + '&note=' + encode(note.id)))
  }
  for (const h of highlights) {
    const source = visibleSources.get(h.sourceId)
    if (!source) continue
    const href = sourceHref(source.id) + '&version=' + encode(h.versionId) + ('page' in h ? '&page=' + h.page : '') + '&highlight=' + encode(h.id)
    const detail = 'page' in h ? 'Page ' + h.page : 'Saved highlight'
    const match = hits(h.quote)[0]
    const linked = 'topicId' in h && typeof h.topicId === 'string' && topicMatches(topic, [h.topicId])
    if (linked || match) add('highlight:' + h.id, 'quote', source.title, detail, h.createdAt, [{ text: match ? around(h.quote, match.from, match.to) : snapshot(h.quote), href, relation: 'Highlight' }])
    add('comment:' + h.id, 'note', source.title, 'Highlight comment', h.updatedAt, mentions(h.note, href))
  }

  function noteExcerpts(text: string, href: string, markdown: boolean, sourceOffset?: number): ConceptExcerpt[] {
    const skips = markdown ? vaultLiteralRanges(text) : []
    const links = markdown ? extractVaultLinks(text, skips) : []
    const at = (start: number, end: number) => sourceOffset === undefined ? href
      : href + '&from=' + (sourceOffset + start) + '&term=' + encode(text.slice(start, end))
    const passages: { pos: number; excerpt: ConceptExcerpt }[] = []
    for (const link of links) {
      skips.push([link.start, link.end])
      const target = link.target.split('/').at(-1)?.replace(/\.(?:md|markdown)$/i, '') ?? ''
      const linked = hits(target).some(hit => hit.from === 0 && hit.to === target.length)
      if (linked || link.alias && hits(link.alias).length) {
        passages.push({ pos: link.start, excerpt: { relation: linked ? 'Wiki link' : 'Mention', text: around(text, link.start, link.end), href: at(link.start, link.end) } })
      }
    }
    for (const hit of hits(text)) {
      if (skips.some(([from, to]) => hit.from < to && hit.to > from)) continue
      passages.push({ pos: hit.from, excerpt: { relation: 'Mention', text: around(text, hit.from, hit.to), href: at(hit.from, hit.to) } })
    }
    return passages.sort((a,b) => a.pos - b.pos).map(hit => hit.excerpt)
  }
  const editionSources = new Set(corpus.books.map(book => book.sourceId).filter(Boolean))
  const current = new Map(corpus.versions.map(v => [v.id, v]))
  const represented = new Set<string>()
  for (const source of visibleSources.values()) {
    if (source.nodeId) represented.add(source.nodeId)
    const v = current.get(source.currentVersionId)
    if (!v || v.sourceId !== source.id || editionSources.has(source.id) || source.externalId.startsWith('writing:') || v.metadata?.format === 'writing') continue
    const obsidian = source.kind === 'obsidian'
    const markdown = obsidian || source.kind === 'document' && /\.(?:md|markdown)$/i.test(String(v.metadata?.path ?? ''))
    const notebook = source.externalId.startsWith('notebook:')
    if (!markdown && !notebook && !['thought', 'legacy'].includes(source.kind)) continue
    const href = sourceHref(source.id) + '&version=' + encode(v.id)
    const bodyStart = markdown && typeof v.metadata?.bodyStart === 'number' ? v.metadata.bodyStart : 0
    const excerpts = noteExcerpts(v.text.slice(bodyStart), href, markdown, bodyStart)
    if (!excerpts.length) excerpts.push(...mentions(source.title, href))
    add('source:' + source.id, 'note', source.title, obsidian ? 'Obsidian note' : notebook ? String(v.metadata?.provider ?? 'Imported note') : markdown ? 'Markdown note' : 'Library note', source.updatedAt, excerpts)
  }
  for (const node of corpus.nodes.values()) {
    if (represented.has(node.id) || node.deletedAt != null || node.corpusExcluded || node.libraryOrigin === 'example') continue
    const href = '#/library?record=' + encode(node.id), excerpts = noteExcerpts(node.contentMd, href, true)
    if (!excerpts.length) excerpts.push(...mentions(node.title, href))
    add('record:' + node.id, 'note', node.title, node.provenance?.source === 'obsidian' ? 'Obsidian note' : 'Library note', node.updatedAt, excerpts)
  }
  return refs.sort((a,b) => b.at - a.at || a.id.localeCompare(b.id))
}
