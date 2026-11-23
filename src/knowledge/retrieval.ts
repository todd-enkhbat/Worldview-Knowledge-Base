import type { KnowledgeSnapshot, SearchFilters, SearchHit } from './types.ts'

const STOP = new Set('a about above across after again against all almost along already also although always am among an and any are around as at away back be because been before being below between both but by can cannot could did do does doing down during each either else enough even ever every few for former from further had has have having here how however i if in inside into is it its itself just later least less like many may me might more most much must my near neither never next no nor not now of off often on once one only onto or other ought our out outside over own perhaps rather same shall she should since so some still such than that the their them then there therefore these they this those through throughout thus to together too toward under until up upon us use used using very via was we well were what when where whether which while who whose why will with within without would yet you your'.split(' '))
export const words = (text: string): string[] => text.toLocaleLowerCase('en').normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu) ?? []

export function topicWords(text: string, limit = 4): string[] {
  const counts = new Map<string, number>()
  for (const word of words(text)) if (!STOP.has(word) && word.length > 3 && !/^\d+$/.test(word)) counts.set(word, (counts.get(word) ?? 0) + 1)
  // Stable sorting preserves source order when counts tie, rather than assigning
  // a neighborhood from an arbitrary alphabetical tie-break.
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([word]) => word)
}

/** Lexical passage retrieval remains available when model inference is disabled. */
export function rankKnowledge(snapshot: KnowledgeSnapshot, query: string, filters: SearchFilters = {}): SearchHit[] {
  const sourceMap = new Map(snapshot.sources.filter((s) => !s.excluded && !s.deleted && (!filters.aiOnly || s.aiAllowed) && (!filters.sourceIds || filters.sourceIds.includes(s.id)) && (!filters.kinds || filters.kinds.includes(s.kind))).map((s) => [s.id, s]))
  const versions = new Map(snapshot.versions.map((v) => [v.id, v]))
  const quoted = [...query.matchAll(/"([^"]+)"/g)].map((match) => match[1].toLocaleLowerCase('en'))
  const terms = [...new Set(words(query).filter((word) => !STOP.has(word)))]
  const phrase = query.trim().toLocaleLowerCase('en').replace(/^"|"$/g, '')
  const hits: SearchHit[] = []
  for (const p of snapshot.passages) {
    const source = sourceMap.get(p.sourceId)
    if (!source || (!filters.includeHistory && source.currentVersionId !== p.versionId) || (filters.role && p.role !== filters.role)) continue
    if (filters.authoredAfter !== undefined && (p.authoredAt === null || p.authoredAt < filters.authoredAfter)) continue
    if (filters.authoredBefore !== undefined && (p.authoredAt === null || p.authoredAt > filters.authoredBefore)) continue
    const version = versions.get(p.versionId)
    if (!version || version.sourceId !== p.sourceId || !Number.isSafeInteger(p.start) || !Number.isSafeInteger(p.end) || p.start < 0 || p.end < p.start || p.end > version.text.length || version.text.slice(p.start, p.end) !== p.text) continue
    const tokens = words(p.text)
    // Search words/phrases must not match unrelated suffixes: `tern` is not `lantern`.
    const tokenText = ` ${tokens.join(' ')} `
    const containsPhrase = (value: string) => { const phraseWords = words(value); return phraseWords.length > 0 && tokenText.includes(` ${phraseWords.join(' ')} `) }
    if (quoted.some((q) => !containsPhrase(q))) continue
    const titleTokens = new Set(words(p.title))
    const tokenCounts = new Map<string, number>()
    for (const token of tokens) tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1)
    const matched = terms.filter((term) => tokenCounts.has(term) || titleTokens.has(term) || source.tags.includes(term))
    let score = phrase && containsPhrase(phrase) ? 16 : 0
    score += matched.length * 4 + matched.reduce((sum, term) => sum + Math.log(1 + (tokenCounts.get(term) ?? 0)), 0)
    score += terms.filter((term) => titleTokens.has(term)).length * 3
    score += terms.length ? matched.length / terms.length * 6 : 0
    if (!query.trim() || score > 0) hits.push({ ...p, score })
  }
  return hits.sort((a, b) => b.score - a.score || (b.authoredAt ?? 0) - (a.authoredAt ?? 0) || a.id.localeCompare(b.id)).slice(0, Math.max(1, Math.min(200, filters.limit ?? 30)))
}
