import type { Editor } from '@tiptap/core'
import { writingPassages } from './concepts.ts'

/** Follow a backlink only while the saved passage or literal wording still matches. */
export function selectWritingPassage(editor: Editor, params: URLSearchParams): 'selected' | 'changed' | 'none' {
  const passageId = params.get('passage'), term = params.get('term'), atom = params.get('atom')
  if (!passageId && !term && atom === null) return 'none'
  if (editor.isDestroyed) return 'changed'
  const { doc } = editor.state
  if (atom !== null) {
    const pos = Number(atom)
    const node = Number.isSafeInteger(pos) && pos >= 0 && pos < doc.content.size ? doc.nodeAt(pos) : null
    if (node?.type.name !== 'writingTopicLink' || node.attrs.topicId !== params.get('topic')) return 'changed'
    editor.chain().setNodeSelection(pos).scrollIntoView().run()
    return 'selected'
  }
  const from = Number(params.get('from'))
  const range = passageId
    ? writingPassages(editor.getJSON()).find(link => link.id === passageId && link.part === Number(params.get('part') ?? 0))
    : term && Number.isSafeInteger(from) && from >= 1 && from + term.length <= doc.content.size && doc.textBetween(from, from + term.length) === term ? { from, to: from + term.length } : null
  if (!range) return 'changed'
  editor.chain().setTextSelection({ from: range.from, to: range.to }).scrollIntoView().run()
  return 'selected'
}
