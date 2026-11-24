import { describe, expect, it } from 'vitest'
import { fitGraphCamera, focusGraphCamera, graphCurve, graphPoint, graphTopology, GraphPresentation, layoutGraph, zoomGraphCamera, type GraphFrame, type GraphScheduler } from '../../src/reading/graphMotion.ts'

function clock() {
  let now = 0, next = 0
  const pending = new Map<number, (time: number) => void>()
  const scheduler: GraphScheduler = { now: () => now, request: (callback) => { const id = ++next; pending.set(id, callback); return id }, cancel: (id) => { pending.delete(id) } }
  return { scheduler, pending, advance: (time: number) => { now = time; const callbacks = [...pending.values()]; pending.clear(); for (const callback of callbacks) callback(now) } }
}
const camera = { x: 500, y: 350, scale: 1 }

describe('bounded graph presentation', () => {
  it('keeps exact 2D pins, deterministic layouts and all source inputs unchanged', () => {
    const nodes = [{ key: 'source:a', kind: 'source' as const }, { key: 'source:b', kind: 'source' as const }, { key: 'topic:c', kind: 'topic' as const }]
    const edges = [{ id: 'saved-a-c', from: 'source:a', to: 'topic:c' }, { id: 'saved-b-c', from: 'source:b', to: 'topic:c' }]
    const before = structuredClone({ nodes, edges }), pins = new Map([['topic:c', { x: 220, y: -30 }]])
    const first = layoutGraph(nodes, edges, new Map(), pins), second = layoutGraph([...nodes].reverse(), [...edges].reverse(), new Map(), pins)
    expect(first.get('topic:c')).toEqual({ x: 220, y: -30 })
    for (const [key, point] of first) { expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true); expect(second.get(key)?.x).toBeCloseTo(point.x, 7); expect(second.get(key)?.y).toBeCloseTo(point.y, 7) }
    expect({ nodes, edges }).toEqual(before)
    expect(pins).toEqual(new Map([['topic:c', { x: 220, y: -30 }]]))
    expect(graphTopology(nodes, edges)).toBe(graphTopology([...nodes].reverse(), [...edges].reverse()))
  })

  it('bounds the canvas at 320 nodes and preserves its existing mental map when a neighbor arrives', () => {
    const nodes = [{ key: 'source:a', kind: 'source' as const }, { key: 'topic:b', kind: 'topic' as const }], edge = { id: 'ab', from: 'source:a', to: 'topic:b' }
    const first = layoutGraph(nodes, [edge]), expanded = layoutGraph([...nodes, { key: 'source:c', kind: 'source' }], [edge, { id: 'bc', from: 'topic:b', to: 'source:c' }], first)
    for (const node of nodes) expect(Math.hypot(expanded.get(node.key)!.x - first.get(node.key)!.x, expanded.get(node.key)!.y - first.get(node.key)!.y)).toBeLessThan(150)
    const large = Array.from({ length: 400 }, (_, i) => ({ key: `source:${i}`, kind: 'source' as const }))
    expect(layoutGraph(large, []).size).toBe(320)
  })

  it('keeps the pointer-anchored world point stable while zooming and centers a focused node', () => {
    const current = { x: 170, y: 80, scale: .7 }, anchor = { x: 450, y: 260 }, point = graphPoint(anchor, current)
    const zoomed = zoomGraphCamera(current, 1.6, anchor, .1, 5)
    expect(graphPoint(anchor, zoomed).x).toBeCloseTo(point.x, 10)
    expect(graphPoint(anchor, zoomed).y).toBeCloseTo(point.y, 10)
    const focused = focusGraphCamera({ x: -110, y: 300 }, 800, 600, 1.2)
    expect(-110 * focused.scale + focused.x).toBe(400)
    expect(300 * focused.scale + focused.y).toBe(300)
    const fitted = fitGraphCamera(new Map([['a', { x: -200, y: -100 }], ['b', { x: 300, y: 500 }]]), 350, 400)
    expect(fitted.scale).toBeGreaterThan(0)
    expect(graphCurve({ x: 0, y: 0 }, { x: 100, y: 0 }, 30).d).toBe('M0,0 Q50,30 100,0')
  })

  it('finishes finite transitions, cancels work and resumes an interruption from the actually displayed frame', () => {
    const timer = clock(), presentation = new GraphPresentation(timer.scheduler), frames: GraphFrame[] = [], render = (frame: GraphFrame) => frames.push(frame)
    presentation.transition(new Map([['a', { x: 0, y: 0 }]]), camera, render)
    expect(timer.pending.size).toBe(0)
    presentation.transition(new Map([['a', { x: 100, y: 0 }]]), { ...camera, x: 600 }, render, { duration: 500 })
    expect(timer.pending.size).toBe(1)
    timer.advance(200)
    const displayed = presentation.frame!
    expect(displayed.positions.get('a')!.x).toBeGreaterThan(0)
    expect(displayed.positions.get('a')!.x).toBeLessThan(100)
    presentation.transition(new Map([['a', { x: 200, y: 80 }]]), { ...camera, x: 700 }, render, { duration: 500 })
    expect(presentation.frame!.positions.get('a')).toEqual(displayed.positions.get('a'))
    expect(presentation.frame!.camera).toEqual(displayed.camera)
    expect(timer.pending.size).toBe(1)
    timer.advance(700)
    expect(presentation.frame!.positions.get('a')).toEqual({ x: 200, y: 80 })
    expect(timer.pending.size).toBe(0)
    expect(presentation.running).toBe(false)
    const before = frames.length
    timer.advance(20000)
    expect(frames).toHaveLength(before)
    presentation.transition(new Map([['a', { x: 300, y: 0 }]]), camera, render)
    presentation.stop()
    expect(timer.pending.size).toBe(0)
    timer.advance(30000)
    expect(frames).toHaveLength(before + 1)
  })

  it('reveals new nodes from a real neighbor, honors zero-duration/reduced motion and skips unchanged work', () => {
    const timer = clock(), presentation = new GraphPresentation(timer.scheduler), render = () => {}
    presentation.transition(new Map([['a', { x: 20, y: 30 }]]), camera, render)
    presentation.transition(new Map([['a', { x: 20, y: 30 }], ['b', { x: 200, y: 200 }]]), camera, render, { origins: new Map([['b', { x: 20, y: 30 }]]), duration: 500 })
    expect(presentation.frame!.positions.get('b')).toEqual({ x: 20, y: 30 })
    expect(presentation.frame!.entering.has('b')).toBe(true)
    presentation.transition(new Map([['a', { x: 20, y: 30 }], ['b', { x: 200, y: 200 }]]), camera, render, { duration: 0 })
    expect(presentation.frame!.positions.get('b')).toEqual({ x: 200, y: 200 })
    expect(timer.pending.size).toBe(0)
    presentation.transition(presentation.frame!.positions, camera, render)
    expect(timer.pending.size).toBe(0)
    expect(presentation.frame!.progress).toBe(1)
  })
})
