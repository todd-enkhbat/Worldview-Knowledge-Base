import { createHash } from 'node:crypto'
import type { CrmJson } from '../src/crm/types.ts'
import type { CrmConnectorBatch, CrmConnectorCandidate, CrmImportMapping, CrmImportPreview } from '../src/crm/connectionTypes.ts'

export const crmHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const clean = (value: unknown, limit = 20000) => String(value ?? '').replaceAll('\0', '').trim().slice(0, limit)
export const crmEmail = (value: unknown) => { const email = clean(value, 320).toLowerCase(); return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : '' }
export const crmUrl = (value: unknown) => { try { const url = new URL(clean(value, 4096)); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '' } catch { return '' } }
export const crmPerson = (name: string, email = '', phone = '', url = '') => ({ fullName: clean(name, 1000) || email || 'Unnamed contact', firstName: '', lastName: '', emails: email ? [email] : [], phones: phone ? [phone] : [], urls: url ? [url] : [], jobTitle: '', description: '', location: '', companyIds: [], tags: [], avatarAssetId: null, mergedIntoId: null })
export function connectorCandidate(provider: string, accountId: string, externalId: string, payload: Record<string, unknown>, raw: CrmJson, originalAssetId: string, now: number, kind: CrmConnectorCandidate['kind'] = 'person'): CrmConnectorCandidate {
  const sourceRef = { provider, accountId, externalId, originalAssetId, observedAt: now }
  return { kind, status: 'pending', provider, accountId, externalId, payload, targetId: null, confidence: 'unknown', evidence: [{ label: `${provider} imported record`, sourceRef }], sourceRefs: [sourceRef], raw }
}

