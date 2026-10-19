import { describe, expect, it } from 'vitest'
import { clipTitle, countOverlaps, labelPriority, labelSize, placeLabels, type LabelCandidate } from '../../src/world/nodes/declutter.ts'

const c = (id: string, x: number, y: number, priority: number, w = 100, h = 30): LabelCandidate => ({ id, x, y, w, h, priority })
const view = { width: 800, height: 600 }

describe('placeLabels', () => {
  it('moves the lower-priority label to another side when two collide', () => {
    const out = placeLabels([c('a', 400, 300, 1), c('b', 410, 305, 5)], view)
    expect(out.map((p) => [p.id, p.side])).toEqual([
      ['b', 'above'],
      ['a', 'below'],
    ])
    expect(countOverlaps(out)).toBe(0)
  })

  it('drops a label that fits on no side', () => {
    const big = (id: string, p: number) => c(id, 400, 300, p, 780, 280)
    expect(placeLabels([big('a', 1), big('b', 5)], { ...view, height: 500 }).map((p) => p.id)).toEqual(['b'])
  })

  it('places separated labels and never overlaps', () => {
    const cands: LabelCandidate[] = []
    for (let i = 0; i < 200; i++) cands.push(c(`n${i}`, (i * 37) % 800, 60 + ((i * 53) % 540), i % 7))
    const out = placeLabels(cands, view)
    expect(out.length).toBeGreaterThan(10)
    expect(countOverlaps(out)).toBe(0)
  })

  it('moves labels off the viewport edge and out of avoided regions', () => {
    const out = placeLabels([c('edge', 10, 300, 1), c('top', 400, 20, 1), c('hud', 400, 590, 1), c('ok', 400, 300, 1)], {
      ...view,
      avoid: [[0, 560, 800, 600]],
    })
    expect(out.map((p) => [p.id, p.side])).toEqual([
      ['edge', 'right'],
      ['ok', 'above'],
      ['top', 'right'],
    ])
  })

  it('is stable on ties and respects max', () => {
    const cands = [c('b', 200, 300, 1), c('a', 600, 300, 1), c('c', 400, 500, 1)]
    expect(placeLabels(cands, { ...view, max: 2 }).map((p) => p.id)).toEqual(['a', 'b'])
  })
})

describe('label helpers', () => {
  it('ranks selection > hover > neighbours > degree > nearness', () => {
    const base = { selected: false, hovered: false, linkedToSelection: false, degree: 0, distance: 50 }
    const sel = labelPriority({ ...base, selected: true, distance: 900 })
    const hov = labelPriority({ ...base, hovered: true })
    const nb = labelPriority({ ...base, linkedToSelection: true })
    const deg = labelPriority({ ...base, degree: 3, distance: 400 })
    const near = labelPriority({ ...base, distance: 10 })
    expect(sel).toBeGreaterThan(hov)
    expect(hov).toBeGreaterThan(nb)
    expect(nb).toBeGreaterThan(deg)
    expect(deg).toBeGreaterThan(near)
  })

  it('clips long titles and sizes for 12 px', () => {
    expect(clipTitle('short')).toBe('short')
    expect(clipTitle('x'.repeat(40))).toHaveLength(28)
    expect(labelSize('abcdefghij', 'IDEA').w).toBeGreaterThanOrEqual(84)
  })
})
