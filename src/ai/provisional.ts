import type { Archetype, EntityKind, TemporalPrecision } from '../domain/types.ts'

// Omnibox step 1: a provisional record from the raw text in microseconds, no model, so
// something appears in the world at once (PLAN: < 1500 ms). Claude refines it afterwards.
// Pure and deterministic given `now`.

export interface ProvisionalDraft {
  archetype: Archetype
  title: string
  contentMd: string
  tags: string[]
  temporalOrigin: number
  temporalPrecision: TemporalPrecision
  entityKind?: EntityKind
  demonQuery?: string
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const TITLE_MAX = 80

const RULES: [Archetype, RegExp][] = [
  // Only command phrasing: "Maxwell's demon …" is an idea about a demon, not a standing query.
  ['demon', /^(?:demon\s*:|(?:watch for|gather|collect all|sort)\b)/i],
  ['memory', /\b(i (met|went|visited|saw|remember|moved|started|graduated|lived|was|felt)|when i|remember when|trip to|we (went|met)|my first)\b/i],
  ['document', /\b(book|paper|article|essay|blog post|thesis|notes? on|reading|read|chapter|arxiv|doi)\b/i],
  ['lens', /\b(lens|framework|through the lens|way of seeing|mental model|perspective of|worldview)\b/i],
]

/** Parse the date the text mentions; null when it mentions none. */
export function parseDate(text: string, now: number): { epochMs: number; precision: TemporalPrecision } | null {
  const t = text.toLowerCase()
  const nowD = new Date(now)
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t)
  if (m) return { epochMs: Date.UTC(+m[1], +m[2] - 1, +m[3]), precision: 'day' }
  m = new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{4})\\b`).exec(t)
  if (m) return { epochMs: Date.UTC(+m[2], MONTHS.indexOf(m[1]), 1), precision: 'month' }
  m = /\b(?:in|since|from|around|circa|c\.)?\s*((?:19|20)\d{2})\b/.exec(t)
  if (m) return { epochMs: Date.UTC(+m[1], 0, 1), precision: 'year' }
  const day = Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate())
  if (/\byesterday\b/.test(t)) return { epochMs: day - 86_400_000, precision: 'day' }
  if (/\b(today|tonight|this morning)\b/.test(t)) return { epochMs: day, precision: 'day' }
  if (/\blast year\b/.test(t)) return { epochMs: Date.UTC(nowD.getUTCFullYear() - 1, 0, 1), precision: 'year' }
  if (/\blast month\b/.test(t)) return { epochMs: Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - 1, 1), precision: 'month' }
  return null
}

function titleFrom(text: string): string {
  const firstLine = text.split('\n').find((l) => l.trim()) ?? text
  const sentence = /^(.+?[.!?])(\s|$)/.exec(firstLine.trim())?.[1] ?? firstLine.trim()
  const t = sentence.replace(/[.!?]+$/, '').trim()
  if (t.length <= TITLE_MAX) return t
  const cut = t.slice(0, TITLE_MAX - 1)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).trimEnd()}…`
}

/** A bare proper name ("Ada Lovelace", "CERN"): 1–4 capitalised words, nothing else. */
function looksLikeName(s: string): boolean {
  return /^([A-Z][\p{L}'’.-]*|[A-Z]{2,})(\s+([A-Z][\p{L}'’.-]*|of|de|von|van|the)){0,3}$/u.test(s.trim())
}

export function parseProvisional(raw: string, opts: { now: number; T0: number }): ProvisionalDraft {
  const tags: string[] = []
  const text = raw
    .replace(/(^|\s)#([\p{L}\p{N}_-]+)/gu, (_m, pre: string, tag: string) => {
      const t = tag.toLowerCase()
      if (!tags.includes(t)) tags.push(t)
      return pre
    })
    .replace(/\s+/g, ' ')
    .trim()
  const body = text || raw.trim()
  let archetype: Archetype = 'idea'
  for (const [a, re] of RULES) {
    if (re.test(body)) {
      archetype = a
      break
    }
  }
  let entityKind: EntityKind | undefined
  if (archetype === 'idea' && looksLikeName(body)) {
    archetype = 'entity'
    entityKind = /^[A-Z]{2,}$/.test(body) ? 'organization' : 'other'
  }
  const date = parseDate(body, opts.now)
  const clamp = (t: number) => Math.min(opts.now, Math.max(opts.T0, t))
  const today = Date.UTC(new Date(opts.now).getUTCFullYear(), new Date(opts.now).getUTCMonth(), new Date(opts.now).getUTCDate())
  const title = titleFrom(body) || 'Untitled'
  const draft: ProvisionalDraft = {
    archetype,
    title,
    contentMd: body.length > title.length + 1 ? body : '',
    tags,
    temporalOrigin: clamp(date?.epochMs ?? today),
    temporalPrecision: date?.precision ?? 'day',
  }
  if (entityKind) draft.entityKind = entityKind
  if (archetype === 'demon') draft.demonQuery = body.replace(/^(demon|watch for|gather|collect all|sort)\s*:?\s*/i, '').slice(0, 200)
  return draft
}