/** RFC 4180-style quoted fields, including embedded newlines; malformed quotes fail instead of shifting columns. */
export function parseCrmCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false, afterQuote = false
  const finish = () => { row.push(field); field = ''; afterQuote = false }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else { quoted = false; afterQuote = true } } else field += c; continue }
    if (c === '"') { if (field || afterQuote) throw new Error('CSV contains a misplaced quote. Export it again.'); quoted = true }
    else if (c === ',') finish()
    else if (c === '\r' || c === '\n') { if (c === '\r' && text[i + 1] === '\n') i++; finish(); if (row.some(Boolean)) rows.push(row); row = [] }
    else if (afterQuote && !/\s/.test(c)) throw new Error('CSV contains text after a closing quote.')
    else if (!afterQuote) field += c
  }
  if (quoted) throw new Error('CSV contains an unfinished quoted field.')
  finish(); if (row.some(Boolean)) rows.push(row)
  if (!rows.length) return []
  const header = rows.shift()!.map((item, i) => clean(item.replace(/^\uFEFF/, ''), 1000) || `Column ${i + 1}`)
  if (new Set(header).size !== header.length) throw new Error('CSV has duplicate column names. Rename those columns before importing so no fields are lost.')
  if (rows.length > 10000) throw new Error('Import at most 10,000 CSV rows at a time.')
  return rows.map((values) => { if (values.length > header.length) throw new Error('CSV row contains more fields than its header.'); return Object.fromEntries(header.map((key, i) => [key, values[i] ?? ''])) })
}
function mappingFor(columns: string[]): CrmImportMapping {
  const find = (...labels: string[]) => columns.find((column) => labels.includes(column.toLowerCase().replaceAll(/[_-]/g, ' ').trim()))
  return { name: find('name', 'full name', 'guest name', 'display name'), firstName: find('first name', 'firstname'), lastName: find('last name', 'lastname'), email: find('email', 'email address', 'e mail', 'guest email'), phone: find('phone', 'phone number', 'mobile'), company: find('company', 'organization', 'company name'), jobTitle: find('title', 'job title', 'position'), url: find('url', 'profile url', 'linkedin', 'linkedin url', 'website') }
}
const unfold = (text: string) => text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
const unescapeField = (text: string) => text.replace(/\\[nN]/g, '\n').replace(/\\([,;\\])/g, '$1')
function cards(text: string): Record<string, string>[] {
  const result: Record<string, string>[] = []; let row: Record<string, string> | null = null
  for (const line of unfold(text)) {
    if (/^BEGIN:VCARD$/i.test(line)) { row = {}; continue }
    if (/^END:VCARD$/i.test(line)) { if (row) { if (!row.FN && row.N) { const parts = row.N.split(';'); row.FN = [parts[3], parts[1], parts[2], parts[0], parts[4]].filter(Boolean).join(' ') } result.push(row) } row = null; continue }
    if (!row) continue
    const colon = line.indexOf(':'); if (colon < 0) continue
    const key = line.slice(0, colon).split(';')[0].split('.').at(-1)!.toUpperCase(), value = unescapeField(line.slice(colon + 1))
    row[key] = row[key] ? `${row[key]}\n${value}` : value; row[`RAW:${line.slice(0, colon)}`] = line.slice(colon + 1)
  }
  if (row) throw new Error('The vCard file ends before END:VCARD.')
  return result
}
export function parseCrmIcs(text: string): Record<string, string>[] {
  const events: Record<string, string>[] = []; let row: Record<string, string> | null = null
  for (const line of unfold(text)) {
    if (/^BEGIN:VEVENT$/i.test(line)) { row = {}; continue }
    if (/^END:VEVENT$/i.test(line)) { if (row) events.push(row); row = null; continue }
    if (!row) continue
    const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/); if (colon < 0) continue
    const fullKey = line.slice(0, colon), key = fullKey.split(';')[0].toUpperCase(), value = unescapeField(line.slice(colon + 1))
    row[key] = row[key] ? `${row[key]}\n${value}` : value; row[`RAW:${fullKey}`] = line.slice(colon + 1)
    if (key === 'DTSTART' || key === 'DTEND') row[`${key}:TZID`] = /;TZID="?([^;"]+)/i.exec(fullKey)?.[1] ?? ''
  }
  if (row) throw new Error('The calendar file ends before END:VEVENT.')
  return events
}
function icsTime(value: string, tz = ''): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value)
  if (!match) return null
  const desired = Date.UTC(+match[1], +match[2] - 1, +match[3], +(match[4] ?? 0), +(match[5] ?? 0), +(match[6] ?? 0))
  const date = new Date(desired); if (date.getUTCFullYear() !== +match[1] || date.getUTCMonth() !== +match[2] - 1 || date.getUTCDate() !== +match[3] || date.getUTCHours() !== +(match[4] ?? 0) || date.getUTCMinutes() !== +(match[5] ?? 0) || date.getUTCSeconds() !== +(match[6] ?? 0)) return null
  if (match[7] || !match[4]) return desired
  if (!tz) return null // Floating time is retained verbatim; never assume the server timezone.
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    const represented = (instant: number) => { const parts = Object.fromEntries(formatter.formatToParts(instant).map(({ type, value: part }) => [type, part])); return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) }
    let instant = desired; for (let i = 0; i < 4; i++) instant += desired - represented(instant)
    if (represented(instant) !== desired || [-7200000, -3600000, -1800000, 1800000, 3600000, 7200000].some((delta) => represented(instant + delta) === desired)) return null
    return instant
  } catch { return null }
}
const emailAddresses = (value: string) => [...value.matchAll(/(?:([^<,;]+?)\s*<)?([\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+\.[A-Za-z]{2,})(?:>)?/g)].map((match) => ({ name: clean(match[1]?.replace(/^"|"$/g, '') ?? '', 1000), email: crmEmail(match[2]) })).filter((item) => item.email)
export function parseCrmEmailHeaders(text: string): { name: string; email: string }[] {
  const headers = text.split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, ' ')
  return [...headers.matchAll(/^(?:From|To|Cc):\s*(.*)$/gim)].flatMap((match) => emailAddresses(match[1]))
}

