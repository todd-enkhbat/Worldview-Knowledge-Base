// Small scored subsequence matcher for the Library search and the Cmd+K palette.
//
// Each query character must appear in order in the text (case-insensitive). Among all such
// alignments a tiny dynamic program picks the best one, so "bar" in "foobar bar" lands on
// the second word instead of the first occurrence a greedy scan would take. Scores reward
// word starts and consecutive runs and charge for gaps, a late start and long texts.
// Worlds hold hundreds of nodes, not millions: O(query × text) per field is plenty.

export interface FuzzyMatch {
  score: number
  /** Matched UTF-16 indices into the text, ascending. */
  positions: number[]
}

/** A searchable field. `bias` is added to its score (e.g. negative for tags, so titles win ties). */
export interface FuzzyField {
  text: string
  bias?: number
}

export interface FieldsMatch {
  score: number
  /** Matched positions per field, in the order the fields were given. */
  positions: number[][]
}

export interface Ranked<T> extends FieldsMatch {
  item: T
}

const SCORE_MATCH = 1
const BONUS_CONSECUTIVE = 6
const BONUS_WORD_START = 8
const BONUS_FIRST_CHAR = 4
const PENALTY_GAP = 1
const PENALTY_LEADING = 0.5
const MAX_LEADING_PENALTY = 6
const BONUS_PREFIX = 12
const BONUS_EXACT = 24
const PENALTY_LENGTH = 0.02
/** Query characters past this are ignored; nobody types a 64-character search. */
const MAX_QUERY = 64
/** Text past this is not searched (titles are ≤ 200 chars; this only guards odd input). */
const MAX_TEXT = 512

