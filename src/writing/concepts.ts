import type { WritingNode } from './types.ts'

export type ConceptRelation = 'concept' | 'example'
export interface ConceptTerm { id: string; label: string; aliases?: string[] }
export interface ConceptLink { id: string; topicId: string; relation: ConceptRelation; createdAt: number; updatedAt: number }
export interface WritingPassage extends ConceptLink { text: string; from: number; to: number; part: number }
export const conceptMark = 'writingConcept'
export const passageHref = (doc: string, passage: string, part = 0) =>
  '#/write?doc=' + encodeURIComponent(doc) + '&passage=' + encodeURIComponent(passage) + (part ? '&part=' + part : '')

const textblocks = new Set(['paragraph', 'heading', 'codeBlock'])
const containers = new Set(['doc', ...textblocks, 'blockquote', 'bulletList', 'orderedList', 'listItem', 'table', 'tableRow', 'tableCell', 'tableHeader'])

/** A passage can cross styles and paragraphs. An unlinked insertion splits it into separately navigable excerpts. */
export function writingPassages(content: WritingNode): WritingPassage[] {
  const found: WritingPassage[] = []
  const tails = new Map<string, { link: WritingPassage; sequence: number; line: number }>()
  let sequence = 0, line = 0
  function visit(node: WritingNode, position: number): number {
    if (node.type === 'text') {
      const text = node.text ?? ''
      for (const mark of node.marks ?? []) {
        if (mark.type !== conceptMark || !mark.attrs) continue
        const attrs = mark.attrs as unknown as ConceptLink
        const previous = tails.get(attrs.id)
        let link: WritingPassage
        if (previous && previous.sequence === sequence) {
          link = previous.link
          link.text += '\n'.repeat(line - previous.line) + text
          link.to = position + text.length
        } else {
          link = { ...attrs, text, from: position, to: position + text.length, part: previous ? previous.link.part + 1 : 0 }
          found.push(link)
        }
        tails.set(attrs.id, { link, sequence: sequence + 1, line })
      }
      sequence++
      return text.length
    }
    if (node.type === 'hardBreak') { line++; return 1 }
    if (!containers.has(node.type)) { sequence++; return 1 }
    if (textblocks.has(node.type)) line++
    let offset = position + (node.type === 'doc' ? 0 : 1)
    for (const child of node.content ?? []) offset += visit(child, offset)
    return offset - position + (node.type === 'doc' ? 0 : 1)
  }
  visit(content, 0)
  return found
}

export function conceptMentions(terms: ConceptTerm[]) {
  const labels = new Map<string, string | null>()
  for (const term of terms) for (const label of [term.label, ...(term.aliases ?? [])]) {
    const key = label.trim().normalize('NFC').toLowerCase()
    if (key) labels.set(key, labels.has(key) && labels.get(key) !== term.id ? null : term.id)
  }
  const choices = [...labels.keys()].filter(key => labels.get(key)).sort((a,b) => b.length - a.length)
  const escaped = choices.map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const words = escaped.length ? new RegExp('(?<![\\p{L}\\p{N}\\p{M}_])(?:' + escaped.join('|') + ')(?![\\p{L}\\p{N}\\p{M}_])', 'giu') : null
  return (text: string) => {
    if (!words || !text) return []
    const normalized = text.normalize('NFC')
    // Keep editor offsets in the original UTF-16 string when pasted text uses
    // a combining accent (or another canonically equivalent spelling).
    let offsets: Map<number, number> | undefined
    if (normalized !== text) {
      offsets = new Map([[0, 0]])
      let n = 0
      for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
        n += part.segment.normalize('NFC').length
        offsets.set(n, part.index + part.segment.length)
      }
    }
    return [...normalized.matchAll(words)].flatMap(match => {
      const id = labels.get(match[0].toLowerCase()), start = match.index!, end = start + match[0].length
      const from = offsets ? offsets.get(start) : start, to = offsets ? offsets.get(end) : end
      return id && from !== undefined && to !== undefined ? [{ from, to, id }] : []
    })
  }
}

export function recognizedPassages(content: WritingNode, term: ConceptTerm, match = conceptMentions([term])) {
  const found: { text: string; label: string; from: number; to: number }[] = []
  function visit(node: WritingNode, position: number): number {
    if (node.type === 'text') return node.text?.length ?? 0
    if (!node.content) return ['paragraph','heading','codeBlock','doc'].includes(node.type) ? (node.type === 'doc' ? 0 : 2) : 1
    let offset = position + (node.type === 'doc' ? 0 : 1), text = '', start = offset
    const flush = () => {
      for (const hit of match(text)) if (hit.id === term.id) found.push({ text: text.slice(Math.max(0, hit.from - 60), hit.to + 80), label: text.slice(hit.from, hit.to), from: start + hit.from, to: start + hit.to })
      text = ''
    }
    for (const child of node.content) {
      if (child.type === 'text' && node.type !== 'codeBlock' && !child.marks?.some(mark => ['code','link','writingQuote',conceptMark].includes(mark.type))) {
        if (!text) start = offset
        text += child.text || ''
      } else flush()
      offset += visit(child, offset)
    }
    flush()
    return offset - position + (node.type === 'doc' ? 0 : 1)
  }
  visit(content, 0)
  return found
}

/** Include the surrounding paragraph for an explicit mark, whose selected words may be just one term. */
export function writingReferenceStructure(root: WritingNode) {
  const blocks: { start: number; end: number; text: string }[] = []
  const atoms: { node: WritingNode; at: number }[] = []
  const savedQuoteMarks: { start: number; end: number; quote: string }[] = []
  function visit(node: WritingNode, pos: number): number {
    if (node.type === 'text') {
      const length = node.text?.length ?? 0
      const mark = node.marks?.find(mark => mark.type === 'writingQuote')
      if (typeof mark?.attrs?.quoteId === 'string') savedQuoteMarks.push({ start: pos, end: pos + length, quote: mark.attrs.quoteId })
      return length
    }
    if (node.type === 'writingTopicLink' || node.type === 'writingCitation') atoms.push({ node, at: pos })
    const block = ['paragraph', 'heading', 'codeBlock'].includes(node.type)
    if (!node.content && node.type !== 'doc' && !block) return 1
    let offset = pos + (node.type === 'doc' ? 0 : 1)
    for (const child of node.content ?? []) offset += visit(child, offset)
    if (block) blocks.push({ start: pos + 1, end: offset, text: (node.content ?? []).map(child => child.text ?? ' ').join('') })
    return offset - pos + (node.type === 'doc' ? 0 : 1)
  }
  visit(root, 0)
  return { blocks, atoms, savedQuoteMarks }
}