export function previewCrmImport(name: string, bytes: Uint8Array, provider = 'file', customMapping?: CrmImportMapping): { preview: CrmImportPreview; rows: Record<string, string>[] } {
  if (!bytes.length || bytes.length > 12 * 1024 * 1024) throw new Error('Choose a nonempty contact file up to 12 MiB.')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), ext = name.split('.').at(-1)?.toLowerCase(), format = ext === 'vcf' || /BEGIN:VCARD/i.test(text.slice(0, 1000)) ? 'vcf' : ext === 'ics' || /BEGIN:VCALENDAR/i.test(text.slice(0, 1000)) ? 'ics' : ext === 'eml' ? 'eml' : 'csv'
  const rows = format === 'vcf' ? cards(text) : format === 'ics' ? parseCrmIcs(text) : format === 'eml' ? parseCrmEmailHeaders(text).map((item) => ({ Name: item.name, Email: item.email })) : parseCrmCsv(text)
  if (rows.length > 10000) throw new Error('Import at most 10,000 records at a time.')
  const columns = [...new Set(rows.flatMap(Object.keys))], mapping: CrmImportMapping = customMapping ?? (format === 'vcf' ? Object.fromEntries(Object.entries({ name: 'FN', email: 'EMAIL', phone: 'TEL', company: 'ORG', jobTitle: 'TITLE', url: 'URL' }).filter(([, column]) => columns.includes(column))) : mappingFor(columns))
  for (const key of Object.values(mapping)) if (key && !columns.includes(key)) throw new Error(`The selected column “${key}” is not in this file.`)
  const warnings = format === 'ics' ? ['Recurring rules and floating/ambiguous times remain in the original. Event presence and RSVP do not confirm attendance.'] : format === 'eml' ? ['Only From, To and Cc headers become candidates. The selected original file is retained locally.'] : ['Review identity matches before accepting. Names alone never establish a match.']
  return { preview: { name, provider, hash: crmHash(bytes), format, columns, mapping, count: rows.length, samples: rows.slice(0, 5), warnings }, rows }
}

export function batchCrmImport(name: string, bytes: Uint8Array, provider: string, accountId: string, now: number, mapping?: CrmImportMapping): CrmConnectorBatch {
  const { preview, rows } = previewCrmImport(name, bytes, provider, mapping), originalAssetId = `crm-file-${preview.hash}`, candidates: CrmConnectorCandidate[] = [], errors: string[] = []
  rows.forEach((row, index) => {
    if (preview.format === 'ics') {
      const startAt = icsTime(row.DTSTART ?? '', row['DTSTART:TZID']), endAt = icsTime(row.DTEND ?? '', row['DTEND:TZID']), externalId = row.UID ? `${row.UID}:${row['RECURRENCE-ID'] ?? ''}` : `${preview.hash}:${index}`
      const payload = { title: row.SUMMARY || 'Calendar event', type: 'event', status: row.STATUS === 'CANCELLED' ? 'cancelled' : 'scheduled', body: row.DESCRIPTION ?? '', personIds: [], companyIds: [], startAt, endAt, occurredAt: null, timezone: row['DTSTART:TZID'] || (/Z$/.test(row.DTSTART ?? '') ? 'UTC' : ''), allDay: /^\d{8}$/.test(row.DTSTART ?? ''), attendanceConfirmed: false, attachmentAssetIds: [], importedAttendees: row.ATTENDEE ?? '', recurrence: row.RRULE ?? '', originalStart: row.DTSTART ?? '' }
      if (startAt === null) errors.push(`Event ${index + 1}: local time could not be resolved; original time retained for review.`)
      candidates.push(connectorCandidate(provider, accountId, externalId, payload, row, originalAssetId, now, 'interaction')); return
    }
    const get = (key: keyof CrmImportMapping) => preview.mapping[key] ? row[preview.mapping[key]!] ?? '' : ''
    const nameValue = get('name') || `${get('firstName')} ${get('lastName')}`.trim(), emails = [...new Set(get('email').split(/[\n;,]+/).map(crmEmail).filter(Boolean))], phones = get('phone').split('\n').map((item) => clean(item, 100)).filter(Boolean), urls = get('url').split('\n').map(crmUrl).filter(Boolean)
    if (!nameValue && !emails.length && !phones.length && !urls.length) { errors.push(`Row ${index + 1}: no mapped name or identity; original row retained.`); return }
    const payload = { ...crmPerson(nameValue, emails[0] ?? ''), firstName: get('firstName'), lastName: get('lastName'), emails, phones, urls, jobTitle: get('jobTitle'), importedCompanyName: get('company') }
    const externalId = row.UID || row.id || row.ID || `${preview.hash}:${index}`
    candidates.push(connectorCandidate(provider, accountId, externalId, payload, row, originalAssetId, now))
  })
  return { provider, accountId, name, originalAssetIds: [originalAssetId], candidates, counts: { rows: rows.length, candidates: candidates.length, warnings: errors.length }, errors }
}
