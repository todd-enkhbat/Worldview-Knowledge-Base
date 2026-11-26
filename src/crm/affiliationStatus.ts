import type { CrmAffiliation } from './types.ts'

export function employmentStatus(role: Pick<CrmAffiliation, 'current' | 'endDate'>): 'current' | 'former' | 'other' {
  if (role.current === false || role.endDate && /\d{4}/.test(role.endDate)) return 'former'
  if (role.current === true || /^(present|current|now|ongoing)$/i.test(role.endDate?.trim() ?? '')) return 'current'
  return 'other'
}

export type EducationStatus = 'student' | 'graduate' | 'alum' | 'attended'

/** A degree title and an end date identify a program, without proving it was awarded. */
export function educationStatus(row: CrmAffiliation): EducationStatus {
  const segments = [row.excerpt, row.degree, row.role, ...(row.evidence || []).map(item => item.excerpt)]
    .filter((text): text is string => !!text).flatMap(text => text.split(/[·\n|]/)).map(text => text.trim())
  const school = row.organization.toLowerCase()
  const completion = segments.some(text => {
    if (/\b(?:not|never|expected|candidate|anticipated|plans?|didn.t|will)\b/i.test(text)) return false
    const from = text.match(/^graduated from (.+?)(?:\s+(?:with|in)\s+|[.,;]|$)/i)
    if (from) return from[1].toLowerCase() === school
    return /^(?:graduated(?:\s+(?:in\s+\d{4}|with\s+.+))?|(?:degree|diploma)\s+(?:awarded|conferred)(?:\s+\d{4})?)[.!]?$/i.test(text)
  })
  if (completion) return 'graduate'
  if (row.current === true || /^(?:present|current|ongoing)$/i.test(row.endDate?.trim() || '')) return 'student'
  if (segments.some(text => /^(?:alumniOf|alumnus|alumna|alum)$/i.test(text))) return 'alum'
  return 'attended'
}
