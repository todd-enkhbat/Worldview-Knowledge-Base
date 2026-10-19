import type { LinkKind, NodeRecord } from '../../domain/types.ts'

// How each link kind is drawn, and the pure link list the layer, the legend and the hover
// tooltip share. A link is drawn once per node pair: when a pair carries several kinds, the
// most assertive wins (KIND_PRECEDENCE). Directed kinds point along the flow of ideas: for
// "A derives from B" and "A was influenced by B" the arrow runs B → A.

export interface LinkStyle {
  /** Display colour (sRGB hex); the layer brightens it for HDR bloom. */
  color: string
  /** Line width in CSS px. */
  width: number
  /** Dash and gap in world units, or null for solid. */
  dash: readonly [number, number] | null
  /** Arrowhead at the downstream end. */
  arrow: boolean
  /** Break in the middle of the line (fraction of its length). */
  gap: number
  /** Legend wording: "A <verb> B". */
  verb: string
}

export const LINK_STYLE: Record<LinkKind, LinkStyle> = {
  supports: { color: '#e8b04a', width: 2, dash: null, arrow: false, gap: 0, verb: 'supports' },
  contradicts: { color: '#ff4a1c', width: 2, dash: null, arrow: false, gap: 0.14, verb: 'contradicts' },
  derives: { color: '#d9d4c7', width: 1.5, dash: [1.4, 0.9], arrow: true, gap: 0, verb: 'derives from' },
  'influenced-by': { color: '#b8b3a8', width: 1.5, dash: [0.35, 0.6], arrow: true, gap: 0, verb: 'was influenced by' },
  relates: { color: '#8d8a84', width: 1, dash: null, arrow: false, gap: 0, verb: 'is related to' },
}

/** Legend and draw order. Earlier kinds win when one pair carries several. */
export const KIND_PRECEDENCE: readonly LinkKind[] = ['contradicts', 'supports', 'derives', 'influenced-by', 'relates']

export interface TypedLink {
  /** Upstream end (the arrow's tail for directed kinds). */
  from: string
  /** Downstream end (where a directed arrow points). */
  to: string
  kind: LinkKind
  /** The node whose record declares the link, and the one it names. */
  declaredBy: string
  target: string
}

/** One link per live node pair, strongest kind first, in a stable order. Exported for tests. */
export function buildTypedLinks(nodes: ReadonlyMap<string, NodeRecord>): TypedLink[] {
  const rank = (k: LinkKind) => KIND_PRECEDENCE.indexOf(k)
  const best = new Map<string, TypedLink>()
  for (const n of nodes.values()) {
    for (const l of n.links) {
      const t = l.targetId
      if (t === n.id || !nodes.has(t)) continue
      const key = n.id < t ? `${n.id}|${t}` : `${t}|${n.id}`
      const prev = best.get(key)
      if (prev && rank(prev.kind) <= rank(l.kind)) continue
      // "n derives from t" / "n was influenced by t": ideas flow t → n.
      const directed = LINK_STYLE[l.kind].arrow
      best.set(key, {
        from: directed ? t : n.id,
        to: directed ? n.id : t,
        kind: l.kind,
        declaredBy: n.id,
        target: t,
      })
    }
  }
  return [...best.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, v]) => v)
}

/** "Landauer's principle — derives from → Shannon 1948" style sentence for the tooltip. */
export function linkSentence(link: TypedLink, title: (id: string) => string): string {
  return `${title(link.declaredBy)} — ${LINK_STYLE[link.kind].verb} → ${title(link.target)}`
}

/** Squared distance from point p to segment ab in 2D (screen px). */
export function distToSegment2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0
  const x = ax + t * dx - px
  const y = ay + t * dy - py
  return x * x + y * y
}
