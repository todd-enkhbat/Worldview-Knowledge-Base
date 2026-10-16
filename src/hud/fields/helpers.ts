import { MASS_RANGE } from '../../domain/constants.ts'
import type { Link, LinkKind, NodeRecord } from '../../domain/types.ts'

// Pure helpers behind the editor controls (unit-tested in tests/hud/nodeEditorHelpers.test.ts).

// ─── tags ────────────────────────────────────────────────────────────────────────────

export const TAG_MAX = 48

/** Trim, collapse inner whitespace, strip a leading '#', cap the length. '' means "no tag". */
export function normalizeTag(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().replace(/^#+/, '').trim().slice(0, TAG_MAX).trim()
}

/**
 * Add the comma-separated tags in `raw` to `tags`. Case-insensitive de-duplication keeps the
 * first spelling, because the primary tag drives placement and near-duplicates would scatter.
 */
export function mergeTags(tags: readonly string[], raw: string): string[] {
  const out = [...tags]
  const seen = new Set(tags.map((t) => t.toLowerCase()))
  for (const part of raw.split(',')) {
    const t = normalizeTag(part)
    if (!t || seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase())
    out.push(t)
  }
  return out
}

// ─── link search ─────────────────────────────────────────────────────────────────────

export const LINK_KINDS: readonly LinkKind[] = ['relates', 'supports', 'contradicts', 'derives', 'influenced-by']

export const LINK_KIND_HINT: Record<LinkKind, string> = {
  relates: 'is related to',
  supports: 'supports',
  contradicts: 'contradicts',
  derives: 'derives from',
  'influenced-by': 'was influenced by',
}

/**
 * Nodes whose title (or a tag) matches `query`, best first: title prefix, then word prefix,
 * then substring, then tag hit; ties by title. An empty query lists the most recent nodes.
 */
export function searchNodes(
  nodes: Iterable<NodeRecord>,
  query: string,
  opts: { exclude?: ReadonlySet<string>; limit?: number } = {},
): NodeRecord[] {
  const q = query.trim().toLowerCase()
  const limit = opts.limit ?? 8
  const scored: { n: NodeRecord; s: number }[] = []
  for (const n of nodes) {
    if (opts.exclude?.has(n.id)) continue
    if (!q) {
      scored.push({ n, s: -n.updatedAt })
      continue
    }
    const t = n.title.toLowerCase()
    let s = -1
    if (t.startsWith(q)) s = 0
    else if (t.split(/[\s\-_/:,.]+/).some((w) => w.startsWith(q))) s = 1
    else if (t.includes(q)) s = 2
    else if (n.tags.some((tag) => tag.toLowerCase().includes(q))) s = 3
    if (s >= 0) scored.push({ n, s })
  }
  scored.sort((a, b) => a.s - b.s || a.n.title.localeCompare(b.n.title))
  return scored.slice(0, limit).map((x) => x.n)
}

/** Add a link unless the same (target, kind) pair already exists. */
export function addLink(links: readonly Link[], targetId: string, kind: LinkKind, now: number): Link[] {
  if (links.some((l) => l.targetId === targetId && l.kind === kind)) return [...links]
  return [...links, { targetId, kind, createdAt: now }]
}

/** Change the kind of links[index]; a change that would duplicate another link is refused. */
export function setLinkKind(links: readonly Link[], index: number, kind: LinkKind): Link[] {
  const l = links[index]
  if (!l || links.some((o, i) => i !== index && o.targetId === l.targetId && o.kind === kind)) return [...links]
  return links.map((o, i) => (i === index ? { ...o, kind } : o))
}

// ─── thermo sliders ──────────────────────────────────────────────────────────────────

// Significance is log-scaled: mass spans a 16× range, and a linear slider would park the
// default (mass 1) at 20 % with most of the travel spent on the heavy end.
const [M_LO, M_HI] = MASS_RANGE
const LOG_SPAN = Math.log(M_HI / M_LO)

/** mass ∈ [0.25, 4] → slider position ∈ [0, 1] (mass 1 sits at 0.5). */
export function massToSignificance(mass: number): number {
  const m = Math.min(M_HI, Math.max(M_LO, mass))
  return Math.log(m / M_LO) / LOG_SPAN
}

/** slider position ∈ [0, 1] → mass, rounded to 2 decimals and kept inside the range. */
export function significanceToMass(s: number): number {
  const x = Math.min(1, Math.max(0, s))
  const m = M_LO * Math.exp(x * LOG_SPAN)
  return Math.min(M_HI, Math.max(M_LO, Math.round(m * 100) / 100))
}

export function significanceWord(mass: number): string {
  if (mass < 0.6) return 'passing: drifts with the field'
  if (mass < 1.5) return 'notable'
  if (mass < 2.8) return 'weighty: hard to move'
  return 'foundational: bends everything near it'
}

export function volatilityWord(temperature: number): string {
  if (temperature < 0.15) return 'anchored: barely drifts'
  if (temperature < 0.4) return 'steady'
  if (temperature < 0.7) return 'lively'
  return 'restless: wanders the field'
}
