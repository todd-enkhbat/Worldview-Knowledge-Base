import { savedQuote } from './quoteLink.ts'
import { conceptExtension } from './conceptExtension.ts'
import type { ConceptTerm } from './concepts.ts'
import { topicHref } from '../reading/topics.ts'
import { Mark, Extension, Node, InputRule, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TextStyleKit } from '@tiptap/extension-text-style'
import TextAlign from '@tiptap/extension-text-align'
import Highlight from '@tiptap/extension-highlight'
import Placeholder from '@tiptap/extension-placeholder'
import { TableKit } from '@tiptap/extension-table'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import { Fragment } from '@tiptap/pm/model'
import type { Editor } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { WritingEmbedView, WritingMediaView } from './WritingMediaView.tsx'
import { safeWritingLink } from './model.ts'
import type { WritingNode } from './types.ts'

export const WRITING_EXTERNAL_UPDATE = 'writing:external-content'

export function normalizedWritingJSON(input: JSONContent | WritingNode): WritingNode {
  const attrs = input.attrs ? Object.fromEntries(Object.entries(input.attrs).filter(([, value]) => value !== null && value !== undefined)) : undefined
  const marks = input.marks?.map((mark) => {
    const attributes = mark.attrs ? Object.fromEntries(Object.entries(mark.attrs).filter(([, value]) => value !== null && value !== undefined && !(mark.type === 'textStyle' && value === ''))) : undefined
    return { type: mark.type, ...(attributes && Object.keys(attributes).length ? { attrs: attributes } : {}) }
  }).filter((mark) => mark.type !== 'textStyle' || mark.attrs && Object.keys(mark.attrs).length)
  return { type: input.type ?? 'doc', ...(attrs && Object.keys(attrs).length ? { attrs } : {}), ...(input.text !== undefined ? { text: input.text } : {}), ...(marks?.length ? { marks } : {}), ...(input.content?.length ? { content: input.content.map(normalizedWritingJSON) } : {}) }
}

function safeColor(value: string): boolean {
  return /^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value) || /^(?:rgb|hsl)a?\([\d.,%\s+-]+\)$/.test(value) && value.length <= 80
}

