import { createHash, randomUUID } from 'node:crypto'
import type { CrmCalendarEvent } from '../src/crm/connectionTypes.ts'
import type { CrmInteraction, CrmSourceRef } from '../src/crm/types.ts'
import type { CrmConnections } from './crmConnections.ts'
import type { SqliteCrmStore } from './crmStore.ts'

export type ReaderCalendar = Pick<CrmConnections, 'status' | 'calendars' | 'events'>
const day = 86_400_000
const matchProvider = (text: string) => {
  const domains = (text.match(/https?:\/\/[^\s<>"']+/gi) ?? []).flatMap(link => {
    try { return [new URL(link).hostname.toLowerCase()] } catch { return [] }
  })
  const host = text.includes('@') && !text.includes(' ') ? text.split('@').at(-1)?.toLowerCase() : undefined
  if (host) domains.push(host)
  const hasDomain = (name: string) => domains.some(domain => domain === name || domain.endsWith('.' + name))
  return hasDomain('lu.ma') || hasDomain('luma.com') ? 'Luma' : hasDomain('partiful.com') ? 'Partiful' : null
}
const eventProvider = (record: CrmInteraction) =>
  record.sourceRefs.some(ref => ref.provider === 'luma') ? 'Luma' :
  record.sourceRefs.some(ref => ref.provider === 'partiful') ? 'Partiful' :
  matchProvider(record.sourceRefs.map(ref => ref.url).join(' ')) ??
  (record.sourceRefs.some(ref => ref.provider === 'google-calendar') ? 'Google Calendar' : 'Saved')
const reusable = (record: CrmInteraction) => record.archivedAt === null && record.status !== 'cancelled' &&
  (record.type === 'event' || record.sourceRefs.some(ref => /calendar|ics|luma|partiful/.test(ref.provider)))
const refFor = (event: CrmCalendarEvent, now: number): CrmSourceRef => ({
  provider: 'google-calendar', accountId: event.accountId, externalId: `${event.calendarId}:${event.id}`, observedAt: now,
  ...(event.htmlLink ? { url: event.htmlLink } : {}),
})
const identityFor = (event: CrmCalendarEvent, now: number): CrmSourceRef | null => event.iCalUID ? {
  provider: 'calendar-uid', accountId: '', externalId: createHash('sha256').update(`${event.iCalUID}:${Date.parse(event.originalStartTime) || event.startAt}`).digest('hex'), observedAt: now,
} : null

type Suggestion = {
  id: string; title: string; date: number | null; allDay: boolean; source: string; calendar?: string; matched: boolean
}
type Choice = { refs: CrmSourceRef[]; row: Suggestion; endAt: number | null; timezone: string }
type Scope = { key: string; type: 'person' | 'company'; id: string }

export class ReaderEvents {
  private readonly choices = new Map<string, { scope: string; expires: number; choice: Choice }>()
  private readonly store: SqliteCrmStore
  private readonly google?: ReaderCalendar
  constructor(store: SqliteCrmStore, google?: ReaderCalendar) {
    this.store = store
    this.google = google
  }

  async suggestions(scope: Scope, now: number, online: boolean, current: () => void) {
    const linked = (record: CrmInteraction) => (scope.type === 'person' ? record.personIds : record.companyIds).includes(scope.id)
    const records = this.store.rows('interactions', false).filter(reusable)
    const saved: Suggestion[] = records.filter(record => !linked(record)).map(record => ({
      id: `saved:${record.id}`, title: record.title, date: record.startAt, allDay: record.allDay,
      source: eventProvider(record), matched: false,
    }))
    const sort = (a: Suggestion, b: Suggestion) => Number(b.matched) - Number(a.matched) ||
      Math.abs((a.date ?? now) - now) - Math.abs((b.date ?? now) - now)
    if (!online || !this.google) return { events: saved.sort(sort), calendarStatus: 'local' }
    const google = this.google
    const person = scope.type === 'person' ? this.store.get('people', scope.id) : undefined
    const addresses = new Set((person?.emails ?? []).map(address => address.trim().toLowerCase()))
    const timeMin = new Date(now - 45 * day).toISOString()
    const timeMax = new Date(now + 30 * day).toISOString()
    const found = new Map<string, Choice>()
    let incomplete = false
    const accounts = await google.status().then(result =>
      result.accounts.filter(account => account.connected && account.capabilities.includes('calendar'))
    ).catch(() => { incomplete = true; return [] })
    await Promise.all(accounts.map(async account => {
      try {
        const { calendars, complete } = await google.calendars(account.id)
        const visible = calendars.filter(calendar => calendar.primary || calendar.selected)
        const selected = visible.slice(0, 5)
        if (!complete || visible.length > selected.length) incomplete = true
        await Promise.all(selected.map(async calendar => {
          try {
            const page = await google.events({ accountId: account.id, calendarId: calendar.id, timeMin, timeMax })
            const next = page.nextPageToken ? await google.events({
              accountId: account.id, calendarId: calendar.id, timeMin, timeMax, pageToken: page.nextPageToken,
            }).catch(() => { incomplete = true; return null }) : null
            if (next?.nextPageToken) incomplete = true
            for (const event of [...page.events, ...(next?.events ?? [])]) {
              if (event.status === 'cancelled' || !event.id || event.startAt === null) continue
              const ref = refFor(event, now), identity = identityFor(event, now)
              const key = identity?.externalId || `${account.id}:${ref.externalId}`
              const matched = [event.organizer, ...event.attendees].some(entry => addresses.has(entry.email.toLowerCase()))
              const previous = found.get(key)
              if (previous) {
                previous.refs.push(ref)
                previous.row.matched ||= matched
                continue
              }
              const raw = event.raw
              const location = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.location : ''
              const provider = matchProvider(event.organizer.email) ?? matchProvider(`${event.body} ${location ?? ''}`)
              const refs = identity ? [identity, ref] : [ref]
              if (provider) refs.push({ provider: provider.toLowerCase(), accountId: '', externalId: key, observedAt: now })
              found.set(key, {
                refs, endAt: event.endAt, timezone: event.timezone,
                row: { id: '', title: event.title, date: event.startAt, allDay: event.allDay,
                  calendar: account.email || account.label || calendar.summary, source: provider ?? 'Google Calendar', matched },
              })
            }
          } catch { incomplete = true }
        }))
      } catch { incomplete = true }
    }))
    current()
    const savedById = new Map(saved.map(row => [row.id, row]))
    const remote = [...found.values()].sort((a, b) => sort(a.row, b.row)).slice(0, 200).flatMap(choice => {
      const existing = choice.refs.flatMap(ref => this.store.findBySource('interactions', ref))
      if (existing.length) {
        for (const item of existing) {
          const row = savedById.get(`saved:${item.id}`)
          if (row && choice.row.matched) row.matched = true
        }
        return []
      }
      const key = `calendar:${randomUUID()}`
      this.choices.set(key, { scope: scope.key, expires: now + 10 * 60_000, choice })
      return [{ ...choice.row, id: key }]
    })
    for (const [key, item] of this.choices) {
      if (item.expires <= now || this.choices.size > 1200) this.choices.delete(key)
    }
    return { events: [...saved, ...remote].sort(sort), calendarStatus: incomplete ? 'partial' : accounts.length ? 'complete' : 'disconnected' }
  }

  link(scope: Scope, key: string, requestId: string, now: number, changed: () => void) {
    const relation = scope.type === 'person' ? 'personIds' : 'companyIds'
    if (key.startsWith('saved:')) {
      const record = this.store.get('interactions', key.slice(6))
      if (!record || !reusable(record)) throw new Error('This event is unavailable. Refresh the suggestions.')
      if (record[relation].includes(scope.id)) return
      const result = this.store.command({
        requestId, operation: 'update', collection: 'interactions', id: record.id, expectedRecordRevision: record.revision,
        patch: {
          [relation]: [...record[relation], scope.id],
          ...(record.attendanceConfirmed ? { confirmedPersonIds: record.confirmedPersonIds ?? record.personIds } : {}),
        },
      }, 'reader-organization')
      if (!result.replayed) changed()
      return
    }
    const entry = this.choices.get(key)
    if (entry?.scope !== scope.key || entry.expires <= now) throw new Error('This calendar suggestion expired. Refresh the suggestions.')
    const { row, endAt, timezone, refs } = entry.choice
    const result = this.store.command({
      requestId, operation: 'log_calendar',
      record: { title: row.title, type: 'event', [relation]: [scope.id], sourceRefs: refs,
        startAt: row.date, endAt, timezone, allDay: row.allDay },
    }, 'reader-organization')
    if (!result.replayed) changed()
  }
}
