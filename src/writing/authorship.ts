import type { ParsedMessage } from '../knowledge/types.ts'
import { plainTextFromWriting, validateWritingContent } from './model.ts'
import type { WritingNode } from './types.ts'

export interface WritingAuthorshipMessage extends ParsedMessage {
  role: 'human' | 'third-party'
  start: number
  end: number
}

/**
 * Publication uses the exact readable document, with its quotation boundaries intact.
 * Quoted wording and its attribution are evidence from another source, not the
 * writer's own prose. Separator characters belong to the document's human author.
 */
export function writingAuthorshipMessages(content: WritingNode, authoredAt: number | null = null): WritingAuthorshipMessage[] {
  if (authoredAt !== null && (!Number.isFinite(authoredAt) || authoredAt < 0)) throw new Error('Writing authorship needs a valid recorded date.')
  const document = validateWritingContent(content)
  const messages: WritingAuthorshipMessage[] = []
  let cursor = 0
  function append(text: string, role: WritingAuthorshipMessage['role']) {
    if (!text) return
    const previous = messages.at(-1)
    if (previous?.role === role) { previous.text += text; previous.end += text.length }
    else messages.push({ text, start: cursor, end: cursor + text.length, role, authoredAt: role === 'human' ? authoredAt : null })
    cursor += text.length
  }
  function visit(node: WritingNode) {
    if (node.type === 'writingCitation') { append(plainTextFromWriting(node), 'third-party'); return }
    if (!node.content) { append(plainTextFromWriting(node), 'human'); return }
    const separator = ['doc', 'blockquote'].includes(node.type) ? '\n\n' : ['orderedList', 'bulletList', 'listItem', 'table', 'tableCell', 'tableHeader'].includes(node.type) ? '\n' : node.type === 'tableRow' ? '\t' : ''
    node.content.forEach((child, index) => { if (index) append(separator, 'human'); visit(child) })
  }
  visit(document)
  const text = plainTextFromWriting(document)
  if (messages.map((message) => message.text).join('') !== text || cursor !== text.length) throw new Error('Writing authorship no longer matches its readable document. Your draft was preserved.')
  for (const message of messages) {
    const start = message.start
    if (start > 0 && /[\uD800-\uDBFF]/.test(text[start - 1]) && /[\uDC00-\uDFFF]/.test(text[start])) throw new Error('A quotation splits a Unicode character. Re-enter the character beside this quotation before saving to Library.')
  }
  return messages
}
