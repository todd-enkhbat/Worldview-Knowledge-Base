import { Mark } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import type { Node as DocNode } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { conceptMark, conceptMentions, type ConceptTerm, writingPassages } from './concepts.ts'
import { topicHref } from '../reading/topics.ts'

export function conceptExtension(terms: () => ConceptTerm[]) {
  return Mark.create({
    name: conceptMark, inclusive: false, excludes: '',
    addAttributes() {
      return { id: { default: null }, topicId: { default: null }, relation: { default: 'concept' }, createdAt: { default: null }, updatedAt: { default: null } }
    },
    renderHTML({ mark }) {
      return ['a', { href: topicHref(mark.attrs.topicId), 'data-writing-concept': mark.attrs.topicId, 'data-passage-id': mark.attrs.id, tabindex: '0', class: 'writing-concept-link', title: 'Open concept and linked passages' }, 0]
    },
    addProseMirrorPlugins() {
      let lastTerms: ConceptTerm[] | undefined, lastDoc: DocNode | undefined
      let match = conceptMentions([]), decorations = DecorationSet.empty
      let pointerStart: { x: number; y: number } | undefined
      return [new Plugin({
        props: {
          decorations(state) {
            const options = terms()
            if (state.doc === lastDoc && lastTerms === options) return decorations
            if (lastTerms !== options) { match = conceptMentions(options); lastTerms = options }
            lastDoc = state.doc
            const hits: Decoration[] = []
            if (options.length) state.doc.descendants((node, pos) => {
              if (node.type.spec.code || node.type.name === 'writingCitation') return false
              if (!node.isTextblock) return
              let text = '', start = pos + 1
              const flush = () => {
                for (const hit of match(text)) hits.push(Decoration.inline(start + hit.from, start + hit.to, {
                  nodeName: 'a', tabindex: '0', href: topicHref(hit.id), 'data-writing-concept': hit.id, class: 'writing-concept-mention', title: 'Open recognized concept',
                }))
                text = ''
              }
              node.forEach((child, offset) => {
                if (!child.isText || child.marks.some(mark => ['code', 'link', 'writingQuote', conceptMark].includes(mark.type.name))) { flush(); return }
                if (!text) start = pos + 1 + offset
                text += child.text || ''
              })
              flush()
              return false
            })
            decorations = DecorationSet.create(state.doc, hits)
            return decorations
          },
          handleDOMEvents: {
            pointerdown(_view, event) {
              pointerStart = { x: event.clientX, y: event.clientY }
              return false
            },
            click(view, event) {
              const link = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-writing-concept]') : null
              if (!link || !view.dom.contains(link)) return false
              // A drag selects editable prose. An ordinary click opens its concept.
              const dragged = pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5
              pointerStart = undefined
              if (dragged || event.shiftKey || event.altKey) { event.preventDefault(); return true }
              event.preventDefault()
              location.hash = topicHref(link.dataset.writingConcept!)
              return true
            },
            keydown(view, event) {
              if (event.key !== 'Enter' || event.target === view.dom) return false
              const link = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-writing-concept]') : null
              if (!link || !view.dom.contains(link)) return false
              event.preventDefault()
              location.hash = topicHref(link.dataset.writingConcept!)
              return true
            },
          },
        },
        appendTransaction(transactions, oldState, nextState) {
          if (!transactions.some(tr => tr.docChanged) || transactions.some(tr => tr.getMeta('writing:external-content') || tr.getMeta('writing:concept-edit'))) return null
          const type = nextState.schema.marks[conceptMark]
          if (!oldState.doc.rangeHasMark(0, oldState.doc.content.size, type)) return null
          function texts(doc: DocNode) {
            const excerpts = new Map<string, string[]>()
            for (const { id, text } of writingPassages(doc.toJSON())) {
              const group = excerpts.get(id)
              if (group) group.push(text)
              else excerpts.set(id, [text])
            }
            return excerpts
          }
          const before = texts(oldState.doc), after = texts(nextState.doc)
          const changed = new Set([...after].filter(([id, parts]) => before.has(id) && JSON.stringify(before.get(id)) !== JSON.stringify(parts)).map(([id]) => id))
          if (!changed.size) return null
          const tr = nextState.tr.setMeta('writing:concept-edit', true), time = Date.now()
          nextState.doc.descendants((node, pos) => {
            if (node.isText) for (const mark of node.marks) if (mark.type === type && changed.has(mark.attrs.id)) {
              tr.removeMark(pos, pos + node.nodeSize, mark).addMark(pos, pos + node.nodeSize, type.create({ ...mark.attrs, updatedAt: Math.max(mark.attrs.updatedAt + 1, time) }))
            }
          })
          return tr
        },
      })]
    },
  })
}
