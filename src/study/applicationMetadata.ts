const clean = (value: unknown) => String(value || '').replace(/\s+/g, ' ').trim()
const deadlineCue = /\b(?:applications? (?:close|due)|deadline|apply by|closes?(?: on)?|closing date)\b/gi
const dateText = /(?:\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+20\d{2})?|\b20\d{2}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/20\d{2})?\b)/i

/** Preserve the date as published and skip nearby dates before the deadline signal. */
export function applicationDeadline(text: string): { deadline: string; deadlineEvidence: string } {
  for (const cue of text.matchAll(deadlineCue)) {
    const start = cue.index + cue[0].length
    const detail = text.slice(start, start + 100).split(/[\n.!?]/, 1)[0]
    const date = dateText.exec(detail)
    if (date) return { deadline: date[0], deadlineEvidence: clean(cue[0] + detail.slice(0, date.index + date[0].length)) }
  }
  return { deadline: '', deadlineEvidence: '' }
}

export function applicationMetadata(title: string, text: string) {
  const opportunity = clean(title).replace(/\s*(?:[|–—-]\s*)?(?:apply(?: now)?|application(?: form)?)\s*$/i, '').trim()
  return {
    opportunity, organization: opportunity, ...applicationDeadline(text),
    description: clean(text.split('\n').find(line => /\$[\d,]+|funding|fellowship|scholarship|eligib|award|prize provides/i.test(line))).slice(0, 1000),
  }
}