/** Schema parsing is the last boundary; resource attributes are removed before inert parsing. */
export function sanitizeWritingPasteHTML(html: string): string {
  const withoutResources = html.replace(/\s(?:src|srcset|srcdoc|poster|background|data)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  // Template contents have no active browsing context: images, frames and styles
  // cannot activate while we strip them. This fragment never enters the live DOM.
  const template = document.createElement('template')
  template.innerHTML = withoutResources
  template.content.querySelectorAll('script,style,iframe,frame,object,embed,img,picture,video,audio,source,track,svg,math,form,input,textarea,select,button,meta,link,base').forEach((element) => element.remove())
  for (const element of template.content.querySelectorAll<HTMLElement>('*')) {
    const originalStyle = element.style
    const safeStyles: string[] = []
    for (const property of ['color', 'background-color']) {
      const value = originalStyle.getPropertyValue(property).trim()
      if (safeColor(value)) safeStyles.push(`${property}:${value}`)
    }
    const family = originalStyle.fontFamily.trim()
    if (family && family.length <= 120 && /^[\w\s'",_-]+$/.test(family) && !/url/i.test(family)) safeStyles.push(`font-family:${family}`)
    const size = /^(\d+(?:\.\d+)?)(px|pt)$/.exec(originalStyle.fontSize)
    if (size) { const value = Number(size[1]) * (size[2] === 'pt' ? 4 / 3 : 1); if (value >= 8 && value <= 96) safeStyles.push(`font-size:${Math.round(value)}px`) }
    const alignment = originalStyle.textAlign
    if (['left', 'center', 'right', 'justify'].includes(alignment)) safeStyles.push(`text-align:${alignment}`)
    const href = element.tagName === 'A' ? element.getAttribute('href') : null
    const colspan = ['TD', 'TH'].includes(element.tagName) ? element.getAttribute('colspan') : null
    const rowspan = ['TD', 'TH'].includes(element.tagName) ? element.getAttribute('rowspan') : null
    const start = element.tagName === 'OL' ? element.getAttribute('start') : null
    const language = element.tagName === 'CODE' ? /(?:^|\s)language-([\w-]{1,80})(?:\s|$)/.exec(element.className)?.[1] : null
    for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name)
    if (safeStyles.length) element.setAttribute('style', safeStyles.join(';'))
    if (href && safeWritingLink(href)) { element.setAttribute('href', href); element.setAttribute('rel', 'noopener noreferrer'); element.setAttribute('target', '_blank') }
    if (colspan && /^\d+$/.test(colspan) && Number(colspan) >= 1 && Number(colspan) <= 100) element.setAttribute('colspan', colspan)
    if (rowspan && /^\d+$/.test(rowspan) && Number(rowspan) >= 1 && Number(rowspan) <= 100) element.setAttribute('rowspan', rowspan)
    if (start && /^\d+$/.test(start) && Number(start) >= 1) element.setAttribute('start', start)
    if (language) element.className = `language-${language}`
  }
  return template.innerHTML
}

const WritingMedia = Node.create({
  name: 'writingMedia', group: 'block', atom: true, draggable: true, selectable: true,
  addAttributes() { return { assetId: { default: '' }, kind: { default: 'image' }, name: { default: '' }, mime: { default: '' }, alt: { default: '' }, caption: { default: '' }, width: { default: 'normal' }, displayWidth: { default: null } } },
  // Media enters through validated local uploads/JSON, never pasted resource URLs.
  parseHTML() { return [] },
  renderHTML({ node }) { return ['figure', { 'data-writing-media': node.attrs.assetId }, ['figcaption', node.attrs.caption || node.attrs.name || 'Local media']] },
  addNodeView() { return ReactNodeViewRenderer(WritingMediaView) },
})
const WritingEmbed = Node.create({
  name: 'writingEmbed', group: 'block', atom: true, draggable: true, selectable: true,
  addAttributes() { return { url: { default: '' }, provider: { default: null } } },
  parseHTML() { return [] },
  renderHTML() { return ['figure', { 'data-writing-embed': '' }, ['figcaption', 'Video embed']] },
  addNodeView() { return ReactNodeViewRenderer(WritingEmbedView) },
})
const WritingCitation = Node.create({
  name: 'writingCitation', group: 'block', atom: true, draggable: true, selectable: true,
  addAttributes() { return { sourceId: { default: '' }, versionId: { default: '' }, sourceTitle: { default: '' }, quote: { default: '' }, start: { default: 0 }, end: { default: 0 }, url: { default: null }, page: { default: null } } },
  parseHTML() { return [] },
  renderHTML({ node }) { const a = node.attrs; return ['blockquote', { class: 'writing-citation', 'data-source-id': a.sourceId, 'data-source-version': a.versionId }, ['p', { style: 'white-space:pre-wrap' }, a.quote], ['cite', ['a', { href: `#/library?source=${encodeURIComponent(String(a.sourceId))}&version=${encodeURIComponent(String(a.versionId))}${a.page ? `&page=${Number(a.page)}` : ''}`, 'aria-label': `Read source: ${a.sourceTitle}` }, a.sourceTitle || 'Retained source'], ['small', a.page ? ` · page ${Number(a.page)}` : ` · characters ${Number(a.start) + 1}–${a.end}`]]] },
  renderText({ node }) { return `${node.attrs.quote} — ${node.attrs.sourceTitle}` },
})
const WritingTopicLink = Node.create({
  name: 'writingTopicLink', group: 'inline', inline: true, atom: true, selectable: true,
  addAttributes() { return { topicId: { default: '' }, label: { default: '' } } },
  parseHTML() { return [] },
  renderHTML({ node }) { return ['a', { href: topicHref(node.attrs.topicId), 'data-writing-concept': node.attrs.topicId, tabindex: 0, class: 'writing-topic-link', title: 'Open concept' }, `[[${node.attrs.label}]]`] },
  renderText({ node }) { return `[[${node.attrs.label}]]` },
})
const WritingFootnote = Node.create({
  name: 'writingFootnote', group: 'inline', inline: true, atom: true, selectable: true,
  addAttributes() { return { id: { default: '' }, text: { default: '' } } },
  parseHTML() { return [] },
  renderHTML({ node }) { return ['span', { class: 'writing-footnote', title: node.attrs.text, tabindex: 0, 'aria-label': `Footnote: ${node.attrs.text}` }, ['sup', '※'], ['span', { class: 'writing-footnote-text' }, node.attrs.text]] },
  renderText({ node }) { return `[Note: ${node.attrs.text}]` },
})
const ReadOnlyGate = Extension.create({
  name: 'writingReadOnly',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [new Plugin({ filterTransaction: (transaction) => !transaction.docChanged || editor.isEditable || transaction.getMeta(WRITING_EXTERNAL_UPDATE) === true })]
  },
})

export function writingExtensions(options: { topics?: () => ConceptTerm[]; placeholder?: string } = {}) {
  return [Mark.create({name:"writingAi",inclusive:false,parseHTML(){return []},renderHTML(){return ["span",{"class":"writing-ai-words","title":"AI-written"},0]}}),savedQuote, conceptExtension(options.topics ?? (() => [])),
    StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, link: { openOnClick: false, autolink: false, linkOnPaste: false, defaultProtocol: 'https', isAllowedUri: (url) => safeWritingLink(url), HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' } } }),
    TextStyleKit.configure({ lineHeight: false }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Highlight.configure({ multicolor: true }),
    Placeholder.configure({ placeholder: options.placeholder ?? 'Begin with a thought…', showOnlyCurrent: false }),
    TableKit.configure({ table: { resizable: true, cellMinWidth: 60, renderWrapper: true } }),
    WritingMedia, WritingEmbed, WritingCitation, WritingTopicLink, WritingFootnote, ReadOnlyGate,
    Extension.create({ name: 'writingTopicInput', addInputRules() { return [new InputRule({ find: /\[\[([^\]\n]{1,100})\]\]$/, handler: ({ state, range, match }) => { if (state.selection.$from.parent.type.spec.code) return null; const label = String(match[1]).normalize('NFKC').trim().toLocaleLowerCase(); const topic = options.topics?.().find((entry) => [entry.label, ...(entry.aliases ?? [])].some(name => name.normalize('NFKC').trim().toLocaleLowerCase() === label)); if (!topic) return null; state.tr.replaceWith(range.from, range.to, state.schema.nodes.writingTopicLink.create({ topicId: topic.id, label: topic.label })); } })] } }),
  ]
}

/** Heading-delimited sections retain their complete blocks and can move in one undoable transaction. */
export function writingSections(editor: Editor) {
  const sections: { title: string; from: number; to: number; index: number }[] = []
  editor.state.doc.forEach((node, offset) => {
    if (!sections.length || node.type.name === 'heading') sections.push({ title: node.textContent.slice(0, 100) || (node.type.name === 'heading' ? 'Untitled section' : 'Opening'), from: offset, to: offset + node.nodeSize, index: sections.length })
    else sections[sections.length - 1].to = offset + node.nodeSize
  })
  return sections
}
export function moveWritingSection(editor: Editor, fromIndex: number, toIndex: number): boolean {
  if (editor.isDestroyed || !editor.isEditable || !Number.isSafeInteger(fromIndex) || !Number.isSafeInteger(toIndex)) return false
  const sections = writingSections(editor)
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= sections.length || toIndex >= sections.length || fromIndex === toIndex) return false
  const blocks = sections.map((section) => editor.state.doc.slice(section.from, section.to).content)
  const moved = blocks.splice(fromIndex, 1)[0]; blocks.splice(toIndex, 0, moved)
  const nodes = blocks.flatMap((fragment) => { const result: typeof editor.state.doc[] = []; fragment.forEach((node) => result.push(node)); return result })
  const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, Fragment.fromArray(nodes))
  const position = blocks.slice(0, toIndex).reduce((total, fragment) => total + fragment.size, 0)
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(tr.doc.content.size, position + 1))))
  editor.view.dispatch(tr.scrollIntoView()); return true
}
