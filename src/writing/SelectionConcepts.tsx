import { useEffect, useId, useRef, useState, type Ref } from 'react'
import type { Editor } from '@tiptap/core'
import { ArrowSquareOut, CirclesThreePlus, Quotes } from '@phosphor-icons/react'
import { topicHref } from '../reading/topics.ts'
import { selectedWords, type QuoteSelection } from './quoteLink.ts'
import { conceptMark, type ConceptRelation, type ConceptTerm } from './concepts.ts'

interface Choice extends QuoteSelection { relation: ConceptRelation }
export interface ConceptActions { onDesk?:(kind:'word'|'ai',text:string,sentence:string)=>void;
  terms: ConceptTerm[]
  resolve: (name: string) => Promise<{ id: string; name: string }>
  onQuote: (selection: QuoteSelection) => void
}
function linkedSelection(editor: Editor) {
  const { doc, selection: { from, to } } = editor.state
  let topicId: string | undefined
  let complete = from !== to
  doc.nodesBetween(from, to, node => {
    if (!node.isText) return
    const linked = node.marks.find(mark => mark.type.name === conceptMark && mark.attrs.relation === 'concept')
    if (!linked || (topicId && topicId !== linked.attrs.topicId)) complete = false
    else topicId = linked.attrs.topicId
  })
  return complete ? topicId : undefined
}
export function SelectionConcepts({ editor, actions, onMessage, primaryRef }: { editor: Editor; actions: ConceptActions; onMessage: (message: string) => void; primaryRef: Ref<HTMLButtonElement> }) {
  const [choice, setChoice] = useState<Choice | null>(null), [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const id = useId(), inFlight = useRef(false), active = useRef(true), input = useRef<HTMLInputElement>(null)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => { if (choice) input.current?.focus() }, [choice])
  function selection(relation: ConceptRelation) {
    const { doc, selection: { from, to } } = editor.state
    if (from === to) return null
    const text = selectedWords(doc, from, to)
    if (!text.trim() || text.includes('\ufffc')) { onMessage('Select a passage of text.'); return null }
    return { from, to, text, doc, relation }
  }
  async function save(selected: Choice, label: string) {
    if (inFlight.current || !editor.isEditable || editor.isDestroyed || !label.trim()) return
    inFlight.current = true; setBusy(true); setError('')
    try {
      const type = editor.schema.marks[conceptMark]
      let supported = true
      selected.doc.nodesBetween(selected.from, selected.to, node => {
        if (node.isTextblock && !node.type.allowsMarkType(type) || node.type.spec.code || node.marks.some(mark => mark.type.name === 'code')) supported = false
      })
      if (!supported) throw new Error('Select prose outside a code block to link a concept.')
      if (editor.state.doc !== selected.doc) throw new Error('The passage changed. Select its current wording to link it.')
      const topic = await actions.resolve(label.trim())
      if (!active.current || editor.isDestroyed || !editor.isEditable) return
      if (editor.state.doc !== selected.doc) throw new Error('The passage changed. Select its current wording to link it.')
      let existing = true
      selected.doc.nodesBetween(selected.from, selected.to, node => {
        if (node.isText && !node.marks.some(mark => mark.type === type && mark.attrs.topicId === topic.id && mark.attrs.relation === selected.relation)) existing = false
      })
      if (!existing) {
        const time = Date.now()
        const mark = type.create({ id: crypto.randomUUID(), topicId: topic.id, relation: selected.relation, createdAt: time, updatedAt: time })
        const tr = editor.state.tr
        selected.doc.nodesBetween(selected.from, selected.to, (node, pos) => {
          if (node.isText) tr.addMark(Math.max(selected.from, pos), Math.min(selected.to, pos + node.nodeSize), mark)
        })
        editor.view.dispatch(tr)
      }
      setChoice(null); onMessage((selected.relation === 'example' ? 'Example linked to ' : 'Passage linked to ') + topic.name + '.')
    } catch (cause) { if (active.current) { const message = cause instanceof Error ? cause.message : String(cause); setError(message); onMessage(message) } }
    finally { inFlight.current = false; if (active.current) setBusy(false) }
  }
  function begin(relation: ConceptRelation) {
    const selected = selection(relation)
    if (!selected) return
    setError('')
    if (relation === 'concept' && selected.text.trim().length <= 160 && !selected.text.includes('\n')) { void save(selected, selected.text); return }
    setName(''); setChoice(selected)
  }
  const linked = linkedSelection(editor)
  return <div className="writing-selection-concepts">
    <button ref={primaryRef} type="button" className="writing-make-concept" disabled={busy} aria-keyshortcuts="Meta+Shift+K Control+Shift+K" title={linked ? 'See notes and quotes for this concept' : 'Make concept (⌘/Ctrl + Shift + K)'} onMouseDown={event => event.preventDefault()} onClick={() => { if (linked) location.hash = topicHref(linked); else begin('concept') }}>
      {linked ? <ArrowSquareOut size={15} aria-hidden="true" /> : <CirclesThreePlus size={16} aria-hidden="true" />}{linked ? 'Open concept' : 'Make concept'}
    </button>
    <button type="button" title="Save selected words as a quotation" onMouseDown={event => event.preventDefault()} onClick={() => { const selected = selection('concept'); if (selected) actions.onQuote(selected) }}><Quotes size={15} aria-hidden="true" />Quote</button>
    <button type="button" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => begin('example')}>Example of…</button>
    {actions.onDesk && <>{(['word','ai'] as const).map(kind=><button type="button" key={kind} onMouseDown={e=>e.preventDefault()} onClick={()=>{const sel=selection('concept');if(sel)actions.onDesk?.(kind,sel.text,editor.state.selection.$from.parent.textContent)}}>{kind==='word'?'Look up word':'Explain with AI'}</button>)}<button type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>editor.chain().focus().setMark('writingAi').run()}>Mark as AI-written</button></>}
    {choice && <form className="writing-concept-form" aria-label="Link selected passage" onSubmit={event => { event.preventDefault(); void save(choice, name) }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setChoice(null); editor.commands.focus(undefined, { scrollIntoView: false }) } }}>
      <label htmlFor={id}>{choice.relation === 'example' ? 'Example of' : 'Concept name'}</label>
      <input id={id} ref={input} value={name} maxLength={160} list={id + '-terms'} placeholder="Choose or name a concept" onChange={event => setName(event.target.value)} />
      <datalist id={id + '-terms'}>{actions.terms.map(term => <option key={term.id} value={term.label}>{term.aliases?.join(', ')}</option>)}</datalist>
      {error && <small role="alert">{error}</small>}
      <span><button type="button" onClick={() => { setChoice(null); editor.commands.focus() }}>Cancel</button><button type="submit" disabled={busy || !name.trim()}>Link passage</button></span>
    </form>}
  </div>
}