const NEG = Number.NEGATIVE_INFINITY
const SEPARATOR = /[\s\-_/\\.:,;()[\]{}#'"&+|·—–]/

// toLowerCase can lengthen a char (e.g. 'İ' → 'i̇'); keep one code unit so indices stay aligned
// with the original string for highlighting.
function fold(ch: string): string {
  const l = ch.toLowerCase()
  return l.length === 1 ? l : l[0]
}

function isUpper(ch: string): boolean {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase()
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isWordStart(text: string, j: number): boolean {
  if (j === 0) return true
  const prev = text[j - 1]
  const cur = text[j]
  if (SEPARATOR.test(prev)) return !SEPARATOR.test(cur)
  // camelCase and letter→digit boundaries ("Phase2", "fooBar").
  if (isUpper(cur) && !isUpper(prev)) return true
  return isDigit(cur) && !isDigit(prev)
}

function foldQuery(query: string): string {
  let q = ''
  for (const ch of query.slice(0, MAX_QUERY * 2)) {
    if (/\s/.test(ch)) continue
    q += fold(ch)
    if (q.length >= MAX_QUERY) break
  }
  return q
}

function normalizePhrase(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Score `text` against `query`. Whitespace in the query is ignored (use fuzzyMatchFields for
 * multi-word queries across several fields). Returns null when the query is not a
 * subsequence of the text. An empty query matches with score 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = foldQuery(query)
  const m = q.length
  if (m === 0) return { score: 0, positions: [] }
  const t = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text
  const n = t.length
  if (m > n) return null

  const tl = new Array<string>(n)
  for (let j = 0; j < n; j++) tl[j] = fold(t[j])

  // Cheap reject before allocating the table.
  for (let i = 0, j = 0; i < m; i++, j++) {
    while (j < n && tl[j] !== q[i]) j++
    if (j === n) return null
  }

  const bonus = new Float64Array(n)
  for (let j = 0; j < n; j++) bonus[j] = SCORE_MATCH + (isWordStart(t, j) ? BONUS_WORD_START : 0) + (j === 0 ? BONUS_FIRST_CHAR : 0)

  // M[i*n + j]: best score with query[i] matched at text[j]; from[i*n + j]: where query[i-1] sat.
  const M = new Float64Array(m * n).fill(NEG)
  const from = new Int32Array(m * n).fill(-1)
  // G[k]: best M[i-1][k'] for k' ≤ k, charged PENALTY_GAP per char skipped up to k.
  let G = new Float64Array(n)
  let Garg = new Int32Array(n)
  let nextG = new Float64Array(n)
  let nextGarg = new Int32Array(n)

  for (let i = 0; i < m; i++) {
    const row = i * n
    const prevRow = row - n
    for (let j = i; j < n; j++) {
      if (tl[j] !== q[i]) continue
      if (i === 0) {
        M[row + j] = bonus[j] - Math.min(j * PENALTY_LEADING, MAX_LEADING_PENALTY)
        continue
      }
      let best = NEG
      let src = -1
      if (M[prevRow + j - 1] > NEG) {
        best = M[prevRow + j - 1] + BONUS_CONSECUTIVE
        src = j - 1
      }
      if (j >= 2 && G[j - 2] > NEG) {
        const gapped = G[j - 2] - PENALTY_GAP
        if (gapped > best) {
          best = gapped
          src = Garg[j - 2]
        }
      }
      if (src < 0) continue
      M[row + j] = best + bonus[j]
      from[row + j] = src
    }
    if (i === m - 1) break
    for (let j = 0; j < n; j++) {
      const here = M[row + j]
      const carried = j > 0 ? nextG[j - 1] - PENALTY_GAP : NEG
      if (here >= carried) {
        nextG[j] = here
        nextGarg[j] = j
      } else {
        nextG[j] = carried
        nextGarg[j] = nextGarg[j - 1]
      }
    }
    const g = G
    G = nextG
    nextG = g
    const ga = Garg
    Garg = nextGarg
    nextGarg = ga
  }

  const last = (m - 1) * n
  let end = -1
  let score = NEG
  for (let j = m - 1; j < n; j++) {
    if (M[last + j] > score) {
      score = M[last + j]
      end = j
    }
  }
  if (end < 0) return null

  const positions = new Array<number>(m)
  for (let i = m - 1, j = end; i >= 0; i--) {
    positions[i] = j
    j = from[i * n + j]
  }

  if (positions[m - 1] === m - 1) score += BONUS_PREFIX
  if (normalizePhrase(t) === normalizePhrase(query)) score += BONUS_EXACT
  score -= n * PENALTY_LENGTH
  return { score, positions }
}

function asField(f: string | FuzzyField): FuzzyField {
  return typeof f === 'string' ? { text: f } : f
}

/**
 * Match a possibly multi-word query against several fields (title, tags, …). Either the
 * whole query matches inside one field, or every whitespace-separated token matches in
 * some field; the better of the two wins. Null when neither works.
 */
export function fuzzyMatchFields(query: string, fields: readonly (string | FuzzyField)[]): FieldsMatch | null {
  const fs = fields.map(asField)
  const empty = (): number[][] => fs.map(() => [])
  const tokens = query.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { score: 0, positions: empty() }

  let best: FieldsMatch | null = null

  // Whole query inside a single field.
  for (let f = 0; f < fs.length; f++) {
    const r = fuzzyMatch(query, fs[f].text)
    if (!r) continue
    const score = r.score + (fs[f].bias ?? 0)
    if (!best || score > best.score) {
      const positions = empty()
      positions[f] = r.positions
      best = { score, positions }
    }
  }

  // Each token in its best field.
  if (tokens.length > 1) {
    const positions = empty()
    let total = 0
    let ok = true
    for (const tok of tokens) {
      let tokBest: { score: number; f: number; positions: number[] } | null = null
      for (let f = 0; f < fs.length; f++) {
        const r = fuzzyMatch(tok, fs[f].text)
        if (!r) continue
        const score = r.score + (fs[f].bias ?? 0)
        if (!tokBest || score > tokBest.score) tokBest = { score, f, positions: r.positions }
      }
      if (!tokBest) {
        ok = false
        break
      }
      total += tokBest.score
      const merged = new Set([...positions[tokBest.f], ...tokBest.positions])
      positions[tokBest.f] = [...merged].sort((a, b) => a - b)
    }
    if (ok && (!best || total > best.score)) best = { score: total, positions }
  }

  return best
}

/**
 * Filter and sort `items` by how well `query` matches their fields. Ties keep the input
 * order, so callers pre-sort by their own default (e.g. newest first). An empty query
 * returns the first `limit` items unchanged.
 */
export function fuzzyRank<T>(
  items: readonly T[],
  query: string,
  fieldsOf: (item: T) => readonly (string | FuzzyField)[],
  limit = Number.POSITIVE_INFINITY,
): Ranked<T>[] {
  if (query.trim() === '') {
    return items.slice(0, Math.min(items.length, limit)).map((item) => ({ item, score: 0, positions: [] }))
  }
  const out: (Ranked<T> & { order: number })[] = []
  items.forEach((item, order) => {
    const r = fuzzyMatchFields(query, fieldsOf(item))
    if (r) out.push({ item, score: r.score, positions: r.positions, order })
  })
  out.sort((a, b) => b.score - a.score || a.order - b.order)
  return out.slice(0, Math.min(out.length, limit)).map(({ item, score, positions }) => ({ item, score, positions }))
}

export interface Segment {
  text: string
  hit: boolean
}

/** Split `text` into runs of matched / unmatched characters for highlighting. */
export function highlightSegments(text: string, positions: readonly number[] | undefined): Segment[] {
  if (!positions || positions.length === 0) return text ? [{ text, hit: false }] : []
  const hits = new Set(positions)
  const out: Segment[] = []
  let run = ''
  let runHit = hits.has(0)
  for (let i = 0; i < text.length; i++) {
    const h = hits.has(i)
    if (h !== runHit && run) {
      out.push({ text: run, hit: runHit })
      run = ''
    }
    runHit = h
    run += text[i]
  }
  if (run) out.push({ text: run, hit: runHit })
  return out
}
