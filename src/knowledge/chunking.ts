export const STRUCTURAL_CHUNKER_VERSION = 'worldview-structural-2'
export interface ChunkOptions {
  maxChars?: number
  overlapChars?: number
  /** Text-only budget. Without a tokenizer, UTF-8 bytes provide a conservative upper bound. */
  maxTokens?: number
  countTokens?: (text: string) => number
}
export interface TextSpan { start: number; end: number }

const safeBoundary = (text: string, at: number) => at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]) ? at - 1 : at

/** Fences stay together when they fit; oversized code is split at line boundaries. */
function fenceSpans(text: string, start: number, end: number): TextSpan[] {
  const spans: TextSpan[] = []
  let opened: { start: number; character: string; length: number } | null = null
  for (const match of text.slice(start, end).matchAll(/^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/gm)) {
    const delimiter = match[1]
    if (!opened) opened = { start: start + match.index, character: delimiter[0], length: delimiter.length }
    else if (delimiter[0] === opened.character && delimiter.length >= opened.length) { spans.push({ start: opened.start, end: start + match.index + match[0].length }); opened = null }
  }
  if (opened) spans.push({ start: opened.start, end })
  return spans
}

/** Exact UTF-16 spans. A supplied tokenizer is authoritative; no model or download occurs here. */
export function structuralSpans(text: string, segment: TextSpan, opts: ChunkOptions = {}): TextSpan[] {
  if (!Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end) || segment.start < 0 || segment.end < segment.start || segment.end > text.length || safeBoundary(text, segment.start) !== segment.start || safeBoundary(text, segment.end) !== segment.end) throw new Error('A passage segment must have valid Unicode-safe UTF-16 offsets.')
  const maxChars = Math.floor(opts.maxChars ?? 1400)
  const maxTokens = Math.floor(opts.maxTokens ?? 1024)
  if (maxChars < 16 || maxTokens < 16 || !Number.isFinite(maxChars) || !Number.isFinite(maxTokens)) throw new Error('Passage budgets must be finite and at least 16.')
  const overlap = Math.max(0, Math.min(Math.floor(opts.overlapChars ?? 120), Math.floor(maxChars / 3)))
  const encoder = new TextEncoder()
  const tokens = opts.countTokens ?? ((value: string) => encoder.encode(value).length)
  const fences = fenceSpans(text, segment.start, segment.end)
  const points: { at: number; priority: number }[] = []
  for (const fence of fences) points.push({ at: fence.start, priority: 4 }, { at: fence.end, priority: 4 })
  for (const match of text.slice(segment.start, segment.end).matchAll(/(^ {0,3}#{1,6}\s+[^\r\n]+)|\r?\n[ \t]*\r?\n|\r?\n/gm)) {
    const at = segment.start + match.index + (match[1] ? 0 : match[0].length)
    if (fences.some((fence) => at > fence.start && at < fence.end)) { if (!match[1]) points.push({ at, priority: 1 }); continue }
    points.push({ at, priority: match[1] ? 3 : /\n[ \t]*\r?\n/.test(match[0]) ? 2 : 1 })
  }
  const spans: TextSpan[] = []
  let cursor = segment.start
  while (cursor < segment.end) {
    let hard = safeBoundary(text, Math.min(segment.end, cursor + maxChars))
    if (tokens(text.slice(cursor, hard)) > maxTokens) {
      let low = cursor + 1, high = hard
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        const candidate = safeBoundary(text, middle)
        if (tokens(text.slice(cursor, candidate)) <= maxTokens) low = middle
        else high = middle - 1
      }
      hard = safeBoundary(text, low)
    }
    if (hard <= cursor) throw new Error('The selected tokenizer cannot fit one source character in the passage budget.')
    let end = hard
    if (hard < segment.end) {
      const crossing = fences.find((fence) => hard > fence.start && hard < fence.end && fence.start > cursor && fence.end - fence.start <= maxChars && tokens(text.slice(fence.start, fence.end)) <= maxTokens)
      if (crossing) end = crossing.start
      else {
        const floor = cursor + Math.floor((hard - cursor) * .5)
        const choice = points.filter((point) => point.at > floor && point.at <= hard).sort((a, b) => b.priority - a.priority || b.at - a.at)[0]
        if (choice) end = choice.at
        else { const space = text.lastIndexOf(' ', hard); if (space > floor) end = space }
      }
    }
    end = safeBoundary(text, end)
    if (end <= cursor) end = hard
    // Token counts can change non-monotonically with BPE merges. The final span,
    // including a chosen paragraph break, must satisfy the authoritative budget.
    while (end > cursor && tokens(text.slice(cursor, end)) > maxTokens) end = safeBoundary(text, end - 1)
    if (end <= cursor) throw new Error('The selected tokenizer cannot fit one source character in the passage budget.')
    if (text.slice(cursor, end).trim()) spans.push({ start: cursor, end })
    if (end >= segment.end) break
    let next = safeBoundary(text, Math.max(cursor + 1, end - overlap))
    const overlappingCode = fences.find((fence) => next > fence.start && next < fence.end && fence.end - fence.start <= maxChars)
    if (overlappingCode) next = overlappingCode.start > cursor ? overlappingCode.start : end
    if (next <= cursor) next = end
    cursor = next
  }
  return spans
}
