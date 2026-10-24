// Screen-label placement: pure, so it is testable without a canvas. Candidates arrive with
// a projected anchor (CSS px) and a priority; placement is greedy by priority, dropping any
// label that fits on no side of its anchor (above, right, left, below) without overlapping
// one already placed or leaving the viewport. Ties break on id
// so the result is stable from frame to frame.

export interface LabelCandidate {
  id: string
  /** Anchor in CSS px: the label sits centred above it. */
  x: number
  y: number
  w: number
  h: number
  priority: number
  /** Sides to try, in order (default above, right, left, below). */
  sides?: readonly LabelSide[]
}

export type LabelSide = 'above' | 'right' | 'left' | 'below'

export interface PlacedLabel {
  id: string
  left: number
  top: number
  w: number
  h: number
  side: LabelSide
}

/** Box for a label on one side of its anchor. */
export function sideBox(x: number, y: number, w: number, h: number, side: LabelSide, lift: number): { left: number; top: number } {
  switch (side) {
    case 'above':
      return { left: x - w / 2, top: y - lift - h }
    case 'below':
      return { left: x - w / 2, top: y + lift }
    case 'right':
      return { left: x + lift, top: y - h / 2 }
    case 'left':
      return { left: x - lift - w, top: y - h / 2 }
  }
}

const SIDES: readonly LabelSide[] = ['above', 'right', 'left', 'below']

export interface PlaceOptions {
  width: number
  height: number
  /** Gap kept between labels (px). */
  pad?: number
  /** Gap between the anchor and the label's bottom edge (px). */
  lift?: number
  max?: number
  /** Screen regions labels must avoid (HUD bars), as [left, top, right, bottom]. */
  avoid?: readonly (readonly [number, number, number, number])[]
}

export function placeLabels(cands: readonly LabelCandidate[], opts: PlaceOptions): PlacedLabel[] {
  const pad = opts.pad ?? 4
  const lift = opts.lift ?? 10
  const max = opts.max ?? 40
  const order = [...cands].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const out: PlacedLabel[] = []
  const fits = (left: number, top: number, w: number, h: number) => {
    if (left < 0 || top < 0 || left + w > opts.width || top + h > opts.height) return false
    if (opts.avoid?.some((r) => left < r[2] && left + w > r[0] && top < r[3] && top + h > r[1])) return false
    for (const p of out) {
      if (left < p.left + p.w + pad && left + w + pad > p.left && top < p.top + p.h + pad && top + h + pad > p.top) return false
    }
    return true
  }
  for (const c of order) {
    if (out.length >= max) break
    for (const side of c.sides ?? SIDES) {
      const b = sideBox(c.x, c.y, c.w, c.h, side, lift)
      if (fits(b.left, b.top, c.w, c.h)) {
        out.push({ id: c.id, left: b.left, top: b.top, w: c.w, h: c.h, side })
        break
      }
    }
  }
  return out
}

/** Pairs of placed labels whose boxes intersect (should be none). */
export function countOverlaps(placed: readonly PlacedLabel[]): number {
  let n = 0
  for (let i = 0; i < placed.length; i++) {
    const a = placed[i]
    for (let j = i + 1; j < placed.length; j++) {
      const b = placed[j]
      if (a.left < b.left + b.w && a.left + a.w > b.left && a.top < b.top + b.h && a.top + a.h > b.top) n++
    }
  }
  return n
}

export interface PriorityInput {
  selected: boolean
  hovered: boolean
  /** Linked (either direction) to the selection. */
  linkedToSelection: boolean
  degree: number
  /** Camera distance (world units). */
  distance: number
}

/** Selection, hover and its neighbours first; then well-connected nodes; nearer wins ties. */
export function labelPriority(p: PriorityInput): number {
  return (
    (p.selected ? 1e6 : 0) +
    (p.hovered ? 5e5 : 0) +
    (p.linkedToSelection ? 1e5 : 0) +
    Math.min(p.degree, 20) * 1000 -
    Math.min(p.distance, 999)
  )
}

/** Far titles are clipped; the full title is in the hover tooltip and the Inspector. */
export const FAR_TITLE_CHARS = 28

export function clipTitle(s: string, n = FAR_TITLE_CHARS): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s
}

/** JetBrains Mono advance is 0.6 em. Title 12 px bold, tag 10 px with 0.12 em tracking. */
export function labelSize(title: string, tag: string): { w: number; h: number } {
  const tw = title.length * 12 * 0.6
  const gw = tag.length * 10 * 0.72
  return { w: Math.ceil(Math.max(tw, gw)) + 12, h: 34 }
}
