import type { NodeRecord } from '../domain/types.ts'

// Demon matcher v1: BM25-lite (a BM25F flavour) over title, tags and content.
// Field weights fold into one weighted term frequency and one weighted length per document;
// idf is the always-positive Lucene form ln(1 + (N − df + 0.5)/(df + 0.5)). A document
// matches when its score is > 0, i.e. it contains at least one query term. Phase 4 swaps
// in embeddings behind the same matchDemon() call.

export const BM25 = {
  K1: 1.2,
  B: 0.75,
  FIELD_WEIGHT: { title: 3, tags: 2, content: 1 },
} as const

const STOPWORDS = new Set(
  'a an and are as at be but by for from has have i in is it its me my not of on or our so that the this to was we were what when which who with you your'.split(' '),
)

/** Lower-case, accent-folded word tokens; stopwords and 1-letter words dropped (digits kept). */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const folded = text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
  for (const tok of folded.split(/[^\p{L}\p{N}]+/u)) {
    if (tok === '' || STOPWORDS.has(tok)) continue
    if (tok.length < 2 && !/\p{N}/u.test(tok)) continue
    out.push(tok)
  }
  return out
}

export interface Bm25Doc {
  /** Field-weighted term frequency. */
  tf: Map<string, number>
  /** Field-weighted length. */
  len: number
}

export interface Bm25Index {
  docs: Map<string, Bm25Doc>
  df: Map<string, number>
  avgLen: number
}

type Searchable = Pick<NodeRecord, 'id' | 'title' | 'tags' | 'contentMd'>

export function indexDoc(r: Searchable): Bm25Doc {
  const tf = new Map<string, number>()
  let len = 0
  const add = (text: string, w: number) => {
    for (const tok of tokenize(text)) {
      tf.set(tok, (tf.get(tok) ?? 0) + w)
      len += w
    }
  }
  add(r.title, BM25.FIELD_WEIGHT.title)
  add(r.tags.join(' '), BM25.FIELD_WEIGHT.tags)
  add(r.contentMd, BM25.FIELD_WEIGHT.content)
  return { tf, len }
}

export function buildIndex(records: Iterable<Searchable>): Bm25Index {
  const docs = new Map<string, Bm25Doc>()
  const df = new Map<string, number>()
  let total = 0
  for (const r of records) {
    const d = indexDoc(r)
    docs.set(r.id, d)
    total += d.len
    for (const term of d.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1)
  }
  return { docs, df, avgLen: docs.size > 0 ? total / docs.size : 0 }
}

export function idf(index: Bm25Index, term: string): number {
  const n = index.docs.size
  const df = index.df.get(term) ?? 0
  return Math.log(1 + (n - df + 0.5) / (df + 0.5))
}

/** Unique query terms, in first-seen order. */
export function queryTerms(query: string): string[] {
  return [...new Set(tokenize(query))]
}

export function scoreDoc(index: Bm25Index, terms: readonly string[], id: string): number {
  const d = index.docs.get(id)
  if (!d || terms.length === 0) return 0
  const norm = BM25.K1 * (1 - BM25.B + (BM25.B * d.len) / (index.avgLen || 1))
  let s = 0
  for (const term of terms) {
    const f = d.tf.get(term)
    if (!f) continue
    s += (idf(index, term) * f * (BM25.K1 + 1)) / (f + norm)
  }
  return s
}

export interface Hit {
  id: string
  score: number
}

/** Matching documents (score > 0), best first, ties by id. Restricted to `ids` when given. */
export function search(index: Bm25Index, query: string, ids?: Iterable<string>): Hit[] {
  const terms = queryTerms(query)
  if (terms.length === 0) return []
  const out: Hit[] = []
  for (const id of ids ?? index.docs.keys()) {
    const score = scoreDoc(index, terms, id)
    if (score > 0) out.push({ id, score })
  }
  return out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
