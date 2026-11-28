import { z } from 'zod'

export const STUDY_KEY = 'study.v1'
const id = z.string().min(1).max(1000),
  short = z.string().max(1000),
  text = z.string().max(100000)
const time = z.number().finite().nonnegative()
export const contextSchema = z.object({
  sourceApp:short.optional(),
  bookId: id.optional(),
  bookTitle: short.optional(),
  edition: short.optional(),
  chapter: short.optional(),
  page: short.optional(),
  noteId: id.optional(),
  url: z
    .url()
    .regex(/^https?:\/\//)
    .max(4000)
    .optional(),
  sentence: z.string().max(12000).optional()
})
export type WordContext = z.infer<typeof contextSchema>
const sense = z.object({ pos: short, meaning: z.string().min(1).max(5000) })
const encounter = z.object({ id, at: time, spelling: short, context: contextSchema })
const word = z.object({
  id,
  language: short,
  term: short,
  senses: z.array(sense).min(1).max(80),
  selected: z.number().int().nonnegative(),
  encounters: z.array(encounter),
  history: z.array(z.object({ at: time, grade: z.enum(['again', 'hard', 'got']) })).default([]),
  due: time.nullable(),
  days: z.number().nonnegative(),
  source: short
})
const answer = z.object({ question: z.string().min(1).max(8000), answer: text })
const applicationDetails = { deadline: short.optional(), deadlineSource: z.string().max(4000).optional(), deadlineEvidence: short.optional(), appliedAt: time.nullable().optional(), submissionEvidence: z.string().max(4000).optional(), description: short.optional(), organizationId: id.optional() }
export const applicationInput = z.object({
  ...applicationDetails,
  workspaceToken: short.optional(),
  captureId:z.uuid().optional(),
  id: id.optional(),
  organization: short,
  opportunity: short.min(1),
  source: z.string().max(4000),
  step: short.min(1),
  evidence: text.optional(),
  sourceDate: short.optional(),
  submitted: z.boolean(),
  answers: z.array(answer).max(180)
})
const revision = z.object({
  ...applicationDetails,
  id,
  at: time,
  step: short,
  source: z.string().max(4000),
  answers: z.array(answer),
  evidence: text.optional(),
  sourceDate: short.optional(),
  readerSubmission: z.object({key: short, fingerprint: short}).optional(),
  submitted: z.boolean()
})
const application = z.object({
  ...applicationDetails,
  id,
  organization: short,
  opportunity: short,
  updatedAt: time,
  revisions: z.array(revision)
})
const schema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  words: z.array(word),
  applications: z.array(application)
})
export type StudyState = z.infer<typeof schema>
export type WordEntry = z.infer<typeof word>
export type ApplicationInput = z.infer<typeof applicationInput>
export type Sense = z.infer<typeof sense>
export function decodeStudy(raw: unknown): StudyState {
  return schema.parse(raw ?? { schemaVersion: 1, revision: 0, words: [], applications: [] })
}
/** Historical confirmations can supply a date; a capture timestamp cannot. */
export function applicationAppliedAt(record: StudyState['applications'][number]): number | null {
  if (record.appliedAt != null) return record.appliedAt
  const dates = record.revisions.filter(revision=>revision.submitted).flatMap(revision=>{
    if(revision.appliedAt != null)return [revision.appliedAt]
    if(revision.sourceDate && /\b(?:19|20)\d{2}\b/.test(revision.sourceDate)) {const date=Date.parse(revision.sourceDate);if(Number.isFinite(date))return [date]}
    return []
  })
  return dates.length ? Math.min(...dates) : null
}
export const normalizeTerm = (s: string) => s.normalize('NFC').trim().toLocaleLowerCase().replace(/\s+/g, ' ')
export function applyStudy(state: StudyState, action: string, input: unknown, now = Date.now(), readerSubmission?: {key: string; fingerprint: string}) {
  if (action === 'encounter') {
    const v = z
      .object({
        eventId: id,
        term: short.min(1),
        language: short.min(1),
        senses: z.array(sense).min(1).max(80),
        source: short,
        context: contextSchema
      })
      .parse(input)
    const key = v.language + ':' + normalizeTerm(v.term)
    let entry = state.words.find((w) => w.id === key)
    if (!entry) {
      entry = {
        id: key,
        language: v.language,
        term: v.term,
        senses: v.senses,
        selected: 0,
        encounters: [],
        history: [],
        due: now,
        days: 0,
        source: v.source
      }
      state.words.push(entry)
    }
    if (!entry.encounters.some((e) => e.id === v.eventId))
      entry.encounters.push({ id: v.eventId, at: now, spelling: v.term, context: v.context })
    return key
  }
  if (action === 'application') {
    const v = applicationInput.parse(input)
    const applicationId=v.id??v.captureId??crypto.randomUUID()
    let record = state.applications.find((a) => a.id === applicationId)
    if (v.id && !record) throw Error('This application no longer exists.')
    if (!record) {
      record = {
        id: applicationId,
        organization: v.organization,
        opportunity: v.opportunity,
        updatedAt: now,
        revisions: []
      }
      state.applications.push(record)
    }
    const details = Object.fromEntries(Object.keys(applicationDetails).flatMap(key => { const value = v[key as keyof typeof v]; return value === undefined ? [] : [[key, value]] }))
    if (v.submitted && !record.appliedAt) details.appliedAt = v.appliedAt ?? (v.sourceDate && /\b(?:19|20)\d{2}\b/.test(v.sourceDate) && Number.isFinite(Date.parse(v.sourceDate)) ? Date.parse(v.sourceDate) : null)
    const metadataChanged = Object.entries(details).some(([key,value]) => JSON.stringify(record[key as keyof typeof record]) !== JSON.stringify(value))
    Object.assign(record, details)
    record.organization = v.organization
    record.opportunity = v.opportunity
    const latest = record.revisions.findLast((r) => r.step === v.step)
    if (
      !latest || metadataChanged || readerSubmission ||
      latest.source !== v.source ||
      latest.evidence !== v.evidence ||
      latest.sourceDate !== v.sourceDate ||
      latest.submitted !== v.submitted ||
      JSON.stringify(latest.answers) !== JSON.stringify(v.answers)
    ) {
      record.revisions.push({
        ...details,
        id: crypto.randomUUID(),
        at: now,
        step: v.step,
        source: v.source,
        submitted: v.submitted,
        ...(readerSubmission ? {readerSubmission} : {}),
        answers: v.answers,
        evidence: v.evidence,
        sourceDate: v.sourceDate
      })
      record.updatedAt = now
    }
    return record.id
  }
  const v = z
    .object({
      id,
      eventId: id.optional(),
      index: z.number().int().nonnegative().optional(),
      grade: z.enum(['again', 'hard', 'got']).optional()
    })
    .parse(input)
  const w = state.words.find((x) => x.id === v.id)
  if (!w) throw Error('Word no longer in this workspace.')
  if (action === 'undo' && v.eventId) {
    w.encounters = w.encounters.filter((e) => e.id !== v.eventId)
    if (!w.encounters.length) state.words = state.words.filter((x) => x !== w)
  } else if (action === 'sense' && v.index != null && v.index < w.senses.length) w.selected = v.index
  else if (action === 'remove-card') w.due = null
  else if (action === 'review' && v.grade) {
    w.history.push({ at: now, grade: v.grade })
    w.days = v.grade === 'again' ? 0 : v.grade === 'hard' ? 1 : Math.max(3, Math.round(w.days * 2.3))
    w.due = now + (w.days ? 86400000 * w.days : 600000)
  } else throw Error('Unsupported vocabulary change.')
  return v.id
}
export function safeApplicationText(raw: string) {
  // Skip labeled secrets and their multiline values before parsing Q/A boundaries.
  const safe: string[] = []
  let protectedField = false
  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    const label = line.trim().replace(/^(?:Q(?:uestion)?\s*\d*[:.)]|\d+[.)])\s*/i, '')
    if (
      /^(?:password|passcode|card number|credit card|payment details|security code|cvv|routing number|bank account|social security number)\b/i.test(
        label
      )
    ) {
      protectedField = true
      continue
    }
    if (protectedField && !/^(?:Q(?:uestion)?\s*\d*[:.)]|\d+[.)])|[?:]\s*$/i.test(line.trim())) continue
    protectedField = false
    safe.push(line)
  }
  return safe.join('\n')
}
export function parseApplicationPaste(raw:string){
  raw=safeApplicationText(raw)
  const rows: { question: string; answer: string }[] = []
  let pending: string[] = []
  const finish = () => {
    if (rows.length) rows[rows.length - 1].answer = pending.join('\n').replace(/^\n+|\n+$/g, '')
    pending = []
  }
  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    if (
      /^(?:Q(?:uestion)?\s*\d*[:.)]|\d+[.)]\s|(?:describe|please (?:describe|explain)|tell us|explain)\b)/i.test(
        line.trim()
      ) ||
      line.trim().endsWith('?')
    ) {
      finish()
      rows.push({ question: line.trim(), answer: '' })
    } else pending.push(line.replace(/^A(?:nswer)?\s*:\s*/i, ''))
  }
  if (rows.length) {
    finish()
    return rows
  }
  return []
}

export function answerRelevance(query: string, question: string, answer: string, description: string) {
  const text = normalizeTerm(query)
  if (!text) return 1
  const stop = new Set([
    'the',
    'your',
    'you',
    'for',
    'and',
    'are',
    'why',
    'what',
    'how',
    'would',
    'did',
    'this',
    'our',
    'with'
  ])
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? []
  const keys = words.filter((t) => !stop.has(t)),
    terms = keys.length ? keys : words
  const q = normalizeTerm(question),
    a = normalizeTerm(answer),
    d = normalizeTerm(description)
  return (
    Number(q.includes(text)) * 12 +
    Number(a.includes(text)) * 6 +
    terms.reduce((n, t) => n + (q.includes(t) ? 3 : 0) + (a.includes(t) ? 1 : 0) + (d.includes(t) ? 1 : 0), 0)
  )
}
