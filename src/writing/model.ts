import { z } from 'zod'
import type { WritingAppearance, WritingDocument, WritingNode, WritingSnapshot } from './types.ts'

export const MAX_WRITING_BYTES = 4 * 1024 * 1024
const id = z.string().min(1).max(1000), timestamp = z.number().finite().nonnegative()
const hex = z.string().regex(/^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i)
const asset = z.string().regex(/^writing-[a-f\d]{64}$/)
const appearanceSchema = z.object({ fontFamily: z.enum(['serif', 'sans', 'mono']), fontSize: z.number().min(14).max(28), lineHeight: z.number().min(1.3).max(2.4), pageWidth: z.number().min(560).max(1000), pageColor: hex, textColor: hex, accentColor: hex, backgroundColor: hex, background: z.enum(['solid', 'gradient', 'waves', 'dots', 'image']), backgroundAssetId: asset.nullable(), waveColor: hex, waveIntensity: z.number().min(0).max(100), pageStyle: z.enum(['paper', 'seamless']) }).strict()
export const defaultWritingAppearance = (): WritingAppearance => ({ fontFamily: 'serif', fontSize: 18, lineHeight: 1.8, pageWidth: 760, pageColor: '#faf8f3', textColor: '#292624', accentColor: '#9c6845', backgroundColor: '#e9e6df', background: 'solid', backgroundAssetId: null, waveColor: '#c9bca7', waveIntensity: 25, pageStyle: 'paper' })
export const emptyWritingContent = (): WritingNode => ({ type: 'doc', content: [{ type: 'paragraph' }] })
export const emptyWriting = (): WritingSnapshot => ({ schemaVersion: 1, revision: 0, docs: [] })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = () => new Error('Writing data is incomplete or uses an unsupported format. Your retained draft was not changed.')
const safeColor = (value: unknown) => typeof value === 'string' && (hex.safeParse(value).success || /^(?:rgb|hsl)a?\([\d.,%\s+-]+\)$/.test(value) && value.length <= 80)
const safeFont = (value: unknown) => typeof value === 'string' && value.length <= 120 && /^[a-zA-Z\d\s,'"_-]+$/.test(value)
const safeSize = (value: unknown) => typeof value === 'string' && /^(?:[8-9]|[1-8]\d|9[0-6])px$/.test(value)
export function safeWritingLink(value: unknown): boolean { try { if (typeof value !== 'string' || value.length > 4000) return false; const url = new URL(value); return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password } catch { return false } }
export function safeWritingEmbed(value: unknown): boolean {
  try {
    if (typeof value !== 'string' || value.length > 2000) return false
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
    const host = url.hostname.toLowerCase()
    if (host === 'youtu.be') return /^\/[a-zA-Z\d_-]{11}$/.test(url.pathname)
    if (['youtube.com', 'www.youtube.com', 'www.youtube-nocookie.com'].includes(host)) return url.pathname === '/watch' ? /^[a-zA-Z\d_-]{11}$/.test(url.searchParams.get('v') ?? '') : /^\/(?:embed|shorts)\/[a-zA-Z\d_-]{11}$/.test(url.pathname)
    return ['vimeo.com', 'www.vimeo.com'].includes(host) ? /^\/\d+$/.test(url.pathname) : host === 'player.vimeo.com' && /^\/video\/\d+$/.test(url.pathname)
  } catch { return false }
}
function attrs(value: unknown, validators: Record<string, (value: unknown) => boolean>) {
  if (value === undefined) return
  if (!object(value) || Object.entries(value).some(([key, entry]) => !Object.hasOwn(validators, key) || entry != null && !validators[key](entry))) throw invalid()
}
const textAlign = (value: unknown) => ['left', 'center', 'right', 'justify'].includes(String(value))
const bounded = (max: number) => (value: unknown) => typeof value === 'string' && value.length <= max && !value.includes('\0')
const nodes = new Set(['doc', 'paragraph', 'text', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'codeBlock', 'hardBreak', 'horizontalRule', 'writingMedia', 'writingEmbed', 'writingCitation', 'writingTopicLink', 'writingFootnote', 'table', 'tableRow', 'tableCell', 'tableHeader'])
const leaf = new Set(['text', 'hardBreak', 'horizontalRule', 'writingMedia', 'writingEmbed', 'writingCitation', 'writingTopicLink', 'writingFootnote'])
const inline = new Set(['text', 'hardBreak', 'writingTopicLink', 'writingFootnote'])
const identifier = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 1000 && !value.includes('\0')
const offset = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
const span = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 100
const cellWidth = (value: unknown) => Array.isArray(value) && value.length <= 100 && value.every((width) => Number.isSafeInteger(width) && width >= 0 && width <= 3000)
export function validateWritingContent(value: unknown): WritingNode {
  let count = 0, characters = 0
  function visit(raw: unknown, depth: number, parent?: string): void {
    if (!object(raw) || typeof raw.type !== 'string' || !nodes.has(raw.type) || depth > 64 || ++count > 50000 || Object.keys(raw).some((key) => !['type', 'attrs', 'content', 'text', 'marks'].includes(key))) throw invalid()
    const type = raw.type
    if (depth === 0 && type !== 'doc' || depth > 0 && type === 'doc') throw invalid()
    if (type === 'text') { if (typeof raw.text !== 'string' || !raw.text.length || raw.content !== undefined) throw invalid(); characters += raw.text.length; if (characters > 2000000) throw invalid() }
    else if (raw.text !== undefined) throw invalid()
    if (raw.content !== undefined) { if (!Array.isArray(raw.content) || leaf.has(type)) throw invalid(); for (const child of raw.content) visit(child, depth + 1, type) }
    if (parent === 'doc' && (inline.has(type) || ['listItem', 'tableRow', 'tableCell', 'tableHeader'].includes(type))) throw invalid()
    if (['paragraph', 'heading'].includes(parent ?? '') && !inline.has(type) || parent === 'codeBlock' && !['text', 'hardBreak'].includes(type)) throw invalid()
    if (['bulletList', 'orderedList'].includes(parent ?? '') && type !== 'listItem' || type === 'listItem' && !['bulletList', 'orderedList'].includes(parent ?? '')) throw invalid()
    if (['blockquote', 'listItem', 'tableCell', 'tableHeader'].includes(parent ?? '') && (inline.has(type) || ['listItem', 'tableRow', 'tableCell', 'tableHeader'].includes(type)) || parent === 'codeBlock' && raw.marks !== undefined) throw invalid()
    if (parent === 'table' && type !== 'tableRow' || type === 'tableRow' && parent !== 'table' || parent === 'tableRow' && !['tableCell', 'tableHeader'].includes(type) || ['tableCell', 'tableHeader'].includes(type) && parent !== 'tableRow') throw invalid()
    if (['table', 'tableRow', 'tableCell', 'tableHeader'].includes(type) && (!Array.isArray(raw.content) || !raw.content.length)) throw invalid()
    if (type === 'paragraph' || type === 'heading') attrs(raw.attrs, { textAlign, ...(type === 'heading' ? { level: (value) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 6 } : {}) })
    else if (type === 'orderedList') attrs(raw.attrs, { start: (value) => Number.isSafeInteger(value) && Number(value) >= 1, type: (value) => ['1', 'a', 'A', 'i', 'I'].includes(String(value)) })
    else if (type === 'codeBlock') attrs(raw.attrs, { language: bounded(80) })
    else if (type === 'tableCell' || type === 'tableHeader') attrs(raw.attrs, { colspan: span, rowspan: span, colwidth: cellWidth, align: textAlign })
    else if (type === 'table') attrs(raw.attrs, {})
    else if (type === 'writingCitation') {
      attrs(raw.attrs, { sourceId: identifier, versionId: identifier, sourceTitle: bounded(1000), quote: bounded(200000), start: offset, end: offset, url: safeWritingLink, page: (value) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 100000 })
      const citation = raw.attrs as Record<string, unknown> | undefined
      if (!citation || !identifier(citation.sourceId) || !identifier(citation.versionId) || typeof citation.sourceTitle !== 'string' || typeof citation.quote !== 'string' || !citation.quote.trim() || !offset(citation.start) || !offset(citation.end) || Number(citation.end) - Number(citation.start) !== citation.quote.length) throw invalid()
    } else if (type === 'writingTopicLink') {
      attrs(raw.attrs, { topicId: identifier, label: bounded(300) })
      if (!object(raw.attrs) || !identifier(raw.attrs.topicId) || typeof raw.attrs.label !== 'string' || !raw.attrs.label.trim()) throw invalid()
    } else if (type === 'writingFootnote') {
      attrs(raw.attrs, { id: identifier, text: bounded(20000) })
      if (!object(raw.attrs) || !identifier(raw.attrs.id) || typeof raw.attrs.text !== 'string' || !raw.attrs.text.trim()) throw invalid()
    } else if (type === 'writingMedia') {
      attrs(raw.attrs, { assetId: (value) => asset.safeParse(value).success, kind: (value) => ['image', 'video', 'audio'].includes(String(value)), name: bounded(500), mime: bounded(120), alt: bounded(5000), caption: bounded(10000), width: (value) => ['normal', 'wide', 'full'].includes(String(value)), displayWidth: (value) => Number.isFinite(value) && Number(value) >= 20 && Number(value) <= 100 })
      const media = raw.attrs as Record<string, unknown> | undefined
      if (!media || !asset.safeParse(media.assetId).success || !['image', 'video', 'audio'].includes(String(media.kind)) || typeof media.mime !== 'string' || !media.mime.startsWith(`${media.kind}/`) || /svg|xml|html/i.test(media.mime)) throw invalid()
    } else if (type === 'writingEmbed') { attrs(raw.attrs, { url: safeWritingEmbed, provider: (value) => ['youtube', 'vimeo'].includes(String(value)) }); if (!object(raw.attrs) || !safeWritingEmbed(raw.attrs.url)) throw invalid() }
    else attrs(raw.attrs, {})
    if (raw.marks !== undefined) {
      if (type !== 'text' || !Array.isArray(raw.marks) || raw.marks.length > 16) throw invalid()
      for (const mark of raw.marks) {
        if (!object(mark) || typeof mark.type !== 'string' || Object.keys(mark).some((key) => key !== 'type' && key !== 'attrs')) throw invalid()
        if (['bold', 'italic', 'strike', 'code', 'underline','writingAi'].includes(mark.type)) attrs(mark.attrs, {})
        else if (mark.type === 'textStyle') attrs(mark.attrs, { color: safeColor, backgroundColor: safeColor, fontFamily: safeFont, fontSize: safeSize })
        else if (mark.type === 'highlight') attrs(mark.attrs, { color: safeColor })
        else if (mark.type === 'writingQuote') {
          if (!object(mark.attrs) || !identifier(mark.attrs.quoteId) || Object.keys(mark.attrs).length !== 1) throw invalid()
        }
        else if (mark.type === 'writingConcept') {
          const values = mark.attrs
          if (!object(values) || !identifier(values.id) || !identifier(values.topicId) || !['concept', 'example'].includes(String(values.relation)) ||
              !Number.isSafeInteger(values.createdAt) || !Number.isSafeInteger(values.updatedAt) || Number(values.createdAt) < 0 || Number(values.updatedAt) < Number(values.createdAt) ||
              Object.keys(values).some(key => !['id', 'topicId', 'relation', 'createdAt', 'updatedAt'].includes(key))) throw invalid()
        }
        else if (mark.type === 'link') { attrs(mark.attrs, { href: safeWritingLink, target: (value) => ['_blank', '_self'].includes(String(value)), rel: (value) => typeof value === 'string' && /^[a-z\s-]{0,120}$/.test(value), class: (value) => typeof value === 'string' && /^[a-zA-Z\d\s_-]{0,120}$/.test(value) }); if (!object(mark.attrs) || !safeWritingLink(mark.attrs.href)) throw invalid() }
        else throw invalid()
      }
    }
  }
  visit(value, 0)
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_WRITING_BYTES) throw invalid()
  return structuredClone(value) as WritingNode
}
export function validateWritingAppearance(value: unknown): WritingAppearance { const parsed = appearanceSchema.safeParse(value); if (!parsed.success) throw invalid(); return parsed.data }
const documentSchema = z.object({ id, title: z.string().max(300), subtitle: z.string().max(2000), byline: z.string().max(300), format: z.enum(['note', 'essay', 'newsletter', 'journal', 'poem', 'research']), content: z.unknown(), appearance: z.unknown(), createdAt: timestamp, updatedAt: timestamp, sourceId: id.optional(), basedOnSourceId: id.optional(), applicationId:id.optional(),chapter:z.string().max(500).optional(), bookEditionId: id.nullable().optional(), baseVersionId: id.optional(), archivedAt: timestamp.nullable(), topicIds: z.array(z.string().min(1).max(160)).max(100).optional(), publishedUpdatedAt: timestamp.optional(), publishedFingerprint: z.string().regex(/^[a-f\d]{64}$/).optional(), lastPublishedAt: timestamp.optional() }).strict()
export function validateWritingDocument(value: unknown): WritingDocument { const parsed = documentSchema.safeParse(value); if (!parsed.success || parsed.data.updatedAt < parsed.data.createdAt) throw invalid(); return { ...parsed.data, content: validateWritingContent(parsed.data.content), appearance: validateWritingAppearance(parsed.data.appearance) } }
export function decodeWriting(value: unknown): WritingSnapshot {
  if (value === undefined) return emptyWriting()
  if (!object(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !Array.isArray(value.docs) || value.docs.length > 10000) throw invalid()
  const docs = value.docs.map(validateWritingDocument)
  if (new Set(docs.map((doc) => doc.id)).size !== docs.length) throw invalid()
  const edits = z.array(z.object({ documentId: id, at: timestamp, fields: z.array(z.string().min(1).max(80)).min(1).max(16) })).optional().safeParse(value.edits)
  if (!edits.success) throw invalid()
  return { schemaVersion: 1, revision: Number(value.revision), docs, ...(edits.data ? { edits: edits.data } : {}) }
}
export function writingFromPlainText(text: string): WritingNode { return validateWritingContent({ type: 'doc', content: text.split('\n\n').map((paragraph) => ({ type: 'paragraph', content: paragraph.split('\n').flatMap((line, index) => [...(index ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])]) })) }) }
export function plainTextFromWriting(node: WritingNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'horizontalRule') return '---'
  if (node.type === 'writingCitation') return `${String(node.attrs?.quote ?? '')}\n— ${String(node.attrs?.sourceTitle ?? 'Source')}`
  if (node.type === 'writingTopicLink') return `[[${String(node.attrs?.label ?? '')}]]`
  if (node.type === 'writingFootnote') return `[Note: ${String(node.attrs?.text ?? '')}]`
  if (node.type === 'writingEmbed') return String(node.attrs?.url ?? '')
  if (node.type === 'writingMedia') return String(node.attrs?.caption || node.attrs?.alt || `[${node.attrs?.kind ?? 'media'}: ${node.attrs?.name ?? 'attachment'}]`)
  return (node.content ?? []).map(plainTextFromWriting).join(['doc', 'blockquote'].includes(node.type) ? '\n\n' : ['orderedList', 'bulletList', 'listItem', 'table', 'tableCell', 'tableHeader'].includes(node.type) ? '\n' : node.type === 'tableRow' ? '\t' : '')
}
export function writingPublicationValue(doc: WritingDocument) { return { title: doc.title, subtitle: doc.subtitle, byline: doc.byline, format: doc.format, content: doc.content, appearance: doc.appearance, ...(doc.applicationId ? {applicationId:doc.applicationId}:{}), ...(doc.chapter !== undefined ? {chapter:doc.chapter} : {}), ...(doc.bookEditionId !== undefined ? { bookEditionId: doc.bookEditionId } : {}), ...(doc.topicIds?.length ? { topicIds: doc.topicIds } : {}) } }
export function writingAssetIds(doc: WritingDocument): string[] {
  const ids = new Set<string>(doc.appearance.backgroundAssetId ? [doc.appearance.backgroundAssetId] : [])
  const visit = (node: WritingNode) => { if (node.type === 'writingMedia' && typeof node.attrs?.assetId === 'string') ids.add(node.attrs.assetId); for (const child of node.content ?? []) visit(child) }
  visit(doc.content); return [...ids].sort()
}
