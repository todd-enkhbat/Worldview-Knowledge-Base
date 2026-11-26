import { Mark, type Editor } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import type { MarkType, Node as DocumentNode } from '@tiptap/pm/model'

export interface QuoteSelection { doc: DocumentNode; from: number; to: number; text: string }
export const quoteHref = (id: string) => '#/quotes?quote=' + encodeURIComponent(id)
export const quoteMark = 'writingQuote'
export const selectedWords = (doc: DocumentNode, from: number, to: number) =>
  doc.textBetween(from, to, '\n', node => node.type.name === 'hardBreak' ? '\n' : '\ufffc')

export function linkSavedQuote(editor: Editor, selection: QuoteSelection, id: string, savedWords: string) {
  if (!id || editor.isDestroyed || !editor.isEditable || editor.state.doc !== selection.doc || selection.text !== savedWords ||
      selectedWords(editor.state.doc, selection.from, selection.to) !== savedWords) return false
  const type = editor.schema.marks[quoteMark], mark = type.create({ quoteId: id }), tr = editor.state.tr
  let supported = true
  selection.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (node.isTextblock && !node.type.allowsMarkType(type) || node.marks.some(m => m.type.name === 'code')) supported = false
    if (node.isText) tr.addMark(Math.max(selection.from, pos), Math.min(selection.to, pos + node.nodeSize), mark)
  })
  if (!supported || !tr.docChanged) return false
  editor.view.dispatch(tr)
  return true
}

function quoteWords(doc: DocumentNode, type: MarkType) {
  const byId = new Map<string, { text: string; last: number }>()
  doc.descendants((node, pos) => {
    if (node.isText) for (const mark of node.marks) if (mark.type === type) {
      const id = String(mark.attrs.quoteId), previous = byId.get(id)
      const separator = previous && previous.last < pos ? selectedWords(doc, previous.last, pos) || '\n' : ''
      byId.set(id, { text: (previous?.text || '') + separator + node.text, last: pos + node.nodeSize })
    }
  })
  return byId
}

export const savedQuote = Mark.create({
  name: quoteMark, inclusive: false,
  addAttributes() { return { quoteId: { default: null } } },
  renderHTML({ mark }) {
    return ['a', { href: quoteHref(mark.attrs.quoteId), tabindex: '0', 'data-saved-quote': mark.attrs.quoteId, class: 'writing-saved-quote', title: 'Open saved quote and source' }, 0]
  },
  addProseMirrorPlugins() {
    function open(view: { dom: HTMLElement }, event: Event) {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-saved-quote]') : null
      if (!target || !view.dom.contains(target)) return false
      event.preventDefault()
      location.hash = quoteHref(target.dataset.savedQuote!)
      return true
    }
    return [new Plugin({
      appendTransaction(transactions, oldState, nextState) {
        if (!transactions.some(tr => tr.docChanged) || transactions.some(tr => tr.getMeta('writing:external-content') || tr.getMeta('writing:quote-edit'))) return null
        const type = nextState.schema.marks[quoteMark]
        if (!oldState.doc.rangeHasMark(0, oldState.doc.content.size, type)) return null
        const before = quoteWords(oldState.doc, type), after = quoteWords(nextState.doc, type)
        const changed = new Set([...after].filter(([id, value]) => before.has(id) && before.get(id)!.text !== value.text).map(([id]) => id))
        if (!changed.size) return null
        const tr = nextState.tr.setMeta('writing:quote-edit', true)
        nextState.doc.descendants((node, pos) => {
          if (node.isText) for (const mark of node.marks) if (mark.type === type && changed.has(mark.attrs.quoteId)) tr.removeMark(pos, pos + node.nodeSize, mark)
        })
        return tr
      },
      props: { handleDOMEvents: {
      click: open,
      keydown(view, event) { return event.key === 'Enter' && open(view, event) },
    } } })]
  },
})
