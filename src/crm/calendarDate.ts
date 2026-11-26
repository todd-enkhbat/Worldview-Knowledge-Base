import type { CrmFilter, CrmInteraction } from './types.ts'
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

export const calendarInteraction = (row: Pick<CrmInteraction, 'type'>) => ['calendar', 'event'].includes(row.type)
export function confirmedAttendees(row: CrmInteraction) {
  return row.attendanceConfirmed ? row.confirmedPersonIds ?? row.personIds : []
}

export type ReminderTab = 'Open' | 'Overdue' | 'Today' | 'Upcoming' | 'Completed'
export function reminderFilter(tab: ReminderTab, now = new Date()): CrmFilter {
  const complete: CrmFilter = { field:'completedAt', operator:tab === 'Completed' ? 'notEmpty' : 'empty' }
  const start = new Date(now); start.setHours(0,0,0,0)
  const tomorrow = new Date(start); tomorrow.setDate(start.getDate() + 1)
  const rules: CrmFilter[] = [complete]
  if (tab === 'Overdue') rules.push({ field:'dueAt',operator:'lt',value:start.getTime() })
  if (tab === 'Today') rules.push({ field:'dueAt',operator:'gte',value:start.getTime() },{ field:'dueAt',operator:'lt',value:tomorrow.getTime() })
  if (tab === 'Upcoming') rules.push({ field:'dueAt',operator:'gte',value:tomorrow.getTime() })
  return {op:'and',rules}
}
