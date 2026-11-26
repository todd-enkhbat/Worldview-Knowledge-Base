import { Node } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from '@tiptap/react'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { ArrowCounterClockwise, Check, PencilSimple } from '@phosphor-icons/react'
import { maxSketchStrokes, maxStrokePoints, parseSketchData, sketchHeight, sketchWidth, strokePath, type SketchData, type SketchPoint, type SketchStroke } from './sketch.ts'

const inks = [['Ink', '#29313b'], ['Ocean', '#365e8a'], ['Carmine', '#a44751'], ['Leaf', '#35745c']]
const bound = (n: number, max: number) => Math.round(Math.min(max, Math.max(0, n)))

function SketchView({ node, editor, updateAttributes, getPos }: NodeViewProps) {
  const { strokes, title } = node.attrs as SketchData
  const [editing, setEditing] = useState(!strokes.length)
  const [ink, setInk] = useState(inks[0][1]), [width, setWidth] = useState(4)
  const [trail, setTrail] = useState<SketchStroke | null>(null)
  const [nib, setNib] = useState<SketchPoint>([sketchWidth / 2, sketchHeight / 2]), [keyboard, setKeyboard] = useState(false)
  const pointer = useRef<number | 'keyboard' | null>(null), drawing = useRef<SketchStroke | null>(null)
  const caption = useId(), hint = useId()
  const canvas = useRef<SVGSVGElement>(null)
  const editable = useEditorState({ editor, selector: state => state.editor.isEditable })
  const active = editing && editable
  useEffect(() => { if (!editable) { pointer.current = null; drawing.current = null; setTrail(null); setEditing(false) } }, [editable])
  function begin(point: SketchPoint, id: number | 'keyboard') {
    if (!active || strokes.length >= maxSketchStrokes || pointer.current !== null) return
    pointer.current = id
    drawing.current = { ink, width, points: [point] }
    setTrail(drawing.current)
  }
  function extend(point: SketchPoint) {
    const stroke = drawing.current
    if (!stroke) return
    const last = stroke.points[stroke.points.length - 1]
    if (last[0] === point[0] && last[1] === point[1]) return
    // Decimate very long gestures in place so the tail always follows the pen.
    const points = stroke.points.length === maxStrokePoints ? stroke.points.filter((_, i) => i % 2 === 0) : stroke.points
    drawing.current = { ...stroke, points: [...points, point] }
    setTrail(drawing.current)
  }
  function finish(save = true) {
    const stroke = drawing.current
    if (stroke && save && editor.isEditable && strokes.length < maxSketchStrokes) updateAttributes({ strokes: [...strokes, stroke] })
    pointer.current = null; drawing.current = null; setTrail(null)
  }
  function point(event: PointerEvent<SVGSVGElement>): SketchPoint {
    const rect = event.currentTarget.getBoundingClientRect()
    return [bound((event.clientX - rect.left) * sketchWidth / rect.width, sketchWidth), bound((event.clientY - rect.top) * sketchHeight / rect.height, sketchHeight)]
  }
  function key(event: KeyboardEvent<SVGSVGElement>) {
    if (!active || event.ctrlKey || event.metaKey || event.altKey || typeof pointer.current === 'number') return
    const steps: Record<string, SketchPoint> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const step = steps[event.key]
    if (step) {
      const delta = event.shiftKey ? 1 : 8
      const next: SketchPoint = [bound(nib[0] + step[0] * delta, sketchWidth), bound(nib[1] + step[1] * delta, sketchHeight)]
      setKeyboard(true); setNib(next); if (pointer.current === 'keyboard') extend(next)
    } else if (event.key === ' ' && !event.repeat) {
      setKeyboard(true)
      if (pointer.current === 'keyboard') finish(); else begin(nib, 'keyboard')
    } else if (event.key === 'Escape') {
      finish(); setEditing(false); editor.commands.focus()
    } else return
    event.preventDefault(); event.stopPropagation()
  }
  function toggle() {
    if (active) {
      finish(); setEditing(false)
      const pos = getPos()
      if (typeof pos === 'number') editor.chain().focus().setNodeSelection(pos).run()
    } else { setEditing(true); requestAnimationFrame(() => canvas.current?.focus()) }
  }
  return <NodeViewWrapper className="writing-sketch" data-editing={active || undefined} contentEditable={false}>
    {editable && <div className="writing-sketch-tools" role="group" aria-label="Sketch tools">
      {active ? <><input id={caption} aria-label="Sketch description" placeholder="Sketch description" value={title} maxLength={240} onChange={e => updateAttributes({ title: e.target.value })} />
        <div className="writing-ink-palette" role="group" aria-label="Pen color">{inks.map(([name, color]) => <button type="button" key={name} aria-label={name + ' pen'} title={name + ' pen'} aria-pressed={ink === color} style={{ color }} onClick={() => setInk(color)}><i /></button>)}</div>
        <select aria-label="Pen width" value={width} onChange={e => setWidth(Number(e.target.value))}><option value={2}>Fine</option><option value={4}>Medium</option><option value={8}>Broad</option></select>
        <button type="button" disabled={!strokes.length} aria-label="Undo last stroke" title="Undo last stroke" onClick={() => updateAttributes({ strokes: strokes.slice(0, -1) })}><ArrowCounterClockwise size={16} /></button></> : <span>{title}</span>}
      <button type="button" aria-label={active ? 'Finish sketch' : 'Edit sketch'} onClick={toggle}>{active ? <Check size={15} /> : <PencilSimple size={15} />}{active ? 'Done' : 'Edit'}</button>
    </div>}
    <svg ref={canvas} viewBox="0 0 800 260" role="img" tabIndex={active ? 0 : undefined} aria-label={title || 'Freehand sketch'} aria-describedby={active ? hint : undefined}
      onPointerDown={e => { if (!active || !e.isPrimary || e.button !== 0) return; e.preventDefault(); setKeyboard(false); e.currentTarget.setPointerCapture(e.pointerId); begin(point(e), e.pointerId) }}
      onPointerMove={e => { if (pointer.current === e.pointerId) extend(point(e)) }}
      onPointerUp={e => { if (pointer.current === e.pointerId) { extend(point(e)); finish() } }}
      onPointerCancel={e => { if (pointer.current === e.pointerId) finish() }}
      onLostPointerCapture={e => { if (pointer.current === e.pointerId) finish() }}
      onKeyDown={key} onBlur={() => { if (pointer.current === 'keyboard') finish(); setKeyboard(false) }}>
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">{[...strokes, ...(trail ? [trail] : [])].map((stroke, i) => <path key={i} d={strokePath(stroke.points)} stroke={stroke.ink} strokeWidth={stroke.width} />)}</g>
      {keyboard && active && <circle cx={nib[0]} cy={nib[1]} r={5} stroke={ink} fill="none" strokeDasharray="2 1" />}
    </svg>
    {active && <small id={hint}>{strokes.length >= maxSketchStrokes ? 'Sketch is full. Insert another to keep drawing.' : 'Draw here, or use arrow keys and Space to draw with the keyboard.'}</small>}
  </NodeViewWrapper>
}
export const WritingSketch = Node.create({
  name: 'writingSketch', group: 'block', atom: true, selectable: true, draggable: false,
  addAttributes() { return { title: { default: '' }, strokes: { default: [] } } },
  parseHTML() { return [{ tag: 'figure[data-writing-sketch]', getAttrs: element => parseSketchData(element.getAttribute('data-writing-sketch')) ?? false }] },
  renderHTML({ node }) { return ['figure', { 'data-writing-sketch': JSON.stringify(node.attrs), 'aria-label': node.attrs.title || 'Freehand sketch' }, node.attrs.title || 'Freehand sketch'] },
  renderText({ node }) { return '[Sketch: ' + (node.attrs.title || 'Freehand sketch') + ']' },
  addNodeView() { return ReactNodeViewRenderer(SketchView, { stopEvent: ({ event }) => event.target instanceof Element && !!event.target.closest('svg,input,button,select') }) },
})
