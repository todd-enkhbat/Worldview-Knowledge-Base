import { coordinateText } from './coordinates.ts'
import type { PlaceDraft } from './imports.ts'

function calendarDate(value: string, tz?: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value)
  if (!match) return null
  const [, y, m, d, h, min, s, utc] = match
  const date = [y, m, d].join('-')
  if (!h) return date
  const wall = date + 'T' + [h, min, s].join(':')
  if (utc) return wall + 'Z'
  if (!tz) return wall
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: tz.replace(/^"|"$/g, ''), hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit', month: '2-digit', day: '2-digit', year: 'numeric' })
    const desired = Date.parse(wall + 'Z')
    let at = desired
    for (let attempt = 0; attempt < 3; attempt++) {
      const fields = Object.fromEntries(formatter.formatToParts(at).map(p => [p.type, p.value]))
      const displayed = Date.UTC(+fields.year, +fields.month - 1, +fields.day, +fields.hour, +fields.minute, +fields.second)
      if (displayed === desired) return new Date(at).toISOString()
      at += desired - displayed
    }
  } catch { /* Preserve local wall time for an unknown zone. */ }
  return wall
}
export function calendarVenues(text: string): { drafts: PlaceDraft[]; skipped: number } {
  const drafts: PlaceDraft[] = []
  let props: Map<string, { value: string; params: string }> | null = null, nested = 0, skipped = 0
  for (const line of text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
    if (/^BEGIN:VEVENT$/i.test(line)) { props = new Map(); nested = 0; continue }
    if (!props) continue
    if (/^BEGIN:/i.test(line)) { nested++; continue }
    if (nested) { if (/^END:/i.test(line)) nested--; continue }
    if (/^END:VEVENT$/i.test(line)) {
      const value = (key: string) => props!.get(key)?.value ?? ''
      const date = (key: string) => calendarDate(value(key), /(?:^|;)TZID=([^;]+)/i.exec(props!.get(key)?.params ?? '')?.[1])
      const address = value('LOCATION'), point = coordinateText(value('GEO')) || coordinateText(value('X-APPLE-STRUCTURED-LOCATION'))
      if ((address || point) && !/^https?:\/\//i.test(address) && value('STATUS').toUpperCase() !== 'CANCELLED') {
        const title = value('SUMMARY') || address || 'Calendar venue', start = date('DTSTART')
        const recurrence = value('RECURRENCE-ID')
        drafts.push({ kind: 'event', provider: 'calendar', identity: [value('UID') || [title, address, start].join('|'), recurrence].join('|'),
          title, address, point, startedAt: start, endedAt: date('DTEND'), url: value('URL'), detail: value('DESCRIPTION').slice(0, 1500) })
      } else skipped++
      props = null
      continue
    }
    const parts = /^([A-Z0-9-]+)((?:;(?:[^":]|"[^"]*")*)?):(.*)$/i.exec(line)
    if (!parts) continue
    const value = parts[3].replace(/\\([nN,;\\])/g, (_, c: string) => c.toLowerCase() === 'n' ? '\n' : c)
    props.set(parts[1].toUpperCase(), { params: parts[2], value })
  }
  return { drafts, skipped }
}
