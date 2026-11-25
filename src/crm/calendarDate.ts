import type { CrmCalendarEvent } from './connectionTypes.ts'

/** Badges and timestamps must refer to the same source-calendar day. */
export function calendarEventDate(event: Pick<CrmCalendarEvent, 'startAt' | 'allDay' | 'timezone'>, calendarTimezone = '') {
  if (event.startAt === null) return { day: '—', month: 'Date unavailable', time: 'Original date retained', timezone: '' }
  const requested = event.allDay ? 'UTC' : event.timezone || calendarTimezone
  let timezone = requested, unrecognized = false
  try { if (timezone) new Intl.DateTimeFormat(undefined, { timeZone: timezone }).format(event.startAt) } catch { timezone = 'UTC'; unrecognized = true }
  const options = timezone ? { timeZone: timezone } : {}, format = (parts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, { ...parts, ...options }).format(event.startAt!)
  return { day: format({ day: 'numeric' }), month: format({ month: 'short' }), time: event.allDay ? 'All day' : format({ dateStyle: 'medium', timeStyle: 'short' }), timezone: event.allDay ? '' : unrecognized ? `UTC · source timezone unrecognized (${requested})` : timezone }
}
